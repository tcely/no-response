// src/logic-helpers.ts

import { IssueDetails, Label, TimelineEvent } from './types'
import { hasUser, isClosedIssue } from './gh-api-helpers'

/**
 * Returns true if the issue is currently tagged with the specified Label.
 */
export function isLabeled(issue: IssueDetails, label: Label): boolean {
  return issue.labels.some(l => label.name === l.name)
}

/**
 * Logic to check if an issue was closed by its original author.
 * Fails fast if the issue isn't closed.
 */
export function checkClosedByAuthor(issue: IssueDetails): boolean {
  if ("closed" !== issue.state) return false
  
  if (isClosedIssue(issue) && hasUser(issue)) {
    return issue.user.login === issue.closed_by.login
  }
  return false
}

/**
 * Checks if a timeline event matches the "labeled" event for our specific label.
 */
export function isTargetLabeledEvent(event: TimelineEvent, label: Label): boolean {
  return "labeled" === event.event && label.name === event.label?.name
}

/**
 * Calculates the date threshold for closing issues based on config.
 */
export function getExpiryDate(days: number): Date {
  const ttl = 1000 * 60 * 60 * 24 * days
  return new Date(Date.now() - ttl)
}
