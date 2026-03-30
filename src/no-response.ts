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
  private gracePeriodMs = 1000 * 60 * 15 // minutes

  private client: GitHubApiClient
  private repoMetadata: RepoMetadataCache
  private issueCache: IssueCache

  private repository!: Repository
  private responseRequiredLabel!: Label
  private optionalFollowUpLabel?: Label

  constructor(private config: Config) {
    this.gracePeriodMs = 1000 * 60 * 15 // minutes
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
        color: this.config.optionalFollowUpColor || 'ffffff'
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  async sweep(): Promise<void> {
    core.debug('Starting sweep')
    await this.initializeMetadata()

    await this.repoMetadata.createLabel(this.responseRequiredLabel)

    const writeBatchSize = 10
    const interBatchDelayMs = 1000 * 2 // seconds (secondary rate-limit protection)
    const stats = {
      closed: { ok: 0, failed: 0 },
      reopened: { ok: 0, failed: 0 }
    }

    // 1) Reopen pass (resilient)
    const toReopen = await this.getReopenableIssues()

    for (let i = 0; i < toReopen.length; i += writeBatchSize) {
      const counts = await this.runWriteBatch(
        toReopen.slice(i, i + writeBatchSize),
        async (details) => {
          await this.reopenAndAdjustLabels(details.number)
        },
        (details) => ({ context: 'reopen', issueNumber: details.number })
      )

      stats.reopened.ok += counts.ok
      stats.reopened.failed += counts.failed

      // delay between *write* batches
      if (i + writeBatchSize < toReopen.length) {
        await this.sleep(interBatchDelayMs)
      }
    }

    // Optional extra spacing between reopen and close phases
    if (0 < toReopen.length) await this.sleep(interBatchDelayMs)

    // 2) Close pass (resilient + maxIssuesPerRun already enforced inside getCloseableIssues)
    const toClose = await this.getCloseableIssues()

    for (let i = 0; i < toClose.length; i += writeBatchSize) {
      const counts = await this.runWriteBatch(
        toClose.slice(i, i + writeBatchSize),
        async (details) => {
          await this.close(details.number)
        },
        (details) => ({ context: 'close', issueNumber: details.number })
      )

      stats.closed.ok += counts.ok
      stats.closed.failed += counts.failed

      if (i + writeBatchSize < toClose.length) {
        await this.sleep(interBatchDelayMs)
      }
    }

    core.info(
      `Sweep complete. Reopen: ok=${stats.reopened.ok}, failed=${stats.reopened.failed}. Close: ok=${stats.closed.ok}, failed=${stats.closed.failed}.`
    )
  }

  async handleLabeled(): Promise<void> {
    await this.initializeMetadata()
    const payload = github.context.payload as IssuesLabeledEvent

    if (payload.label?.name !== this.responseRequiredLabel.name) return

    const issueDetails = await this.issueCache.fetch(this.repository, payload.issue.number)

    core.info('Target label matched.')
    await this.assignAuthor(issueDetails)
  }

  /**
   * Author comment handler (issue_comment.created)
   *
   * Intended behavior:
   * - Re-open (or keep open) any issue where the *issue author* comments,
   *   with the ONLY exception:
   *     - if the author closed the issue themselves within the grace period
   *       (default: 15 minutes), do not reopen (treat as a "thanks"/wrap-up).
   *
   * Rationale (IMPORTANT):
   * - This action is intentionally allowed to reopen issues even when
   *   `responseRequiredLabel` is not currently present. This is a deliberate
   *   safety-net behavior for cases where the author cannot reopen the issue
   *   themselves (email replies, permission restrictions) or when event-driven
   *   processing is missed and the scheduled sweep later catches it.
   *
   * Post-conditions (when reopening OR already open):
   * - remove `responseRequiredLabel` (if present),
   * - unassign the author (if assigned via this workflow),
   * - then (if configured) add `optionalFollowUpLabel`.
   *
   * Future note:
   * - We may introduce an input to restrict reopen behavior to only issues that
   *   previously participated in this workflow (e.g., only if
   *   `responseRequiredLabel` was applied at some point). Do not “fix” this
   *   by adding an `isLabeled(...responseRequiredLabel)` guard without that
   *   explicit product decision.
   */
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
      const closedAt = details.closed_at.getTime()
      const createdAt = toDate(payload.comment.created_at)
      const commentedAt = createdAt ? createdAt.getTime() : Date.now()

      if (this.gracePeriodMs < commentedAt - closedAt) {
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
    const payload = github.context.payload as IssuesEvent
    if ('issues' !== github.context.eventName || 'closed' !== payload.action) return

    const senderId = payload.sender?.id
    if (!senderId || senderId !== payload.issue.user?.id) return

    await this.initializeMetadata()
    const issueDetails = await this.issueCache.fetch(this.repository, payload.issue.number)

    await this.clearWorkflowLabels(issueDetails)
  }

  private async assignAuthor(issue: IssueDetails): Promise<void> {
    const login = issue.user?.login
    if (!login || 'unknown' === login) {
      core.warning(
        `Skipping author assignment addition for ${issue.repo.owner}/${issue.repo.name}#${issue.number}: missing/unknown author login.`
      )
      return
    }
    core.info(`Adding author assignee to issue #${issue.number}`)
    return await this.client.addAssignees(issue, [login])
  }

  private async unassignAuthor(issue: IssueDetails): Promise<void> {
    const login = issue.user?.login
    if (!login || 'unknown' === login) {
      core.warning(
        `Skipping author assigment removal for ${issue.repo.owner}/${issue.repo.name}#${issue.number}: missing/unknown author login.`
      )
      return
    }
    core.info(`Removing author assignee from issue #${issue.number}`)
    return await this.client.removeAssignees(issue, [login])
  }

  private async getReopenableIssues(): Promise<IssueDetails[]> {
    const q = `repo:${this.repository.owner}/${this.repository.name} is:issue is:closed label:"${this.responseRequiredLabel.name}"`
    const results = await this.client.octokit.paginate(
      this.client.octokit.rest.search.issuesAndPullRequests,
      { q, per_page: 100 }
    )

    const reopenable: IssueDetails[] = []
    for (const raw of results) {
      const issueDetails = await this.issueCache.fetch(this.repository, raw.number)
      const { details, timeline } = await this.issueCache.ensureClosureDetails(issueDetails)

      const closedAt =
        (checkClosedByAuthor(details) ? this.gracePeriodMs : 0) + details.closed_at.getTime()
      const events = timeline ?? (await this.client.fetchTimeline(details))
      const authorResponded = events.some(
        (e) =>
          'commented' === e.event &&
          details.user.login === e.actor.login &&
          closedAt < e.created_at.getTime()
      )
      if (authorResponded) reopenable.push(details)
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
    const updated = await this.client.updateIssueState(
      { ...details, state: 'closed' },
      'not_planned'
    )
    await this.issueCache.set(updated)
  }

  private async reopenAndAdjustLabels(number: number): Promise<void> {
    const details = await this.issueCache.fetch(this.repository, number)
    const updated = await this.client.updateIssueState({ ...details, state: 'open' }, 'reopened')
    await this.issueCache.set(updated)
    await this.transitionToFollowUp(updated)
  }

  private async clearWorkflowLabels(issue: IssueDetails): Promise<void> {
    const labelsToRemove = []
    if (isLabeled(issue, this.responseRequiredLabel))
      labelsToRemove.push(this.responseRequiredLabel)
    if (this.optionalFollowUpLabel && isLabeled(issue, this.optionalFollowUpLabel))
      labelsToRemove.push(this.optionalFollowUpLabel)

    await this.issueCache.removeLabels(issue, labelsToRemove)
  }

  /**
   * Normalizes an issue after author engagement:
   * - If `responseRequiredLabel` is present, remove it and unassign the author.
   * - If `optionalFollowUpLabel` is configured, add it.
   *
   * Note:
   * - Today, optional follow-up can be applied even if the required label was
   *   not present. This aligns with the “assist users who can’t reopen” default.
   * - If we add a future config input to require prior workflow participation,
   *   this is the place to conditionally apply the follow-up label based on
   *   prior presence/history of `responseRequiredLabel`.
   */
  private async transitionToFollowUp(issue: IssueDetails): Promise<void> {
    if (isLabeled(issue, this.responseRequiredLabel)) {
      await this.issueCache.removeLabels(issue, [this.responseRequiredLabel])
      await this.unassignAuthor(issue)
    }

    if (this.optionalFollowUpLabel) {
      await this.repoMetadata.createLabel(this.optionalFollowUpLabel)
      await this.issueCache.addLabels(issue, [this.optionalFollowUpLabel])
    }
  }

  private formatOctokitError(error: any) {
    // Octokit errors often carry: status, message, request, response.data
    const status = error?.status
    const message = error?.message || String(error)

    const requestUrl =
      error?.request?.url || error?.request?.endpoint || error?.request?.route || undefined

    const documentationUrl = error?.response?.data?.documentation_url
    const apiMessage = error?.response?.data?.message

    return {
      status,
      message,
      apiMessage,
      requestUrl,
      documentationUrl
    }
  }

  private logSweepFailure(context: string, issueNumber: number, error: any): void {
    const info = this.formatOctokitError(error)

    core.warning(
      [
        `[sweep] ${context} failed for #${issueNumber}`,
        info.status ? `status=${info.status}` : undefined,
        info.message ? `message="${info.message}"` : undefined,
        info.apiMessage ? `apiMessage="${info.apiMessage}"` : undefined,
        info.requestUrl ? `requestUrl=${info.requestUrl}` : undefined,
        info.documentationUrl ? `documentationUrl=${info.documentationUrl}` : undefined
      ]
        .filter(Boolean)
        .join(' | ')
    )

    // Useful for deep debugging in action logs
    core.debug(`[sweep] error object: ${JSON.stringify(error, null, 2)}`)
  }

  /**
   * Runs a batch of write operations with allSettled so one failure doesn't halt the run.
   * Returns { ok, failed } counts for reporting.
   */
  private async runWriteBatch<T>(
    batch: T[],
    runner: (item: T) => Promise<void>,
    describe: (item: T) => { context: string; issueNumber: number }
  ): Promise<{ ok: number; failed: number }> {
    const settled = await Promise.allSettled(batch.map((item) => runner(item)))
    let ok = 0
    let failed = 0

    for (let i = 0; i < settled.length; i++) {
      const result = settled[i]
      const meta = describe(batch[i])

      if ('fulfilled' === result.status) {
        ok++
      } else {
        failed++
        this.logSweepFailure(meta.context, meta.issueNumber, result.reason)
      }
    }

    return { ok, failed }
  }
}
