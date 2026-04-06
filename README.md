<div align="center">

# Veto

**sudo for AI agents.**

Stop agents from deleting files, leaking secrets, or pushing to prod — without slowing anyone down.

[![npm](https://img.shields.io/npm/v/veto-sdk?label=veto-sdk&color=000000)](https://www.npmjs.com/package/veto-sdk)
[![npm](https://img.shields.io/npm/v/veto-cli?label=veto-cli&color=000000)](https://www.npmjs.com/package/veto-cli)
[![PyPI](https://img.shields.io/pypi/v/veto?label=veto&color=000000)](https://pypi.org/project/veto)
[![npm downloads](https://img.shields.io/npm/dt/veto-sdk?label=installs&color=000000)](https://www.npmjs.com/package/veto-sdk)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![CI](https://github.com/PlawIO/veto/actions/workflows/ci.yml/badge.svg)](https://github.com/PlawIO/veto/actions/workflows/ci.yml)
[![GitHub Stars](https://img.shields.io/github/stars/PlawIO/veto?style=flat&color=000000)](https://github.com/PlawIO/veto)

[**docs.veto.so**](https://docs.veto.so) · [veto.so](https://veto.so) · [npm](https://www.npmjs.com/package/veto-sdk) · [PyPI](https://pypi.org/project/veto)

</div>

---

AI agents can execute code, call APIs, and modify production systems. Veto is the permission layer that sits between every agent action and execution — validating, blocking, or routing to human approval before anything runs.

```typescript
const veto = await Veto.init(); // loads ./veto/veto.config.yaml + rules
const guarded = veto.wrap(tools); // inject guardrails — types preserved
// pass guarded to your agent. done.
```

The agent is unaware it's being governed. Your tools are unchanged. No behavior change for the AI.

## How it works

```
┌───────────┐         ┌────────────┐         ┌──────────────┐
│ AI Agent  │────────▶│    Veto    │────────▶│  Your Tools  │
│  (LLM)    │         │  (Guard)   │         │  (Handlers)  │
└───────────┘         └────────────┘         └──────────────┘
                            │
                      ┌─────┴──────┐
                      │ YAML Rules │  block · allow · ask
                      └────────────┘
```

1. Agent calls a tool
2. Veto intercepts and validates (deterministic conditions first, optional LLM for semantic rules)
3. **allow** → executes normally · **block** → denied with reason · **ask** → human approval queue

## Packages

| Package                         | Language   | Install                   | Description                              |
| ------------------------------- | ---------- | ------------------------- | ---------------------------------------- |
| [`veto-sdk`](./packages/sdk)    | TypeScript | `npm install veto-sdk`    | SDK for guarded agentic apps             |
| [`veto`](./packages/sdk-python) | Python     | `pip install veto`        | Same API, all major LLM providers        |
| [`veto-cli`](./packages/cli)    | TypeScript | `npm install -g veto-cli` | Interactive studio + headless automation |

## Quick start

### TypeScript

```bash
npm install veto-sdk
npx veto init       # creates ./veto/veto.config.yaml + default rules
```

```typescript
import { Veto } from "veto-sdk";

const veto = await Veto.init();
const guarded = veto.wrap(myTools); // LangChain, Vercel AI SDK, or any custom tools
```

### Python

```bash
pip install veto
veto init
```

```python
from veto import Veto

veto = await Veto.init()
guarded = veto.wrap(my_tools)
```

### Rules

Rules are YAML files in `./veto/rules/`. Static conditions run locally with no API call. LLM validation is opt-in for semantic rules.

```yaml
rules:
  - id: block-large-transfers
    name: Block transfers over $1,000
    action: block
    tools: [transfer_funds]
    conditions:
      - field: arguments.amount
        operator: greater_than
        value: 1000

  - id: require-approval-for-push
    name: Require human approval before pushing to main
    action: ask
    tools: [git_push]
    description: "Intercept any push targeting the main branch."
```

Actions: `block` · `allow` · `warn` · `log` · `ask` (human-in-the-loop)

→ [Full TypeScript SDK docs](./packages/sdk/README.md) · [Python SDK docs](./packages/sdk-python/README.md)

## Economic authorization

For agents that spend money — trading bots, paid API calls, SaaS billing — Veto adds cost-aware policy enforcement.

```yaml
# veto.config.yaml
extends: "@veto/economic-agent"
```

```typescript
const result = await veto.guard(
  "purchase",
  { item: "GPU" },
  {
    economic: {
      cost: 42.5,
      currency: "USD",
      payer: "team-wallet",
      protocol: "custom",
    },
  }
);
// result.decision: 'allow' | 'deny' | 'require_approval'
// (YAML uses action: block/ask — guard() returns the resolved decision)
```

Built-in protocol connectors for x402 (HTTP 402), Stripe MPP, and Google AP2. Session budgets enforced locally; agent/user/global budgets via Veto Cloud.

[Economic Authorization Guide →](https://docs.veto.so/docs/guides/economic-authorization)

## CLI + Studio

```bash
npx veto-cli@latest                        # launch interactive Veto Studio (TUI)
npx veto-cli@latest policy generate \
  --tool transfer_funds \
  --prompt "block over $500 to unverified recipients"
npx veto-cli@latest guard check \
  --tool transfer_funds --args '{"amount": 600}' --json
npx veto-cli@latest scan --fail-uncovered  # CI gate: exit 1 on unguarded tools
```

→ [Full CLI reference](./packages/cli/README.md)

## Why Veto

- **Deterministic-first** — Static conditions run locally, zero latency, no API call. LLM validation only when you need semantic reasoning.
- **Provider agnostic** — Works with OpenAI, Anthropic, Google, LangChain, Vercel AI SDK, and any custom tool-calling setup.
- **Human-in-the-loop** — `ask` action routes sensitive decisions to an approval queue instead of auto-blocking.
- **Audit trail** — Every decision logged with tool name, arguments, rule matched, and outcome. Exportable as JSON or CSV.
- **Local-first** — No cloud required. Fully offline. Optional [Veto Cloud](https://veto.so) for team sync and dashboard.
- **Rate limiting** — Per-rule sliding window rate limits. In-memory or Redis-backed for distributed deployments.
- **Zero-config defaults** — `veto init` generates sensible baseline rules. Production-hardened in under 10 minutes.

## Advanced features

### Rate limiting

Attach sliding window rate limits to any rule. Scopes: `global`, `agent`, `user`, `session`.

```yaml
rules:
  - id: rate-limit-api
    name: Limit API calls
    action: block
    tools: [call_api]
    rate_limits:
      - scope: user
        max_calls: 10
        window_seconds: 60
```

The default store is in-memory. For distributed deployments, plug in `RedisRateLimitStore`:

```typescript
import { RedisRateLimitStore } from "veto-sdk";
const store = new RedisRateLimitStore(redisClient, "veto:rl:");
```

### Audit chain

Every decision is appended to a tamper-evident hash chain. Each record's SHA-256 hash covers the previous hash plus the record's deterministic JSON serialization. Mutating any historical record invalidates all subsequent hashes.

```typescript
import { computeChainHash, GENESIS_HASH } from "veto-sdk";

let prevHash = GENESIS_HASH;
const hash = computeChainHash(prevHash, {
  tool: "transfer_funds",
  decision: "allow",
});
```

Verify integrity from the CLI:

```bash
npx veto-cli audit verify
```

### Policy testing

YAML fixture files validated against your policy with deterministic replay -- no LLM, no network.

```yaml
# ./veto/tests/transfers.yaml
suite: Transfer rules
tests:
  - id: block-large-transfer
    tool: transfer_funds
    arguments: { amount: 5000 }
    expect:
      decision: block
      rule_id: block-large-transfers
```

```bash
npx veto-cli test              # run all fixtures
npx veto-cli test --coverage   # show untested rule IDs
```

### SSE proxy

Intercept OpenAI and Anthropic streaming responses, validate tool calls against policies before forwarding to the client.

```bash
npx veto-cli intercept --port 8080 --target https://api.openai.com
```

Point your application at `http://localhost:8080` instead of the provider URL. Supports auto-detection of OpenAI and Anthropic SSE formats.

### OpenTelemetry

Optional `@opentelemetry/api` peer dependency. When installed, Veto instruments guard checks with spans. When not installed, all tracing functions are no-ops -- zero overhead.

### Webhooks

Send decision events to external systems. Built-in formatters for Slack, PagerDuty, generic JSON, and CEF (ArcSight). Configure webhook endpoints per event type: `tool_call_blocked`, `approval_requested`, `rate_limit_exceeded`, and others.

## skills.sh skill (coding agents)

```bash
npx skills add PlawIO/veto
```

Installs `veto-policy-runtime` — gives Claude Code, Cursor, and Windsurf safe, non-destructive policy operations without any SDK integration. Ideal for teams that want guardrails at the coding-agent level.

## Real-world example: guarded MCP trading agent

Veto also fits agent runtimes outside coding workflows. One practical pattern is a Polymarket MCP server where market reads stay open, mutating tools are policy-gated, and larger actions route to approval before execution.

See the [Guarded Polymarket MCP guide](./docs/polymarket-mcp-guide.md) for the architecture and YAML rules, or the full reference implementation in [PlawIO/polymarket-cli-veto](https://github.com/PlawIO/polymarket-cli-veto).

## Veto Cloud

The OSS SDK runs entirely local. [Veto Cloud](https://veto.so) adds:

- Natural language → policy YAML (no manual YAML writing)
- Central policy sync across all team repos
- Dashboard: decisions, blocked calls, pending approvals
- Approval workflows for human-in-the-loop at scale
- Rate limiting (in-memory + Redis)
- Tamper-evident audit chain
- OpenTelemetry tracing integration
- SSO, audit export, compliance reporting

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). On your first PR, a bot will ask you to sign the [CLA](./CLA.md) — takes 30 seconds, one comment.

## Security

Report vulnerabilities to [security@plaw.io](mailto:security@plaw.io). See [SECURITY.md](./SECURITY.md) for the full disclosure policy.

## License

Apache-2.0 © [Plaw, Inc.](https://plaw.io)
