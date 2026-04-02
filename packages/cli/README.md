# veto-cli

[![npm](https://img.shields.io/npm/v/veto-cli?color=000000)](https://www.npmjs.com/package/veto-cli)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](../../LICENSE)

The canonical Veto CLI. Launch the interactive Veto Studio TUI or run headless policy operations in CI.

## Install

```bash
npm install -g veto-cli
```

Or run without installing:

```bash
npx veto-cli@latest
```

## Studio (interactive TUI)

```bash
veto              # launch Veto Studio
veto studio       # explicit
```

Full-screen terminal UI for managing policies, reviewing decisions, running tests, and monitoring agent activity in real time.

```bash
veto studio --renderer ansi              # force ANSI renderer
veto studio --directory ./packages/sdk   # open a specific workspace
veto studio --demo-template              # demo mode with example data
```

## Policy commands

```bash
# Generate policy YAML from a plain-language description
veto policy generate \
  --tool transfer_funds \
  --prompt "block transfers over $500 to unverified recipients" \
  --save ./veto/rules/financial.yaml

# Apply a policy file locally
veto policy apply --file ./veto/rules/financial.yaml

# Push to Veto Cloud (creates a draft for review)
veto policy apply --file ./veto/rules/financial.yaml --target cloud
```

## Guard check

Test a single tool call against your current rules — no agent needed.

```bash
veto guard check --tool transfer_funds --args '{"amount": 600}' --json
# {"decision":"block","rule":"block-large-transfers","reason":"amount 600 > threshold 500"}

veto guard check --tool git_push --args '{"branch":"main"}' --json
# {"decision":"ask","rule":"require-approval-for-push","reason":"targets main branch"}
```

## Coverage scan

```bash
veto scan                        # show which tools have rules and which don't
veto scan --fail-uncovered       # exit 1 if any tool is unguarded (CI gate)
veto scan --suggest              # include inline YAML suggestions for uncovered tools
veto scan --include-examples     # include examples/ and tests/ in scope
veto scan --format json          # machine-readable output
```

## Policy diff

```bash
veto diff financial.yaml                         # compare working file vs git HEAD
veto diff --old ./rules-v1 --new ./rules-v2      # compare two snapshots
veto diff financial.yaml --log calls.jsonl        # show impact on historical calls
veto diff --old ./rules-v1 --new ./rules-v2 \
  --log calls.jsonl --format json                 # structural + impact report
```

## Cloud

```bash
veto cloud login     # authenticate with Veto Cloud (device flow)
veto cloud whoami    # show active account and org context
```

## Other commands

```bash
veto init            # initialize Veto in the current project
veto doctor          # check runtime, auth, and connectivity
veto version         # show version
```

## All commands

| Command | Description |
|---------|-------------|
| `veto` / `veto studio` | Interactive Veto Studio (TUI) |
| `veto policy generate` | Generate policy YAML from natural language |
| `veto policy apply` | Apply policy file locally or to Veto Cloud |
| `veto guard check` | Validate a tool call against current rules |
| `veto scan` | Coverage audit — which tools have rules |
| `veto diff` | Show what changed between policy versions |
| `veto cloud login` | Authenticate with Veto Cloud |
| `veto cloud whoami` | Show cloud context |
| `veto init` | Initialize Veto in a new project |
| `veto doctor` | Diagnostics |
| `veto version` | Show version |

## Compatibility

`veto-sdk` still exposes the `veto` bin for legacy compatibility. `veto-cli` is the canonical package.

```bash
npx veto-cli@latest   # canonical
npx veto-sdk@latest   # legacy (still works)
```

## License

Apache-2.0 © [Plaw, Inc.](https://plaw.io)
