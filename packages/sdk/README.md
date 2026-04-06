# veto-sdk

[![npm](https://img.shields.io/npm/v/veto-sdk?color=000000)](https://www.npmjs.com/package/veto-sdk)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](../../LICENSE)

Guardrails for AI agent tool calls. Veto intercepts and validates tool calls before execution -- blocking, allowing, or routing to human approval. The agent never knows.

## How it works

1. **Initialize** Veto (loads your YAML rules).
2. **Wrap** your tools with `veto.wrap()`.
3. **Pass** the wrapped tools to your agent -- types preserved, interface unchanged.

When the AI calls a tool, Veto automatically:

1. Intercepts the call.
2. Validates arguments against your rules (deterministic conditions first, optional LLM for semantic rules).
3. **allow** -- executes. **block** -- denied with reason. **ask** -- approval queue.

## Installation

```bash
npm install veto-sdk
```

Optional peer dependencies:

```bash
npm install @opentelemetry/api  # OpenTelemetry tracing
npm install redis               # Distributed rate limiting
```

## Quick start

### 1. Initialize

```bash
npx veto init
```

Creates `./veto/veto.config.yaml` and default rules.

### 2. Wrap your tools

`wrap()` is provider-agnostic -- works with LangChain, Vercel AI SDK, or any custom tool object.

```typescript
import { Veto } from "veto-sdk";

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

# "strict" blocks calls, "log" only logs them, "shadow" computes decisions but never blocks
mode: "strict"

# Validation backend
validation:
  mode: "local" # "local" | "api" | "kernel" | "custom" | "cloud"

# Custom LLM provider (if mode is "custom")
custom:
  provider: "gemini" # openai | anthropic | gemini | openrouter
  model: "gemini-3-flash-preview"

# Cloud mode
cloud:
  apiKey: "veto_..."
  baseUrl: "https://api.veto.so"

logging:
  level: "info"

rules:
  directory: "./rules"
  recursive: true

# Human-in-the-loop approval (for action: require_approval)
approval:
  callbackUrl: "http://localhost:8787/approvals"
  timeout: 30000
  timeoutBehavior: "block" # "block" | "allow"

# Webhook event routing
events:
  webhook:
    url: "https://hooks.slack.com/services/..."
    on: [deny, require_approval, budget_exceeded]
    min_severity: high
    format: slack # slack | pagerduty | generic | cef

# Tamper-evident audit log
audit:
  enabled: true
  path: ".veto/audit.log"

# Economic authorization (x402, MPP, AP2)
economic:
  budgets:
    session: { limit: 500, currency: "USD" }
  cost_extraction:
    field: "arguments.amount"
```

### VetoOptions

```typescript
const veto = await Veto.init({
  configDir: "./veto",
  mode: "strict", // 'strict' | 'log' | 'shadow'
  logLevel: "info",
  sessionId: "sess_123",
  agentId: "agent_1",
  userId: "user_42",
  role: "trader",
  apiKey: "veto_...", // auto-detects cloud mode
  validators: [myCustomValidator],
  onApprovalRequired: (ctx, approvalId) => {
    /* show UI */
  },
  onDecisionMade: (result) => {
    /* log, emit metrics */
  },
  telemetry: {
    enabled: true,
    serviceName: "my-agent",
  },
  audit: {
    enabled: true,
    path: ".veto/audit.log",
  },
});
```

## API Reference

### `Veto.init(options?): Promise<Veto>`

Initialize Veto. Loads configuration and rules from `./veto` by default.

```typescript
const veto = await Veto.init();
const veto = await Veto.init({ configDir: "./policies", mode: "log" });
```

### `veto.wrap<T>(tools: T[]): T[]`

Wrap an array of tools. Injects validation into each tool's execution handler. Preserves types for full framework compatibility.

```typescript
const wrappedForLangChain = veto.wrap(langChainTools);
const wrappedForVercel = veto.wrap(vercelTools);
```

### `veto.wrapTool<T>(tool: T): T`

Wrap a single tool.

```typescript
const safeTool = veto.wrapTool(myTool);
```

### `veto.guard(toolName, args, context?): Promise<GuardResult>`

Standalone validation without wrapping or executing a tool. Returns the raw decision.

```typescript
const result = await veto.guard("transfer_funds", { amount: 5000 });
// { decision: 'deny', reason: 'Amount exceeds limit', ruleId: 'limit-transfers', severity: 'high' }

const result = await veto.guard(
  "send_email",
  { to: "ceo@corp.com" },
  {
    sessionId: "sess_123",
    agentId: "agent_1",
    userId: "user_42",
  }
);
```

`GuardResult`:

```typescript
interface GuardResult {
  decision: "allow" | "deny" | "require_approval";
  reason?: string;
  ruleId?: string;
  severity?: "critical" | "high" | "medium" | "low" | "info";
  approvalId?: string;
  shadow?: boolean;
  economicDenial?: EconomicDenialDetails;
}
```

### `protect(tools, options?)`

One-call alternative to `Veto.init()` + `wrap()`. Accepts inline rules, policy packs, or cloud API keys.

```typescript
import { protect } from "veto-sdk";

const safeTools = await protect(myTools, {
  rules: [
    {
      id: "no-delete",
      name: "Block deletes",
      action: "block",
      tools: ["delete_file"],
    },
  ],
  mode: "strict",
});
```

### `veto.getHistoryStats(): HistoryStats`

Statistics on allowed vs blocked calls.

```typescript
const stats = veto.getHistoryStats();
// { totalCalls: 5, allowedCalls: 4, deniedCalls: 1, ... }
```

### `veto.clearHistory()`

Reset decision history.

### `veto.exportDecisions(format): string`

Export decision history as JSON or CSV.

```typescript
const json = veto.exportDecisions("json");
const csv = veto.exportDecisions("csv");
```

### `veto.dispose()`

Clean up resources (timers, connections).

---

## Rate Limiting

Rules can include sliding-window rate limits. When the limit is exceeded, the rule's `action` fires.

```yaml
rules:
  - id: api-rate-limit
    name: Limit API calls
    action: block
    tools:
      - call_external_api
    rate_limits:
      - scope: session # agent | user | session | global
        max_calls: 10
        window_seconds: 60
```

By default, rate limit state is stored in memory. For distributed systems, plug in Redis:

```typescript
import { RedisRateLimitStore } from "veto-sdk";
import { createClient } from "redis";

const redis = createClient();
await redis.connect();

const store = new RedisRateLimitStore(redis, "veto:rl:");
```

The `RedisRateLimitStore` uses a Lua script for atomic sliding-window checks (no TOCTOU race).

### `RateLimitStore` interface

Implement this to bring your own store:

```typescript
interface RateLimitStore {
  checkAndRecord(
    key: string,
    maxCalls: number,
    windowMs: number
  ): boolean | Promise<boolean>;
  clear(): void | Promise<void>;
}
```

---

## Audit Chain

Tamper-evident append-only audit log. Each decision is hashed with SHA-256 over the previous hash + the record, forming a hash chain. Any mutation to a historical record invalidates all subsequent hashes.

```typescript
import { computeChainHash, GENESIS_HASH } from "veto-sdk";

let prevHash = GENESIS_HASH; // empty string

const entry1 = { tool: "transfer_funds", decision: "allow", ts: Date.now() };
prevHash = computeChainHash(prevHash, entry1);

const entry2 = { tool: "delete_account", decision: "deny", ts: Date.now() };
prevHash = computeChainHash(prevHash, entry2);
```

Enable via config:

```yaml
audit:
  enabled: true
  path: ".veto/audit.log"
```

Verify integrity from the CLI:

```bash
npx veto-cli audit verify
```

---

## OpenTelemetry

Optional tracing via `@opentelemetry/api`. Zero overhead when the package is not installed -- all calls become no-ops.

```typescript
import { tryLoadOtel, SpanStatusCode } from "veto-sdk";

const tracer = await tryLoadOtel("my-service");

const span = tracer.startSpan("validate-tool-call");
span.setAttribute("tool", "transfer_funds");
span.setStatus({ code: SpanStatusCode.OK });
span.end();
```

Veto instruments itself automatically when `@opentelemetry/api` is present. Disable via config:

```typescript
const veto = await Veto.init({
  telemetry: { enabled: false },
});
```

### `VetoTracer` / `VetoSpan`

```typescript
interface VetoTracer {
  startSpan(name: string): VetoSpan;
}

interface VetoSpan {
  setAttribute(key: string, value: string | number | boolean): void;
  setStatus(status: { code: number; message?: string }): void;
  end(): void;
}
```

---

## SSE Proxy (`veto intercept`)

HTTP proxy that intercepts OpenAI and Anthropic streaming responses, validates tool calls in SSE streams before forwarding. Zero code changes to your agent.

### CLI usage

```bash
# Proxy OpenAI (default target: https://api.openai.com)
npx veto-cli intercept --port 8080

# Proxy Anthropic
npx veto-cli intercept --port 8080 --target https://api.anthropic.com --format anthropic

# Auto-detect format from target URL
npx veto-cli intercept --port 8080 --target https://api.anthropic.com
```

Then point your SDK at the proxy:

```typescript
const openai = new OpenAI({ baseURL: "http://localhost:8080/v1" });
```

### Programmatic usage

```typescript
import { startProxyServer } from "veto-sdk/proxy";

const stop = await startProxyServer({
  port: 8080,
  target: "https://api.openai.com",
  maxBufferBytes: 1024 * 1024, // 1 MB
  configDir: "./veto",
  format: "auto", // 'openai' | 'anthropic' | 'auto'
});

// Later:
await stop();
```

### `ProxyConfig`

```typescript
interface ProxyConfig {
  port: number; // default: 8080
  target: string; // default: https://api.openai.com
  maxBufferBytes: number; // default: 1 MB
  configDir: string; // default: ./veto
  format?: "openai" | "anthropic" | "auto";
}
```

Architecture: non-tool-call responses are passed through. Tool-call responses are buffered until the stream signals completion, validated, then either flushed (allow) or replaced with a synthetic error (block). Buffer overflow beyond `maxBufferBytes` flushes without validation.

---

## Policy Testing

Deterministic test runner for policy rules. Loads YAML fixture files and evaluates test cases against your rules. No LLM, no network. Pure local replay.

### CLI

```bash
npx veto-cli test
npx veto-cli test --fixtures ./veto/tests --policy ./veto --coverage
```

### Programmatic

```typescript
import { runTests } from "veto-sdk";

const result = await runTests({
  fixturesPath: "./veto/tests",
  policyPath: "./veto",
  coverage: true,
  quiet: false,
});

console.log(`${result.passed}/${result.total} passed, ${result.failed} failed`);
```

### Fixture format

```yaml
suite: Financial rules
tests:
  - id: block-large-transfer
    description: Block transfers over $1000
    tool: transfer_funds
    arguments:
      amount: 5000
      recipient: vendor_123
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

### `RunTestsOptions`

```typescript
interface RunTestsOptions {
  fixturesPath?: string; // default: ./veto/tests
  policyPath?: string; // default: ./veto
  coverage?: boolean; // report untested rule IDs
  quiet?: boolean; // suppress console output
}
```

### `VetoTestRunResult`

```typescript
interface VetoTestRunResult {
  total: number;
  passed: number;
  failed: number;
  results: VetoTestResult[];
  loadErrors?: string[];
}
```

---

## Provider Adapters

Convert tool definitions and tool calls between Veto's internal format and provider-specific formats.

### OpenAI

```typescript
import { toOpenAITools, fromOpenAI, fromOpenAIToolCall } from "veto-sdk";

// Veto definitions -> OpenAI format
const openaiTools = toOpenAITools(definitions);

// OpenAI tool -> Veto definition
const vetoDef = fromOpenAI(openaiTool);

// OpenAI tool_call -> Veto ToolCall
const vetoCall = fromOpenAIToolCall(toolCall);
```

### Anthropic

```typescript
import {
  toAnthropicTools,
  fromAnthropic,
  fromAnthropicToolUse,
} from "veto-sdk";

const anthropicTools = toAnthropicTools(definitions);
const vetoDef = fromAnthropic(anthropicTool);
const vetoCall = fromAnthropicToolUse(toolUseBlock);
```

### Google (Gemini)

```typescript
import { toGoogleTool, fromGoogleFunctionCall } from "veto-sdk";

const googleTool = toGoogleTool(definitions);
const vetoCall = fromGoogleFunctionCall(functionCall);
```

### MCP (Model Context Protocol)

```typescript
import { toMCPTools, fromMCP, fromMCPToolCall, isMCPTool } from "veto-sdk";

const mcpTools = toMCPTools(definitions);
const vetoDef = fromMCP(mcpTool);
const vetoCall = fromMCPToolCall("tool_name", mcpArgs);
```

---

## Output Redaction

Built-in regex patterns for detecting sensitive data in tool outputs.

```typescript
import {
  OUTPUT_PATTERNS,
  OUTPUT_PATTERN_SSN,
  OUTPUT_PATTERN_CREDIT_CARD,
  OUTPUT_PATTERN_OPENAI_API_KEY,
  OUTPUT_PATTERN_GITHUB_API_KEY,
  OUTPUT_PATTERN_AWS_API_KEY,
  OUTPUT_PATTERN_EMAIL,
  OUTPUT_PATTERN_US_PHONE,
} from "veto-sdk";

// OUTPUT_PATTERNS is an object with all patterns:
// { ssn, creditCard, openAIApiKey, githubApiKey, awsApiKey, email, usPhone }
```

Use these in output rules to block or redact sensitive data from tool responses:

```yaml
output_rules:
  - id: redact-ssn
    name: Redact SSNs from output
    action: redact
    redact_with: "[REDACTED SSN]"
    output_conditions:
      - field: output
        operator: matches
        value: '\b\d{3}-\d{2}-\d{4}\b'

  - id: block-api-keys
    name: Block responses containing API keys
    action: block
    severity: critical
    output_conditions:
      - field: output
        operator: matches
        value: '\bsk-(?:proj-)?[A-Za-z0-9]{20,}\b'
```

---

## Webhooks

Route policy decision events to external systems. Four payload formats are supported.

### Configuration

```yaml
events:
  webhook:
    url: "https://hooks.slack.com/services/T00/B00/xxx"
    on: [deny, require_approval, budget_exceeded]
    min_severity: high
    format: slack
    redact_arguments: true # or ["password", "ssn"] for selective redaction
```

Event types: `deny`, `require_approval`, `budget_exceeded`, `budget_warning`, `approval_triggered`, `spend_committed`, `protocol_detected`.

### Programmatic formatting

```typescript
import {
  formatSlackPayload,
  formatPagerDutyPayload,
  formatGenericPayload,
  formatCefPayload,
} from "veto-sdk";

const event = {
  eventType: "deny",
  toolName: "transfer_funds",
  arguments: { amount: 5000 },
  decision: "deny",
  reason: "Amount exceeds limit",
  ruleId: "limit-transfers",
  severity: "high",
  timestamp: new Date().toISOString(),
};

const slack = formatSlackPayload(event); // Slack Block Kit
const pd = formatPagerDutyPayload(event); // PagerDuty Events API v2
const json = formatGenericPayload(event); // Plain JSON
const cef = formatCefPayload(event); // ArcSight CEF string
```

---

## VetoAdmin (Cloud Management)

Management client for the Veto Cloud API. Full CRUD for policies, decisions, approvals, MCP upstreams, and API keys.

```typescript
import { VetoAdmin } from "veto-sdk";

const admin = new VetoAdmin({
  apiKey: process.env.VETO_API_KEY!,
  baseUrl: "https://api.veto.so", // optional, this is the default
  timeout: 30000, // optional
});
```

### Policies

```typescript
const policies = await admin.listPolicies();
const policy = await admin.getPolicy("transfer_funds");

await admin.createPolicy({
  toolName: "transfer_funds",
  mode: "deterministic",
  constraints: [{ argumentName: "amount", maximum: 1000, enabled: true }],
});

await admin.updatePolicy("transfer_funds", {
  mode: "llm",
  llmConfig: { description: "..." },
});
await admin.activatePolicy("transfer_funds");
await admin.deactivatePolicy("transfer_funds");
await admin.deletePolicy("transfer_funds");
const yaml = await admin.exportPolicies({ format: "yaml" });
```

### Decisions

```typescript
const decisions = await admin.listDecisions({
  toolName: "transfer_funds",
  limit: 50,
});
const decision = await admin.getDecision("dec_123");
const stats = await admin.getDecisionStats({ startDate: "2025-01-01" });
const csv = await admin.exportDecisions({ format: "csv" });
```

### Approvals

```typescript
const pending = await admin.listPendingApprovals();
const approval = await admin.getApproval("apr_123");
await admin.resolveApproval("apr_123", "approve", "user@corp.com");
await admin.batchResolveApprovals([
  { id: "apr_1", action: "approve", resolvedBy: "admin" },
  { id: "apr_2", action: "deny", resolvedBy: "admin" },
]);
```

### MCP Gateway

```typescript
const upstreams = await admin.listUpstreams();
await admin.createUpstream({
  name: "my-server",
  transport: "mcp-sse",
  url: "http://localhost:3001/mcp",
});
const test = await admin.testUpstream("ups_123");
await admin.deleteUpstream("ups_123");
```

### API Keys

```typescript
const keys = await admin.listApiKeys();
const newKey = await admin.createApiKey({ name: "ci-pipeline" });
console.log(newKey.key); // only shown once
await admin.revokeApiKey(newKey._id);
```

### Policy Drafts

```typescript
const draft = await admin.createPolicyDraft({
  name: "New financial rules",
  rules: [
    {
      /* ... */
    },
  ],
  status: "pending_review",
});
await admin.approvePolicyDraft(draft._id);
await admin.rejectPolicyDraft(draft._id, "Missing edge case coverage");
```

### Real-time Events (SSE)

```typescript
// Callback-based
const sub = admin.onEvent(["deny", "require_approval"], (event) => {
  console.log(event.type, event.data);
});
sub.unsubscribe();

// Async iterator
for await (const event of admin.subscribeEvents({ types: ["deny"] })) {
  console.log(event.type, event.data);
}
```

---

## Cloud Client

For direct integration with Veto Cloud's validation and approval workflow.

```typescript
import { VetoCloudClient, ApprovalTimeoutError } from "veto-sdk";
```

When you pass `apiKey` to `Veto.init()`, cloud mode is auto-detected. The SDK registers tools, validates calls against cloud policies, and polls for approval resolution.

```typescript
const veto = await Veto.init({
  apiKey: "veto_...",
  onApprovalRequired: (ctx, approvalId) => {
    console.log(`Approval required: ${approvalId}`);
  },
});
```

`ApprovalTimeoutError` is thrown when an approval poll exceeds the configured timeout.

---

## Economic Authorization

Protocol-agnostic economic policy enforcement for agent payments across x402 (EVM L2), Stripe MPP, and Google AP2.

```typescript
import {
  LocalBudgetEngine,
  EconomicEvaluator,
  createX402Connector,
  createMPPConnector,
  createAP2Connector,
} from "veto-sdk";
```

### Budget tracking

```typescript
const budget = new LocalBudgetEngine({
  budgets: { session: { limit: 500, currency: "USD" } },
});

const check = budget.check("session", 100);
// { allowed: true, remaining: 400 }

budget.commit("session", 100);
```

### Protocol connectors

```typescript
const x402 = createX402Connector({ chainId: 8453 });
const mpp = createMPPConnector({ sessionId: "sess_..." });
const ap2 = createAP2Connector({ mandateId: "mandate_..." });
```

### Rule-based payment gates

```yaml
rules:
  - id: paid-api-call
    name: Require payment for premium API
    action: require_payment
    tools:
      - premium_search
    payment:
      protocol: x402
      amount: 0.01
      currency: USDC
      chain_id: 8453
```

See the [economic authorization guide](../../docs/economic-authorization.md) for full details.

---

## Advanced

### Policy Compiler

AST-based policy expression engine. Compile expressions, evaluate against context, and type-check for errors. No runtime `eval()`.

```typescript
import { compile, evaluate, typeCheck } from "veto-sdk";

const ast = compile('amount > 1000 && currency == "USD"');
const result = evaluate(ast, { amount: 1500, currency: "USD" });
// result === true

const issues = typeCheck(ast);
// TypeCheckResult { valid: boolean, issues: TypeIssue[] }
```

Use expressions in rule conditions:

```yaml
rules:
  - id: complex-check
    name: Multi-field validation
    action: block
    conditions:
      - expression: 'amount > 1000 && currency != "USD"'
```

### Local Evaluator

Offline deterministic rule evaluation. No API calls, sub-millisecond latency. Supports all 14 condition operators, dot-notation field paths, AND/OR condition groups, and tool filtering.

```typescript
import { evaluateRulesLocally } from "veto-sdk";

const result = evaluateRulesLocally(rules, {
  toolName: "transfer_funds",
  arguments: { amount: 5000 },
});
// { decision: 'deny', reason: '...', ruleId: 'limit-transfers' }
```

### Deterministic Constraints

Programmatic constraint definitions for cloud-managed deterministic policies.

```typescript
import type {
  ArgumentConstraint,
  SessionConstraints,
  DeterministicPolicy,
} from "veto-sdk";

const constraint: ArgumentConstraint = {
  argumentName: "amount",
  enabled: true,
  maximum: 1000,
  dynamicMaximum: "session.remaining * 0.15",
};

const session: SessionConstraints = {
  maxCalls: 100,
  budget: 500,
  cumulativeLimits: [{ argumentName: "amount", maxValue: 500 }],
  counters: {
    open_positions: {
      increment: ["buy_shares"],
      decrement: ["sell_shares"],
      max: 3,
      maxAction: "require_approval",
    },
  },
};
```

Dynamic expressions have access to `session.budget`, `session.spent`, `session.remaining`, `session.counter.<name>`, and `args.<name>`.

### Content Extraction

Extract structured entities from text content.

```typescript
import { extractEntities } from "veto-sdk";

const entities = extractEntities(text, { patterns: ["email", "ssn"] });
// { emails: [...], ssns: [...] }
```

---

## Rule YAML Reference

### Input rules

```yaml
rules:
  - id: unique-rule-id              # required
    name: Human readable name       # required
    description: "..."              # optional, used for LLM validation
    enabled: true                   # default: true
    severity: high                  # critical | high | medium | low | info
    action: block                   # block | warn | log | allow | require_approval | require_payment

    # Scope: which tools (omit for global rule)
    tools:
      - make_payment

    # Agent scope (optional)
    agents: [agent_1, agent_2]
    # or exclude: agents: { not: [agent_3] }

    # Static conditions (AND logic, zero latency)
    conditions:
      - field: arguments.amount
        operator: greater_than
        value: 1000
      - field: arguments.currency
        operator: in
        value: [BTC, ETH]

    # OR logic between groups
    condition_groups:
      - - field: arguments.amount
          operator: greater_than
          value: 10000
      - - field: arguments.destination
          operator: matches
          value: '^offshore_.*'

    # Expression syntax (alternative to field/operator/value)
    conditions:
      - expression: 'amount > 1000 && currency != "USD"'

    # Rate limits (sliding window)
    rate_limits:
      - scope: session
        max_calls: 10
        window_seconds: 60

    # Cross-tool sequence constraints
    blocked_by:
      - tool: disable_mfa
        within: 3600
    requires:
      - tool: verify_identity

    # Payment gate
    payment:
      protocol: x402
      amount: 0.01
      currency: USDC
```

### Condition operators

| Operator              | Description                                |
| --------------------- | ------------------------------------------ |
| `equals`              | Exact match (case-insensitive for strings) |
| `not_equals`          | Inverse of equals                          |
| `contains`            | Substring match                            |
| `not_contains`        | Inverse of contains                        |
| `starts_with`         | Prefix match                               |
| `ends_with`           | Suffix match                               |
| `matches`             | Regex match                                |
| `greater_than`        | Numeric comparison                         |
| `less_than`           | Numeric comparison                         |
| `in`                  | Value in array                             |
| `not_in`              | Value not in array                         |
| `length_greater_than` | String/array length                        |
| `percent_of`          | Percentage of reference field              |
| `within_hours`        | Time window match                          |
| `outside_hours`       | Inverse time window                        |

### Output rules

```yaml
output_rules:
  - id: unique-output-rule-id
    name: Redact sensitive data
    enabled: true
    severity: high
    action: redact # block | redact | log
    tools:
      - query_database
    redact_with: "[REDACTED]"
    output_conditions:
      - field: output
        operator: matches
        value: '\b\d{3}-\d{2}-\d{4}\b'
```

### Time window conditions

```yaml
conditions:
  - field: "@timestamp"
    operator: outside_hours
    value:
      start: "09:00"
      end: "17:00"
      timezone: "America/New_York"
      days: [mon, tue, wed, thu, fri]
```

## CLI Commands

```bash
npx veto-cli@latest                                     # Veto Studio (interactive TUI)
npx veto-cli@latest policy generate --tool <name>       # Generate policy from tool
npx veto-cli@latest guard check --tool <name> --args <json>  # Test a guard check
npx veto-cli@latest scan --fail-uncovered               # CI gate
npx veto-cli@latest test                                # Run policy tests
npx veto-cli@latest intercept --port 8080               # Start SSE proxy
npx veto-cli@latest audit verify                        # Verify audit chain
```

Full CLI reference: [`veto-cli`](../cli/README.md)

## License

Apache-2.0 (c) [Plaw, Inc.](https://plaw.io)
