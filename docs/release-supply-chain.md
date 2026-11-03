# Release Supply Chain

Veto releases publish from `.github/workflows/release.yml` using short-lived OIDC credentials.

## npm

For each public workspace package, configure npm Trusted Publishing with:

- Repository: `PlawIO/veto`
- Workflow filename: `release.yml`
- Allowed action: `npm publish`

The release workflow only runs from `refs/heads/master`. The npm publishing jobs `release` and `release-manual` use pinned `ubuntu-24.04` so `RUNNER_ENVIRONMENT` is `github-hosted`. They check that npm is new enough for Trusted Publishing and set npm provenance on publish. Keep package repository metadata aligned with the package directory so provenance points at the source that produced the package. Depot runners report `self-hosted`, which the registry rejects when verifying provenance.

After Trusted Publishing succeeds, disallow traditional npm publish tokens for these packages and revoke old automation tokens.

## PyPI

Configure PyPI Trusted Publishing for the `veto` project against:

- Repository: `PlawIO/veto`
- Workflow filename: `release.yml`

The workflow builds the Python distribution locally, then publishes through `pypa/gh-action-pypi-publish@release/v1` without a password or API token. PyPI project attestations are created by that trusted publisher path.

## Local Gate

Run the release hardening check with:

```sh
pnpm check:release-supply-chain
```

Package install smoke tests run in CI and immediately before release publishing:

```sh
pnpm smoke:release-artifacts
```

The smoke test packs the public npm packages, installs the resulting tarballs into a clean project with lifecycle scripts disabled, imports the expected runtime surfaces, builds the Python wheel, installs it into a clean virtual environment, and imports the expected Python SDK surfaces.

The hardening check fails if release publish tokens, `twine upload`, an npm publishing job on a runner other than `ubuntu-24.04`, missing package provenance metadata, missing package smoke tests, or install-time npm lifecycle hooks are introduced.
