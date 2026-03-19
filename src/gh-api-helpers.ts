// src/gh-api-helpers.ts

import { Issue, RestIssue, Label, RestLabel, TimelineEvent } from './types'

/**
 * Transforms an Issue into a clean RestIssue for API calls.
 */
export function toRestIssue(issue: Issue): RestIssue {
  return {
    owner: issue.repo.owner,
    repo: issue.repo.name,
    issue_number: issue.number
  }
}

/**
 * Transforms a Label into a clean RestLabel for API calls.
 */
export function toRestLabel(label: Label): RestLabel {
  return {
    owner: label.repo.owner,
    repo: label.repo.name,
    name: label.name
  }
}

/**
 * Safely converts an optional ISO 8601 string to a Date object.
 */
export function toDate(dateStr?: string | null): Date | undefined {
  return dateStr ? new Date(dateStr) : undefined
}

/**
 * Maps a raw GitHub API response to a clean IssueDetails object.
 */
export function mapRestIssue(raw: any, repo: Repository): IssueDetails {
  return {
    number: raw.number,
    repo,
    state: raw.state as 'open' | 'closed',
    user: { login: raw.user?.login || 'unknown' },
    labels: (raw.labels || []).map((l: any) => ({
      name: 'string' === typeof l ? l : l.name!,
      repo,
      color: ('string' === typeof l ? '' : l.color) || 'ffffff'
    })),
    closed_by: raw.closed_by ? { login: raw.closed_by.login } : undefined,
    closed_at: toDate(raw.closed_at)
  }
}

/**
 * Maps raw timeline data to our strict TimelineEvent with Date objects.
 */
export function mapTimelineEvent(raw: any): TimelineEvent {
  return {
    event: raw.event,
    created_at: toDate(raw.created_at) ?? new Date(0),
    actor: { login: raw.actor?.login || 'unknown' },
    label: raw.label ? { name: raw.label.name } : undefined
  }
}

/**
 * Type guard to ensure an issue has a valid author login.
 */
export function hasUser<T extends Issue>(issue: T): issue is T & { user: { login: string } } {
  return !!issue.user && typeof issue.user.login === 'string'
}

/**
 * Type guard to ensure a closed issue has a closer login.
 */
export function isClosedIssue(
  issue: any
): issue is { state: 'closed'; closed_by: { login: string } } {
  return issue.state === 'closed' && !!issue.closed_by?.login
}
