import * as core from '@actions/core'
import * as github from '@actions/github'

const defaultCloseComment = `
This issue has been automatically closed because there has been no response
to our request for more information from the original author. With only the
information that is currently in the issue, we don't have enough information
to take action. Please reach out if you have or find the answers we need so
that we can investigate further.
`

interface Repo {
  owner: string
  repo: string
}

/**
 * Reads, interprets, and encapsulates the configuration for the current run of the Action.
 */
export default class Config {
  /** Comment to use when closing an issue, if any. */
  readonly closeComment: string | undefined

  /** How old an issue should be in days before it gets closed. */
  readonly daysUntilClose: number

  /** Repository to operate on. */
  readonly repo: Repo

  /** Color to use when creating the label, encoded as a hex string. */
  readonly responseRequiredColor: string

  /** Name of the label to use for issues that need more information or clarification. */
  readonly responseRequiredLabel: string

  /** An optional label to add when the `responseRequiredLabel` gets removed due to issue author's reply */
  readonly optionalFollowUpLabel?: string

  /** An optional label to add when the `responseRequiredLabel` gets removed due to issue author's reply */
  readonly optionalFollowUpLabelColor?: string

  readonly maxIssuesPerRun: number

  /** GitHub token to use when performing API operations. */
  readonly token: string

  constructor() {
    this.closeComment = this.valueOrDefault(core.getInput('closeComment'), defaultCloseComment)

    if (this.closeComment === 'false') {
      this.closeComment = undefined
    }

    this.daysUntilClose =
      parseInt(this.valueOrDefault(core.getInput('daysUntilClose'), '14'), 10) || 14

    this.repo = github.context.repo

    this.responseRequiredColor = this.valueOrDefault(
      core.getInput('responseRequiredColor'),
      'ffffff'
    )

    this.responseRequiredLabel = this.valueOrDefault(
      core.getInput('responseRequiredLabel'),
      'more-information-needed'
    )

    this.maxIssuesPerRun =
      parseInt(this.valueOrDefault(core.getInput('maxIssuesPerRun'), '50'), 10) || 50

    this.token = core.getInput('token', { required: true })

    this.optionalFollowUpLabel = core.getInput('optionalFollowUpLabel') || undefined

    this.optionalFollowUpLabelColor = core.getInput('optionalFollowUpLabelColor') || undefined
  }

  valueOrDefault(value: string, defaultValue: string): string {
    return value !== '' ? value : defaultValue
  }
}
