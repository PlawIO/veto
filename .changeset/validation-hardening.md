---
"veto-sdk": patch
"@veto/python-release": patch
---

Close audit findings in the validation core.

- Python `priority=0` is no longer silently treated as priority 100 by the validator-engine sort and `normalize_validator` (was using `priority or 100`, which evaluates 0 as falsy).
- `decision: 'modify'` audit-trail mismatch — `HistoryTracker.record(...)` now uses the _final_ arguments the tool actually saw, not the original `call.arguments`. Fixed in both SDKs.
- Unsafe `matches` regex patterns (rejected by the ReDoS-safety heuristic) are surfaced at load time with an `error`-level log per offending rule, so misconfigured rules don't fail-open silently. Walks both `rule.conditions` (flat AND) and `rule.condition_groups` (OR-of-AND).
- New token-based `BudgetTracker.reserveCall` / `releaseReservation` API — `releaseReservation` is idempotent so a double-release can't silently zero `spent`. The interceptor and browser veto switched to the token API. Legacy `reserve(name, args): number` / `refund(amount: number)` pair preserved for backward compatibility.
- Interceptor now releases the budget reservation on `require_approval` decisions too (was only releasing on `deny`), so a rejected approval doesn't permanently hold budget.
