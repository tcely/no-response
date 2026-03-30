# Project Improvements & Refactors

## src/no-response.ts (Orchestrator)

- [ ] **Summary Output**: Use `core.summary` to generate a high-level report (scanned, closed, and reopened counts) on the GitHub Action run page.
- [ ] **Dry Run Mode**: Support a `dryRun` configuration that logs intended changes without performing actual API writes.

## src/config.ts

- [x] **Optional Token Input**: Modify the constructor to fallback from `core.getInput('token')` to standard environment variables like `GITHUB_TOKEN`. The token is still mandatory for API calls, but providing it via `with:` should become optional.

## Testing (test/config.test.ts)

- [ ] **New Input Coverage**: Add tests for `optionalFollowUpLabel` and `optionalFollowUpLabelColor` to ensure they are correctly captured from the environment.
- [ ] **Numeric Edge Cases**: Verify how `Config` handles non-numeric strings for `daysUntilClose`.
- [ ] **Grace Period Test**: Add a test case to verify author comments at 14m (stay closed) vs 16m (reopen).
- [ ] **Integration Test**: Implement a "live" test against a dummy repository to verify the full flow from `IssueCache` to `GitHubApiClient`.

## Documentation

- [x] **Token Documentation Update**: After implementing the optional token logic in `src/config.ts`, update the README "Inputs" table to reflect that the token is no longer strictly required via `with:`.
- [ ] **README Update**: Document all new inputs (`dryRun`).
- [ ] **Migration Note**: Add a section explaining the transition from the legacy logic to this refactored version.

