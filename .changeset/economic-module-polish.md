---
"veto-sdk": minor
---

Add economic authorization module with x402, Stripe MPP, and Google AP2 protocol support.

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
