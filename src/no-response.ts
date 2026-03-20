// src/no-response.ts

import * as core from '@actions/core'
import * as github from '@actions/github'
import { IssueCommentEvent, IssuesEvent, IssuesLabeledEvent } from '@octokit/webhooks-types'

import Config from './config'
import { GitHubApiClient } from './gh-api-client'
import { toDate } from './gh-api-helpers'
import { IssueCache } from './issue-cache'
import {
  isLabeled,
  checkClosedByAuthor,
  getExpiryDate,
  isTargetLabeledEvent
} from './logic-helpers'
import { RepoMetadataCache } from './repo-metadata-cache'
import { Repository, Label, Issue, IssueDetails } from './types'

export default class NoResponse {
  private client: GitHubApiClient
  private repoMetadata: RepoMetadataCache
  private issueCache: IssueCache

  private repository!: Repository
  private responseRequiredLabel!: Label
  private optionalFollowUpLabel?: Label

  constructor(private config: Config) {
    this.client = new GitHubApiClient(config.token)
    this.repoMetadata = new RepoMetadataCache(this.client)
    this.issueCache = new IssueCache(this.client, this.repoMetadata)
  }

  private async initializeMetadata(): Promise<void> {
    if (this.repository && this.responseRequiredLabel) return
    const baseRepo = {
      owner: this.config.repo.owner,
      name: this.config.repo.repo
    }
    this.repository = await this.repoMetadata.getInitializedRepository(baseRepo)

    this.responseRequiredLabel = {
      name: this.config.responseRequiredLabel,
      repo: this.repository,
      color: this.config.responseRequiredColor
    }

    if (this.config.optionalFollowUpLabel) {
      this.optionalFollowUpLabel = {
        name: this.config.optionalFollowUpLabel,
        repo: this.repository,
        color: this.config.optionalFollowUpLabelColor || 'ffffff'
      }
    }
  }

  async sweep(): Promise<void> {
    core.debug('Starting sweep')
    await this.initializeMetadata()

    await this.repoMetadata.createLabel(this.responseRequiredLabel)

    const toReopen = await this.getReopenableIssues()
    for (const details of toReopen) {
      await this.reopenAndAdjustLabels(details.number)
    }

    const toClose = await this.getCloseableIssues()
    const batchSize = 10
    for (let i = 0; i < toClose.length; i += batchSize) {
      const batch = toClose.slice(i, i + batchSize)
      await Promise.all(batch.map((details) => this.close(details.number)))
    }

    core.info(`Sweep complete. Reopened ${toReopen.length} and closed ${toClose.length} issues.`)
  }

  async handleLabeled(): Promise<void> {
    await this.initializeMetadata()
    const payload = github.context.payload as IssuesLabeledEvent

    if (payload.label?.name !== this.responseRequiredLabel.name) return

    const issueDetails = await this.issueCache.fetch(this.repository, payload.issue.number)

    core.info(
      `Target label matched. Assigning #${issueDetails.number} to author: ${issueDetails.user.login}`
    )
    await this.client.addAssignees(issueDetails, [issueDetails.user.login])
  }

  async handleAuthorCommented(): Promise<void> {
    await this.initializeMetadata()
    const payload = github.context.payload as IssueCommentEvent
    const issueDetails = await this.issueCache.fetch(this.repository, payload.issue.number)

    // Verify: Only proceed if the commenter is the original author
    if (issueDetails.user.login !== payload.comment.user.login) return

    const { details } = await this.issueCache.ensureClosureDetails(issueDetails)
    const isAuthorClosed = checkClosedByAuthor(details)

    /*
     * CASE 1: Closed by someone else (Bot/Maintainer).
     * Reopen immediately on author response.
     */
    if (!isAuthorClosed && 'closed' === issueDetails.state) {
      core.info(
        `Author responded to closed issue ${this.repository.owner}/${this.repository.name}#${issueDetails.number}. Reopening.`
      )
      await this.reopenAndAdjustLabels(issueDetails.number)
      return
    }

    /*
     * CASE 2: Closed by the author themselves.
     * Reopen only if the comment happened after the grace period.
     */
    if (isAuthorClosed) {
      const gracePeriodMs = 1000 * 60 * 15 // minutes
      const closedAt = details.closed_at.getTime()
      const createdAt = toDate(payload.comment.created_at)
      const commentedAt = createdAt ? createdAt.getTime() : Date.now()

      if (gracePeriodMs < commentedAt - closedAt) {
        core.info(
          `Author follow-up on self-closed ${this.repository.owner}/${this.repository.name}#${issueDetails.number} after grace period. Reopening.`
        )
        await this.reopenAndAdjustLabels(issueDetails.number)
      } else {
        await this.clearWorkflowLabels(issueDetails)
      }
      return
    }

    /*
     * CASE 3: Issue is OPEN.
     */
    if ('open' === issueDetails.state) {
      await this.transitionToFollowUp(issueDetails)
    }
  }

