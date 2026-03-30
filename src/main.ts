// src/main.ts

import * as core from '@actions/core'
import * as github from '@actions/github'
import Config from './config'
import NoResponse from './no-response'

async function run(): Promise<void> {
  try {
    const eventName = github.context.eventName
    const eventType =
      'string' === typeof github.context.payload.action ? github.context.payload.action : undefined
    core.info(`Running action for: name=${eventName} type=${eventType ?? ''}`)

    const config = new Config()
    const noResponse = new NoResponse(config)

    if ('schedule' === eventName || 'workflow_dispatch' === eventName) {
      await noResponse.sweep()
    } else if ('issue_comment' === eventName) {
      // React to comments on issues
      // When it was the author, we must update the issue
      if ('created' === eventType) {
        await noResponse.handleAuthorCommented()
      } else {
        core.info(`Unrecognized issue_comment type: ${eventType}`)
      }
    } else if ('issues' === eventName) {
      // React to issue events
      // Specifically removing the optional label,
      // after the issue was closed and removing the
      // author from the assigned users

      if ('labeled' === eventType) {
        await noResponse.handleLabeled()
      } else if ('closed' === eventType) {
        await noResponse.handleClosedIssueVerbose()
      } else {
        core.info(`Unrecognized issues type: ${eventType}`)
      }
    } else {
      core.info(`This action was skipped. Unrecognized event: ${eventName}`)
    }
  } catch (error: any) {
    // Graceful failure reporting for the GitHub UI
    core.setFailed(error.message)
  }
}

// Entry point with top-level await support
await run()
