import * as fs from 'node:fs'
import * as core from '@actions/core'
import * as github from '@actions/github'

import Config from './config'

/* eslint-disable import/no-unresolved, import/named */
import { IssueCommentEvent, IssuesEvent } from '@octokit/webhooks-types'
/* eslint-enable */

const fsp = fs.promises

interface Issue {
  issue_number: number
  owner: string
  repo: string
}

interface LabeledEvent {
  created_at: string // GitHub API returns ISO strings
  event: string
  label?: {
    name: string
  }
}

interface TimelineEvent extends LabeledEvent {
  actor: {
    login: string
  }
}

interface RestIssue {
  number: number
}

export default class NoResponse {
  config: Config
  octokit: ReturnType<typeof github.getOctokit>

  // Cache for label existence (key: label name)
  private verifiedLabels = new Map<string, boolean>()

  // Cache for issue data to save GET calls (key: issue number)
  // Store the full response to reuse across sweep and unmark
  private issueCache = new Map<number, any>()

  constructor(config: Config) {
    this.config = config
    this.octokit = github.getOctokit(this.config.token)
  }

  async sweep(): Promise<void> {
    core.debug('Starting sweep')

    // Ensure the required label exists before processing
    await this.ensureLabelExists(
      this.config.responseRequiredLabel,
      this.config.responseRequiredColor
    )

    // Identify and process reopens first
    const toReopen = await this.getReopenableIssues()
    for (const issue of toReopen) {
      await this.reopenAndUnmark(issue.number)
    }

    // Identify and process closures
    const issues = await this.getCloseableIssues()

    const batchSize = 10
    for (let i = 0; i < issues.length; i += batchSize) {
      const currentBatch = issues.slice(i, i + batchSize)

      await Promise.all(
        currentBatch.map((issue) =>
          this.close({
            issue_number: issue.number,
            ...this.config.repo
          })
        )
      )
    }

    core.info(`Sweep complete. Reopened ${toReopen.length} and closed ${issues.length} issues.`)
  }

  async removeLabels(): Promise<void> {
    core.debug('Starting removeLabels')

    const { optionalFollowUpLabel, responseRequiredLabel } = this.config
    if (!optionalFollowUpLabel) {
      return
    }
    const payload = github.context.payload as IssuesEvent
    if (payload.action !== 'closed') {
      return
    }

    const owner = payload.repository.owner.login
    const repo = payload.repository.name
    const { number } = payload.issue
    const issue = { owner, repo, issue_number: number }

    // if the issue closed by the issue author, check if optionalFollowUpLabel is present on the issue and then remove it
    if (payload.issue.user.login === payload.sender.login) {
      const labels = await this.octokit.rest.issues.listLabelsOnIssue(issue)
      const plainLabels = labels.data.map((label: any) => label.name)

      if (plainLabels.includes(responseRequiredLabel)) {
        await this.octokit.rest.issues.removeLabel({
          ...issue,
          name: responseRequiredLabel
        })
      }

      if (optionalFollowUpLabel && plainLabels.includes(optionalFollowUpLabel)) {
        await this.octokit.rest.issues.removeLabel({
          ...issue,
          name: optionalFollowUpLabel
        })
      }
    }
  }

  async unmark(): Promise<void> {
    core.debug('Starting unmark')

    const { responseRequiredLabel, optionalFollowUpLabel, optionalFollowUpLabelColor } = this.config
    const payload: IssueCommentEvent = await this.readPayload()
    const owner = payload.repository.owner.login
    const repo = payload.repository.name
    const { number } = payload.issue
    const comment = payload.comment
    const issue = { owner, repo, issue_number: number }

    // Ensure cache is populated before deciding on action
    const issueInfo = await this.getIssueInfo(number)
    const isMarked = issueInfo.labels.some((l: any) => l.name === responseRequiredLabel)

    // Only proceed if marked and the commenter is the issue author
    if (isMarked && issueInfo.user?.login === comment.user.login) {
      core.info(`${owner}/${repo}#${number} is being unmarked`)

      if (issueInfo.state === 'closed' && issueInfo.user.login !== issueInfo.closed_by?.login) {
        // Use the new shared helper for the full sequence
        await this.reopenAndUnmark(number)
      }
    }
  }

