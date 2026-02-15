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
mode: "strict"  # "strict" blocks calls, "log" only logs them

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

## CLI Commands

| Command | Description |
|---------|-------------|
| `npx veto init` | Initialize Veto in current directory |
| `npx veto version` | Show version |

## General Rule YAML Format

Each rule file (e.g., `veto/rules/policy.yaml`) can contain one or more rules.

```yaml
rules:
  - id: unique-rule-id           # [Required] Unique identifier for the rule
    name: Human readable name    # [Required] Descriptive name for logging
    enabled: true                # [Optional] Default: true
    severity: high               # [Optional] critical, high, medium, low, info. Default: medium
    action: block                # [Required] block, warn, log, allow.
    
    # Scope: Which tools does this rule apply to?
    tools:                       # [Optional] List of tool names.
      - make_payment             # If omitted or empty, applies to ALL tools (Global Rule).
      
    # Static Conditions (Optional):
    # Evaluated locally before LLM validation. Fast checks for specific values.
    conditions:
      - field: arguments.amount  # Dot notation for nested arguments
        operator: greater_than   # equals, contains, starts_with, ends_with, greater_than, less_than
        value: 1000

    # description (Optional):
    # Natural language guidance for the validation LLM.
    description: "Ensure the payment recipient is a verified vendor."
```

## Rule Matching Logic

Veto uses a two-step process to determine if a tool call is safe:

### 1. Rule Selection (Which rules apply?)
Veto selects rules based on the `tools` list in your YAML:
*   **Tool-Specific Rules**: If a rule lists specific tools (e.g., `tools: [make_payment]`), it ONLY applies when those tools are called.
*   **Global Rules**: If `tools` is missing or empty `[]`, the rule activates for **EVERY** tool call. Use this for universal policies (e.g., "Do not reveal internal file paths").

### 2. Validation Execution
For each intercepted tool call, Veto aggregates all applicable rules (Global + Specific) and validates them:
*   **Static Conditions**: If `conditions` are defined, they are checked first by the Validation Engine. If a condition matches (e.g., `amount > 1000`), the rule triggers immediately.
*   **Semantic Validation**: If no static conditions are matched (or none exist), the rule's `name` and `description` are passed to the LLM (via API, Kernel, or Custom provider) to semantically verify if the tool call violates the rule context.

## License

MIT
