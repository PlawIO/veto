# veto (Python SDK)

## 0.15.1

### Patch Changes

- Close two critical fail-open patterns surfaced by the audit. - **Python `protect()` no longer silently degrades to allow-all on init failure.** Previously, _any_ exception during `Veto` initialization (malformed YAML, bad rule shape, transient network error) was caught and replaced with an allow-all instance — every tool call passed with no policy enforcement, no warning, no audit trail. `protect()` now re-raises by default. The legacy degrade-to-allow-all behaviour is reachable via the explicit opt-in `protect(safe_fallback=True)`, which prints a loud `WARNING: Veto initialization failed — falling back to ALLOW-ALL` banner to stderr so it can't be missed. - **Local rule expression errors now propagate** instead of returning `false`. A `block` rule with a parse or eval error used to silently never match, letting the call through. Both compile and evaluate paths in `Veto.evaluateLocalExpression` now log at `error` level and re-raise; the validation engine's existing fail-closed treatment of validator exceptions turns this into a deny. - **`matches` operator on a rejected regex now surfaces a one-time stderr error** in both SDKs. The condition still returns `false` (preserves operator semantics — a non-matching pattern is not a hard error), but a fail-open block rule on a misconfigured pattern is no longer invisible at runtime. Pairs with the load-time scan added in #201; this catches rules added or mutated after init. **Behavioural notes:** - Existing `protect()` callers that relied on the allow-all degradation as a "soft start" need to either (a) fix their config or (b) add `safe_fallback=True` and accept that every tool call is now permitted. - Local rules with a broken expression now produce a deny instead of an allow. For most users this is the safer default; if the previous behaviour is needed, fix the expression.
- Cross-SDK regex parity + small cleanups. - TS expression-DSL `matches` operator is now case-insensitive by default, matching the Python SDK. Same policy expression now produces the same decision in both SDKs. Opt back into case-sensitive matching with an inline `(?-i)` prefix at the start of the pattern. - Removed duplicate `len > MAX_PATTERN_LENGTH` checks in `create_safe_regex` (Python) and `createSafeRegex` (TS) — `is_safe_pattern` / `isSafePattern` already enforces the cap. Behaviour change: TS-only policies that depended on case-sensitive `matches` will need `(?-i)` added to the pattern.
- Harden the decision-stream logger. - Sanitize control chars and ANSI escapes in arg values + tool names so a multi-line tool input doesn't break the one-line-per-decision invariant. - `\n` / `\t` are visualised as `\n` / `\t`; backslash-escape pass now runs on the original string so visualisation backslashes don't get doubled. - Non-finite latency (`NaN`, `±Infinity`) renders as `-` instead of throwing. - Honor `NO_COLOR` and `FORCE_COLOR` env-var conventions. - Default `HH:MM:SS` field to UTC; `VETO_LOG_LOCALTIME=1` opts back into host time. - New `BaseStreamLogger` base class — stream-mode detection is now `instanceof`-strict instead of duck-typed on the `streamDecision` attribute. - Validator's `"Tool call blocked by local rule"` warn is now filtered locally by `StreamLogger` instead of suppressed cross-layer in `Veto`. Other loggers (Console, Memory, custom) see the warn unchanged. - Compact-mode call portion hard-truncated to 80 chars so long calls can't push the latency column off-screen. - Single arg formatter shared between compact + verbose modes.
- Close audit findings in the validation core. - Python `priority=0` is no longer silently treated as priority 100 by the validator-engine sort and `normalize_validator` (was using `priority or 100`, which evaluates 0 as falsy). - `decision: 'modify'` audit-trail mismatch — `HistoryTracker.record(...)` now uses the _final_ arguments the tool actually saw, not the original `call.arguments`. Fixed in both SDKs. - Unsafe `matches` regex patterns (rejected by the ReDoS-safety heuristic) are surfaced at load time with an `error`-level log per offending rule, so misconfigured rules don't fail-open silently. Walks both `rule.conditions` (flat AND) and `rule.condition_groups` (OR-of-AND). - New token-based `BudgetTracker.reserveCall` / `releaseReservation` API — `releaseReservation` is idempotent so a double-release can't silently zero `spent`. The interceptor and browser veto switched to the token API. Legacy `reserve(name, args): number` / `refund(amount: number)` pair preserved for backward compatibility. - Interceptor now releases the budget reservation on `require_approval` decisions too (was only releasing on `deny`), so a rejected approval doesn't permanently hold budget.

## 0.15.0

### Minor Changes

- Add decision stream logging for SDK guard decisions and the Claude Code hook example.

