# Veto

A guardrail system for AI agent tool calls. Veto intercepts and validates tool calls made by AI models before execution.

## How It Works

1. **Initialize** Veto.
2. **Wrap** your tools using `veto.wrap()`.
3. **Pass** the wrapped tools to your AI agent/model.

When the AI model calls a tool, Veto automatically:

1. Intercepts the call.
2. Validates arguments against your rules (via YAML & LLM).
3. Blocks or Allows execution based on the result.

The AI model remains unaware of the guardrail - the tool interface is preserved.

## Installation

```bash
npm install veto-sdk
```

For a complete bank transfer escalation example, see the [HITL guide](../../docs/hitl-guide.md).

## Quick Start

### 1. Initialize Veto

Run the CLI to create configuration:

```bash
npx veto init
```

This creates a `veto/` directory with `veto.config.yaml` and default rules.

### 2. Wrap Your Tools

Veto's `wrap()` method is provider-agnostic. It works with LangChain, Vercel AI SDK, or any custom tool object.

```typescript
import { Veto } from 'veto-sdk';
import { tool } from '@langchain/core/tools'; // Example with LangChain

// 1. Define your tools normally
const myTools = [
  tool(async (args) => { ... }, { name: 'my_tool', ... }),
  // ...
];

// 2. Initialize Veto
const veto = await Veto.init();

// 3. Wrap tools (Validation logic is injected)
// Types are preserved: wrappedTools has same type as myTools
const wrappedTools = veto.wrap(myTools);

// 4. Pass to your Agent/LLM
const agent = createAgent({
  tools: wrappedTools,
  // ...
});
```

### 3. Configure Rules

Edit `veto/rules/financial.yaml` (example):

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

# Operating mode
mode: "strict" # "strict" blocks calls, "log" only logs them

# Validation Backend
validation:
  mode: "custom" # "api", "kernel", or "custom"

# Custom Provider (if mode is custom)
custom:
  provider: "gemini" # or openai, anthropic
  model: "gemini-3-flash-preview"

# Logging
logging:
  level: "info"

# Rules
rules:
  directory: "./rules"
  recursive: true
# Local approval callback (for action: require_approval)
# approval:
#   callbackUrl: "http://localhost:8787/approvals"
#   timeout: 30000
#   timeoutBehavior: "block" # "block" (default) or "allow"
#   includeCustomContext: false # opt-in: forward validation context.custom to webhook
#   responseSchema:
#     decisionField: "decision"
#     reasonField: "reason"
```

## API Reference

### `Veto.init(options?)`

Initialize Veto. Loads configuration from `./veto` by default.

```typescript
const veto = await Veto.init();
```

### `veto.wrap<T>(tools: T[]): T[]`

Wraps an array of tools. The returned tools have Veto validation injected into their execution handler. Preserves the original tool types for full compatibility with your AI framework.

```typescript
const wrappedForLangChain = veto.wrap(langChainTools);
const wrappedForVercel = veto.wrap(vercelTools);
```

### `veto.wrapTool<T>(tool: T): T`

Wraps a single tool instance.

```typescript
const safeTool = veto.wrapTool(myTool);
```

### `veto.getHistoryStats()`

Returns statistics about allowed vs blocked calls.

```typescript
const stats = veto.getHistoryStats();
console.log(stats);
// { totalCalls: 5, allowedCalls: 4, deniedCalls: 1, ... }
```

### `veto.clearHistory()`

Resets the history statistics.

```typescript
veto.clearHistory();
```

### `veto.exportDecisions(format)`

Exports decision history as JSON or CSV.

```typescript
const jsonAudit = veto.exportDecisions("json");
const csvAudit = veto.exportDecisions("csv");
```

## CLI Commands

Canonical package:

```bash
npx veto-cli@latest
```

Compatibility package (still supported):

```bash
npx veto-sdk@latest
```

| Command                                                                               | Description                                     |
| ------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `veto`                                                                                | Start Veto Studio (default interactive mode)    |
| `veto studio`                                                                         | Start Veto Studio explicitly                    |
| `veto repl --legacy`                                                                  | Start legacy line-based REPL                    |
| `veto policy generate --tool <name> --prompt <text> [--target local\|cloud] [--json]` | Generate policy YAML (interactive-independent)  |
| `veto policy apply --file <path> [--target local\|cloud] [--json]`                    | Apply policy file locally or create cloud draft |
| `veto guard check --tool <name> --args <json> [--mode ...] [--json]`                  | Run a deterministic guard check for a tool call |
| `veto cloud login`                                                                    | Start cloud device login                        |
| `veto cloud whoami`                                                                   | Show cloud CLI context                          |
| `veto doctor`                                                                         | Runtime/auth/connectivity diagnostics           |
| `veto init`, `veto learn`, `veto compile`, `veto test`, `veto scan`, `veto diff`      | Existing core workflows                         |
| `veto version`                                                                        | Show version                                    |

Migration notes:

- Legacy REPL is still available via `veto repl --legacy`.
- `veto-cli` is the canonical package. `veto-sdk` CLI path remains compatibility-first.
- Studio template fallback is opt-in (`--demo-template` or `studio.generation.allowTemplateFallback: true`).
- Studio defaults to Ink on Node.js. OpenTUI remains optional (`--renderer opentui`) for Bun runtimes.

Veto Studio examples:

```bash
# Start full-screen Veto Studio
npx veto-cli@latest

