---
"veto-sdk": patch
"@veto/python-release": patch
---

Close two critical fail-open patterns surfaced by the audit.

- **Python `protect()` no longer silently degrades to allow-all on init failure.** Previously, _any_ exception during `Veto` initialization (malformed YAML, bad rule shape, transient network error) was caught and replaced with an allow-all instance — every tool call passed with no policy enforcement, no warning, no audit trail. `protect()` now re-raises by default. The legacy degrade-to-allow-all behaviour is reachable via the explicit opt-in `protect(safe_fallback=True)`, which prints a loud `WARNING: Veto initialization failed — falling back to ALLOW-ALL` banner to stderr so it can't be missed.
- **Local rule expression errors now propagate** instead of returning `false`. A `block` rule with a parse or eval error used to silently never match, letting the call through. Both compile and evaluate paths in `Veto.evaluateLocalExpression` now log at `error` level and re-raise; the validation engine's existing fail-closed treatment of validator exceptions turns this into a deny.
- **`matches` operator on a rejected regex now surfaces a one-time stderr error** in both SDKs. The condition still returns `false` (preserves operator semantics — a non-matching pattern is not a hard error), but a fail-open block rule on a misconfigured pattern is no longer invisible at runtime. Pairs with the load-time scan added in #201; this catches rules added or mutated after init.

**Behavioural notes:**

- Existing `protect()` callers that relied on the allow-all degradation as a "soft start" need to either (a) fix their config or (b) add `safe_fallback=True` and accept that every tool call is now permitted.
- Local rules with a broken expression now produce a deny instead of an allow. For most users this is the safer default; if the previous behaviour is needed, fix the expression.
