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
pip install veto
```

For a complete bank transfer escalation example, see the [HITL guide](../../docs/hitl-guide.md).

For LLM provider support:

```bash
pip install veto[openai]      # OpenAI support
pip install veto[anthropic]   # Anthropic support
pip install veto[gemini]      # Google Gemini support
pip install veto[all]         # All providers
```

## Quick Start

### 1. Initialize Veto

Run the CLI to create configuration:

```bash
veto init
```

This creates a `veto/` directory with `veto.config.yaml` and default rules.

### 2. Wrap Your Tools

```python
from veto import Veto

# 1. Define your tools normally
my_tools = [
    {"name": "my_tool", "handler": my_handler, ...},
    # ...
]

# 2. Initialize Veto
veto = await Veto.init()

# 3. Wrap tools (Validation logic is injected)
wrapped_tools = veto.wrap(my_tools)

# 4. Pass to your Agent/LLM
agent = create_agent(
    tools=wrapped_tools,
    # ...
)
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
  mode: "custom" # "api" or "custom"

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

```python
veto = await Veto.init()
```

### `veto.wrap(tools)`

Wraps an array of tools. The returned tools have Veto validation injected into their execution handler.

```python
wrapped_tools = veto.wrap(my_tools)
```

### `veto.wrap_tool(tool)`

Wraps a single tool instance.

```python
safe_tool = veto.wrap_tool(my_tool)
```

### `veto.get_history_stats()`

Returns statistics about allowed vs blocked calls.

```python
stats = veto.get_history_stats()
print(stats)
# {"total_calls": 5, "allowed_calls": 4, "denied_calls": 1, ...}
```

### `veto.clear_history()`

Resets the history statistics.

```python
veto.clear_history()
```

### `veto.export_decisions(format)`

Exports decision history as JSON or CSV.

```python
json_audit = veto.export_decisions("json")
csv_audit = veto.export_decisions("csv")
```

## CLI Commands

| Command        | Description                          |
| -------------- | ------------------------------------ |
| `veto init`    | Initialize Veto in current directory |
| `veto version` | Show version                         |

## License

MIT
