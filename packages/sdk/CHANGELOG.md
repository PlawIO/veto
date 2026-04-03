# veto-sdk

## 2.1.1

### Patch Changes

- [#165](https://github.com/PlawIO/veto/pull/165) [`f606cde`](https://github.com/PlawIO/veto/commit/f606cdef590530e989b9cdebaa0f22b632a854ac) Thanks [@yazcaleb](https://github.com/yazcaleb)! - Fix decision stream logging in the TypeScript and Python protect helpers, preserve stream-aware cache separation, and keep operational warnings visible in stream mode.

## 2.1.0

### Minor Changes

- [#161](https://github.com/PlawIO/veto/pull/161) [`7207342`](https://github.com/PlawIO/veto/commit/720734208c5b8a783e461a253691aded148dcba6) Thanks [@yazcaleb](https://github.com/yazcaleb)! - Add economic authorization module with x402, Stripe MPP, and Google AP2 protocol support.

  - Protocol connectors with `extract()` and `wrapFetch()` for automatic HTTP interception
  - `EconomicEvaluator` with payer validation, currency matching, budget enforcement, and approval thresholds
  - `LocalBudgetEngine` for in-memory session budget tracking
  - `guard()` integration: economic evaluation runs before behavioral rules, auto-reserves budget on allow
  - `getEconomicBudgetStatus()` and `resetEconomicBudget()` public API
  - MCP economic context extraction via `extractMCPEconomicContext()`
  - Policy IR schema validation for economic config sections
  - Denial reason template rendering with `{variable}` interpolation
  - AP2 spending cap enforcement and category documentation
  - Economic webhook events: `budget_warning`, `approval_triggered`, `spend_committed`, `protocol_detected`
  - `@veto/economic-agent` built-in policy pack

## 2.0.0

### Major Changes

- [#157](https://github.com/PlawIO/veto/pull/157) [`0a2873e`](https://github.com/PlawIO/veto/commit/0a2873e4e89c9ca3bd910341dd50657154fedaa3) Thanks [@yazcaleb](https://github.com/yazcaleb)! - Add local runtime policy reload support, richer local guard evaluation context,
  more-restrictive local rule precedence, and `percent_of` budget conditions for
  generated trading policies.

### Minor Changes

- [#152](https://github.com/PlawIO/veto/pull/152) [`d2f4c12`](https://github.com/PlawIO/veto/commit/d2f4c121ebd8e1839087f05464f7ce9972fbd577) Thanks [@yazcaleb](https://github.com/yazcaleb)! - Add deterministic output redaction policies, including compiled `output_rules`,
  cloud-delivered output rule enforcement, and redaction trace logging for tool
  results.

## 1.17.0

### Minor Changes

- [#146](https://github.com/VulnZap/veto/pull/146) [`69af93e`](https://github.com/VulnZap/veto/commit/69af93e47886394a92f6000a1ab4585b00d0fd94) Thanks [@yazcaleb](https://github.com/yazcaleb)! - Add MCP gateway CLI commands (`veto mcp serve`, `veto mcp doctor`, `veto mcp init`) and harden transport, URL, and API key validation for safer defaults.

## 1.16.1

### Patch Changes

- [#144](https://github.com/VulnZap/veto/pull/144) [`1f4eca1`](https://github.com/VulnZap/veto/commit/1f4eca107a62d7fe1a2490e149d45c1ab8a95513) Thanks [@yazcaleb](https://github.com/yazcaleb)! - fix(cli): lazy-load Studio renderers so Ink import failures fall back to ANSI instead of crashing on startup (for example on Node 22.12).

## 1.16.0

### Minor Changes

- [#142](https://github.com/VulnZap/veto/pull/142) [`e0b1fdc`](https://github.com/VulnZap/veto/commit/e0b1fdc1a26c627cf8736b79ca8d83a60dfdead0) Thanks [@yazcaleb](https://github.com/yazcaleb)! - Launch unified CLI foundations with a new canonical `veto-cli` package, Ink-first Studio runtime on Node, and first-class headless commands.

  Highlights:

  - add shared CLI runner used by both `veto-cli` and `veto-sdk` compatibility path
  - make Studio default for `veto`, `veto studio`, `veto repl`, with `--legacy` support
  - add headless command suite (`policy generate|apply`, `guard check`, `cloud *`, `doctor`)
  - add renderer preference support for `ink` and improved fallback behavior
  - tighten generation behavior (no silent template fallback by default)

## 1.15.1

### Patch Changes

- [#140](https://github.com/VulnZap/veto/pull/140) [`d9e05b5`](https://github.com/VulnZap/veto/commit/d9e05b516eaedb902c6d20c9071bc41a874e4ed5) Thanks [@yazcaleb](https://github.com/yazcaleb)! - Fix Studio runtime behavior by shipping `@opentui/core` as a runtime dependency and correcting CLI version detection under `npx`.

## 1.15.0

### Minor Changes

- [#138](https://github.com/VulnZap/veto/pull/138) [`489c4e8`](https://github.com/VulnZap/veto/commit/489c4e8bd07b1e9ee1aeb5033e7c085042183cb5) Thanks [@yazcaleb](https://github.com/yazcaleb)! - Launch Veto Studio as the default interactive experience for `veto repl` and `veto --repl`, while preserving legacy line REPL compatibility behind `--legacy`.

  ### Added

  - New full-screen Studio workflow with keyboard-first navigation, command palette, policy wizard, simulation, and review/save flow.
  - Renderer selection with `--renderer <auto|opentui|ansi>` and automatic OpenTUI -> ANSI runtime fallback.
  - Workspace and scan scope controls:
    - `--directory <path>`
    - `--include-examples`
    - `--include-tests`
  - Studio configuration support in `veto.config.yaml` under `studio.workspace`, `studio.generation`, and `studio.renderer`.
  - Generation connectivity checks and explicit fallback gate (`--demo-template` / `studio.generation.allowTemplateFallback`).

  ### Changed

  - `veto repl` and `veto --repl` now default to Studio.
  - `veto scan` now correctly honors `--directory` and include/exclude scope flags.
  - Natural-language intent handling for negated approval prompts now defaults to `block` (e.g. `"do not approve invoices above 50"`).
  - CLI version banner/help now use runtime package version (no hardcoded `0.1.0`).

## 1.14.0

### Minor Changes

- [#135](https://github.com/VulnZap/veto/pull/135) [`d48c9dd`](https://github.com/VulnZap/veto/commit/d48c9dd2fb156192fa794dfc4fa4cc7a42a34e65) Thanks [@yazcaleb](https://github.com/yazcaleb)! - Fix the CLI agent init typings and add the missing `picocolors` dependency for the new CLI color utilities.

## 1.13.0

### Minor Changes

- [#131](https://github.com/VulnZap/veto/pull/131) [`40b7552`](https://github.com/VulnZap/veto/commit/40b7552935d1a72894114b098a1630181b016257) Thanks [@yazcaleb](https://github.com/yazcaleb)! - Add a new `npx veto scan` CLI command to audit discovered tool coverage against loaded rules, with optional CI fail gating (`--fail-uncovered`), inline YAML suggestions (`--suggest`), and `text|json` output formats.

- [#134](https://github.com/VulnZap/veto/pull/134) [`b499d76`](https://github.com/VulnZap/veto/commit/b499d763697e4839eac534352d0df1a843aeb321) Thanks [@yazcaleb](https://github.com/yazcaleb)! - Add an interactive REPL for `npx veto` with natural-language policy generation, local `/test` and simulation flows, rule explain/export/load/clear commands, and persistent shell history.

- [#133](https://github.com/VulnZap/veto/pull/133) [`eb23217`](https://github.com/VulnZap/veto/commit/eb23217fd1e99efbe0fbd4acdcf667cbea10c204) Thanks [@yazcaleb](https://github.com/yazcaleb)! - Add `npx veto diff` for structural policy diffs and deterministic replay impact analysis from JSONL call logs.

## 1.12.0

### Minor Changes

- [#129](https://github.com/VulnZap/veto/pull/129) [`4ccb94c`](https://github.com/VulnZap/veto/commit/4ccb94cd5bcb3a873ae9656eb1a9c029eb008b82) Thanks [@yazcaleb](https://github.com/yazcaleb)! - Add true `shadow` mode to TypeScript and Python SDKs so wrapped calls never block while preserving real decisions and emitting shadow telemetry.

## 1.11.0

### Minor Changes

- [#127](https://github.com/VulnZap/veto/pull/127) [`d5e7aeb`](https://github.com/VulnZap/veto/commit/d5e7aebb192ce73ec9cc333272dd33cae976f356) Thanks [@yazcaleb](https://github.com/yazcaleb)! - Add default policy auto-apply enhancements in `protect()` with new `communication` and `deployment` policy packs, expanded tool-name heuristics, auto-apply stderr transparency, and `length_greater_than` condition support across TypeScript and Python SDKs.

## 1.10.0

### Minor Changes

- [#126](https://github.com/VulnZap/veto/pull/126) [`521d540`](https://github.com/VulnZap/veto/commit/521d540bfbc80995c94438db7ad3e83be3882f04) Thanks [@yazcaleb](https://github.com/yazcaleb)! - Add a top-level async `protect()` one-liner API to TypeScript and Python SDKs.

  Highlights:

  - Introduce `protect()` as the primary onboarding entrypoint (`protect(tools)` and `protect(tool)`).
  - Add source auto-detection (rules/api key/endpoint/config/local), heuristic pack selection, and allow-all fallback.
  - Add module-level instance caching so repeated calls reuse initialized Veto state when options match.
  - Add browser entrypoint support for `protect()` with safe allow-all fallback behavior.
  - Add Python `Veto.from_rules()` parity helper and top-level `protect` export.

- [#124](https://github.com/VulnZap/veto/pull/124) [`ec528d8`](https://github.com/VulnZap/veto/commit/ec528d80461fb23ae2779717d307f572c9157981) Thanks [@yazcaleb](https://github.com/yazcaleb)! - Add a browser-compatible SDK path for Chrome extensions, web workers, and MV3 service workers.

  Highlights:

  - Add `Veto.fromRules()` and `Veto.fromCloud()` factories for browser-safe initialization.
  - Add `veto-sdk/browser` entrypoint with browser-safe exports and action wrappers.
  - Add browser-specific tests and cloud reporting support without filesystem dependencies.
  - Add lifecycle cleanup for cloud refresh intervals and resilient decision logging retries.

## 1.9.0

### Minor Changes

- [#121](https://github.com/VulnZap/veto/pull/121) [`574e741`](https://github.com/VulnZap/veto/commit/574e74141d4fe48de50c09e900c29784adb3e158) Thanks [@yazcaleb](https://github.com/yazcaleb)! - Coordinated cross-SDK release train alignment while publishing Python SDK v0.9.0 integrations for CrewAI and PydanticAI. JavaScript APIs remain backward-compatible.

## 1.8.1

### Patch Changes

- [#119](https://github.com/VulnZap/veto/pull/119) [`1639043`](https://github.com/VulnZap/veto/commit/163904315749abf9e1c6788b05af27711138add1) Thanks [@yazcaleb](https://github.com/yazcaleb)! - Replace hardcoded api.veto.dev with api.runveto.com in SDK defaults and test fixtures

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
