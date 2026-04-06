# veto

[![PyPI](https://img.shields.io/pypi/v/veto?color=000000)](https://pypi.org/project/veto)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](../../LICENSE)

A guardrail system for AI agent tool calls. Veto intercepts and validates tool calls made by AI models before execution -- blocking, allowing, or routing to human approval.

## How it works

1. **Initialize** Veto (loads your YAML rules).
2. **Wrap** your tools with `veto.wrap()`.
3. **Pass** the wrapped tools to your agent -- interface unchanged.

When the AI calls a tool, Veto automatically:

1. Intercepts the call.
2. Validates arguments against your rules (deterministic conditions first, optional LLM for semantic rules).
3. **allow** -- executes. **block** -- denied with reason. **ask** -- routed to approval queue.

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

mode: "strict" # "strict" blocks calls, "log" only logs them

validation:
  mode: "custom" # "api" or "custom"

custom:
  provider: "gemini" # openai | anthropic | gemini
  model: "gemini-3-flash-preview"

logging:
  level: "info"

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

## Rate Limiting

Per-rule sliding window rate limits. In-memory store by default; bring your own store (e.g. Redis) by implementing the `RateLimitStore` protocol.

### Rule configuration

```yaml
rules:
  - id: throttle-emails
    name: Throttle email sending
    action: block
    tools:
      - send_email
    rate_limits:
      - scope: user # agent | user | session | global
        window_seconds: 60
        max_calls: 10
```

### Programmatic use

```python
from veto import evaluate_rate_limits, RateLimitEntry, RateLimitStore

limits = [RateLimitEntry(scope="global", max_calls=5, window_seconds=60)]

# ctx must have agent_id/user_id/session_id attributes matching the scope
reason = await evaluate_rate_limits(limits, ctx, tool_name="send_email", logger=logger)
if reason:
    print(f"Blocked: {reason}")
```

### Custom store

Implement the `RateLimitStore` protocol to back rate limits with Redis or another external store:

```python
from veto import RateLimitStore

class RedisRateLimitStore:
    def check_and_record(self, key: str, max_calls: int, window_ms: int) -> bool:
        # Return True if allowed, False if rate limited
        ...

    def clear(self) -> None:
        ...

reason = await evaluate_rate_limits(limits, ctx, "send_email", logger, store=my_store)
```

### Built-in store functions

```python
from veto import check_and_record, clear_store

allowed = check_and_record("my-key", max_calls=10, window_ms=60000)
clear_store()  # reset all rate limit state
```

## Audit Chain

SHA-256 hash chain for tamper-evident decision logging. Each hash is computed over the previous hash concatenated with a deterministic JSON serialization of the record.

```python
from veto import compute_chain_hash, GENESIS_HASH

chain_hash = GENESIS_HASH  # empty string

for decision in decisions:
    chain_hash = compute_chain_hash(chain_hash, decision)
    store(decision, chain_hash)

# To verify: recompute the chain from genesis and compare hashes.
# Any mutation to a historical record invalidates all subsequent hashes.
```

`compute_chain_hash(prev_hash: str, record: Any) -> str` -- returns a hex-encoded SHA-256 digest.

`GENESIS_HASH` -- empty string (`""`), the starting point of every chain.

## OpenTelemetry

Optional integration. If `opentelemetry-api` is installed, `try_load_otel()` returns a real tracer. Otherwise it returns a no-op tracer -- zero cost, no import errors.

```python
from veto import try_load_otel, SPAN_STATUS_OK, SPAN_STATUS_ERROR

tracer = try_load_otel(service_name="my-agent")

span = tracer.start_span("veto.validate")
span.set_attribute("tool.name", "transfer_funds")
span.set_status(SPAN_STATUS_OK)
span.end()
```

### Types

- `VetoTracer` -- protocol with `start_span(name: str) -> VetoSpan`
- `VetoSpan` -- protocol with `set_attribute()`, `set_status()`, `end()`
- `SPAN_STATUS_OK = 1`, `SPAN_STATUS_ERROR = 2`

## Policy Testing

YAML fixture-based policy testing. No LLM, no network. Evaluates test cases against your rule files using the same condition logic as the runtime.

### Write fixtures

`veto/tests/financial.yaml`:

```yaml
suite: Financial rules
tests:
  - id: block-large-transfer
    tool: transfer_funds
    arguments:
      amount: 5000
    expect:
      decision: block
      rule_id: limit-transfers

  - id: allow-small-transfer
    tool: transfer_funds
    arguments:
      amount: 50
    expect:
      decision: allow
```

### Run tests

```python
from veto import run_tests

result = run_tests(
    fixtures_path="./veto/tests",
    policy_path="./veto",
    coverage=True,  # print rule coverage report
    quiet=False,    # print pass/fail per test
)

print(f"{result.passed}/{result.total} passed, {result.failed} failed")

for r in result.results:
    if not r.passed:
        print(f"  FAIL {r.test_id}: {r.error}")
```

### Types

- `VetoTestRunResult` -- `total`, `passed`, `failed`, `results: list[VetoTestResult]`
- `VetoTestResult` -- `test_id`, `suite`, `passed`, `expected`, `actual_decision`, `actual_rule_id`, `error`
- `VetoTestSuite` -- `suite` name + `tests: list[VetoTestCase]`
- `VetoTestCase` -- `id`, `tool`, `arguments`, `expect`, optional `description` and `context`

### Supported condition operators

`equals`, `not_equals`, `contains`, `greater_than`, `less_than`, `in`, `not_in`, `exists`, `not_exists`

## Cloud Client

Register tools and validate calls against cloud-managed policies via the Veto Cloud API.

```python
from veto import VetoCloudClient, VetoCloudConfig

config = VetoCloudConfig(
    api_key="veto_sk_...",      # or set VETO_API_KEY env var
    base_url="https://api.veto.so",  # default
    timeout=30000,              # ms
    retries=2,
)
client = VetoCloudClient(config)
```

### Register tools

```python
from veto import ToolRegistration, ToolParameter

tools = [
    ToolRegistration(
        name="transfer_funds",
        description="Transfer money between accounts",
        parameters=[
            ToolParameter(name="amount", type="number", required=True),
            ToolParameter(name="to_account", type="string", required=True),
        ],
    )
]
response = await client.register_tools(tools)
```

### Validate a tool call

```python
result = await client.validate(
    tool_name="transfer_funds",
    arguments={"amount": 500, "to_account": "acct_123"},
    context={"user_id": "usr_456"},
)
# result.decision: "allow" | "deny" | "require_approval"
# result.reason: str | None
# result.failed_constraints: list[FailedConstraint]
```

### Poll for human approval

```python
from veto import ApprovalTimeoutError

if result.decision == "require_approval" and result.approval_id:
    try:
        approval = await client.poll_approval(result.approval_id)
        # approval.status: "approved" | "denied"
    except ApprovalTimeoutError:
        print("Approval timed out")
```

### Policy cache

Stale-while-revalidate cache for cloud policies. Background refresh keeps latency low.

```python
from veto import PolicyCache

cache = PolicyCache(client, fresh_seconds=60, max_seconds=300)
policy = cache.get("transfer_funds")  # returns DeterministicPolicy or None
cache.invalidate("transfer_funds")
cache.invalidate_all()
```

### Cleanup

```python
await client.close()
```

## Provider Adapters

Convert between Veto's internal tool format and provider-specific formats. Adapters exist for OpenAI, Anthropic, and Google (Gemini).

### OpenAI

```python
from veto import to_openai, to_openai_tools, from_openai, from_openai_tool_call
from veto import ToolDefinition

tool = ToolDefinition(
    name="get_weather",
    description="Get current weather",
    input_schema={"type": "object", "properties": {"city": {"type": "string"}}},
)

openai_tool = to_openai(tool)               # single tool
openai_tools = to_openai_tools([tool])      # batch

veto_tool = from_openai(openai_tool)        # convert back
veto_call = from_openai_tool_call(tc)       # parse tool call from response
```

### Anthropic

```python
from veto import to_anthropic, to_anthropic_tools, from_anthropic, from_anthropic_tool_use

anthropic_tool = to_anthropic(tool)
anthropic_tools = to_anthropic_tools([tool])

veto_tool = from_anthropic(anthropic_tool)
veto_call = from_anthropic_tool_use(tool_use_block)
```

### Google (Gemini)

```python
from veto import to_google_tool, from_google_function_call

google_tool = to_google_tool([tool1, tool2])   # wraps all declarations in one object
veto_call = from_google_function_call(fc)      # parse function call from response
```

## Output Patterns

Reference regex patterns for detecting sensitive data in tool outputs. These are not applied automatically -- use them in your own output validation or redaction logic.

```python
from veto import (
    OUTPUT_PATTERNS,
    OUTPUT_PATTERN_SSN,
    OUTPUT_PATTERN_CREDIT_CARD,
    OUTPUT_PATTERN_EMAIL,
    OUTPUT_PATTERN_US_PHONE,
    OUTPUT_PATTERN_OPENAI_API_KEY,
    OUTPUT_PATTERN_GITHUB_API_KEY,
    OUTPUT_PATTERN_AWS_API_KEY,
)

import re

text = "Call me at 555-123-4567"
if re.search(OUTPUT_PATTERN_US_PHONE, text):
    print("Phone number detected")

# OUTPUT_PATTERNS is a dict mapping names to patterns:
# {"ssn": r"...", "credit_card": r"...", "email": r"...", ...}
for name, pattern in OUTPUT_PATTERNS.items():
    if re.search(pattern, text):
        print(f"Matched: {name}")
```

## Webhooks

Format decision events for external notification systems. Four built-in formatters: Slack, PagerDuty, generic JSON, and CEF (Common Event Format).

### Configuration (YAML)

```yaml
events:
  webhook:
    url: "https://hooks.slack.com/services/T00/B00/xxx"
    on: [deny, require_approval, budget_exceeded]
    min_severity: medium # critical | high | medium | low | info
    format: slack # slack | pagerduty | generic | cef
```

### Formatting payloads manually

```python
from veto import (
    WebhookEvent,
    format_slack_payload,
    format_pagerduty_payload,
    format_generic_payload,
    format_cef_payload,
)

event = WebhookEvent(
    event_type="deny",
    tool_name="transfer_funds",
    arguments={"amount": 50000},
    decision="deny",
    reason="Amount exceeds limit",
    rule_id="limit-transfers",
    severity="high",
    timestamp="2026-04-06T12:00:00Z",
)

slack_body = format_slack_payload(event)         # Slack Block Kit
pd_body = format_pagerduty_payload(event)        # PagerDuty Events API v2
generic_body = format_generic_payload(event)     # flat JSON dict
cef_line = format_cef_payload(event)             # CEF:0|Veto|SDK|... string
```

### Types

- `WebhookEventType` -- `"deny" | "require_approval" | "budget_exceeded"`
- `WebhookFormat` -- `"slack" | "pagerduty" | "generic" | "cef"`
- `EventWebhookConfig` -- `url`, `on`, `min_severity`, `format`

## Deterministic Validation

Validate tool call arguments against constraints without an LLM. Supports numeric bounds, string length/regex/enum, array size, required/not-null checks, and ReDoS-safe regex validation.

```python
from veto import validate_deterministic, ArgumentConstraint

constraints = [
    ArgumentConstraint(
        argument_name="amount",
        minimum=0,
        maximum=10000,
    ),
    ArgumentConstraint(
        argument_name="currency",
        enum=["USD", "EUR", "GBP"],
    ),
    ArgumentConstraint(
        argument_name="recipient",
        required=True,
        min_length=1,
        max_length=100,
        regex=r"^[a-zA-Z0-9_]+$",
    ),
]

result = validate_deterministic(
    tool_name="transfer_funds",
    args={"amount": 500, "currency": "USD", "recipient": "alice"},
    constraints=constraints,
)

# result.decision: "allow" | "deny"
# result.reason: str | None
# result.failed_argument: str | None
# result.validations: list[ValidationEntry]
# result.latency_ms: float
```

### Regex safety

`is_safe_pattern(pattern: str) -> bool` checks for ReDoS-vulnerable patterns before compilation. The validator uses this internally; you can call it directly.

```python
from veto import is_safe_pattern

is_safe_pattern(r"^[a-z]+$")          # True
is_safe_pattern(r"(a+)+$")            # False -- catastrophic backtracking
```

### Types

- `ArgumentConstraint` -- all constraint fields (`minimum`, `maximum`, `greater_than`, `less_than`, `regex`, `enum`, `min_length`, `max_length`, `min_items`, `max_items`, `required`, `not_null`)
- `DeterministicPolicy` -- `tool_name`, `mode`, `constraints`, `version`
- `LocalValidationResult` -- `decision`, `reason`, `failed_argument`, `validations`, `latency_ms`

## Policy Validation

Validate policy YAML/JSON documents against the Policy IR v1 schema. Catches structural errors before runtime.

```python
from veto import validate_policy_ir, PolicySchemaError

policy_doc = {
    "version": 1,
    "rules": [
        {
            "id": "limit-transfers",
            "action": "block",
            "tools": ["transfer_funds"],
            "conditions": [
                {"field": "arguments.amount", "operator": "greater_than", "value": 1000}
            ],
        }
    ],
}

try:
    validate_policy_ir(policy_doc)
except PolicySchemaError as e:
    for err in e.errors:
        print(f"{err.path}: {err.message}")
```

`PolicySchemaError.errors` is a list of `PolicyValidationError(path, message, keyword)`.

## Rule YAML Reference

Same schema as the TypeScript SDK. See [full rule reference](../sdk/README.md#rule-yaml-format).

```yaml
rules:
  - id: unique-rule-id
    name: Human readable name
    action: block # block | warn | log | allow | ask
    tools: [make_payment]
    conditions:
      - field: arguments.amount
        operator: greater_than
        value: 1000
    description: "Semantic description for LLM validation (optional)."
    rate_limits:
      - scope: global
        window_seconds: 60
        max_calls: 10
```

## License

Apache-2.0 (c) [Plaw, Inc.](https://plaw.io)
