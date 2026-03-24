# Guarded Polymarket MCP Guide

This guide shows how to use Veto as the policy layer inside an MCP server that can read markets, place orders, and escalate sensitive actions for approval.

## Scenario: put Veto in front of a trading agent

Goal: let an agent inspect markets freely, but require policy checks before any order placement, cancellation, or wallet-adjacent operation runs.

The useful split is:

- Read-only tools: `markets_search`, `markets_get`, `clob_book`
- Mutating tools: `order_create_limit`, `order_market`, `order_cancel`, `order_cancel_all`
- High-risk tools: `wallet_import`, `wallet_reset`, `clob_delete_api_key`

In practice, most teams also simulate mutations by default and make live execution a separate runtime opt-in. That live-vs-sim behavior belongs in your MCP runtime. Veto remains the decision layer that says allow, deny, or require approval.

## 1) Configure Veto rules

Create `veto/veto.config.yaml`:

```yaml
version: "1.0"
mode: strict

validation:
  mode: local

rules:
  directory: ./rules
  recursive: true
```

Create `veto/rules/trading.yaml`:

```yaml
version: "1.0"
name: polymarket-trading

rules:
  - id: require-approval-for-orders-over-25
    name: Require approval for larger orders
    action: require_approval
    tools: [order_create_limit, order_market]
    conditions:
      - field: arguments.amount_usd
        operator: greater_than
        value: 25

  - id: require-approval-for-cancel-all
    name: Require approval before wiping all open orders
    action: require_approval
    tools: [order_cancel_all]

  - id: block-wallet-mutations
    name: Block wallet and key mutation operations
    action: block
    tools: [wallet_import, wallet_reset, clob_delete_api_key]
```

This keeps the policy logic explicit:

- small trades can pass automatically
- larger trades can escalate to a human
- destructive wallet operations never reach execution

## 2) Guard an MCP-style runtime

```ts
import { Veto } from "veto-sdk";

const veto = await Veto.init({
  configDir: "./veto",
  logLevel: "silent",
});

type ToolContext = {
  sessionId: string;
  agentId: string;
};

async function callTool(
  toolName: string,
  args: Record<string, unknown>,
  context: ToolContext,
) {
  const decision = await veto.guard(toolName, args, context);

  if (decision.decision === "deny") {
    return {
      ok: false,
      error: decision.reason ?? "Denied by policy",
    };
  }

  if (decision.decision === "require_approval") {
    return {
      ok: false,
      pending: true,
      approvalId: decision.approvalId ?? null,
      message: decision.reason ?? "Approval required",
    };
  }

  return await executeUnderlyingTool(toolName, args);
}
```

The MCP runtime owns what happens next:

- read tools can execute normally
- mutating tools can run in simulation mode first
- approval-required results can be returned to the agent with an `approvalId`
- a separate MCP tool can check approval status later

That separation matters. Veto decides whether the action is permitted. Your runtime decides how to stage execution, persist pending approvals, and expose status back to the agent.

## 3) Why this pattern works well for MCP

- MCP gives agents a uniform tool surface.
- Veto lets you keep policy separate from tool code.
- Deterministic YAML rules are a good fit for notional thresholds, blocked operations, and time-of-day controls.
- Approval flows let an agent continue working instead of blindly failing or executing.
- The same pattern applies to other priced tools beyond trading, including paid research and budgeted API calls.

## 4) Reference implementation

For a complete working example, see:

- [`PlawIO/polymarket-cli-veto`](https://github.com/PlawIO/polymarket-cli-veto) — Rust Polymarket CLI plus a Veto-powered MCP sidecar
- [`@plawio/polymarket-veto-mcp`](https://www.npmjs.com/package/@plawio/polymarket-veto-mcp) — published MCP server package

That implementation adds runtime behavior on top of Veto, including:

- simulation by default for mutating tools
- approval polling through a dedicated `approval_status` tool
- profile-based policies such as `defaults`, `agent`, `user`, and `conservative`
- optional economic authorization for trade notional and paid research spend
