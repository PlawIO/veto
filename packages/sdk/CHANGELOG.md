# veto-sdk

## 2.8.1

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

- [#206](https://github.com/PlawIO/veto/pull/206) [`0f84e26`](https://github.com/PlawIO/veto/commit/0f84e2631a28f8dd4b25db90602fd5635bef6d1a) Thanks [@anirudhp26](https://github.com/anirudhp26)! - Improve CLI policy generation and clean-build reliability.

  - make local `veto policy generate --tool ...` consistently target the requested tool
  - make `veto guard check --mode local` report real SDK approval decisions
  - honor `veto init --directory ...`
  - harden optional-provider and LangChain imports so clean-container builds succeed without extra packages installed

- [#205](https://github.com/PlawIO/veto/pull/205) [`ac02f5d`](https://github.com/PlawIO/veto/commit/ac02f5d6ba716742d0f503b326469e304a702259) Thanks [@anirudhp26](https://github.com/anirudhp26)! - Harden SDK cache reuse and internal snapshot behavior.

  - prevent `protect()` from reusing stale default/cached instances across incompatible policy and approval-callback contexts
  - stop invalidated cloud policy cache entries from being repopulated by stale background refreshes
  - return immutable history snapshots so callers cannot mutate internal Veto history state
  - align browser-side protect caching with the Node runtime behavior

- [#207](https://github.com/PlawIO/veto/pull/207) [`e248124`](https://github.com/PlawIO/veto/commit/e248124b0f358797e1b10f5d9f1cedbf0db9206c) Thanks [@anirudhp26](https://github.com/anirudhp26)! - Harden proxy streaming and benchmark dataset parsing.

  - stop OpenAI streaming proxy responses after a synthetic blocked event so clients receive only one terminal `[DONE]`
  - preserve `tools: []` as an empty tool list when loading benchmark dataset rules
  - add focused proxy and benchmark regression coverage for these runtime paths

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

## 2.8.0

### Minor Changes

- [#196](https://github.com/PlawIO/veto/pull/196) [`04e6fe3`](https://github.com/PlawIO/veto/commit/04e6fe3a7c4a36bfac92cdf4a02aa82318d05ef8) Thanks [@anirudhp26](https://github.com/anirudhp26)! - Add decision stream logging for SDK guard decisions and the Claude Code hook example.

## 2.7.0

### Minor Changes

- [#197](https://github.com/PlawIO/veto/pull/197) [`da432af`](https://github.com/PlawIO/veto/commit/da432afe7de659bad31a2686760030a5c4c76149) Thanks [@yazcaleb](https://github.com/yazcaleb)! - Add starter compliance policy packs, public built-in pack registry helpers, and clearer custom provider API-key resolution/retry errors.

  Add create-veto-app for scaffolding minimal TypeScript Veto agent projects.

## 2.6.0

### Minor Changes

- [`be3a38b`](https://github.com/PlawIO/veto/commit/be3a38b874ba3664d83157d5a64ebe1414b63e99) Thanks [@yazcaleb](https://github.com/yazcaleb)! - Add typed FeedRef / PipelineRef condition values and the content-addressable Pipeline DSL.

  - `RuleCondition.value` now accepts tagged references (`{ kind: "feed" | "pipeline", ... }`) in addition to bare literals. Set-membership operators (`in`, `not_in`, `contains`, `not_contains`) resolve the reference against an injected `FeedProvider` at evaluation time, with `fail_open` / `fail_closed` / `last_known_good` fallback when the snapshot is missing or stale. Backward compatible — existing literal comparands are unchanged.
  - New `pipeline-dsl` module exposes a Zod schema for declarative, content-addressable pipeline specs (`PipelineSpec`, `parsePipelineSpec`, `computePipelineId`, `verifyPipelineId`). The id is the sha256 of the canonicalized spec, so equivalent specs share one pipeline identity. Import via the dedicated subpath: `import { ... } from "veto-sdk/rules/pipeline-dsl"`. It is intentionally NOT re-exported from `veto-sdk/rules` so the rules barrel stays free of the optional `zod` peer dep.
  - New `feed-provider` module exposes the `FeedProvider` interface and `InMemoryFeedProvider` reference implementation for tests and SDK-side use.
  - `evaluateCondition` and `evaluateRulesLocally` take an optional `LocalEvalOptions { feedProvider?, now_ms? }`.
  - `canonicalizeJson` (used internally by `computePipelineId`) now throws on non-plain objects (Date, Map, Set, RegExp, class instances) and on unserializable primitives (BigInt, Symbol, function) to prevent silent hash collisions. Pipeline specs validated by `PipelineSpecSchema` never contain such values; the guard hardens callers that bypass Zod.

## 2.5.1

### Patch Changes

- [#190](https://github.com/PlawIO/veto/pull/190) [`c76d142`](https://github.com/PlawIO/veto/commit/c76d142d8273a0a3ea526847c8ed71ebe29c0717) Thanks [@yazcaleb](https://github.com/yazcaleb)! - Fix MCP connect no-op rewrites and Python admin SSE streaming behavior.

- [#189](https://github.com/PlawIO/veto/pull/189) [`95c6f1e`](https://github.com/PlawIO/veto/commit/95c6f1eab3e203343a51731ada996c1140cc1bb1) Thanks [@yazcaleb](https://github.com/yazcaleb)! - Add `veto init --cloud` and `--api-key` flags so cloud validation mode and credentials can be scaffolded in one command for PLW-201 / GH #263.

## 2.5.0

### Minor Changes

- [#187](https://github.com/PlawIO/veto/pull/187) [`15843f1`](https://github.com/PlawIO/veto/commit/15843f13d29fab6eee27353637b369049632e497) Thanks [@yazcaleb](https://github.com/yazcaleb)! - Add `veto mcp connect` command for persisting MCP client configuration, supporting both local gateway and hosted API endpoints.

### Patch Changes

- [#186](https://github.com/PlawIO/veto/pull/186) [`3d9c1ec`](https://github.com/PlawIO/veto/commit/3d9c1ec2381d7fb201d636a0715eeb5337d2a162) Thanks [@yazcaleb](https://github.com/yazcaleb)! - Remove the misleading deprecation warning from `veto agent` compatibility commands, which remain the primary entry point for agent workflows.

- [#182](https://github.com/PlawIO/veto/pull/182) [`dfa6240`](https://github.com/PlawIO/veto/commit/dfa6240f8d932473bc9c5e4d2c748811c4f6881d) Thanks [@yazcaleb](https://github.com/yazcaleb)! - Add the missing changeset for the already-merged `@veto/crypto-trading` policy pack so the follow-up CI fix passes for PR #179 / SCO-004.

## 2.4.0

### Minor Changes

- [#179](https://github.com/PlawIO/veto/pull/179) [`c38f704`](https://github.com/PlawIO/veto/commit/c38f70449c598efab837964b9a084a1993788c8c) Thanks [@yazcaleb](https://github.com/yazcaleb)! - Add @veto/crypto-trading policy pack with consumer-grade trading guardrails

- [#180](https://github.com/PlawIO/veto/pull/180) [`82549f9`](https://github.com/PlawIO/veto/commit/82549f98f8765e9fb16ddbbc4fdf87ba9cb8d2f7) Thanks [@yazcaleb](https://github.com/yazcaleb)! - Add OpenClaw integration hooks to Veto SDK and publishable openclaw-veto plugin

## 2.3.0

### Minor Changes

- [#173](https://github.com/PlawIO/veto/pull/173) [`0e102a8`](https://github.com/PlawIO/veto/commit/0e102a8e1deae477aed8ba78476f486a806959e6) Thanks [@yazcaleb](https://github.com/yazcaleb)! - Add rate limiting (in-memory + Redis), audit chain, OTEL tracing, SSE proxy for OpenAI/Anthropic, VetoAdmin client, and YAML test runner. Port rate limiting, audit, OTEL, and test runner to Python SDK. Align cross-SDK behavior for case-insensitive conditions and fail-closed malformed conditions.

### Patch Changes

- [#171](https://github.com/PlawIO/veto/pull/171) [`8c5e643`](https://github.com/PlawIO/veto/commit/8c5e643f7090edeb387ac1d50156d9cac044f20e) Thanks [@yazcaleb](https://github.com/yazcaleb)! - Harden SDK security: fix ReDoS in regex evaluator, fail-closed malformed conditions, prototype chain traversal guards, bounded caches, evaluator consistency alignment, and eliminate all npm audit vulnerabilities

## 2.2.1

### Patch Changes

- [#169](https://github.com/PlawIO/veto/pull/169) [`daa2464`](https://github.com/PlawIO/veto/commit/daa2464ca26481ffc2d7bd98864385f75d428286) Thanks [@yazcaleb](https://github.com/yazcaleb)! - Harden SDK security: fix ReDoS in regex evaluator, fail-closed malformed conditions, prototype chain traversal guards, bounded caches, evaluator consistency alignment, and eliminate all npm audit vulnerabilities

## 2.2.0

### Minor Changes

- [#168](https://github.com/PlawIO/veto/pull/168) [`f2d8948`](https://github.com/PlawIO/veto/commit/f2d89482af05ee0da186d0a4eaa527a4b9f4f0d0) Thanks [@yazcaleb](https://github.com/yazcaleb)! - Add content extractor, local rule evaluator, and policy generator utilities upstreamed from the browser extension. New entry points: veto-sdk/extractors, veto-sdk/policy. Add onDecisionMade callback to VetoOptions and VetoBrowserOptions.

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
