# veto-bash

[![npm](https://img.shields.io/npm/v/veto-bash?color=000000)](https://www.npmjs.com/package/veto-bash)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](../../LICENSE)

`veto-bash` is a publishable bash wrapper for partner integrations. It validates inspectable bash invocations with Veto before handing off to the real system `bash`.

## Install

```bash
npm install -g veto-bash
```

## Shadow `bash` in `PATH`

```bash
mkdir -p "$HOME/.veto/bin"
ln -sf "$(command -v veto-bash)" "$HOME/.veto/bin/bash"
export PATH="$HOME/.veto/bin:$PATH"
```

Override the real shell binary explicitly when needed:

```bash
export VETO_BASH_REAL_BASH=/bin/bash
```

## Usage

Cloud mode validates against `POST /v1/validate` with the `bash` tool name and `arguments.command` as the canonical payload.

```bash
bash --veto-api-key "$VETO_API_KEY" -c 'echo hello'
bash --veto-api-key "$VETO_API_KEY" -lc 'npm publish --dry-run'
bash --veto-api-key "$VETO_API_KEY" ./scripts/deploy.sh staging
printf 'echo from stdin\n' | bash --veto-api-key "$VETO_API_KEY" -s
```

Local/offline mode uses the nearest `./veto/veto.config.yaml` discovered from the current working directory upward.

```bash
bash --offline -c 'pnpm test'
```

If cloud validation is configured but unreachable, `veto-bash` falls back to local Veto rules when a nearby Veto config exists. Otherwise it fails closed.

## Flags

| Flag                    | Default               | Description                                                |
| ----------------------- | --------------------- | ---------------------------------------------------------- |
| `--veto-api-key <key>`  | `VETO_API_KEY`        | API key for cloud validation                               |
| `--veto-api-url <url>`  | `https://api.veto.so` | Base URL for `POST /v1/validate` and approval polling      |
| `--cache-ttl <seconds>` | `60`                  | Persistent decision cache TTL                              |
| `--offline`             | `false`               | Skip cloud validation and evaluate locally with `veto-sdk` |

Wrapper flags must appear before the bash argv. Use `--` if you need to pass a literal value that would otherwise be parsed as a wrapper flag. Inspectable commands already fail closed by default on deny, approval failure, or missing policy sources.

## What gets validated

`veto-bash` validates tool name `bash` with payloads shaped like:

```json
{
  "command": "rm -rf /tmp/demo",
  "cwd": "/workspace/app",
  "argv": ["-c", "rm -rf /tmp/demo"],
  "shellMode": "command"
}
```

Supported inspectable modes:

- `bash -c 'echo hello'`
- `bash -lc 'echo hello'` and other short-option bundles that include `c`
- `bash ./script.sh arg1 arg2` by reading the script file contents before execution
- `bash -s` by buffering stdin and validating the buffered script text

Interactive shells without an inspectable command source (`bash`, `bash -l`, `bash -i`, etc.) pass through directly to the real `bash`. `veto-bash` documents this limitation instead of pretending an interactive REPL can be pre-validated.

## Approval flow

When the API returns `require_approval`, `veto-bash` polls `GET /v1/approvals/:id` until the approval is approved, denied, expired, or times out.

- approved → executes the original bash argv
- denied / expired / timeout → prints a compact stderr message and exits non-zero

Pending approval responses are never cached. Final allow/deny outcomes are cached per user under `$HOME/.veto/cache/veto-bash-decisions.json`.
