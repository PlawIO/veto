# Veto

**The permission layer for AI agents.**

Veto gives you control over what AI agents can and cannot do. Whether you're building agentic applications or using AI coding assistants, Veto ensures they operate within boundaries you define.

## Packages

| Package                       | Language   | Description                           | Documentation                                        |
| ----------------------------- | ---------- | ------------------------------------- | ---------------------------------------------------- |
| [veto-sdk](./packages/sdk)    | TypeScript | SDK for building guarded agentic apps | [**Read the docs**](./packages/sdk/README.md)        |
| [veto](./packages/sdk-python) | Python     | SDK for building guarded agentic apps | [**Read the docs**](./packages/sdk-python/README.md) |
| [veto-cli](./packages/cli)    | TypeScript | CLI for AI coding assistants          | [**Read the docs**](./packages/cli/README.md)        |

## Install

```bash
# TypeScript SDK
npm install veto-sdk

# Python SDK
pip install veto

# CLI for AI coding assistants
npm install -g veto-cli
```

## How It Works

```
┌─────────────┐     ┌─────────┐     ┌──────────────┐
│  AI Agent   │────▶│  Veto   │────▶│  Your Tools  │
│  (LLM)      │     │ (Guard) │     │  (Handlers)  │
└─────────────┘     └─────────┘     └──────────────┘
                         │
                         ▼
                    ┌─────────┐
                    │  Rules  │
                    │  (YAML) │
                    └─────────┘
```

1. AI agent requests a tool call
2. Veto intercepts and validates against your rules
3. Allowed → execute. Blocked → deny. Ask → prompt user.
4. Result returned to agent (unaware of guardrail)

## Guides

- [Human-in-the-loop approval guide (bank transfer escalation)](./docs/hitl-guide.md)

## Why Veto?

- **Zero-config defaults** — Sensible security rules out of the box
- **Multi-language** — TypeScript and Python SDKs
- **Provider agnostic** — OpenAI, Anthropic, Google, LangChain
- **Local-first** — No cloud required, optional custom LLM validation
- **Real-time monitoring** — TUI dashboard for coding assistants

## Contributor Workflow

Veto is set up for external contributions with explicit CI guardrails.

### Required PR checks

- `Build & Test` (TypeScript packages)
- `Python SDK` (ruff + mypy + pytest)
- `Dependency Review` (blocks high-severity dependency risk)
- `Changeset Required` (for package changes unless maintainer-exempt)
- `PR Title` (conventional title format)

### Auto-management workflows

- `Auto Label` labels PRs by changed paths (`area:sdk`, `area:python`, etc.)
- `Sync Labels` keeps repository labels aligned with `.github/labels.yml`
- `Actionlint` validates all workflow files
- `First Interaction` welcomes first-time contributors on issues and PRs

## Release and Publishing

Releases are automated from `master` via `.github/workflows/release.yml`:

1. Changesets create/maintain a Version Packages PR
2. Merge the release PR to publish to npm
3. Python package is built and uploaded to PyPI
4. GitHub releases/tags are created

For package-impacting PRs, run:

```bash
pnpm changeset
```

Maintainers can exempt non-release PRs with the `release-exempt` or `no-changeset` label.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for branch naming, local development, and release rules.

## License

Apache-2.0
