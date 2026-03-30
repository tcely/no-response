// src/gh-api-helpers.ts

import {
  Issue,
  IssueDetails,
  Label,
  Repository,
  RestIssue,
  RestLabel,
  TimelineEvent
} from './types'

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
  if (!dateStr) return undefined
  const d = new Date(dateStr)
  return Number.isNaN(d.getTime()) ? undefined : d
}

/**
 * Maps a raw GitHub API response to a clean IssueDetails object.
 */
export function mapRestIssue(raw: any, repo: Repository): IssueDetails {
  const closedAt = toDate(raw.closed_at)
  const date_closedAt = closedAt ?? new Date()

  const openIssue = {
    number: raw.number,
    repo,
    state: 'open' as 'open',
    user: { login: raw.user?.login || 'unknown' },
    labels: (raw.labels || []).map((l: any) => ({
      name: 'string' === typeof l ? l : l.name!,
      repo,
      color: ('string' === typeof l ? '' : l.color) || 'ffffff'
    })),
    closed_by: undefined,
    closed_at: undefined
  }

  if ('closed' === raw.state) {
    return {
      ...openIssue,
      state: 'closed' as 'closed',
      closed_by: raw.closed_by ? { login: raw.closed_by.login } : undefined,
      closed_at: date_closedAt
    }
  } else {
    return openIssue
  }
}

/**
 * Maps raw timeline data to our strict TimelineEvent with Date objects.
 */
export function mapTimelineEvent(raw: any): TimelineEvent {
  return {
    event: String(raw.event || ''),
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
