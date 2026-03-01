# Contributing to Veto

There's no standard authorization layer for AI agents yet. We're building it. If that's interesting to you, we'd love your help.

This guide covers everything you need to go from idea → merged PR.

## Quick start

```bash
git clone https://github.com/PlawIO/veto.git
cd veto
pnpm install
pnpm build
pnpm test
```

## Project structure

```
veto/
├── packages/
│   ├── sdk/           # TypeScript SDK (npm: veto-sdk)
│   ├── sdk-python/    # Python SDK (pip: veto-sdk)
│   └── cli/           # CLI + TUI (npm: veto-cli)
└── .changeset/        # Version management
```

## Development workflow

### 1. Create a branch

```bash
git checkout -b feat/sdk/your-feature   # SDK feature
git checkout -b feat/cli/your-feature   # CLI feature
git checkout -b fix/sdk/your-fix        # SDK bugfix
```

### 2. Make changes

```bash
pnpm dev:sdk    # Watch SDK
pnpm dev:cli    # Watch CLI
pnpm dev:web    # Landing page dev server
```

Code style:

- **TypeScript**: Use `.js` extensions in imports
- **Types**: Explicit param/return types, use `type` imports
- **Errors**: Throw typed errors, never `process.exit()` in libraries
- **Tests**: Add tests for new functionality

### 3. Add a changeset

Every PR that affects a published package needs a changeset:

```bash
pnpm changeset
```

Select changed packages, pick a bump type, write a one-liner summary.

Bump guidelines:

- `patch`: Bug fixes, dependency updates
- `minor`: New features, non-breaking additions
- `major`: Breaking changes

### 4. Run checks

```bash
pnpm build      # Build all packages
pnpm test       # Run all tests
pnpm typecheck  # Type check
```

### 5. Open a PR

- Conventional title: `feat: ...`, `fix: ...`, `chore: ...`, `docs: ...`
- Reference issues: `Fixes #123`
- A bot will walk you through any remaining steps (changeset, CLA)

If your PR touches `packages/sdk`, `packages/sdk-python`, or `packages/cli`, include a changeset unless a maintainer labels it `release-exempt`.

## Testing

```bash
pnpm test                           # All tests
pnpm --filter veto-sdk test         # SDK only
pnpm --filter veto-cli test         # CLI only
pnpm --filter veto-sdk test:watch   # Watch mode
```

**Python SDK:**

```bash
cd packages/sdk-python
pip install -e ".[dev]"
pytest -v
ruff check veto
mypy veto --ignore-missing-imports
```

## Release process

Fully automated. Merge a PR with a changeset → a "Version Packages" PR appears → merge that to publish to npm and PyPI and cut a GitHub release. Nothing manual.

```bash
gh workflow run release.yml -f force=true   # maintainers only — force a release
```

## CI

Every PR runs:

- `CI` — build, typecheck, test
- `Dependency Review` — blocks high-severity dependency risk
- `PR Title` — conventional format check
- `Changeset Required` — ensures package changes are versioned

## Commands

| Command          | What it does             |
| ---------------- | ------------------------ |
| `pnpm install`   | Install all dependencies |
| `pnpm build`     | Build all packages       |
| `pnpm test`      | Run all tests            |
| `pnpm typecheck` | Type check all packages  |
| `pnpm changeset` | Add a changeset          |
| `pnpm dev:sdk`   | Watch SDK                |
| `pnpm dev:cli`   | Watch CLI                |
| `pnpm dev:web`   | Start web dev server     |

## Getting help

- [GitHub Issues](https://github.com/PlawIO/veto/issues) — bugs and feature requests
- [GitHub Discussions](https://github.com/PlawIO/veto/discussions) — questions and ideas

## One housekeeping thing

First-time contributors need to sign a [Contributor License Agreement](CLA.md). A bot handles it — when you open your first PR it'll post a comment, you reply with one line, and you're done. You only ever sign once.

It's standard practice for open-source projects with a company behind them. It lets us keep the project healthy and properly licensed for everyone using it.
