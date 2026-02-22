---
"veto-sdk": minor
---

Add a new standalone `guard()` API to TypeScript and Python SDKs that runs the existing validation pipeline without wrapping or executing tools.

Highlights:

- return typed `GuardResult` with `allow`, `deny`, or `require_approval`
- preserve real deny/require_approval outcomes in log mode for `guard()` callers
- include `ruleId`, `severity`, and `approvalId` when metadata is available
- support per-call `sessionId`/`agentId` overrides for standalone checks
- export `GuardResult` from both SDK package roots
