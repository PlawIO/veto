# veto

[![PyPI](https://img.shields.io/pypi/v/veto?color=000000)](https://pypi.org/project/veto)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](../../LICENSE)

A guardrail system for AI agent tool calls. Veto intercepts and validates tool calls made by AI models before execution — blocking, allowing, or routing to human approval.

## How it works

1. **Initialize** Veto (loads your YAML rules).
2. **Wrap** your tools with `veto.wrap()`.
3. **Pass** the wrapped tools to your agent — interface unchanged.

When the AI calls a tool, Veto automatically:

1. Intercepts the call.
2. Validates arguments against your rules (deterministic conditions first, optional LLM for semantic rules).
3. **allow** → executes · **block** → denied with reason · **ask** → approval queue.

The agent is unaware of the guardrail.

## Installation

```bash
pip install veto
```

With LLM provider support:

```bash
pip install veto[openai]      # OpenAI
pip install veto[anthropic]   # Anthropic
pip install veto[gemini]      # Google Gemini
pip install veto[all]         # All providers
```

For a complete human-in-the-loop example, see the [HITL guide](../../docs/hitl-guide.md).

## Quick start

### 1. Initialize Veto

```bash
veto init
```

Creates `./veto/veto.config.yaml` and default rules.

### 2. Wrap your tools

```python
from veto import Veto

my_tools = [
    {"name": "my_tool", "handler": my_handler},
]

veto = await Veto.init()
wrapped_tools = veto.wrap(my_tools)

agent = create_agent(tools=wrapped_tools)
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

mode: "strict"   # "strict" blocks calls, "log" only logs them

validation:
  mode: "custom"   # "api" or "custom"

custom:
  provider: "gemini"   # openai | anthropic | gemini
  model: "gemini-3-flash-preview"

logging:
  level: "info"

rules:
  directory: "./rules"
  recursive: true
```

## API reference

### `Veto.init(options?)`

Initialize Veto. Loads configuration from `./veto` by default.

```python
veto = await Veto.init()
```

### `veto.wrap(tools)`

Wrap a list of tools. Injects Veto validation into each tool's execution handler.

```python
wrapped_tools = veto.wrap(my_tools)
```

### `veto.wrap_tool(tool)`

Wrap a single tool.

```python
safe_tool = veto.wrap_tool(my_tool)
```

### `veto.get_history_stats()`

Statistics on allowed vs blocked calls.

```python
stats = veto.get_history_stats()
# {"total_calls": 5, "allowed_calls": 4, "denied_calls": 1, ...}
```

### `veto.clear_history()`

Reset history statistics.

### `veto.export_decisions(format)`

Export decision history as JSON or CSV.

```python
json_audit = veto.export_decisions("json")
csv_audit  = veto.export_decisions("csv")
```

## Rule YAML format

Same schema as the TypeScript SDK. See [full rule reference](../sdk/README.md#rule-yaml-format).

```yaml
rules:
  - id: unique-rule-id
    name: Human readable name
    action: block           # block | warn | log | allow | ask
    tools: [make_payment]
    conditions:
      - field: arguments.amount
        operator: greater_than
        value: 1000
    description: "Semantic description for LLM validation (optional)."
```

## License

Apache-2.0 © [Plaw, Inc.](https://plaw.io)
