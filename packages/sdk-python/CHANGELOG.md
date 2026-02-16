# veto (Python SDK)

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
