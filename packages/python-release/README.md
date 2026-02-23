# @veto/python-release

Internal marker package used by Changesets to model Python SDK release bumps.

This package is private and never published. Its changesets are consumed by
`scripts/version.mjs`, which applies version/changelog updates to:

- `packages/sdk-python/pyproject.toml`
- `packages/sdk-python/CHANGELOG.md`
