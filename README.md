# No response with add back a label

A GitHub Action that closes Issues where the author hasn't responded to a request for more information.

This is a fork of [MBilalShafi/no-response-add-label](https://github.com), which was originally forked from [lee-dohm/no-response](https://github.com/lee-dohm/no-response).
On top of the original functionality, this version adds an optional label back to the issue once the `responseRequiredLabel` is removed.

## Use

Recommended basic configuration:

```yaml
name: No Response

on:
  issues:
    types: [closed]
  issue_comment:
    types: [created]
  schedule:
    # Schedule for five minutes after the hour, every hour
    - cron: '5 * * * *'

jobs:
  noResponse:
    runs-on: ubuntu-latest
    steps:
      - uses: tcely/no-response@v0.1.0
        with:
          token: ${{ github.token }}
```

Example with custom configurations:

```yaml
name: No Response

# `issues`.`closed`, `issue_comment`.`created`, and `scheduled` event types are required for this Action
# to work properly.
on:
  issues:
    types: [closed]
  issue_comment:
    types: [created]
  schedule:
    # Schedule for thirty-five minutes after the hour, every hour
    - cron: '35 * * * *'

jobs:
  noResponse:
    runs-on: ubuntu-latest
    steps:
      - uses: tcely/no-response@v0.1.0
        with:
          token: ${{ github.token }}
          # Auto close after 7 days of inactivity
          daysUntilClose: 7
          # Label to track when a response is required
          responseRequiredLabel: "status: waiting for author"
          # Label to add once the author responds
          optionalFollowUpLabel: "status: review required"
          # Custom close comment
          closeComment: >
            This issue was closed due to lack of response. Please respond if you have the requested info!
```

### Inputs

See [`action.yml`](action.yml) for full defaults.


| Input | Description | Default |
| :--- | :--- | :--- |
| `token` | **Required**. GitHub token (e.g. `${{ github.token }}`) | N/A |
| `daysUntilClose` | Days to wait before closing an inactive issue. | `14` |
| `responseRequiredLabel` | Label indicating a response is needed. | `more-information-needed` |
| `responseRequiredColor` | Hex color for the response label. | `ffffff` |
| `optionalFollowUpLabel` | Label to add after the author responds. | `undefined` |
| `optionalFollowUpLabelColor` | Hex color for the follow-up label. | `ffffff` |
| `closeComment` | Comment to post on close. Set to `false` to disable. | (Standard message) |

## Action flow

### Scheduled
Searches for open issues with the `responseRequiredLabel` that were labeled more than `daysUntilClose` ago. It will post the `closeComment` and close the issue.

### `issue_comment` Event
If the original author comments on an issue marked with `responseRequiredLabel`:
1. Removes `responseRequiredLabel`.
2. Reopens the issue (if it was closed by someone else).
3. Adds `optionalFollowUpLabel` (if configured).

### `issues` Event
If the original author closes the issue, the action will remove the `optionalFollowUpLabel` to keep the issue state clean.

## License

[MIT](LICENSE.md)
