# veto (Python SDK)

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
