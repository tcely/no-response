// src/issue-cache.ts

import { Repository, Issue, IssueDetails } from './types'
import { RepoMetadataCache } from './repo-metadata-cache'
import { GitHubApiClient } from './gh-api-client'

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
}
