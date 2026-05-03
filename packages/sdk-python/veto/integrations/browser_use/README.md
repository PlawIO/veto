# Veto × Browser-Use Integration

Add Veto policy checks to [browser-use](https://github.com/browser-use/browser-use) AI browser agents. Every browser action (navigate, click, input, search, etc.) is validated against your Veto policies before execution.

For ordinary Python tool lists, start with the public entrypoint:

```python
from veto import protect

safe = await protect(tools)
```

## Installation

```bash
pip install veto browser-use
```

## Quick Start

```python
import asyncio
from veto import Veto, VetoOptions
from veto.integrations.browser_use import wrap_browser_use
from browser_use import Agent, BrowserSession
from langchain_google_genai import ChatGoogleGenerativeAI

async def main():
    # 1. Advanced integration: create an explicit Veto instance
    veto = await Veto.init(VetoOptions(api_key="your-veto-api-key"))

    # 2. Create Veto-wrapped browser tools
    tools = await wrap_browser_use(veto)

    # 3. Use with browser-use Agent as normal
    agent = Agent(
        task="Search DuckDuckGo for 'best laptops 2025'",
        llm=ChatGoogleGenerativeAI(model="gemini-2.0-flash"),
        tools=tools,
        browser_session=BrowserSession(),
    )
    await agent.run()

asyncio.run(main())
```

That's it — use `protect(tools)` for ordinary tools, or `wrap_browser_use(veto)` when the browser-use adapter needs an explicit Veto instance.

## How It Works

`wrap_browser_use(veto)` returns a standard browser-use `Tools` instance where every browser action is validated through Veto Cloud before execution:

1. **Tool schemas are auto-synced** — all browser-use actions (navigate, click, input, search, scroll, extract, done) are automatically registered with Veto Cloud, so you can configure policies immediately from the dashboard.

2. **`act()` is intercepted** — the `Tools.act()` method is the single dispatch point for all browser actions. The integration subclasses `Tools` and validates each action against your Veto policies before calling the original implementation.

3. **Denied actions return errors** — if a policy blocks an action, the agent receives an `ActionResult` with an error message. The agent can then adapt its behavior (e.g., try a different URL or rephrase input).

## Configuration

### Choosing Which Actions to Validate

By default, the following actions are validated:

- `navigate` — URL navigation
- `search` — search engine queries
- `click` — element clicks
- `input` — text input
- `extract` — content extraction
- `scroll` — page scrolling
- `done` — task completion

You can customize this:

```python
# Only validate navigation and input
tools = await wrap_browser_use(
    veto,
    validated_actions={"navigate", "input"},
)
```

### Callbacks

You can add callbacks for allow/deny events:

```python
async def on_allow(action_name: str, params: dict):
    print(f"ALLOWED: {action_name}")

async def on_deny(action_name: str, params: dict, reason: str):
    print(f"BLOCKED: {action_name} — {reason}")

tools = await wrap_browser_use(
    veto,
    on_allow=on_allow,
    on_deny=on_deny,
)
```

## Managing Policies

Policies can be created, updated, activated, and deactivated directly from the [Veto Dashboard](https://app.veto.dev) — no code changes or redeployment required. This means you can:

- **Activate/deactivate policies on the fly** — toggle a policy off during debugging, re-enable it in production.
- **Update constraints in real time** — change a URL allowlist regex or adjust a max length limit without restarting your agent.
- **Monitor live** — view the live feed of allow/deny decisions as your agent runs.

You can also manage policies programmatically via the Veto API (see the example policies below).

## Example Policies

### URL Allowlist (navigate)

Only allow navigation to approved domains:

| Field    | Value                                                          |
| -------- | -------------------------------------------------------------- |
| Tool     | `navigate`                                                     |
| Mode     | `deterministic`                                                |
| Argument | `url`                                                          |
| Regex    | `^https?://(www\.)?(google\.com\|wikipedia\.org\|github\.com)` |

### Block PII in Input (input)

Prevent the agent from typing sensitive data like credit card numbers:

| Field      | Value                  |
| ---------- | ---------------------- |
| Tool       | `input`                |
| Mode       | `deterministic`        |
| Argument   | `text`                 |
| Regex      | `^[a-zA-Z0-9 .,'\"]+$` |
| Max Length | `500`                  |

### Search Query Length Limit (search)

Cap search query length:

| Field      | Value           |
| ---------- | --------------- |
| Tool       | `search`        |
| Mode       | `deterministic` |
| Argument   | `query`         |
| Max Length | `200`           |

## API Reference

### `wrap_browser_use(veto, *, validated_actions=None, on_allow=None, on_deny=None)`

Create a browser-use `Tools` instance with Veto guardrails.

**Parameters:**

- `veto` (`Veto`) — An initialized Veto instance.
- `validated_actions` (`set[str]`, optional) — Set of action names to validate. Defaults to all standard actions.
- `on_allow` (async callable, optional) — Called with `(action_name, params)` when an action is allowed.
- `on_deny` (async callable, optional) — Called with `(action_name, params, reason)` when an action is denied.

**Returns:** A `Tools` instance (drop-in replacement for `browser_use.tools.service.Tools`).
