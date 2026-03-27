# Project Improvements & Refactors

## action.yml (Composite Action)

- [ ] **Simplify Run Step**: Remove the `env:` block from the `Run Action` step. GitHub automatically exports all `inputs` as `INPUT_<UPPERCASE_NAME>` environment variables.

## CI/CD Logic (.github/workflows/test.yaml)

- [x] **Enhanced Binary Smoke Test**: Verified binary functionality and reported the embedded Bun version without fragile string matching.

## src/types.ts & GitHubApiClient

- [x] **Timestamp Support**: Added `closed_at?: Date` to the `IssueDetails` interface.
- [x] **Data Mapping**: Updated mapping helpers and client to handle `closed_at` from the GitHub API response.
- [x] **Assignment Methods**: Added `addAssignees` and `removeAssignees` (with `ByNumber` variants) to `GitHubApiClient` using `RestIssue` spread and Yoda-style guards.

## src/no-response.ts (Orchestrator)

- [x] **Semantic Label Helpers**: Implemented private helpers `clearWorkflowLabels` and `transitionToFollowUp`.
- [x] **Method Sync**: Refactored handlers to use semantic helpers, Yoda-style comparisons, and `!isAuthorClosed` guards.
- [x] **Consistency & Logic**: 
    - Use `this.repository.owner` and `this.repository.name` for all log and search strings.
    - Implement the 15-minute grace period using `1000 * 60 * 15 // minutes` and **Yoda style** (`gracePeriodMs < commentedAt - closedAt`).
    - Place `!isAuthorClosed` first in conditional checks.
- [x] **Search Implementation**: Use `this.client.octokit.paginate` directly in search methods.
- [x] **Author Assignment Logic**:
    - Implement `handleLabeled` to assign author on `responseRequiredLabel`.
    - Update `transitionToFollowUp` to unassign author only if the required label was present.
- [x] **API Resilience**: Wrap the `sweep` batch processing in a `try/catch` block so failures on specific issues (e.g., 403 on locked issues) don't halt the entire run.
- [x] **Rate Limit Protection**: Add a small delay (e.g., `1000 // ms`) between batch writes in the `sweep` to avoid triggering GitHub's secondary rate limits.
- [ ] **Summary Output**: Use `core.summary` to generate a high-level report (scanned, closed, and reopened counts) on the GitHub Action run page.
- [ ] **Dry Run Mode**: Support a `dryRun` configuration that logs intended changes without performing actual API writes.

## src/config.ts

- [x] **Readonly Properties**: Marked all class properties as `readonly` for immutability.
- [x] **Safe Parsing**: Implemented `parseInt(..., 10) || default` fallbacks to handle invalid or missing numeric inputs.
- [x] **Input Validation**: Ensure `daysUntilClose` is a positive integer. If the parsed value is zero or less, fallback to the default (14).
- [ ] **Optional Token Input**: Modify the constructor to fallback from `core.getInput('token')` to standard environment variables like `GITHUB_TOKEN`. The token is still mandatory for API calls, but providing it via `with:` should become optional.

## Testing (test/config.test.ts)

- [ ] **New Input Coverage**: Add tests for `optionalFollowUpLabel` and `optionalFollowUpLabelColor` to ensure they are correctly captured from the environment.
- [ ] **Numeric Edge Cases**: Verify how `Config` handles non-numeric strings for `daysUntilClose`.
- [ ] **Grace Period Test**: Add a test case to verify author comments at 14m (stay closed) vs 16m (reopen).
- [ ] **Integration Test**: Implement a "live" test against a dummy repository to verify the full flow from `IssueCache` to `GitHubApiClient`.

## Documentation

- [x] **README Update**: Documented auto-assignment logic, 15-minute grace period, and mandatory quoting for disabling comments.
- [ ] **Token Documentation Update**: After implementing the optional token logic in `src/config.ts`, update the README "Inputs" table to reflect that the token is no longer strictly required via `with:`.
- [ ] **README Update**: Document all new inputs (`dryRun`).
- [ ] **Migration Note**: Add a section explaining the transition from the legacy logic to this refactored version.