  async handleClosedIssue(): Promise<void> {
    if ('closed' !== github.context.payload.action) return

    await this.initializeMetadata()
    const payload = github.context.payload as IssuesEvent
    const issueDetails = await this.issueCache.fetch(this.repository, payload.issue.number)

    if (payload.issue.user.login !== payload.sender.login) return

    await this.clearWorkflowLabels(issueDetails)
  }

  private async getReopenableIssues(): Promise<IssueDetails[]> {
    const q = `repo:${this.repository.owner}/${this.repository.name} is:issue is:closed label:"${this.responseRequiredLabel.name}"`
    const results = await this.client.octokit.paginate(
      this.client.octokit.rest.search.issuesAndPullRequests,
      { q, per_page: 100 }
    )

    const reopenable: IssueDetails[] = []
    for (const raw of results) {
      const issue: Issue = {
        number: raw.number,
        repo: this.repository,
        state: raw.state as 'open' | 'closed',
        user: { login: raw.user!.login }
      }
      const issueDetails = await this.issueCache.fetchDetails(issue)
      const { details, timeline } = await this.issueCache.ensureClosureDetails(issueDetails)

      if (!checkClosedByAuthor(details)) {
        const closedAt = details.closed_at.getTime()
        const events = timeline ?? (await this.client.fetchTimeline(details))
        const authorResponded = events.some(
          (e) =>
            'commented' === e.event &&
            details.user.login === e.actor.login &&
            closedAt < e.created_at.getTime()
        )
        if (authorResponded) reopenable.push(details)
      }
    }
    return reopenable
  }

  private async getCloseableIssues(): Promise<IssueDetails[]> {
    const q = `repo:${this.repository.owner}/${this.repository.name} is:issue is:open label:"${this.responseRequiredLabel.name}"`
    const results = await this.client.octokit.paginate(
      this.client.octokit.rest.search.issuesAndPullRequests,
      { q, per_page: 100 }
    )

    const closeable: IssueDetails[] = []
    for (const raw of results) {
      if (closeable.length >= this.config.maxIssuesPerRun) break
      if (await this.verifyStaleStatus(raw.number)) {
        closeable.push(await this.issueCache.fetch(this.repository, raw.number))
      }
    }
    return closeable
  }

  private async verifyStaleStatus(number: number): Promise<boolean> {
    const details = await this.issueCache.fetch(this.repository, number)
    const timeline = await this.client.fetchTimeline(details)

    const labeledEvents = timeline
      .filter((e) => isTargetLabeledEvent(e, this.responseRequiredLabel))
      .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())

    if (0 === labeledEvents.length) return false
    const lastLabeled = labeledEvents[0]

    if (lastLabeled.created_at.getTime() > getExpiryDate(this.config.daysUntilClose).getTime())
      return false

    return !timeline.some(
      (e) =>
        'commented' === e.event &&
        details.user.login === e.actor.login &&
        e.created_at.getTime() > lastLabeled.created_at.getTime()
    )
  }

  private async close(number: number): Promise<void> {
    const details = await this.issueCache.fetch(this.repository, number)
    core.info(`Closing ${this.repository.owner}/${this.repository.name}#${number} as "not_planned"`)
    if (this.config.closeComment) await this.client.createComment(details, this.config.closeComment)
    details.state = 'closed'
    const updated = await this.client.updateIssueState(details, 'not_planned')
  }

  private async reopenAndAdjustLabels(number: number): Promise<void> {
    const details = await this.issueCache.fetch(this.repository, number)
    details.state = 'open'
    const updated = await this.client.updateIssueState(details, 'reopened')
    await this.transitionToFollowUp(updated)
  }

  private async clearWorkflowLabels(issue: IssueDetails): Promise<void> {
    const labelsToRemove = []
    if (isLabeled(issue, this.responseRequiredLabel))
      labelsToRemove.push(this.responseRequiredLabel)
    if (this.optionalFollowUpLabel && isLabeled(issue, this.optionalFollowUpLabel))
      labelsToRemove.push(this.optionalFollowUpLabel)

    await this.client.removeLabels(issue, labelsToRemove)
  }

  private async unassignAuthor(issue: IssueDetails): Promise<void> {
    core.info(`Removing author assignee from issue #${issue.number}`)
    return await this.client.removeAssignees(issue, [issue.user.login])
  }

  private async transitionToFollowUp(issue: IssueDetails): Promise<void> {
    if (isLabeled(issue, this.responseRequiredLabel)) {
      await this.client.removeLabels(issue, [this.responseRequiredLabel])
      await this.unassignAuthor(issue)
    }

    if (this.optionalFollowUpLabel) {
      await this.repoMetadata.createLabel(this.optionalFollowUpLabel)
      await this.client.addLabels(issue, [this.optionalFollowUpLabel])
    }
  }
}
