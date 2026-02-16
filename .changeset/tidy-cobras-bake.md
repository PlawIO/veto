---
"veto-sdk": minor
---

Add local human-in-the-loop approval support with `action: require_approval`, including webhook callback routing, configurable timeout behavior, and approval response mapping.

Add decision history export in JSON and CSV (`exportDecisions` / `export_decisions`) with normalized audit fields (`timestamp`, `tool_name`, `arguments`, `policy_version`, `rule_id`, `decision`, `reason`) and update schema/docs coverage for `require_approval` across TypeScript and Python SDKs.
