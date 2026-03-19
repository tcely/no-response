// src/repo-metadata-cache.ts

import * as core from '@actions/core'
import { Repository, Label } from './types'
import { GitHubApiClient } from './gh-api-client'

export class RepoMetadataCache {
  // Bridge: "owner/name" -> node_id (Used only for the first lookup)
  private idBridge = new Map<string, string>()
  
  // Data: node_id -> Label[]
  private labelsCache = new Map<string, Label[]>()

  // Cache for the fully "hydrated" Repository objects
  private fullRepoCache = new Map<string, Repository>()

  constructor(private client: GitHubApiClient) {}

  /**
   * Generates a consistent key for looking up a repository's unique ID.
   */
  private makeBridgeKey(repo: { owner: string; name: string }): string {
    return `${repo.owner}/${repo.name}`.toLowerCase()
  }

  /**
   * Performs exactly TWO parallel API calls to fully hydrate a repository.
   * This is the single source of truth for repository synchronization.
   */
  private async syncRepoMetadata(repo: { owner: string; name: string }): Promise<{ repo: Repository; labels: Label[] }> {
    const bridgeKey = this.makeBridgeKey(repo)
    core.debug(`Syncing all metadata for ${bridgeKey}`)

    // 1. Fetch the full repo identity first (node_id, id, etc.)
    const fullRepo = await this.client.fetchRepoMetadata(repo)

    // 2. Use the complete object to fetch labels (ensures strict type safety)
    const labels = await this.client.fetchLabels(fullRepo)

    // 3. Populate all caches
    this.idBridge.set(bridgeKey, fullRepo.node_id!)
    this.labelsCache.set(fullRepo.node_id!, labels)
    this.fullRepoCache.set(fullRepo.node_id!, fullRepo)

    return { repo: fullRepo, labels }
  }

  /**
   * Returns a fully filled-out Repository interface.
   * Zero API calls if already synced.
   */
  async getInitializedRepository(baseRepo: { owner: string; name: string }): Promise<Repository> {
    const bridgeKey = this.makeBridgeKey(baseRepo)
    const nodeId = this.idBridge.get(bridgeKey)

    if (undefined !== nodeId) {
      const cached = this.fullRepoCache.get(nodeId)
      if (undefined !== cached) return cached
    }

    const { repo } = await this.syncRepoMetadata(baseRepo)
    return repo
  }

  /**
   * Resolves the immutable node_id for a Repository.
   */
  async getRepoId(repo: Repository): Promise<string> {
    if (undefined !== repo.node_id) return repo.node_id

    const bridgeKey = this.makeBridgeKey(repo)
    const cachedId = this.idBridge.get(bridgeKey)
    if (undefined !== cachedId) return cachedId

    const { repo: fullRepo } = await this.syncRepoMetadata(repo)
    return fullRepo.node_id!
  }

  /**
   * Retrieves labels for a Repository, populating the cache if missing.
   */
  async getLabels(repo: Repository): Promise<Label[]> {
    const nodeId = await this.getRepoId(repo)
    const cachedLabels = this.labelsCache.get(nodeId)
    if (undefined !== cachedLabels) return cachedLabels

    const { labels } = await this.syncRepoMetadata(repo)
    return labels
  }

  /**
   * Ensures a label exists. Fails fast if cached, otherwise creates on GitHub.
   * Patches the local cache with the result and returns the full list.
   */
  async createLabel(label: Label): Promise<Label[]> {
    const repository = await this.getInitializedRepository(label.repo)
    const currentLabels = await this.getLabels(repository)
    if (currentLabels.some(l => l.name === label.name)) {
      return currentLabels
    }

    const nodeId = await this.getRepoId(repository)

    try {
      const createdLabel = await this.client.createLabel(label)
      const updatedList = [...currentLabels, createdLabel]
      this.labelsCache.set(nodeId, updatedList)
      return await this.getLabels(repository)
    } catch (error: any) {
      // If label exists on server but not in our cache, re-sync to get it.
      if (error.errors?.some((e: any) => "already_exists" === e.code)) {
        const { labels } = await this.syncRepoMetadata(repository)
        return labels
      }
      throw error
    }
  }
}