# Start Studio with explicit flag
npx veto-cli@latest studio

# Force ANSI renderer
npx veto-cli@latest studio --renderer ansi

# Open a specific workspace from multi-repo root
npx veto-cli@latest studio --directory ./packages/sdk

# Enable explicit template demo mode (otherwise no silent fallback in Studio)
npx veto-cli@latest studio --demo-template

# Legacy line-based REPL remains available
npx veto-cli@latest repl --legacy
```

Legacy REPL slash-command examples:

```bash
# Test a call locally (no network)
/test transfer_funds({"amount": 50000})

# Ask a what-if question in plain language
what would happen if my agent tried to transfer $50,000?

# Explain a rule
/explain fin-block-high-transfers

# Run scenario suite
test my agent against current rules

# Export merged rules
/export
```

Coverage audit examples:

```bash
# Human-readable coverage report
npx veto scan

# Scan an explicit workspace directory
npx veto scan --directory ./packages/sdk

# Include examples/ and tests/ directories in scan scope
npx veto scan --include-examples --include-tests

# CI gate: fail when uncovered tools are found
npx veto scan --fail-uncovered

# Include inline YAML snippets for uncovered tools
npx veto scan --suggest

# Machine-readable output for CI pipelines
npx veto scan --format json
```

Policy diff examples:

```bash
# Compare working rule file against HEAD (git snapshot)
npx veto diff financial.yaml

# Compare two explicit snapshots (file or directory mode)
npx veto diff --old ./rules-v1 --new ./rules-v2

# Include deterministic replay impact from historical calls
npx veto diff financial.yaml --log calls.jsonl

# Machine-readable structural + impact report
npx veto diff --old ./rules-v1 --new ./rules-v2 --log calls.jsonl --format json
```

## General Rule YAML Format

Each rule file (e.g., `veto/rules/policy.yaml`) can contain one or more rules.

```yaml
rules:
  - id: unique-rule-id # [Required] Unique identifier for the rule
    name: Human readable name # [Required] Descriptive name for logging
    enabled: true # [Optional] Default: true
    severity: high # [Optional] critical, high, medium, low, info. Default: medium
    action: block # [Required] block, warn, log, allow, require_approval.

    # Scope: Which tools does this rule apply to?
    tools: # [Optional] List of tool names.
      - make_payment # If omitted or empty, applies to ALL tools (Global Rule).

    # Static Conditions (Optional):
    # Evaluated locally before LLM validation. Fast checks for specific values.
    conditions:
      - field: arguments.amount # Dot notation for nested arguments
        operator: greater_than # equals, contains, starts_with, ends_with, greater_than, less_than
        value: 1000

    # description (Optional):
    # Natural language guidance for the validation LLM.
    description: "Ensure the payment recipient is a verified vendor."
```

## Rule Matching Logic

Veto uses a two-step process to determine if a tool call is safe:

### 1. Rule Selection (Which rules apply?)

Veto selects rules based on the `tools` list in your YAML:

- **Tool-Specific Rules**: If a rule lists specific tools (e.g., `tools: [make_payment]`), it ONLY applies when those tools are called.
- **Global Rules**: If `tools` is missing or empty `[]`, the rule activates for **EVERY** tool call. Use this for universal policies (e.g., "Do not reveal internal file paths").

### 2. Validation Execution

For each intercepted tool call, Veto aggregates all applicable rules (Global + Specific) and validates them:

- **Static Conditions**: If `conditions` are defined, they are checked first by the Validation Engine. If a condition matches (e.g., `amount > 1000`), the rule triggers immediately.
- **Semantic Validation**: If no static conditions are matched (or none exist), the rule's `name` and `description` are passed to the LLM (via API, Kernel, or Custom provider) to semantically verify if the tool call violates the rule context.

## License

MIT
