// src/gh-api-client.ts

import * as github from '@actions/github'
import { mapRestIssue, mapTimelineEvent, toRestIssue, toRestLabel } from './gh-api-helpers'
import {
  Issue,
  IssueDetails,
  Label,
  Repository,
  RestIssue,
  RestLabel,
  TimelineEvent
} from './types'

export class GitHubApiClient {
  private _octokit: ReturnType<typeof github.getOctokit>

  constructor(token: string) {
    this._octokit = github.getOctokit(token)
  }

  private repoParams(repo: Repository) {
    return { owner: repo.owner, repo: repo.name }
  }

  /**
   * Provides direct access to the Octokit instance for custom operations like searching.
   */
  public get octokit(): ReturnType<typeof github.getOctokit> {
    return this._octokit
  }

  /**
   * Fetches core repository IDs.
   */
  async fetchRepoMetadata(repo: { owner: string; name: string }): Promise<Repository> {
    const { data } = await this.octokit.rest.repos.get({
      owner: repo.owner,
      repo: repo.name
    })

    return {
      name: data.name,
      owner: data.owner.login,
      id: data.id,
      node_id: data.node_id,
      owner_id: data.owner.id
    }
  }

  /**
   * Fetches all labels for a repository.
   */
  async fetchLabels(repo: Repository): Promise<Label[]> {
    const labels = await this.octokit.paginate(this.octokit.rest.issues.listLabelsForRepo, {
      ...this.repoParams(repo),
      per_page: 100
    })

    return labels.map((l) => ({
      name: l.name,
      repo,
      color: l.color,
      id: l.id,
      node_id: l.node_id,
      default: l.default
    }))
  }

  /**
   * Fetches the full details of an issue.
   */
  async fetchIssueByNumber(repo: Repository, issue_number: number): Promise<IssueDetails> {
    const { data } = await this.octokit.rest.issues.get({
      ...this.repoParams(repo),
      issue_number
    })

    return mapRestIssue(data, repo)
  }

  async fetchIssue(issue: Issue): Promise<IssueDetails> {
    return await this.fetchIssueByNumber(issue.repo, issue.number)
  }

  /**
   * Fetches all timeline events for an issue using its repository and number (RestIssue).
   */
  async fetchTimelineByNumber(issue: RestIssue): Promise<TimelineEvent[]> {
    const events = await this.octokit.paginate(this.octokit.rest.issues.listEventsForTimeline, {
      ...issue,
      per_page: 100
    })
    return events.map(mapTimelineEvent)
  }

  /**
   * Fetches all timeline events for an issue using the Issue object.
   */
  async fetchTimeline(issue: Issue): Promise<TimelineEvent[]> {
    return await this.fetchTimelineByNumber(toRestIssue(issue))
  }

  /**
   * Creates a label in a repository using its identity (RestLabel).
   */
  async createLabelByRepo(label: RestLabel, color: string): Promise<Label> {
    const { data } = await this.octokit.rest.issues.createLabel({
      ...label,
      color
    })

    return {
      name: data.name,
      repo: { owner: label.owner, name: label.repo },
      color: data.color,
      id: data.id,
      node_id: data.node_id,
      default: data.default
    }
  }

  /**
   * Creates a label in a repository using a Label object.
   */
  async createLabel(label: Label): Promise<Label> {
    return await this.createLabelByRepo(toRestLabel(label), label.color)
  }

  /**
   * Adds a comment to an issue using its repository and number (RestIssue).
   */
  async createCommentByNumber(issue: RestIssue, body: string): Promise<void> {
    await this.octokit.rest.issues.createComment({
      ...issue,
      body
    })
  }

  /**
   * Adds a comment to an issue using the Issue object.
   */
  async createComment(issue: Issue, body: string): Promise<void> {
    await this.createCommentByNumber(toRestIssue(issue), body)
  }

  /**
   * Updates an issue's state using its repository and number (RestIssue).
   * Returns the updated IssueDetails.
   */
  async updateIssueStateByNumber(
    issue: RestIssue,
    state: 'open' | 'closed',
    state_reason?: 'completed' | 'not_planned' | 'reopened'
  ): Promise<IssueDetails> {
    const { data } = await this.octokit.rest.issues.update({
      ...issue,
      state,
      state_reason
    })

    return mapRestIssue(data, { owner: issue.owner, name: issue.repo })
  }

  /**
   * Updates an issue's state using the Issue object's current state.
   * Returns the updated IssueDetails.
   */
  async updateIssueState(
    issue: Issue,
    state_reason?: 'completed' | 'not_planned' | 'reopened'
  ): Promise<IssueDetails> {
    return await this.updateIssueStateByNumber(toRestIssue(issue), issue.state, state_reason)
  }

  /**
   * Adds specified labels to an issue and returns the full updated list of labels.
   */
  async addLabels(issue: IssueDetails, labelsToAdd: Label[]): Promise<Label[]> {
    if (1 > labelsToAdd.length) return issue.labels

    const restIssue = toRestIssue(issue)
    const newNames = labelsToAdd.map((l) => l.name)

    const { data } = await this.octokit.rest.issues.addLabels({
      ...restIssue,
      labels: newNames
    })

    return data.map((l) => ({
      name: l.name,
      repo: issue.repo,
      color: l.color || 'ffffff',
      id: l.id,
      node_id: l.node_id
    }))
  }

  /**
   * Removes specified labels from an issue and returns the updated set of labels.
   * Uses 'setLabels' for an atomic update.
   */
  async removeLabels(issue: IssueDetails, labelsToRemove: Label[]): Promise<Label[]> {
    if (1 > labelsToRemove.length) return issue.labels

    const restIssue = toRestIssue(issue)
    const toRemoveNames = new Set(labelsToRemove.map((l) => l.name))

    const refreshed = await this.fetchIssue(issue)
    const remainingLabels = refreshed.labels.filter((l) => !toRemoveNames.has(l.name))
    const remainingNames = remainingLabels.map((l) => l.name)

    await this.octokit.rest.issues.setLabels({
      ...restIssue,
      labels: remainingNames
    })

    return remainingLabels
  }

  /**
   * Assigns users to an issue using its repository and number (RestIssue).
   */
  async addAssigneesByNumber(issue: RestIssue, assignees: string[]): Promise<void> {
    if (1 > assignees.length) return

    await this.octokit.rest.issues.addAssignees({
      ...issue,
      assignees
    })
  }

  /**
   * Assigns users to an issue using the Issue object.
   */
  async addAssignees(issue: Issue, assignees: string[]): Promise<void> {
    return await this.addAssigneesByNumber(toRestIssue(issue), assignees)
  }

  /**
   * Removes assignees from an issue using its repository and number (RestIssue).
   */
  async removeAssigneesByNumber(issue: RestIssue, assignees: string[]): Promise<void> {
    if (1 > assignees.length) return

    await this.octokit.rest.issues.removeAssignees({
      ...issue,
      assignees
    })
  }

  /**
   * Removes assignees from an issue using the Issue object.
   */
  async removeAssignees(issue: Issue, assignees: string[]): Promise<void> {
    return await this.removeAssigneesByNumber(toRestIssue(issue), assignees)
  }
}
