# veto-sdk

[![npm](https://img.shields.io/npm/v/veto-sdk?color=000000)](https://www.npmjs.com/package/veto-sdk)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](../../LICENSE)

A guardrail system for AI agent tool calls. Veto intercepts and validates tool calls made by AI models before execution — blocking, allowing, or routing to human approval.

## How it works

1. **Initialize** Veto (loads your YAML rules).
2. **Wrap** your tools with `veto.wrap()`.
3. **Pass** the wrapped tools to your agent — types preserved, interface unchanged.

When the AI calls a tool, Veto automatically:

1. Intercepts the call.
2. Validates arguments against your rules (deterministic conditions first, optional LLM for semantic rules).
3. **allow** → executes · **block** → denied with reason · **ask** → approval queue.

The agent is unaware of the guardrail.

## Installation

```bash
npm install veto-sdk
```

For a complete human-in-the-loop example, see the [HITL guide](../../docs/hitl-guide.md).

## Quick start

### 1. Initialize Veto

```bash
npx veto init
```

Creates `./veto/veto.config.yaml` and default rules.

### 2. Wrap your tools

`wrap()` is provider-agnostic — works with LangChain, Vercel AI SDK, or any custom tool object.

```typescript
import { Veto } from 'veto-sdk';
import { tool } from '@langchain/core/tools';

const myTools = [
  tool(async (args) => { /* ... */ }, { name: 'my_tool', /* ... */ }),
];

const veto = await Veto.init();

// Types are preserved: wrappedTools has the same type as myTools
const wrappedTools = veto.wrap(myTools);

const agent = createAgent({ tools: wrappedTools });
```

### 3. Configure rules

Edit `veto/rules/financial.yaml`:

```yaml
rules:
  - id: limit-transfers
    name: Limit large transfers
    action: block
    tools:
      - transfer_funds
    conditions:
      - field: arguments.amount
        operator: greater_than
        value: 1000
```

## Configuration

### veto.config.yaml

```yaml
version: "1.0"

# "strict" blocks calls, "log" only logs them
mode: "strict"

# Validation backend
validation:
  mode: "custom"   # "api", "kernel", or "custom"

# Custom provider (if mode is custom)
custom:
  provider: "gemini"   # openai | anthropic | gemini
  model: "gemini-3-flash-preview"

logging:
  level: "info"

rules:
  directory: "./rules"
  recursive: true

# Human-in-the-loop approval (for action: ask)
# approval:
#   callbackUrl: "http://localhost:8787/approvals"
#   timeout: 30000
#   timeoutBehavior: "block"
```

## API reference

### `Veto.init(options?)`

Initialize Veto. Loads configuration from `./veto` by default.

```typescript
const veto = await Veto.init();
```

### `veto.wrap<T>(tools: T[]): T[]`

Wrap an array of tools. Injects Veto validation into each tool's execution handler. Preserves types for full framework compatibility.

```typescript
const wrappedForLangChain = veto.wrap(langChainTools);
const wrappedForVercel    = veto.wrap(vercelTools);
```

### `veto.wrapTool<T>(tool: T): T`

Wrap a single tool.

```typescript
const safeTool = veto.wrapTool(myTool);
```

### `veto.getHistoryStats()`

Statistics on allowed vs blocked calls.

```typescript
const stats = veto.getHistoryStats();
// { totalCalls: 5, allowedCalls: 4, deniedCalls: 1, ... }
```

### `veto.clearHistory()`

Reset history statistics.

### `veto.exportDecisions(format)`

Export decision history as JSON or CSV.

```typescript
const json = veto.exportDecisions("json");
const csv  = veto.exportDecisions("csv");
```

## CLI commands

```bash
npx veto-cli@latest                                   # Veto Studio (interactive TUI)
npx veto-cli@latest policy generate --tool <name> --prompt <text>
npx veto-cli@latest guard check --tool <name> --args <json> --json
npx veto-cli@latest scan --fail-uncovered             # CI gate
```

→ [Full CLI reference](../cli/README.md)

## Rule YAML format

```yaml
rules:
  - id: unique-rule-id          # required
    name: Human readable name   # required
    enabled: true               # optional, default: true
    severity: high              # critical | high | medium | low | info
    action: block               # block | warn | log | allow | ask

    # Scope: which tools does this rule apply to?
    # Omit or leave empty to apply to ALL tools (global rule).
    tools:
      - make_payment

    # Static conditions (optional) — evaluated locally, zero latency
    conditions:
      - field: arguments.amount     # dot notation for nested args
        operator: greater_than      # equals | contains | starts_with | ends_with | greater_than | less_than
        value: 1000

    # Semantic guidance for LLM validation (optional)
    description: "Ensure the payment recipient is a verified vendor."
```

## Rule matching logic

Veto uses a two-step process:

1. **Rule selection** — rules with a matching `tools` list apply. Rules with no `tools` (global rules) apply to every call.
2. **Validation** — static `conditions` are checked first (local, no API call). If conditions match, the rule triggers immediately. Otherwise, the rule's `name` and `description` are sent to the LLM for semantic validation.

## License

Apache-2.0 © [Plaw, Inc.](https://plaw.io)
