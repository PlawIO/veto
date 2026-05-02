# veto-bash

[![npm](https://img.shields.io/npm/v/veto-bash?color=000000)](https://www.npmjs.com/package/veto-bash)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](../../LICENSE)

`veto-bash` is a Rust-first policy runtime for bash tool calls with MCP support. The npm package in @packages/bash ships the native runtime plus a small Node helper command; the hot path lives in the native crate at @crates/veto-bash.

## First integration path

For application tools, start with the SDK public entrypoint:

```ts
import { protect } from "veto-sdk";

const safeTools = await protect(tools);
```

Use `veto-bash` when the tool being governed is a shell command or a bash MCP server. `Veto.init()` and `.wrap()` are advanced SDK APIs.

## Architecture

- native runtime owns bash argv parsing, local deterministic evaluation, real bash handoff, approval polling, decision caching, policy SWR refresh, audit spooling, and MCP stdio mode
- npm package ships the current-platform native binary produced during `pnpm --filter veto-bash build`
- the `veto-bash` command is a setup/helper entrypoint; shadowed `bash` should point at the packaged native binary path, not the JS helper
- inspectable executions fail closed by default

Warm-path overhead is designed around local deterministic evaluation:

1. fresh cached cloud policy for tool `bash` → evaluate in-process
2. stale cached policy → evaluate in-process and trigger background refresh
3. no usable deterministic policy cache → call cloud `POST /v1/validate`
4. cloud network failure + local project present → local project fallback
5. cloud network failure + no local project → fail closed

The `<=3ms` target applies to the warm deterministic path, not a cold cloud round-trip.

## Install

```bash
npm install -g veto-bash
```

This PR intentionally does not fake a universal native distribution pipeline. Today the supported story is:

- build from this repo with Cargo available, or
- install a package artifact built on the same platform/arch as the target machine

There are no cross-platform prebuilt binaries in this PR yet.

## Shadow `bash` in `PATH`

```bash
mkdir -p "$HOME/.veto/bin"
VETO_BASH_NATIVE="$(veto-bash native-path)"
ln -sf "$VETO_BASH_NATIVE" "$HOME/.veto/bin/bash"
export PATH="$HOME/.veto/bin:$PATH"
export VETO_BASH_REAL_BASH=/bin/bash
```

`veto-bash native-path` is a one-time helper for setup. After that, intercepted `bash` launches hit the native binary directly with no Node process in front of the hot path.

The runtime resolves the real shell in this order:

1. `VETO_BASH_REAL_BASH`
2. `/bin/bash`
3. `/usr/bin/bash`

If none exist, execution fails clearly instead of recursing into the wrapper.

## Direct wrapper usage

Wrapper flags must appear before the bash argv. Use `--` to stop wrapper parsing.

```bash
bash --veto-api-key "$VETO_API_KEY" -c 'echo hello'
bash --veto-api-key "$VETO_API_KEY" -lc 'npm publish --dry-run'
bash --veto-api-key "$VETO_API_KEY" ./scripts/deploy.sh staging
printf 'echo from stdin\n' | bash --veto-api-key "$VETO_API_KEY" -s
bash --offline -c 'pnpm test'
```

If you invoke `veto-bash` directly, it still forwards into the native runtime, but the recommended bash-shadowing setup is the native binary path above so warm command interception stays fully native.

Supported inspectable modes:

- `bash -c 'echo hello'`
- bundled short flags like `bash -lc 'echo hello'`
- script-file execution by reading the script contents before exec
- `bash -s` with buffered stdin validation

Interactive shells without an inspectable command source (`bash`, `bash -l`, `bash -i`) pass through to the real shell in direct wrapper mode. They are rejected in MCP mode.

## MCP

`veto-bash` can run as a generic stdio MCP server so an external agent can disable its built-in shell tool and delegate to the guarded runtime instead.

Start the server:

```bash
veto-bash mcp serve --veto-api-key "$VETO_API_KEY"
```

Emit ready-to-paste config:

```bash
veto-bash mcp init
veto-bash mcp init --output ./veto-bash-mcp-snippets.txt
```

Current MCP surface:

- `bash_exec` — execute guarded bash argv with optional `cwd` and `stdin`

Example generic MCP config:

```json
{
  "mcpServers": {
    "veto-bash": {
      "command": "veto-bash",
      "args": ["mcp", "serve", "--veto-api-key", "${VETO_API_KEY}"],
      "env": {
        "VETO_BASH_REAL_BASH": "/bin/bash"
      }
    }
  }
}
```

## Validation contract

Cloud validation uses tool name `bash` and `POST /v1/validate` with camelCase payloads. `arguments.command` remains the canonical field so existing policy packs keep working.

```json
{
  "toolName": "bash",
  "arguments": {
    "command": "rm -rf /tmp/demo",
    "cwd": "/workspace/app",
    "argv": ["-c", "rm -rf /tmp/demo"],
    "shellMode": "command"
  }
}
```

## Deterministic local evaluation

Two local deterministic sources exist:

- nearby local project rules discovered from `./veto/veto.config.yaml`
- cached cloud `bash` policy fetched from `GET /v1/policies/bash`

The native evaluator handles the bash policy subset needed for fast command interception:

- `arguments.command` string checks
- regex checks
- enum / inclusion checks
- presence / length / numeric bounds

If a cached cloud policy uses unsupported features such as session constraints, rate limits, or unsupported dynamic constraints, the runtime skips the local fast path and goes to cloud instead of guessing.

For nearby local project rules, keep the current Rust subset in mind:

- the runtime discovers plain rule files from `veto/veto.config.yaml` and `veto/rules/**`
- local rule evaluation currently understands `allow`, `block`, and `require_approval`
- rule-file `extends` is not supported in the native local path yet; use flattened local rules or cloud validation instead

## Cache layout

- decision cache: `$HOME/.veto/cache/veto-bash-decisions.json`
- cloud policy cache: `$HOME/.veto/cache/veto-bash-policies.json`
- audit spool: `$HOME/.veto/audit/veto-bash-spool.jsonl`

Decision-cache key fields are:

- requested mode
- API URL
- API-key namespace derived with `scrypt` from the API key
- command text
- cwd
- original bash argv
- shell mode
- script path
- discovered local Veto directory

Raw API keys are never written to cache files. `cloud-fallback-local` decisions are not reusable from the decision cache.

## Approval flow

When cloud returns `require_approval`, the runtime polls `GET /v1/approvals/:id` until a terminal state.

- approved → executes
- denied / expired / timeout → exits non-zero with a compact stderr reason
- non-retriable approval HTTP errors such as `403` / `404` fail fast
- only network errors, `429`, and `5xx` are retried

## Auditing

Every guarded decision appends a JSONL event to the local spool. Deterministic local decisions can be forwarded asynchronously to cloud without blocking execution.
