// src/issue-cache.ts

import { GitHubApiClient } from './gh-api-client'
import { findLastClosedEvent } from './logic-helpers'
import { RepoMetadataCache } from './repo-metadata-cache'
import { Issue, IssueDetails, Repository, TimelineEvent } from './types'

export class IssueCache {
  // Key format: "repoNodeId:issueNumber"
  private cache = new Map<string, IssueDetails>()

  constructor(
    private client: GitHubApiClient,
    private repoMetadata: RepoMetadataCache
  ) {}

  /**
   * Internal helper to generate a composite key using the repo's node_id.
   * Lazily resolves the node_id via RepoMetadataCache if it's missing.
   */
  private async makeKey(repo: Repository, number: number): Promise<string> {
    const repoId = await this.repoMetadata.getRepoId(repo)
    return `${repoId}:${number}`
  }

  /**
   * Retrieves an issue from the cache.
   * Returns undefined if the issue has not been cached yet.
   */
  async get(repo: Repository, number: number): Promise<IssueDetails | undefined> {
    const key = await this.makeKey(repo, number)
    return this.cache.get(key)
  }

  /**
   * Caches or updates an issue's details manually.
   */
  async set(repo: Repository, details: IssueDetails): Promise<void> {
    const key = await this.makeKey(repo, details.number)
    this.cache.set(key, details)
  }

  /**
   * Fetches an issue's details using repository and number.
   * Checks cache first; falls back to API on miss.
   */
  async fetch(repo: Repository, number: number): Promise<IssueDetails> {
    const cached = await this.get(repo, number)

    if (undefined !== cached && undefined !== cached.labels) {
      return cached
    }

    const details = await this.client.fetchIssueByNumber(repo, number)

    await this.set(repo, details)
    return details
  }

  /**
   * "Upgrades" a base Issue into full IssueDetails.
   */
  async fetchDetails(issue: Issue): Promise<IssueDetails> {
    return await this.fetch(issue.repo, issue.number)
  }

  /**
   * If an issue is closed but closure metadata is missing/suspicious, fetch timeline
   * and seed closed_by (and optionally closed_at) into IssueDetails + cache.
   */
  async ensureClosureDetails(
    details: IssueDetails
  ): Promise<{ details: IssueDetails; timeline: TimelineEvent[] | undefined }> {
    if ('closed' !== details.state) {
      return { details, timeline: undefined }
    }

    const missingCloser = undefined === details.closed_by?.login
    const suspiciousCloser = 'unknown' === details.closed_by?.login
    const missingClosedAt = undefined === details.closed_at

    // Only hit the timeline endpoint when we actually need it
    if (!(missingCloser || suspiciousCloser || missingClosedAt)) {
      return { details, timeline: undefined }
    }

    const timeline = await this.client.fetchTimeline(details)
    const lastClosed = findLastClosedEvent(timeline)
    if (lastClosed === undefined) {
      return { details, timeline }
    }

    // Patch what we can from timeline
    if (missingCloser || suspiciousCloser) details.closed_by = { login: lastClosed.actor.login }

    // Optional: timeline "closed" created_at can be used if REST closed_at is missing
    if (missingClosedAt) details.closed_at = lastClosed.created_at

    await this.set(details.repo, details)
    return { details, timeline }
  }
}
