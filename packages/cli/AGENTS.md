# CLI AGENTS.md

## Purpose

`packages/cli` is the canonical package that ships the `veto` command.
It delegates command execution to shared logic exported from `veto-sdk/cli-runner`.

## Local Commands

```bash
pnpm --filter veto-cli build
pnpm --filter veto-cli dev
```

## Rules

- Keep `veto-cli` as a thin wrapper around shared CLI core.
- Avoid duplicating parser/command logic here.
- Prefer changes in `packages/sdk/src/cli/*` for behavior updates.
