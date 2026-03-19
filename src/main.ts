// src/main.ts

import * as core from '@actions/core'
import Config from './config'
import NoResponse from './no-response'

async function run(): Promise<void> {
  try {
    const eventName = process.env['GITHUB_EVENT_NAME']
    core.debug(`Running action for event: ${eventName}`)

    const config = new Config()
    const noResponse = new NoResponse(config)

    if (eventName === 'schedule' || eventName === 'workflow_dispatch') {
      await noResponse.sweep()
    } else if (eventName === 'issue_comment') {
      // React to comments on issues
      // When it was the author, we must update the issue
      await noResponse.handleAuthorCommented()
    } else if (eventName === 'issues') {
      // React to issue events
      // Specifically removing the optional label,
      // after the issue was closed and removing the
      // author from the assigned users
      const action = process.env['GITHUB_EVENT_ACTION']

      if ('labeled' === action) {
        await noResponse.handleLabeled()
      } else if ('closed' === action) {
        await noResponse.handleClosedIssue()
      }
    } else {
      core.info(`This action was skipped. Unrecognized event: ${eventName}"`)
    }
  } catch (error: any) {
    // Graceful failure reporting for the GitHub UI
    core.setFailed(error.message)
  }
}

// Entry point with top-level await support
await run()
