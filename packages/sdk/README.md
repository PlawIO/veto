# veto-sdk

![npm](https://img.shields.io/npm/v/veto-sdk?color=000000)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](../../LICENSE)

TypeScript policy runtime for AI agent tool calls. Veto wraps your tools, evaluates deterministic policy before each handler runs, and preserves the original tool interface.

## Install

```bash
npm install veto-sdk
```

## Quick start

```ts
import { protect } from "veto-sdk";

const safeTools = await protect(tools);
const agent = createAgent({ tools: safeTools });
```

`protect(tools)` is the public entrypoint. It loads `./veto/veto.config.yaml` and `./veto/rules/*.yaml` when present. Without local policy or explicit options, it uses the built-in `@veto/safe-defaults` pack in observe mode: suspicious destructive shell, file, database, or money-movement network patterns are warned/logged, not blocked.

## 60-second denied call

```bash
npm install veto-sdk
npx --package veto-cli@latest veto init
node examples/60-second-denied-call/denied-call.mjs
```

`npx --package veto-cli@latest veto init` creates blocking local defaults in `veto/rules/defaults.yaml`, so the example deterministically denies `bash` with `rm -rf` before the handler runs. No provider SDK or API key is required.

## Python parity

```python
from veto import protect

safe = await protect(tools)
agent = create_agent(tools=safe)
```

## Local policy

```bash
npx --package veto-cli@latest veto init
```

For public no-install CLI usage, use the owned `veto-cli` package form: `npx --package veto-cli@latest veto ...`. The unscoped `veto` npm name is reserved/local pending transfer; `veto-cli` and `veto-sdk` bins remain compatibility paths for existing users.

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

Actions are `block`, `allow`, `warn`, `log`, and `require_approval`.

## Runtime adapters

All adapters are dependency-free TypeScript surfaces unless noted; provider-specific schemas reuse the SDK provider adapters.

| Runtime                 | Import                                | Artifact                                     | Status         |
| ----------------------- | ------------------------------------- | -------------------------------------------- | -------------- |
| Provider-agnostic tools | `veto-sdk`                            | `protect(tools)`, `Veto.wrap()`              | Canonical path |
| Vercel AI SDK           | `veto-sdk/integrations/vercel-ai`     | middleware + guard helper                    | Supported      |
| OpenAI Agents           | `veto-sdk/integrations/openai-agents` | input/output/tool guardrails + guard helper  | Supported      |
| LangChain / LangGraph   | `veto-sdk/integrations/langchain`     | middleware, ToolNode, callback, guard helper | Supported      |
| MCP                     | `veto-sdk/providers/adapters`         | MCP conversion + `Veto.wrapMCPTools()`       | Supported      |
| Browser Use             | `veto-sdk/integrations/browser-use`   | action wrapping                              | Supported      |
| OpenClaw                | `veto-sdk/integrations/openclaw`      | before/after tool hooks                      | Supported      |
| Claude SDK              | `veto-sdk/integrations/claude-sdk`    | Anthropic tool/tool-use helpers              | Added P2       |
| Google ADK              | `veto-sdk/integrations/google-adk`    | function declarations/calls                  | Added P2       |
| Mastra                  | `veto-sdk/integrations/mastra`        | tool wrappers                                | Added P2       |
| AutoGen                 | `veto-sdk/integrations/autogen`       | function/tool wrappers                       | Added P2       |
| CrewAI                  | `veto-sdk/integrations/crewai`        | tool-function wrappers                       | Added P2       |

```ts
import { guardClaudeToolUse } from "veto-sdk/integrations/claude-sdk";
import { guardGoogleADKFunctionCall } from "veto-sdk/integrations/google-adk";
import { wrapMastraTool } from "veto-sdk/integrations/mastra";
import { wrapAutoGenFunction } from "veto-sdk/integrations/autogen";
import { wrapCrewAITool } from "veto-sdk/integrations/crewai";

const claudeDecision = await guardClaudeToolUse(veto, toolUse);
const googleDecision = await guardGoogleADKFunctionCall(veto, functionCall);
const safeMastraTool = wrapMastraTool(veto, mastraTool);
const safeAutoGenFn = wrapAutoGenFunction(veto, "delete_file", deleteFile);
const safeCrewTool = wrapCrewAITool(veto, crewTool);
```

## Optional semantic PII output detection

Output rules can opt into NVIDIA GLiNER PII detection for semantic redaction or blocking beyond regex fallbacks. Enable it explicitly and provide `NVIDIA_API_KEY` or `VETO_NVIDIA_API_KEY`; the synchronous `validateOutput()` API remains regex-only, while wrapped tools and `validateOutputAsync()` run the detector when configured.

```yaml
pii:
  enabled: true
  provider: "nvidia-gliner-pii"
  model: "nvidia/gliner-pii"
  threshold: 0.45

output_rules:
  - id: redact-pii
    name: Redact semantic PII
    enabled: true
    severity: high
    action: redact
    metadata:
      detector: "nvidia-gliner-pii"
      labels: [email, phone_number, ssn, credit_debit_card]
      fields: [output]
    redact_with: "[REDACTED_PII]"
```

Detector failures fail open by default. Do not enable this in browser builds with client-side NVIDIA keys.

## API

### `protect(tools, options?)`

```ts
import { protect } from "veto-sdk";

const safeTools = await protect(tools);
```

Python equivalent:

```python
from veto import protect

safe_tools = await protect(tools)
```

Options mirror the advanced runtime configuration when you need explicit policy sources:

```ts
const safeTools = await protect(tools, {
  rules: [
    {
      id: "no-prod-deploy",
      name: "Block direct production deploys",
      enabled: true,
      severity: "critical",
      action: "block",
      tools: ["deploy"],
      conditions: [
        {
          field: "arguments.environment",
          operator: "equals",
          value: "production",
        },
      ],
    },
  ],
  mode: "strict",
});
```

Python equivalent:

```python
safe_tools = await protect(
    tools,
    rules=[
        {
            "id": "no-prod-deploy",
            "name": "Block direct production deploys",
            "enabled": True,
            "severity": "critical",
            "action": "block",
            "tools": ["deploy"],
            "conditions": [
                {
                    "field": "arguments.environment",
                    "operator": "equals",
                    "value": "production",
                }
            ],
        }
    ],
    mode="strict",
)
```

Supported policy sources:

- `rules`: inline deterministic rules
- `pack`: built-in policy pack such as `@veto/coding-agent`
- `configDir`: explicit local config directory
- `apiKey` / `endpoint`: cloud or self-hosted PDP

### Advanced: `Veto.init()` + `.wrap()`

`Veto.init()` remains supported for advanced/internal-facing integrations that need a reusable instance, direct `guard()` calls, event hooks, audit export, or explicit self-host/cloud configuration.

```ts
import { Veto } from "veto-sdk";

const veto = await Veto.init({ configDir: "./veto", mode: "strict" });
const safeTools = veto.wrap(tools);
const decision = await veto.guard("transfer_funds", { amount: 1500 });
```

Python equivalent:

```python
from veto import Veto, VetoOptions

veto = await Veto.init(VetoOptions(config_dir="./veto", mode="strict"))
safe_tools = veto.wrap(tools)
decision = await veto.guard("transfer_funds", {"amount": 1500})
```

### `veto.guard(toolName, args, context?)`

```ts
const result = await veto.guard("transfer_funds", { amount: 5000 });
// { decision: 'deny', reason: 'Amount exceeds limit', ruleId: 'block-large-transfers' }
```

Python equivalent:

```python
result = await veto.guard("transfer_funds", {"amount": 5000})
# ValidationResult(decision="deny", reason="Amount exceeds limit", rule_id="block-large-transfers")
```

### Decision history

```ts
const stats = veto.getHistoryStats();
const json = veto.exportDecisions("json");
const csv = veto.exportDecisions("csv");
```

Python equivalent:

```python
stats = veto.get_history_stats()
json_audit = veto.export_decisions("json")
csv_audit = veto.export_decisions("csv")
```

Decision export is local to your process unless you explicitly configure a remote endpoint.

## Policy packs

Built-in packs ship in `packs/` and are referenced with `extends` or `protect(..., { pack })`:

- `@veto/safe-defaults` observe-mode zero-config defaults
- `@veto/coding-agent`
- `@veto/financial`
- `@veto/crypto-trading`
- `@veto/browser-automation`
- `@veto/data-access`
- `@veto/communication`
- `@veto/deployment`
- `@veto/economic-agent`
- `@veto/soc2-lite`, `@veto/hipaa-lite`, `@veto/eu-ai-act-starter` starter packs

## Self-host / BYOC boundary

The SDK can point at a self-hosted PDP with `endpoint`, but customer-plane data stays in the customer environment unless you explicitly configure outbound integrations. Public BYOC artifacts in the repo state the boundary: customer policy, decision rows, tool args, agent IDs, user IDs, Slack content, prompts, environment variables, and secrets do not cross to Plaw.

## License

Apache-2.0