  async close(issue: Issue): Promise<void> {
    const { closeComment } = this.config

    // Check cache first to see if we have the data
    const issueData = this.issueCache.get(issue.issue_number)

    core.info(`${issue.owner}/${issue.repo}#${issue.issue_number} is being closed`)

    if (closeComment) {
      await this.octokit.rest.issues.createComment({ body: closeComment, ...issue })
    }

    await this.octokit.rest.issues.update({
      ...issue,
      state: 'closed',
      state_reason: 'not_planned'
    })

    // Update cache to reflect the new closed state
    if (issueData) {
      this.issueCache.set(issue.issue_number, {
        ...issueData,
        state: 'closed'
      })
    }
  }

  async ensureLabelExists(name: string, color: string): Promise<void> {
    // If we've already verified this label in this run, skip the API calls
    if (this.verifiedLabels.has(name)) {
      return
    }

    try {
      await this.octokit.rest.issues.getLabel({ name, ...this.config.repo })
    } catch {
      await this.octokit.rest.issues.createLabel({ name, color, ...this.config.repo })
    }

    this.verifiedLabels.set(name, true)
  }

  async findLastLabeledEvent(issue: Issue): Promise<TimelineEvent | undefined> {
    const { responseRequiredLabel } = this.config

    const events = (await this.octokit.paginate(this.octokit.rest.issues.listEvents, {
      ...issue,
      per_page: 100
    })) as unknown as TimelineEvent[]

    // Look for the 'closed' event to find who closed it
    const closedEvent = events.findLast((e) => e.event === 'closed')
    if (closedEvent) {
      // Manually update your issueCache with the closer info to save a GET later
      const cached = this.issueCache.get(issue.issue_number) || {}
      this.issueCache.set(issue.issue_number, {
        ...cached,
        closed_by: closedEvent.actor
      })
    }

    return events.findLast(
      (event) => event.event === 'labeled' && event.label?.name === responseRequiredLabel
    )
  }

  async getReopenableIssues(): Promise<RestIssue[]> {
    const { owner, repo } = this.config.repo
    const { responseRequiredLabel } = this.config
    const q = `repo:${owner}/${repo} is:issue is:closed label:"${responseRequiredLabel}"`

    const issues = await this.octokit.paginate(this.octokit.rest.search.issuesAndPullRequests, {
      q,
      sort: 'updated',
      order: 'desc',
      per_page: 100
    })

    const reopenableIssues: RestIssue[] = []

    for (const issue of issues) {
      // Seed the cache with the search result
      this.issueCache.set(issue.number, issue)

      // getIssueInfo handles the potential fetch for closed_by info
      const issueInfo = await this.getIssueInfo(issue.number)

      // Reopen logic: if the closer was not the issue author
      if (issueInfo.user?.login !== issueInfo.closed_by?.login) {
        reopenableIssues.push(issue as RestIssue)
      }
    }

    return reopenableIssues
  }

