# AGENTS.md

> **For strategy, positioning, and business context, see [VISION.md](./VISION.md).**

## Monorepo Navigation

| Package                                        | Purpose                            | Guide                                                   |
| ---------------------------------------------- | ---------------------------------- | ------------------------------------------------------- |
| [`packages/sdk`](./packages/sdk)               | TypeScript SDK for agentic apps    | [TS SDK AGENTS.md](./packages/sdk/AGENTS.md)            |
| [`packages/sdk-python`](./packages/sdk-python) | Python SDK for agentic apps        | [Python SDK AGENTS.md](./packages/sdk-python/AGENTS.md) |
| [`packages/cli`](./packages/cli)               | CLI + TUI for AI coding assistants | [CLI AGENTS.md](./packages/cli/AGENTS.md)               |

## Quick Commands

```bash
pnpm install          # Install all dependencies
pnpm build            # Build all packages (turbo-cached)
pnpm test             # Test all packages (turbo-cached)
pnpm typecheck        # Typecheck all packages
pnpm dev:sdk          # Watch SDK
pnpm dev:cli          # Watch CLI
pnpm changeset        # Add a changeset for releases
```

## Code Style (All Packages)

- **TypeScript ESM**: Use `.js` extensions in imports (`import { x } from './foo.js'`)
- **Types**: Explicit param/return types; use `type` imports for type-only
- **Naming**: camelCase (functions/vars), PascalCase (types/classes), UPPER_SNAKE (constants)
- **Errors**: Throw typed errors, never `process.exit()` in libraries
  - SDK: `ToolCallDeniedError`, `RuleSchemaError`
  - CLI: `CLIError`, `ConfigError`, `ValidationError`, `AgentError`, `NetworkError`
- **Tests**: Vitest with `describe`/`it`/`expect`, pattern `test/*.test.ts` or `tests/*.test.ts`

## CI/CD

### Build System

- **Turborepo**: All builds/tests are turbo-cached for speed
- **Parallel**: SDK + CLI build/test run in parallel
- **Cache**: Local `.turbo/` cache, CI uses remote caching

### Release Process (Changesets)

1. Make changes, add a changeset: `pnpm changeset`
2. PR merges to `master`
3. "Version Packages" PR auto-created
4. Merge that PR → auto-publishes to npm (SDK, CLI) and PyPI (Python SDK)

### Branching

- `feat/sdk/*`, `feat/cli/*` - New features
- `fix/sdk/*`, `fix/cli/*` - Bug fixes
- `chore/infra/*` - CI/tooling

## Links

- **Repo**: https://github.com/PlawIO/veto
- **npm SDK**: https://npmjs.com/package/veto-sdk
- **npm CLI**: https://npmjs.com/package/veto-cli
- **PyPI SDK**: https://pypi.org/project/veto-sdk
- **Landing**: https://veto.so
