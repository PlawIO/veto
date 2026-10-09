# Workflow runners and releases

CI, benchmarks, and repository automation use `depot-ubuntu-24.04-4` (Ubuntu 24.04, four CPUs). Depot's managed-runner GitHub App serves these jobs through the organization's Default runner group, which must allow public repositories for Veto. Existing `actions/cache` and setup-action caches use Depot's cache integration automatically.

The two publishing jobs in `release.yml` stay on GitHub-hosted `ubuntu-latest` because npm provenance requires a GitHub-hosted runner. Keep their OIDC permissions and provenance settings when changing release infrastructure.

GitHub manages CodeQL through repository settings, outside these workflow files. Its default setup uses the same `depot-ubuntu-24.04-4` label; keep that label configured in both GitHub and `.github/actionlint.yaml`.

## Release approval

Changesets creates the version PR and enables auto-merge. A maintainer must approve its GitHub Actions runs and review the PR; GitHub does not permit the bot to approve its own PR. Master requires `Build & Test` and `Validate changeset presence`, with up-to-date branches and one approving review.

After the version PR merges, npm publishes missing versions. Python publication runs whenever no changesets remain, independently of whether npm published a package. PyPI's `skip-existing` option makes retries safe for versions already uploaded. A manual forced release runs only the manual publishing job.

## Validation

Run `actionlint` and `pnpm check:release-supply-chain` before pushing workflow changes. Verify the PR's jobs actually run on Depot, as a valid runner label alone does not prove runner access.

References: [Depot runner types](https://depot.dev/docs/github-actions/runner-types), [public repository access](https://depot.dev/docs/github-actions/troubleshooting), [npm provenance](https://docs.npmjs.com/generating-provenance-statements/).
