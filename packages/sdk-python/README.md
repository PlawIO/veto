# veto

[![PyPI](https://img.shields.io/pypi/v/veto?color=000000)](https://pypi.org/project/veto)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](../../LICENSE)

Python policy runtime for AI agent tool calls. Veto wraps your tools, evaluates deterministic policy before each handler runs, and preserves the original tool interface.

## Install

```bash
pip install veto
```

With provider extras:

```bash
pip install veto[openai]
pip install veto[anthropic]
pip install veto[gemini]
pip install veto[all]
```

## Quick start

```python
from veto import protect

safe = await protect(tools)
agent = create_agent(tools=safe)
```

`protect(tools)` is the public entrypoint. It loads `./veto/veto.config.yaml` and `./veto/rules/*.yaml` when present. Without local policy or explicit options, it uses the built-in `@veto/safe-defaults` pack in observe mode: suspicious destructive shell, file, database, or money-movement network patterns are warned/logged, not blocked.

## TypeScript parity

```ts
import { protect } from "veto-sdk";

const safeTools = await protect(tools);
const agent = createAgent({ tools: safeTools });
```

## Local policy

```bash
veto init
```

```yaml
rules:
  - id: limit-transfers
    name: Limit large transfers
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

## API

### `protect(tools, **kwargs)`

```python
from veto import protect

safe = await protect(tools)
```

Explicit policy source example:

```python
safe = await protect(
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
                {"field": "arguments.environment", "operator": "equals", "value": "production"}
            ],
        }
    ],
    mode="strict",
)
```

### Advanced: `Veto.init()` + `.wrap()`

`Veto.init()` remains supported for advanced/internal-facing integrations that need a reusable instance, direct `guard()` calls, event hooks, audit export, or explicit self-host/cloud configuration.

```python
from veto import Veto, VetoOptions

veto = await Veto.init(VetoOptions(config_dir="./veto", mode="strict"))
safe = veto.wrap(tools)
result = await veto.guard("transfer_funds", {"amount": 1500})
```

### Decision history

```python
stats = veto.get_history_stats()
json_audit = veto.export_decisions("json")
csv_audit = veto.export_decisions("csv")
```

Decision export is local to your process unless you explicitly configure a remote endpoint.

## Policy packs

Built-in packs match the TypeScript SDK: `@veto/safe-defaults`, `@veto/coding-agent`, `@veto/crypto-trading`, `@veto/financial`, `@veto/browser-automation`, `@veto/data-access`, `@veto/communication`, `@veto/deployment`, `@veto/economic-agent`, `@veto/soc2-lite`, `@veto/hipaa-lite`, and `@veto/eu-ai-act-starter`.

## MCP and pipeline-backed rules

Python now exposes the same MCP adapter and feed-backed rule helpers as TypeScript:

```python
from veto import InMemoryFeedProvider, FeedSnapshot, Veto

feed = InMemoryFeedProvider()
feed.put("gambling-sites", FeedSnapshot(data=["casino.example"], refreshed_at_ms=0))

veto = Veto.from_rules(
    rules=[{
        "id": "block-feed-url",
        "name": "Block feed URLs",
        "action": "block",
        "tools": ["browser_go_to_url"],
        "conditions": [{
            "field": "arguments.url",
            "operator": "in",
            "value": {
                "kind": "feed",
                "feed_id": "gambling-sites",
                "version": "latest",
                "max_staleness_sec": 3600,
                "fallback": "fail_open",
            },
        }],
    }],
    feed_provider=feed,
)
```

## Economic, model, and extractor parity

Python also exposes the TypeScript SDK's economic authorization helpers, kernel/custom validation modes, and deterministic content extractor:

```python
from veto import Veto, extract_entities, create_x402_connector

entities = extract_entities("Salary: $150,000. Card: 4111 1111 1111 1111")
assert entities.has_sensitive_pii

veto = Veto.from_rules(
    rules=[],
    economic_policy={
        "budgets": [{"scope": "session", "limit": 50, "currency": "USD", "window": "session"}],
        "cost_extraction": {"default": "arguments.cost"},
    },
)
decision = await veto.guard("paid_tool", {"cost": 60})
assert decision.economic_denial.reason == "budget_exceeded"
```

## Self-host / BYOC boundary

The SDK can point at a self-hosted PDP with `endpoint`, but customer-plane data stays in the customer environment unless you explicitly configure outbound integrations. Customer policy, decision rows, tool args, agent IDs, user IDs, Slack content, prompts, environment variables, and secrets do not cross to Plaw.

## License

Apache-2.0
