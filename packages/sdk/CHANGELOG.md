# veto-sdk

## 1.8.0

### Minor Changes

- [#117](https://github.com/VulnZap/veto/pull/117) [`220e7f1`](https://github.com/VulnZap/veto/commit/220e7f102bee5e57f073584dba38076849277877) Thanks [@yazcaleb](https://github.com/yazcaleb)! - Add a new standalone `guard()` API to TypeScript and Python SDKs that runs the existing validation pipeline without wrapping or executing tools.

  Highlights:

  - return typed `GuardResult` with `allow`, `deny`, or `require_approval`
  - preserve real deny/require_approval outcomes in log mode for `guard()` callers
  - include `ruleId`, `severity`, and `approvalId` when metadata is available
  - support per-call `sessionId`/`agentId` overrides for standalone checks
  - export `GuardResult` from both SDK package roots

## 1.7.0

### Minor Changes

- [#98](https://github.com/VulnZap/veto/pull/98) [`0a45454`](https://github.com/VulnZap/veto/commit/0a45454a2e778a53809ebce00a6c4781f94e4ab2) Thanks [@yazcaleb](https://github.com/yazcaleb)! - Add deep Vercel AI SDK and LangChain integrations with middleware-level tool call interception, streaming support, and LangGraph ToolNode wrapping for both TypeScript and Python SDKs.

## 1.6.0

### Minor Changes

- [#89](https://github.com/VulnZap/veto/pull/89) [`b13f6a9`](https://github.com/VulnZap/veto/commit/b13f6a9cfb7677f73ee69ec888d0da456f16c4d0) Thanks [@yazcaleb](https://github.com/yazcaleb)! - Add local human-in-the-loop approval support with `action: require_approval`, including webhook callback routing, configurable timeout behavior, and approval response mapping.

  Add decision history export in JSON and CSV (`exportDecisions` / `export_decisions`) with normalized audit fields (`timestamp`, `tool_name`, `arguments`, `policy_version`, `rule_id`, `decision`, `reason`) and update schema/docs coverage for `require_approval` across TypeScript and Python SDKs.

## 1.5.0

### Minor Changes

- **Three-mode SDK** — Local (default), Cloud, and Self-Hosted runtime modes with auto-detection at init. Fresh installs now default to local mode with zero network calls. Set `VETO_API_KEY` or `options.apiKey` for cloud mode, `options.endpoint` for self-hosted. ([#86](https://github.com/VulnZap/veto/pull/86))

- **`veto compile`** — Compile natural language policy descriptions into deterministic YAML rules using an LLM at build time. Supports `--input`, `--file`, `--output`, and `--provider` flags. ([#83](https://github.com/VulnZap/veto/pull/83))

- **`veto learn`** — Observe tool calls and auto-generate tight allowlist policies from observations. Supports `--runs`, `--duration`, `--output`, and `--margin` flags. ([#82](https://github.com/VulnZap/veto/pull/82))

- **`veto test`** — Adversarial policy gap finder. Static analysis that detects uncovered tools, argument splitting, regex bypasses, and type coercion gaps. CI-friendly with exit code 1 on critical gaps. ([#84](https://github.com/VulnZap/veto/pull/84))

- **Budget constraints** — Per-session cost circuit breaker. Configure `budget.max` and per-tool costs in YAML. Throws `BudgetExceededError` with `spent`, `limit`, `remaining` fields when the budget is exhausted. ([#80](https://github.com/VulnZap/veto/pull/80))

- **MCP tool support** — `veto.wrap()` now auto-detects MCP tool format via `isMCPTool()` and converts `inputSchema` to `parameters` transparently. Manual adapters available at `veto-sdk/providers`. ([#81](https://github.com/VulnZap/veto/pull/81))

- **Expanded constraint operators** — YAML rule conditions now support: `matches`, `in`, `not_in`, `contains`, `not_contains`, `starts_with`, `ends_with`, `equals`, `not_equals`. All operators work in both local and cloud evaluation modes. ([#78](https://github.com/VulnZap/veto/pull/78))

### Patch Changes

- Fixed package name references to use `veto-sdk` consistently across all docs and exports. ([#79](https://github.com/VulnZap/veto/pull/79))

## 1.4.0

### Minor Changes

- [#62](https://github.com/VulnZap/veto/pull/62) [`188a543`](https://github.com/VulnZap/veto/commit/188a5431e293a6beada02d6dbcd029e87e0f5f12) Thanks [@yazcaleb](https://github.com/yazcaleb)! - Add client-side deterministic validation with cloud policy sync

  **Local deterministic validation** -- SDK now evaluates deterministic constraints locally before falling back to the server, eliminating network round-trips for simple checks (number ranges, string enums, regex patterns, required fields).

  **Policy cache with stale-while-revalidate** -- Policies fetched from the cloud are cached locally with configurable freshness and max-age windows. Stale policies serve immediately while a background refresh runs, ensuring zero-latency validation on cache hits.

  **Client-side decision logging** -- Validation decisions made locally are logged back to the server via fire-and-forget POST to `/v1/decisions`, keeping the dashboard audit trail complete without blocking the agent.

  **Python SDK parity** -- All features above are implemented identically in the Python SDK (`veto` on PyPI), including `PolicyCache` with background refresh, `VetoCloudClient.log_decision()`, and `VetoCloudClient.fetch_policy()`.

## 1.3.0

### Minor Changes

- [#53](https://github.com/VulnZap/veto/pull/53) [`7dc81c5`](https://github.com/VulnZap/veto/commit/7dc81c54aa544582ced4add8d651c2ffea3a16d3) Thanks [@yazcaleb](https://github.com/yazcaleb)! - Add require_approval flow with human-in-the-loop approval for tool calls

  **Cloud validation mode** -- New `cloud` validation mode routes tool calls through the Veto Cloud API for policy-managed validation. Supports `allow`, `deny`, and `require_approval` decisions.

  **Approval polling** -- When the cloud returns `require_approval`, the SDK automatically polls `GET /v1/approvals/:id` until a human approves or denies the call (or timeout). Configurable poll interval and timeout via config YAML or init options.

  **Approval preference cache** -- `setApprovalPreference(toolName, 'approve_all' | 'deny_all')` lets integrators cache a per-tool preference that skips server polling on subsequent calls. Clear with `clearApprovalPreferences()`.

  **onApprovalRequired hook** -- Fires when a tool call needs human review, enabling integrators (e.g. Sidekick) to present approve/deny UI. Receives full `ValidationContext` and `approvalId`.

  **VetoCloudClient** -- New standalone client with `validate()`, `pollApproval()`, `registerTools()`, retry logic, and typed `ApprovalTimeoutError`.

  **Python SDK parity** -- All features above are implemented identically in the Python SDK (`veto` on PyPI), including typed `ApprovalData`, `ApprovalPollOptions`, `ApprovalTimeoutError`, and the same hook/preference APIs.

- [#7](https://github.com/VulnZap/veto/pull/7) [`c90063d`](https://github.com/VulnZap/veto/commit/c90063d23460cee131cf3e4a4c57b18bf644445a) Thanks [@anirudhp26](https://github.com/anirudhp26)! - added browser-use plugin