## 0.14.1

### Patch Changes

- Add starter compliance policy packs, public built-in pack registry helpers, and clearer custom provider API-key resolution/retry errors. Add create-veto-app for scaffolding minimal TypeScript Veto agent projects.

## 0.14.0

### Minor Changes

- Fix MCP connect no-op rewrites and Python admin SSE streaming behavior.
- Add an aiohttp-based Python proxy server with OpenAI and Anthropic SSE interception helpers.

## 0.13.0

### Minor Changes

- Port `VetoAdmin` to the Python SDK with async admin management client support matching the TypeScript admin surface.

## 0.12.1

### Patch Changes

- Fix decision stream logging in the TypeScript and Python protect helpers, preserve stream-aware cache separation, and keep operational warnings visible in stream mode.

## 0.12.0

### Minor Changes

- Add true `shadow` mode to TypeScript and Python SDKs so wrapped calls never block while preserving real decisions and emitting shadow telemetry.

## 0.11.0

### Minor Changes

- Add default policy auto-apply enhancements in `protect()` with new `communication` and `deployment` policy packs, expanded tool-name heuristics, auto-apply stderr transparency, and `length_greater_than` condition support across TypeScript and Python SDKs.

## 0.10.0

### Minor Changes

- Add a top-level async `protect()` one-liner API to TypeScript and Python SDKs. Highlights: - Introduce `protect()` as the primary onboarding entrypoint (`protect(tools)` and `protect(tool)`). - Add source auto-detection (rules/api key/endpoint/config/local), heuristic pack selection, and allow-all fallback. - Add module-level instance caching so repeated calls reuse initialized Veto state when options match. - Add browser entrypoint support for `protect()` with safe allow-all fallback behavior. - Add Python `Veto.from_rules()` parity helper and top-level `protect` export.

## 0.9.0

### Minor Changes

- [#121](https://github.com/VulnZap/veto/pull/121) [`574e741`](https://github.com/VulnZap/veto/commit/574e74141d4fe48de50c09e900c29784adb3e158) Thanks [@yazcaleb](https://github.com/yazcaleb)! - Add native Python SDK integrations for CrewAI and PydanticAI.

  Highlights:

  - add `wrap_crewai_tools(veto, tools)` for CrewAI `BaseTool` wrappers
  - add `wrap_pydanticai_tool(veto, tool_name, handler)` for async function tools
  - add `create_veto_tool_decorator(veto, tool_name)` for decorator-style wrapping
  - add CrewAI auto-detection path in `veto.wrap()` for `BaseTool` instances
  - add integration tests using mocked framework modules (no framework deps required)

## 0.8.0

### Minor Changes

- [#117](https://github.com/VulnZap/veto/pull/117) [`220e7f1`](https://github.com/VulnZap/veto/commit/220e7f102bee5e57f073584dba38076849277877) Thanks [@yazcaleb](https://github.com/yazcaleb)! - Add a standalone `guard()` API for the Python SDK so tool calls can be validated without wrapping/executing tools.

  Highlights:

  - returns typed `GuardResult` with `allow`, `deny`, or `require_approval`
  - preserves real deny/require-approval outcomes for `guard()` callers in log mode
  - includes `rule_id`, `severity`, and `approval_id` when metadata is available
  - supports per-call `session_id` and `agent_id` overrides for standalone checks

## 0.6.0

### Minor Changes

- Add decision history export in JSON and CSV via `export_decisions()` with normalized audit fields (`timestamp`, `tool_name`, `arguments`, `policy_version`, `rule_id`, `decision`, `reason`).

- Add `require_approval` schema/docs parity updates and align release contents with TypeScript SDK v1.6.0.

## 0.5.0

### Minor Changes

- Version bump to align with TypeScript SDK v1.5.0 release. The Python SDK does not yet include Wave 1 features (`compile`, `learn`, `test`, MCP, budget constraints, three-mode init). These will be ported in a future release.

## 0.4.0

### Minor Changes

- Add client-side deterministic validation with cloud policy sync, matching TypeScript SDK v1.4.0 feature parity. Includes `PolicyCache` with background refresh, `VetoCloudClient.log_decision()`, and `VetoCloudClient.fetch_policy()`.

## 0.3.0

### Minor Changes

- Add `require_approval` flow with human-in-the-loop approval for tool calls. Cloud validation mode, approval polling, approval preference cache, `onApprovalRequired` hook, and `VetoCloudClient` with retry logic.

## 0.2.0

### Minor Changes

- Added browser-use integration plugin for automated browser control with Veto guardrails
