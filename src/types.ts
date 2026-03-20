// src/types.ts

/**
 * A standalone, flat representation of a GitHub Repository.
 */
export interface Repository {
  name: string // The repo name (e.g. "my-repo")
  owner: string // The owner (e.g. "my-org")
  id?: number // Numeric repo ID
  node_id?: string // Global immutable ID
  owner_id?: number // Numeric owner ID
}

export interface Label {
  name: string
  repo: Repository
  color: string
  id?: number
  node_id?: string
  default?: boolean
}

export interface RestIssue {
  owner: string
  repo: string
  issue_number: number
}

export interface RestLabel {
  owner: string
  repo: string
  name: string
}

export interface TimelineEvent {
  event: string
  created_at: Date
  actor: { login: string }
  label?: { name: string }
}

export interface Issue {
  number: number
  repo: Repository
  state: 'open' | 'closed'
  user: { login: string }
}

export interface IssueDetailsBase extends Issue {
  labels: Label[]
}

export interface OpenIssueDetails extends IssueDetailsBase {
  state: 'open'
  closed_at?: undefined
  closed_by?: undefined
}

export interface ClosedIssueDetails extends IssueDetailsBase {
  state: 'closed'
  closed_at: Date
  closed_by?: { login: string }
}

export type IssueDetails = OpenIssueDetails | ClosedIssueDetails
