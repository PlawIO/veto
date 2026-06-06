# @veto/python-release

## 0.9.0

### Minor Changes

- [#245](https://github.com/PlawIO/veto/pull/245) [`575531c`](https://github.com/PlawIO/veto/commit/575531ce046925dab0e2608e8086bf41acf570d8) Thanks [@yazcaleb](https://github.com/yazcaleb)! - Split Python SDK runtime dependencies into optional extras and add dependency-free `Veto.local(...)` enforcement with receipt verification smoke coverage.

### Patch Changes

- [#243](https://github.com/PlawIO/veto/pull/243) [`7fc7d94`](https://github.com/PlawIO/veto/commit/7fc7d94a7d592ffb728c8ea265fb6a723bc88393) Thanks [@yazcaleb](https://github.com/yazcaleb)! - Add release provenance metadata and OIDC trusted publishing hardening for npm and PyPI release paths.

## 0.8.0

### Minor Changes

- [#238](https://github.com/PlawIO/veto/pull/238) [`e1b1d9d`](https://github.com/PlawIO/veto/commit/e1b1d9dea04360753c7b00c7bdd242223aeb9dd7) Thanks [@yazcaleb](https://github.com/yazcaleb)! - Add universal decision receipt export, verification, and local MCP gateway receipt flows across the SDKs.

## 0.7.0

### Minor Changes

- [#232](https://github.com/PlawIO/veto/pull/232) [`d3630ca`](https://github.com/PlawIO/veto/commit/d3630ca3af337a2b00d386a9f926763e61012601) Thanks [@anirudhp26](https://github.com/anirudhp26)! - Sync the Python SDK with the TypeScript SDK's provider adapters, feed-backed rule helpers, economic authorization, model validation, extractors, CLI, and parity docs.

## 0.6.2

### Patch Changes

- [#208](https://github.com/PlawIO/veto/pull/208) [`1723ee1`](https://github.com/PlawIO/veto/commit/1723ee1b9c1d53af62952ae2d1b705f9ead1ddfe) Thanks [@yazcaleb](https://github.com/yazcaleb)! - Normalize first-party package metadata to Apache-2.0 and update package descriptions toward policy-runtime/tool-call governance wording.

- [#208](https://github.com/PlawIO/veto/pull/208) [`1723ee1`](https://github.com/PlawIO/veto/commit/1723ee1b9c1d53af62952ae2d1b705f9ead1ddfe) Thanks [@yazcaleb](https://github.com/yazcaleb)! - Make `protect(tools)` the protect-first onboarding path and use the built-in `@veto/safe-defaults` observe-mode pack when no local policy or explicit policy source is configured.

## 0.6.1

### Patch Changes

- [#203](https://github.com/PlawIO/veto/pull/203) [`8ac71d8`](https://github.com/PlawIO/veto/commit/8ac71d810707cbd8c34e6fbee67567656340ce5a) Thanks [@anirudhp26](https://github.com/anirudhp26)! - Close two critical fail-open patterns surfaced by the audit.

  - **Python `protect()` no longer silently degrades to allow-all on init failure.** Previously, _any_ exception during `Veto` initialization (malformed YAML, bad rule shape, transient network error) was caught and replaced with an allow-all instance — every tool call passed with no policy enforcement, no warning, no audit trail. `protect()` now re-raises by default. The legacy degrade-to-allow-all behaviour is reachable via the explicit opt-in `protect(safe_fallback=True)`, which prints a loud `WARNING: Veto initialization failed — falling back to ALLOW-ALL` banner to stderr so it can't be missed.
  - **Local rule expression errors now propagate** instead of returning `false`. A `block` rule with a parse or eval error used to silently never match, letting the call through. Both compile and evaluate paths in `Veto.evaluateLocalExpression` now log at `error` level and re-raise; the validation engine's existing fail-closed treatment of validator exceptions turns this into a deny.
  - **`matches` operator on a rejected regex now surfaces a one-time stderr error** in both SDKs. The condition still returns `false` (preserves operator semantics — a non-matching pattern is not a hard error), but a fail-open block rule on a misconfigured pattern is no longer invisible at runtime. Pairs with the load-time scan added in #201; this catches rules added or mutated after init.

  **Behavioural notes:**

  - Existing `protect()` callers that relied on the allow-all degradation as a "soft start" need to either (a) fix their config or (b) add `safe_fallback=True` and accept that every tool call is now permitted.
  - Local rules with a broken expression now produce a deny instead of an allow. For most users this is the safer default; if the previous behaviour is needed, fix the expression.

- [#202](https://github.com/PlawIO/veto/pull/202) [`bbb69ca`](https://github.com/PlawIO/veto/commit/bbb69ca768ec1a8297acb507afba68e6edf9390e) Thanks [@anirudhp26](https://github.com/anirudhp26)! - Cross-SDK regex parity + small cleanups.

  - TS expression-DSL `matches` operator is now case-insensitive by default, matching the Python SDK. Same policy expression now produces the same decision in both SDKs. Opt back into case-sensitive matching with an inline `(?-i)` prefix at the start of the pattern.
  - Removed duplicate `len > MAX_PATTERN_LENGTH` checks in `create_safe_regex` (Python) and `createSafeRegex` (TS) — `is_safe_pattern` / `isSafePattern` already enforces the cap.

  Behaviour change: TS-only policies that depended on case-sensitive `matches` will need `(?-i)` added to the pattern.

- [#200](https://github.com/PlawIO/veto/pull/200) [`b910716`](https://github.com/PlawIO/veto/commit/b910716ba8e66a4e23d9cb82254a645426c07d65) Thanks [@anirudhp26](https://github.com/anirudhp26)! - Harden the decision-stream logger.

  - Sanitize control chars and ANSI escapes in arg values + tool names so a multi-line tool input doesn't break the one-line-per-decision invariant.
  - `\n` / `\t` are visualised as `\n` / `\t`; backslash-escape pass now runs on the original string so visualisation backslashes don't get doubled.
  - Non-finite latency (`NaN`, `±Infinity`) renders as `-` instead of throwing.
  - Honor `NO_COLOR` and `FORCE_COLOR` env-var conventions.
  - Default `HH:MM:SS` field to UTC; `VETO_LOG_LOCALTIME=1` opts back into host time.
  - New `BaseStreamLogger` base class — stream-mode detection is now `instanceof`-strict instead of duck-typed on the `streamDecision` attribute.
  - Validator's `"Tool call blocked by local rule"` warn is now filtered locally by `StreamLogger` instead of suppressed cross-layer in `Veto`. Other loggers (Console, Memory, custom) see the warn unchanged.
  - Compact-mode call portion hard-truncated to 80 chars so long calls can't push the latency column off-screen.
  - Single arg formatter shared between compact + verbose modes.

- [#201](https://github.com/PlawIO/veto/pull/201) [`959f91c`](https://github.com/PlawIO/veto/commit/959f91c4fe1b8b253c2bfa0134725587e42f50e6) Thanks [@anirudhp26](https://github.com/anirudhp26)! - Close audit findings in the validation core.

  - Python `priority=0` is no longer silently treated as priority 100 by the validator-engine sort and `normalize_validator` (was using `priority or 100`, which evaluates 0 as falsy).
  - `decision: 'modify'` audit-trail mismatch — `HistoryTracker.record(...)` now uses the _final_ arguments the tool actually saw, not the original `call.arguments`. Fixed in both SDKs.
  - Unsafe `matches` regex patterns (rejected by the ReDoS-safety heuristic) are surfaced at load time with an `error`-level log per offending rule, so misconfigured rules don't fail-open silently. Walks both `rule.conditions` (flat AND) and `rule.condition_groups` (OR-of-AND).
  - New token-based `BudgetTracker.reserveCall` / `releaseReservation` API — `releaseReservation` is idempotent so a double-release can't silently zero `spent`. The interceptor and browser veto switched to the token API. Legacy `reserve(name, args): number` / `refund(amount: number)` pair preserved for backward compatibility.
  - Interceptor now releases the budget reservation on `require_approval` decisions too (was only releasing on `deny`), so a rejected approval doesn't permanently hold budget.

## 0.6.0

### Minor Changes

- [#196](https://github.com/PlawIO/veto/pull/196) [`04e6fe3`](https://github.com/PlawIO/veto/commit/04e6fe3a7c4a36bfac92cdf4a02aa82318d05ef8) Thanks [@anirudhp26](https://github.com/anirudhp26)! - Add decision stream logging for SDK guard decisions and the Claude Code hook example.

## 0.5.1

### Patch Changes

- [#197](https://github.com/PlawIO/veto/pull/197) [`da432af`](https://github.com/PlawIO/veto/commit/da432afe7de659bad31a2686760030a5c4c76149) Thanks [@yazcaleb](https://github.com/yazcaleb)! - Add starter compliance policy packs, public built-in pack registry helpers, and clearer custom provider API-key resolution/retry errors.

  Add create-veto-app for scaffolding minimal TypeScript Veto agent projects.

## 0.5.0

### Minor Changes

- [#188](https://github.com/PlawIO/veto/pull/188) [`29c5123`](https://github.com/PlawIO/veto/commit/29c512337b7db8b7590c14f395706d9e97c11c70) Thanks [@yazcaleb](https://github.com/yazcaleb)! - Add an aiohttp-based Python proxy server with OpenAI and Anthropic SSE interception helpers.

### Patch Changes

- [#190](https://github.com/PlawIO/veto/pull/190) [`c76d142`](https://github.com/PlawIO/veto/commit/c76d142d8273a0a3ea526847c8ed71ebe29c0717) Thanks [@yazcaleb](https://github.com/yazcaleb)! - Fix MCP connect no-op rewrites and Python admin SSE streaming behavior.

## 0.4.0

### Minor Changes

- [#185](https://github.com/PlawIO/veto/pull/185) [`bd8c579`](https://github.com/PlawIO/veto/commit/bd8c579124fc98fbac6e676b8a1886b10d8bda17) Thanks [@yazcaleb](https://github.com/yazcaleb)! - Port `VetoAdmin` to the Python SDK with async admin management client support matching the TypeScript admin surface.

## 0.3.1

### Patch Changes

- [#165](https://github.com/PlawIO/veto/pull/165) [`f606cde`](https://github.com/PlawIO/veto/commit/f606cdef590530e989b9cdebaa0f22b632a854ac) Thanks [@yazcaleb](https://github.com/yazcaleb)! - Fix decision stream logging in the TypeScript and Python protect helpers, preserve stream-aware cache separation, and keep operational warnings visible in stream mode.

## 0.3.0

### Minor Changes

- [#129](https://github.com/VulnZap/veto/pull/129) [`4ccb94c`](https://github.com/VulnZap/veto/commit/4ccb94cd5bcb3a873ae9656eb1a9c029eb008b82) Thanks [@yazcaleb](https://github.com/yazcaleb)! - Add true `shadow` mode to TypeScript and Python SDKs so wrapped calls never block while preserving real decisions and emitting shadow telemetry.

## 0.2.0

### Minor Changes

- [#127](https://github.com/VulnZap/veto/pull/127) [`d5e7aeb`](https://github.com/VulnZap/veto/commit/d5e7aebb192ce73ec9cc333272dd33cae976f356) Thanks [@yazcaleb](https://github.com/yazcaleb)! - Add default policy auto-apply enhancements in `protect()` with new `communication` and `deployment` policy packs, expanded tool-name heuristics, auto-apply stderr transparency, and `length_greater_than` condition support across TypeScript and Python SDKs.

## 0.1.0

### Minor Changes

- [#126](https://github.com/VulnZap/veto/pull/126) [`521d540`](https://github.com/VulnZap/veto/commit/521d540bfbc80995c94438db7ad3e83be3882f04) Thanks [@yazcaleb](https://github.com/yazcaleb)! - Add a top-level async `protect()` one-liner API to TypeScript and Python SDKs.

  Highlights:

  - Introduce `protect()` as the primary onboarding entrypoint (`protect(tools)` and `protect(tool)`).
  - Add source auto-detection (rules/api key/endpoint/config/local), heuristic pack selection, and allow-all fallback.
  - Add module-level instance caching so repeated calls reuse initialized Veto state when options match.
  - Add browser entrypoint support for `protect()` with safe allow-all fallback behavior.
  - Add Python `Veto.from_rules()` parity helper and top-level `protect` export.
