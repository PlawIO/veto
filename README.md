# Veto

Veto is the policy runtime for AI agent tool calls — write deny rules in plain English, enforce them deterministically, in 5 lines of code.

[![npm](https://img.shields.io/npm/v/veto?label=veto&color=000000)](https://www.npmjs.com/package/veto)
[![npm](https://img.shields.io/npm/v/veto-sdk?label=veto-sdk&color=000000)](https://www.npmjs.com/package/veto-sdk)
[![PyPI](https://img.shields.io/pypi/v/veto?label=python%20veto&color=000000)](https://pypi.org/project/veto)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

Veto sits between an agent and the tools it can execute. It evaluates tool name + arguments against deterministic policy, then allows, denies, warns, logs, or routes to approval before your handler runs. It governs tool calls, not prompts.

## Benchmarks

Checked-in PR-mode baselines are measured on GitHub Actions runner output, not local hardware or thresholds. CI gates Veto p99 regressions above 10% against `benchmark/baselines/*.json`; absolute thresholds remain separate.

| Runtime | Workload                           | Iterations |          p50 |           p95 |           p99 | p99 threshold | Source                                              |
| ------- | ---------------------------------- | ---------: | -----------: | ------------: | ------------: | ------------: | --------------------------------------------------- |
| Veto    | single-rule local eval             |     50,000 |   0.000260ms |    0.001092ms |    0.002594ms |        0.05ms | measured on GitHub Actions PR-mode, PR #208 CI log  |
| Veto    | 100-rule merged packs              |     50,000 |   0.027291ms |    0.037470ms |    0.057136ms |         0.5ms | measured on GitHub Actions PR-mode, PR #212 CI log  |
| Veto    | localhost PDP server eval          |        250 |   0.402051ms |    0.841651ms |    2.092263ms |          30ms | local loopback fixture baseline; not run in PR mode |
| AGT     | policy eval latency per rule       |  published | 0.012ms/rule | not published | not published |           n/a | source: published, not reproduced                   |
| AGT     | throughput at 50 concurrent agents |  published |  35K ops/sec | not published | not published |           n/a | source: published, not reproduced                   |

## Get started

```ts
import { protect } from "veto-sdk";
const safeTools = await protect(tools);
```

```bash
npm install veto-sdk
```

Pass `safeTools` to LangChain, Vercel AI SDK, OpenAI Agents, MCP adapters, or your own tool runner. If `./veto/veto.config.yaml` and `./veto/rules/*.yaml` exist, `protect()` loads them. Without local policy, Veto applies `@veto/safe-defaults` in observe mode so suspicious shell/file/db/money-movement patterns are logged without surprise blocking.

For a blocking local policy in under a minute:

```bash
npm install veto-sdk
npx veto init
npx veto policy generate --tool bash --prompt "block rm -rf" --save ./veto/rules/block-rm-rf.yaml
node examples/60-second-denied-call/denied-call.mjs
```

This path is local-only: no provider SDK or API key is required. For prose generation, Veto tries configured cloud/self-hosted/kernel endpoints first, then uses a local deterministic template fallback with review warnings; in fallback, no prompt or policy data leaves your machine.

Install Veto into developer tools and MCP clients:

```bash
npx veto install claude-code
npx veto install cursor
npx veto install codex
veto-mcp-proxy --config ./veto/mcp.config.yaml
```

## TypeScript

```bash
npm install veto-sdk
```

```ts
import { protect } from "veto-sdk";

const safeTools = await protect(tools);
const agent = createAgent({ tools: safeTools });
```

## Python

```bash
pip install veto
```

```python
from veto import protect

safe = await protect(tools)
agent = create_agent(tools=safe)
```

## Add local deny rules

```bash
npx veto init
```

`npx veto init` creates `./veto/veto.config.yaml` and `./veto/rules/defaults.yaml`. The default local rules are strict and include deterministic denials for sensitive paths and destructive shell commands.

Prefer prose for new rules, then review the generated YAML:

```bash
npx veto policy generate --tool bash --prompt "block rm -rf" --save ./veto/rules/block-rm-rf.yaml
```

```yaml
rules:
  - id: block-large-transfers
    name: Block transfers over $1,000
    enabled: true
    severity: high
    action: block
    tools: [transfer_funds]
    conditions:
      - field: arguments.amount
        operator: greater_than
        value: 1000
```

Actions: `block`, `allow`, `warn`, `log`, `require_approval`.

## Advanced API

`Veto.init()` and `.wrap()` remain supported for advanced/internal-facing integrations that need an explicit instance, `guard()` checks, cloud/self-host options, audit exports, or event hooks.

```ts
import { Veto } from "veto-sdk";

const veto = await Veto.init({ configDir: "./veto", mode: "strict" });
const safeTools = veto.wrap(tools);
const decision = await veto.guard("transfer_funds", { amount: 1500 });
```

## Packages

| Package                                         | Language    | Install                    | Purpose                                      |
| ----------------------------------------------- | ----------- | -------------------------- | -------------------------------------------- |
| [`veto`](./packages/veto)                       | TypeScript  | `npx veto init`            | Canonical CLI package behind `npx veto init` |
| [`veto-sdk`](./packages/sdk)                    | TypeScript  | `npm install veto-sdk`     | Policy runtime for agent tool calls          |
| [`veto` (Python)](./packages/sdk-python)        | Python      | `pip install veto`         | Python parity SDK with `protect()`           |
| [`veto-cli`](./packages/cli)                    | TypeScript  | `npx veto-cli@latest`      | Compatibility CLI package exposing `veto`    |
| [`veto-bash`](./packages/bash)                  | Rust + Node | `npm install -g veto-bash` | Native bash tool-call enforcement path       |
| [`create-veto-app`](./packages/create-veto-app) | TypeScript  | `npm create veto-app`      | Starter TypeScript app                       |

## Self-host locally

```bash
docker compose up
curl -s http://localhost:3001/v1/validate \
  -H 'content-type: application/json' \
  -d '{"toolName":"bash","arguments":{"command":"echo hello"}}'
```

See [docs/self-hosting.md](./docs/self-hosting.md) for the public reviewer path, fixed `localhost:3001` compose mapping, disabled-by-default outbound checks, and the local unauthenticated validation contract.

## BYOC / customer-plane boundary

Veto BYOC runs in the customer plane. Public install artifacts are in [`helm/`](./helm), [`terraform-modules/`](./terraform-modules), [`cf-templates/`](./cf-templates), and [`cdk/`](./cdk). They are outbound-only and must not grant Plaw cross-account IAM or impersonation. Customer policy, decision rows, tool arguments, agent IDs, user IDs, Slack content, prompts, environment variables, and secrets do not cross to Plaw.

Allowed outbound control-plane checks are limited to license heartbeat and optional telemetry. The heartbeat schema is exactly six fields: `instance_uuid`, `license_id`, `decision_count_30d`, `sdk_version`, `operator_version`, `timestamp`.

Install docs:

- [Kubernetes](./docs/install/k8s.md)
- [AWS](./docs/install/aws.md)
- [GCP](./docs/install/gcp.md)
- [Azure](./docs/install/azure.md)
- [Air-gapped](./docs/install/air-gapped.md)
- [Verifying images](./docs/verifying-images.md)

## Why Veto

- Deterministic local evaluation for policy rules that can be checked from tool arguments.
- Provider-agnostic wrapping for any agent framework or custom tool runner.
- Human approval and cost-aware governance for sensitive tool calls.
- Local-first operation with optional self-hosted or cloud policy distribution.
- Apache-2.0 licensed packages and public supply-chain verification artifacts.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Report vulnerabilities to [security@plaw.io](mailto:security@plaw.io).

## License

Apache-2.0 © [Plaw, Inc.](https://plaw.io)
