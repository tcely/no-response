# Issue Management: Response & Assignment

Automate the lifecycle of issues requiring author feedback. This GitHub Action
closes stale issues, manages author assignments, and transitions labels based on
user response.

## History

The lineage of this Action began with
[lee-dohm/no-response](https://github.com/lee-dohm/no-response), which provided
the core logic for closing issues that lacked author feedback. This was later
expanded by
[MBilalShafi/no-response-add-label](https://github.com/MBilalShafi/no-response-add-label)
to include the ability to add a specific label back to an issue once an author
provided their response.

This current version refines those features further by integrating automated
author assignment, a 15-minute grace period for self-closed issues, and a robust
scheduling safety net to ensure no author responses are overlooked.

## License

[MIT](LICENSE.md)

## Features

- **Automated Author Assignment**:  
  Automatically assigns the issue to the original author as soon as the `responseRequiredLabel` is applied.
- **Post-Reopen Unassignment**:  
  Removes the author as an assignee only after the issue has been successfully reopened in response to their feedback.
- **Label Transitions**:  
  Clears the "response required" status and optionally applies a follow-up label (e.g., `review required`) when the author comments.
- **Self-Close Grace Period**:  
  Implements a 15-minute grace period for issues closed by the author.  
  This action will only reopen them if a comment arrives after this window, preventing "thank you" comments from triggering reopens.
- **Scheduled Safety Net**:  
  In addition to event-based triggers, a scheduled run scans for missed responses, ensuring that even if a webhook is dropped, author replies are eventually processed.
- **Configurable Batching**:  
  Includes a `maxIssuesPerRun` setting to prevent hitting secondary rate limits when managing repositories with high issue volume.

> [!NOTE]
> This fork also makes use of GitHub's [immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases), so pinning by commit hash is not required.

## Getting Started

To begin using this Action, create a workflow file (e.g., `.github/workflows/no-response.yml`) with the following configuration. This minimal setup handles
the hourly sweep and event-based response triggers.

```yml
name: No Response

on:
  issues:
    types: [closed, labeled]
  issue_comment:
    types: [created]
  schedule:
    # Schedule for five minutes after the hour, every hour
    - cron: '5 * * * *'

jobs:
  noResponse:
    runs-on: ubuntu-latest
    permissions:
      # Required for labels and assignees
      issues: write
    steps:
      - uses: tcely/no-response@v0.1.0
        with:
          token: ${{ github.token }}
```

### Advanced Configuration

For more control, you can customize the timing, labels, and closing messages:

```yml
name: No Response

on:
  workflow_dispatch:
  issues:
    types: [closed, labeled]
  issue_comment:
    types: [created]
  schedule:
    # Schedule for thirty-five minutes after the hour, every hour
    - cron: '35 * * * *'

jobs:
  noResponse:
    runs-on: ubuntu-latest
    permissions:
      # Required for labels and assignees
      issues: write
    steps:
      - uses: tcely/no-response@v0.1.0
        with:
          token: ${{ github.token }}
          daysUntilClose: 7
          responseRequiredLabel: 'waiting for author'
          optionalFollowUpLabel: 'review required'
          maxIssuesPerRun: 100
          # Optional custom close comment
          closeComment: >
            This issue was closed due to lack of response. Please respond if you
            have the requested info!
```

### Inputs

See [`action.yml`](action.yml) for full defaults.

| Input                        | Description                                           | Default                              |
| :--------------------------- | :---------------------------------------------------- | :----------------------------------- |
| `token`                      | **Required**. GitHub token (e.g. `${{ token }}`)      | N/A                                  |
| `daysUntilClose`             | Days to wait before closing an inactive issue.        | `14`                                 |
| `responseRequiredLabel`      | Label indicating a response is needed.                | `more-information-needed`            |
| `responseRequiredColor`      | Hex color for the response label.                     | `ffffff`                             |
| `optionalFollowUpLabel`      | Label to add after the author responds.               | `undefined`                          |
| `optionalFollowUpLabelColor` | Hex color for the follow-up label.                    | `ffffff`                             |
| `maxIssuesPerRun`            | Maximum number of issues to close per scheduled run.  | `50`                                 |
| `closeComment`               | Optional comment on close. Set to `false` to disable. | (Standard message)[^default-comment] |

[^default-comment]: Defined in [src/config.ts](src/config.ts):
    > This issue has been automatically closed because there has been no response to our request for more information from the original author.
    > With only the information that is currently in the issue, we don't have enough information to take action.
    > Please reach out if you have or find the answers we need so that we can investigate further.

### Disabling Automated Comments

If you want the action to close issues silently without posting a comment, set the `closeComment` input explicitly to the string `'false'`.

> [!CAUTION]
> The single quotes around `'false'` are mandatory.
> 
> Without them, the GitHub Actions YAML parser will interpret the value as a boolean instead of the literal string required by the configuration logic.

```yml
    steps:
      - uses: tcely/no-response@v0.1.0
        with:
          token: ${{ github.token }}
          closeComment: 'false'
```

## Action flow

### Scheduled

When manually triggered or using a scheduled trigger, this action performs these operations:

1. **Reopening Missed Responses**:  
   Scans for closed issues still carrying the `responseRequiredLabel` where the author responded after closure.  
   This serves as a safety net for any `issue_comment` triggers missed due to GitHub outages or concurrent event failures.
2. **Closing Stale Issues**:  
   Searches for open issues with the `responseRequiredLabel` that were labeled more than `daysUntilClose` ago.  
   Unless explicitly disabled via `closeComment: 'false'`, the action posts the configured comment before closing the issue.

### `issues` Event

The following actions are processed for issues events:

1. **Labeled**:  
   When the `responseRequiredLabel` is added, this action automatically **assigns the issue to its author**.
2. **Closed**:  
   If the original author closes the issue, this action removes both workflow labels to keep the state clean.

### `issue_comment` Event

If the original author comments on an issue marked with `responseRequiredLabel` these steps are taken by this action:

1. Reopens the issue (if it was closed by someone other than the author).
2. Removes `responseRequiredLabel`.
3. **Unassigns the author** (Triggered specifically after the successful reopen transition and label removal).
4. Optionally, adds `optionalFollowUpLabel` (if configured).

> [!NOTE]
> If the author previously closed the issue themselves, it will only be
> reopened if the comment occurs after a **15-minute grace period**.
