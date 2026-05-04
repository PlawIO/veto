# veto-cli

[![npm](https://img.shields.io/npm/v/veto-cli?color=000000)](https://www.npmjs.com/package/veto-cli)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](../../LICENSE)

Compatibility Veto CLI package. The canonical npm CLI package is `veto`; it ships the same `veto` bin and is the package behind `npx veto init`.

## Install

```bash
npm install -g veto
```

Or run without installing:

```bash
npx veto@latest init
```

Existing `veto-cli` installs continue to work as a compatibility path:

```bash
npx veto-cli@latest init
```

## First integration path

```ts
import { protect } from "veto-sdk";

const safeTools = await protect(tools);
```

Use the CLI to add local blocking rules when you are ready:

```bash
npx veto init
npx veto policy generate --tool bash --prompt "block rm -rf" --save ./veto/rules/block-rm-rf.yaml
npx veto guard check --tool bash --args '{"command":"rm -rf /tmp/demo"}' --json
```

Install Veto directly into developer tools:

```bash
npx veto install claude-code
npx veto install cursor
npx veto install codex
```

`Veto.init()` and `.wrap()` are advanced/internal-facing SDK APIs; new app integrations should start with `protect(tools)`.

## Studio (interactive TUI)

```bash
veto              # launch Veto Studio
veto studio       # explicit
```

Full-screen terminal UI for managing policies, reviewing decisions, running tests, and monitoring agent activity in real time.

```bash
veto studio --renderer ansi              # force ANSI renderer (auto|ink|opentui|ansi)
veto studio --theme claude               # theme: veto, claude, high-contrast
veto studio --directory ./packages/sdk   # open a specific workspace
veto studio --demo-template              # demo mode with example data
veto studio --legacy                     # line-based REPL instead of TUI
```

## Policy commands

### Generate

Convert a plain-language description into policy YAML. This is the canonical NL-to-YAML command.

```bash
veto policy generate \
  --tool transfer_funds \
  --prompt "block transfers over $500 to unverified recipients" \
  --save ./veto/rules/financial.yaml

veto policy generate \
  --tool send_email \
  --prompt "only allow emails to @company.com" \
  --mode-hint deterministic \
  --target cloud \
  --json
```

`--mode-hint` accepts `auto`, `deterministic`, or `llm`; local generation passes it through to configured endpoints and records review warnings when fallback is used. `--target` accepts `local` (default) or `cloud`.

Keyless local generation tries configured endpoints in order: Veto Cloud via `VETO_API_KEY`, self-hosted `llm.baseUrl`, then kernel/Ollama when kernel mode is configured. If none is available, it uses local deterministic template fallback with warnings to review the YAML. No customer prompt or policy data leaves the machine in fallback. Use `--no-template-fallback` to fail instead of falling back; `--demo-template` remains a compatibility alias.

### Apply

Push a policy file into your local config or Veto Cloud.

```bash
veto policy apply --file ./veto/rules/financial.yaml
veto policy apply --file ./veto/rules/financial.yaml --target cloud
veto policy apply --file ./veto/rules/financial.yaml --target cloud --project proj_abc --json
```

## Guard check

Validate a single tool call against your current rules -- no agent needed.

```bash
veto guard check --tool transfer_funds --args '{"amount": 600}' --json
# {"decision":"block","rule":"block-large-transfers","reason":"amount 600 > threshold 500"}

veto guard check --tool git_push --args '{"branch":"main"}' --context '{"user":"dev"}' --mode local --json
# {"decision":"ask","rule":"require-approval-for-push","reason":"targets main branch"}
```

`--mode` accepts `local` (default), `cloud`, `kernel`, or `custom`.

## Testing

Run YAML policy unit tests. No LLM, no network. Pure deterministic replay.

```bash
veto test                          # run tests from ./veto/tests/
veto test ./my-tests/              # custom fixtures path
veto test --policy ./veto          # specify policy directory (default: ./veto)
veto test --coverage               # report which rule IDs have tests and which don't
veto test --gaps                   # adversarial gap analysis (static, no LLM)
veto test --gaps --format json     # machine-readable gap report
veto test --gaps --output gaps.json
```

`--gaps` switches to the adversarial gap finder, which reads your policy YAML and generates a report of missing coverage, overly broad rules, and unguarded argument ranges.

## Coverage scan

Discover which tools in your codebase have rules and which are unguarded.

```bash
veto scan                        # show coverage report
veto scan --fail-uncovered       # exit 1 if any tool is unguarded (CI gate)
veto scan --suggest              # include inline YAML suggestions for uncovered tools
veto scan --include-examples     # include examples/ in scope
veto scan --include-tests        # include test/, tests/, __tests__/ in scope
veto scan --format json          # machine-readable output
```

## Policy diff

Compare two versions of a policy and optionally show impact on historical calls.

```bash
veto diff financial.yaml                         # compare working file vs git HEAD
veto diff --old ./rules-v1 --new ./rules-v2      # compare two snapshots
veto diff financial.yaml --log calls.jsonl        # show impact on historical calls
veto diff --old ./rules-v1 --new ./rules-v2 \
  --log calls.jsonl --format json                 # structural + impact report
```

## Intercept (SSE proxy)

HTTP proxy that sits between your agent and the LLM provider. Validates tool calls in streaming SSE responses before they reach your agent. No code changes required.

```bash
veto intercept --port 8080 --target https://api.openai.com
veto intercept --target https://api.anthropic.com --format anthropic
veto intercept --config ./veto --max-buffer 2097152
```

Point your agent at the proxy:

```bash
OPENAI_BASE_URL=http://localhost:8080 node your-agent.js
ANTHROPIC_BASE_URL=http://localhost:8080 python your_agent.py
```

| Flag           | Default                  | Description                                  |
| -------------- | ------------------------ | -------------------------------------------- |
| `--port`       | `8080`                   | Proxy listen port                            |
| `--target`     | `https://api.openai.com` | Upstream API base URL                        |
| `--format`     | `auto`                   | API format: `openai`, `anthropic`, or `auto` |
| `--config`     | `./veto`                 | Veto config directory                        |
| `--max-buffer` | `1048576`                | Buffer limit per response in bytes           |

## MCP commands

Start an MCP gateway that enforces Veto policies on tool calls passing through MCP servers.

### Connect

Persist an MCP client entry that points either at the local Veto gateway or at Veto Cloud.

```bash
veto mcp connect                          # writes mcp.json and initializes ./veto/mcp.config.yaml
veto mcp connect --output ~/.codeium/mcp_config.json
veto mcp connect --cloud
veto mcp connect --cloud --output ~/.cursor/mcp.json --json
```

| Flag            | Default    | Description                                                         |
| --------------- | ---------- | ------------------------------------------------------------------- |
| `--output`      | `mcp.json` | MCP client config JSON file to create or update                     |
| `--config`      | --         | Local gateway config path to initialize and reference in local mode |
| `--server-name` | `veto`     | MCP server key to create or update                                  |
| `--cloud`       | `false`    | Persist a remote MCP entry for `https://api.veto.so/v1/mcp/default` |

### Serve

```bash
veto mcp serve --upstream http://localhost:3000
veto mcp serve --config ./veto/mcp.config.yaml
veto-mcp-proxy --config ./veto/mcp.config.yaml
veto mcp serve --listen 127.0.0.1:8799 --transport mcp-sse --timeout-ms 60000
veto mcp serve --api-key $VETO_API_KEY --policy-server http://localhost:3001
```

| Flag              | Default                 | Description                     |
| ----------------- | ----------------------- | ------------------------------- |
| `--config`        | `veto/mcp.config.yaml`  | Config file path                |
| `--listen`        | `127.0.0.1:8799`        | Host and port to listen on      |
| `--upstream`      | --                      | Upstream MCP server URL         |
| `--transport`     | --                      | `mcp-sse` or `mcp-stdio`        |
| `--api-key`       | --                      | Veto Cloud API key              |
| `--policy-server` | `http://localhost:3001` | Policy validation server URL    |
| `--timeout-ms`    | `30000`                 | Request timeout in milliseconds |

### Doctor and init

```bash
veto mcp doctor                  # diagnose MCP config issues
veto mcp doctor --config ./veto/mcp.config.yaml --json
veto mcp init                    # generate a starter mcp.config.yaml
veto mcp init --output ./veto/mcp.config.yaml --json
```

## Learn

Observe live tool calls and generate deterministic policies from observed behavior. Reads newline-delimited JSON from stdin.

```bash
cat calls.jsonl | veto learn --runs 100 --output ./veto/rules/learned.yaml
veto learn --duration 1h --output ./veto/rules/learned.yaml < calls.jsonl
veto learn --runs 50 --margin 0.2 --output ./rules.yaml
```

Input format (one JSON object per line):

```json
{ "tool": "transfer_funds", "args": { "amount": 100, "to": "alice" } }
```

| Flag         | Default                     | Description                                               |
| ------------ | --------------------------- | --------------------------------------------------------- |
| `--runs`     | --                          | Stop after N observed calls (required if no `--duration`) |
| `--duration` | --                          | Stop after duration: `30s`, `10m`, `1h`, `500ms`          |
| `--output`   | `./veto/rules/learned.yaml` | Output path for generated YAML                            |
| `--margin`   | `0.1`                       | Boundary margin (0-1) for numeric/string constraints      |

## Compile

Compatibility command for older NL-to-YAML workflows. Prefer `veto policy generate`; `compile` now uses the same shared local generation stack by default and preserves legacy provider behavior when `--provider` is passed or provider environment variables are configured.

```bash
veto compile --input "block external emails" --output ./veto/rules/
veto compile --file ./policy.txt --output ./veto/rules/compiled.yaml
veto compile --file ./policy.txt --output ./rules/ --provider anthropic --model claude-sonnet-4-5-20250929
```

| Flag         | Default          | Description                                      |
| ------------ | ---------------- | ------------------------------------------------ |
| `--input`    | --               | Inline policy text                               |
| `--file`     | --               | File containing policy text                      |
| `--output`   | --               | Output path (file or directory, required)        |
| `--provider` | optional legacy  | `openai`, `anthropic`, `gemini`, or `openrouter` |
| `--model`    | provider default | Model to use for compilation                     |

Provider auto-detection checks environment variables in order: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`. Without those provider env vars, `compile` is keyless and uses the policy-as-prose fallback behavior described under `policy generate`.

## Replay

Replay historical tool calls against a policy. Shows what would be allowed, denied, or flagged for approval. Pure deterministic evaluation -- no LLM, no network.

```bash
veto replay --policy ./veto --log calls.jsonl
veto replay --policy ./veto --log calls.jsonl --diff       # show only changed decisions
veto replay --policy ./veto --log calls.jsonl --format json
```

Log format (newline-delimited JSON, one call per line):

```json
{
  "tool": "send_email",
  "arguments": { "to": "ext@example.com" },
  "timestamp": "2025-01-15T10:00:00Z",
  "decision": "allow"
}
```

The optional `decision` field enables diff mode: replay compares the new policy's verdict against the original decision and highlights changes.

## REPL

Interactive REPL for testing rules, scanning tools, and running test suites.

```bash
veto repl
veto repl --legacy                # line-based REPL (same as veto studio --legacy)
```

Available REPL commands:

| Command                | Description                                  |
| ---------------------- | -------------------------------------------- |
| `/scan`                | Rescan project tools and coverage            |
| `/test <tool>({args})` | Test a tool call against loaded rules        |
| `/test-suite`          | Run generated scenarios against loaded rules |
| `/explain <ruleId>`    | Explain rule behavior                        |
| `/list`                | List active rules in session                 |
| `/export [file]`       | Export merged rules to YAML                  |
| `/load <file>`         | Load a policy YAML file into session         |
| `/clear`               | Clear session rules and reload from disk     |
| `/quit`                | Exit REPL                                    |

Free-form input is also supported: `"what would happen if my agent transfers $50,000?"`, `"block emails to external domains"`.

## Audit

Verify the integrity of the tamper-evident audit chain. Each record contains a `chain_hash` linking it to the previous record. A single tampered byte breaks the chain.

```bash
veto audit verify                  # verify .veto/audit.log (default)
veto audit verify ./audit.log      # verify a custom log file
```

```
$ veto audit verify
Audit log verified: 847 records, chain intact
```

## Cloud

```bash
veto cloud login           # authenticate with Veto Cloud (device flow)
veto cloud whoami          # show active account and org context
veto cloud whoami --json   # machine-readable
veto cloud org use <id>    # switch org context
veto cloud project use <id>  # switch project context
veto cloud logout          # clear stored credentials
```

## Other commands

```bash
veto init                  # initialize Veto in the current project
veto init --pack financial # extend a built-in policy pack
veto init --mode cloud     # set validation mode (local|cloud|kernel|custom)
veto init --approval       # enable human approval flow
veto doctor                # check runtime, auth, and connectivity
veto doctor --json         # machine-readable diagnostics
veto version               # show version
```

### Deprecated

`veto agent` commands (`init`, `policy add`, `policy list`, `scan`, `config`) are deprecated. Use `veto policy` and `veto guard` instead.

## All commands

| Command                  | Description                                      |
| ------------------------ | ------------------------------------------------ |
| `veto` / `veto studio`   | Interactive Veto Studio (TUI)                    |
| `veto policy generate`   | Generate policy YAML from natural language       |
| `veto policy apply`      | Apply policy file locally or to Veto Cloud       |
| `veto guard check`       | Validate a tool call against current rules       |
| `veto test`              | Run YAML policy unit tests (deterministic)       |
| `veto test --gaps`       | Adversarial gap analysis                         |
| `veto scan`              | Coverage audit -- which tools have rules         |
| `veto diff`              | Show what changed between policy versions        |
| `veto intercept`         | HTTP proxy for OpenAI/Anthropic SSE streams      |
| `veto mcp connect`       | Persist MCP client config for local or cloud use |
| `veto mcp serve`         | Start MCP gateway with policy enforcement        |
| `veto mcp doctor`        | Diagnose MCP configuration                       |
| `veto mcp init`          | Generate starter MCP config                      |
| `veto learn`             | Generate policies from observed tool calls       |
| `veto compile`           | Compatibility NL-to-YAML wrapper                 |
| `veto replay`            | Replay historical calls against a policy         |
| `veto repl`              | Interactive REPL for rules and testing           |
| `veto audit verify`      | Verify tamper-evident audit chain                |
| `veto cloud login`       | Authenticate with Veto Cloud                     |
| `veto cloud whoami`      | Show cloud context                               |
| `veto cloud org use`     | Switch org context                               |
| `veto cloud project use` | Switch project context                           |
| `veto cloud logout`      | Clear stored credentials                         |
| `veto init`              | Initialize Veto in a new project                 |
| `veto doctor`            | Diagnostics                                      |
| `veto version`           | Show version                                     |

## Compatibility

`veto` is the canonical npm package. `veto-cli` and `veto-sdk` still expose the `veto` bin for existing users.

```bash
npx veto@latest init      # canonical
npx veto-cli@latest init  # compatibility
npx veto-sdk@latest init  # compatibility
```

## License

Apache-2.0 (c) [Plaw, Inc.](https://plaw.io)
