# Workflow runners and releases

CI, benchmarks, and repository automation run on Depot. Depot's managed-runner GitHub App serves these jobs through the organization's Default runner group, which must allow public repositories for Veto. Existing `actions/cache` and setup-action caches use Depot's cache integration automatically.

Most jobs use `depot-ubuntu-24.04-4` (Ubuntu 24.04, four CPUs). `runner-guard.yml` runs on `depot-ubuntu-24.04` for pull requests that change `.github/workflows/**` and fails when a job `runs-on` is not `depot-*` or `self-hosted`.

The npm publishing jobs in `release.yml` (`release` and `release-manual`) stay on pinned GitHub-hosted `ubuntu-24.04`. npm sets the provenance builder id from `RUNNER_ENVIRONMENT` and the registry accepts only `github-hosted`. Depot runners report `self-hosted`, so publishing there fails provenance verification. The runner guard allowlists exactly those two job names with `ubuntu-24.04`. Any other `release.yml` job can use a Depot runner.

Publishing keeps its OIDC `id-token: write` permission and `NPM_CONFIG_PROVENANCE=true`.

Each public npm package must trust GitHub owner `PlawIO`, repository `veto`, workflow `release.yml`, with direct `npm publish` allowed and no environment name. Both release paths use Changesets, which calls npm to authenticate with OIDC and skips versions already published. Do not add `NPM_TOKEN` or `NODE_AUTH_TOKEN`; a stale token can prevent OIDC authentication.

GitHub manages CodeQL through repository settings, outside these workflow files. Its default setup uses the same `depot-ubuntu-24.04-4` label; keep `depot-ubuntu-24.04` and `depot-ubuntu-24.04-4` configured in both GitHub and `.github/actionlint.yaml`.

## Release approval

Changesets creates the version PR and enables auto-merge. A maintainer must approve its GitHub Actions runs and review the PR; GitHub does not permit the bot to approve its own PR. Master requires `Build & Test` and `Validate changeset presence`, with up-to-date branches and one approving review.

After the version PR merges, npm publishes missing versions. Python publication runs whenever no changesets remain, independently of whether npm published a package. PyPI's `skip-existing` option makes retries safe for versions already uploaded. A manual forced release runs only the manual publishing job.

## Validation

Run `actionlint` and `pnpm check:release-supply-chain` before pushing workflow changes. Verify the PR's jobs actually run on Depot, as a valid runner label alone does not prove runner access.

References: [Depot runner types](https://depot.dev/docs/github-actions/runner-types), [public repository access](https://depot.dev/docs/github-actions/troubleshooting), [npm provenance](https://docs.npmjs.com/generating-provenance-statements/).