  async getCloseableIssues(): Promise<RestIssue[]> {
    const { owner, repo } = this.config.repo
    const { daysUntilClose, maxIssuesPerRun, responseRequiredLabel } = this.config
    const q = `repo:${owner}/${repo} is:issue is:open label:"${responseRequiredLabel}"`
    const labeledEarlierThan = this.since(daysUntilClose)

    const issues = await this.octokit.paginate(this.octokit.rest.search.issuesAndPullRequests, {
      q,
      sort: 'created',
      order: 'asc',
      per_page: 100
    })

    const tasks: (() => Promise<RestIssue | null>)[] = []

    // Seed the cache with search results
    for (const issue of issues) {
      this.issueCache.set(issue.number, issue)

      tasks.push(async () => {
        const event = await this.findLastLabeledEvent({
          issue_number: issue.number,
          ...this.config.repo
        })

        if (!event) {
          return null
        }

        core.debug(`Checking: ${JSON.stringify(issue, null, 2)}`)
        core.debug(`Using: ${JSON.stringify(event, null, 2)}`)

        const creationDate = new Date(event.created_at)

        core.debug(
          `${creationDate.toISOString()} < ${labeledEarlierThan.toISOString()} === ${
            creationDate < labeledEarlierThan
          }`
        )
        if (creationDate < labeledEarlierThan) {
          return issue as RestIssue
        }
        return null
      })
    }

    const batchSize = 10
    const closableIssues: RestIssue[] = []
    for (let i = 0; i < tasks.length; i += batchSize) {
      if (closableIssues.length >= maxIssuesPerRun) {
        break
      }

      const currentBatch = tasks.slice(i, i + batchSize)
      const results = await Promise.all(currentBatch.map((task) => task()))

      for (const issue of results) {
        if (issue) {
          closableIssues.push(issue)
          if (closableIssues.length >= maxIssuesPerRun) {
            break
          }
        }
      }
    }

    core.debug(`Closeable: ${JSON.stringify(closableIssues, null, 2)}`)

    return closableIssues as RestIssue[]
  }

  async readPayload(): Promise<IssueCommentEvent> {
    if (!process.env.GITHUB_EVENT_PATH) {
      throw new Error('GITHUB_EVENT_PATH is not defined')
    }

    const text = (await fsp.readFile(process.env.GITHUB_EVENT_PATH)).toString()

    return JSON.parse(text)
  }

  async getIssueInfo(issue_number: number): Promise<any> {
    // Check if we already have the data from a search or previous fetch
    const cached = this.issueCache.get(issue_number)
    if (cached && cached.labels) {
      core.debug(`Cache hit for issue #${issue_number}`)
      return cached
    }

    // Cache miss: perform the API call
    core.debug(`Fetching full data for issue #${issue_number}...`)
    const { data } = await this.octokit.rest.issues.get({
      ...this.config.repo,
      issue_number
    })

    // Merge: Keep any 'closed_by' info we found in the timeline while
    // filling in the rest of the issue details from the API.
    const mergedData = { ...data, ...cached }

    // Store it so we don't fetch it again
    this.issueCache.set(issue_number, mergedData)
    return mergedData
  }

  since(days: number): Date {
    const ttl = days * 24 * 60 * 60 * 1000

    return new Date(Date.now() - ttl)
  }

  private async reopenAndUnmark(issueNumber: number): Promise<void> {
    const { responseRequiredLabel, optionalFollowUpLabel, optionalFollowUpLabelColor } = this.config
    const issue = { ...this.config.repo, issue_number: issueNumber }

    // Pull data from cache and clear it immediately
    const cached = this.issueCache.get(issueNumber)
    this.issueCache.delete(issueNumber)

    core.info(`Reopening and unmarking #${issueNumber}`)

    // Reopen first, THEN handle labels only if the reopen succeeds
    await this.octokit.rest.issues
      .update({
        ...issue,
        state: 'open'
      })
      .then(async () => {
        const tasks: Promise<any>[] = [
          this.octokit.rest.issues.removeLabel({
            ...issue,
            name: responseRequiredLabel
          })
        ]

        if (optionalFollowUpLabel) {
          tasks.push(
            this.ensureLabelExists(
              optionalFollowUpLabel,
              optionalFollowUpLabelColor || 'ffffff'
            ).then(() =>
              this.octokit.rest.issues.addLabels({
                ...issue,
                labels: [optionalFollowUpLabel]
              })
            )
          )
        }

        return Promise.all(tasks)
      })
  }
}
