# Human-in-the-Loop Approval Guide

This guide shows how to require human approval for sensitive tool calls and export the full decision history.

## Scenario: Escalate Large Bank Transfers

Goal: allow normal transfers, but escalate transfers above a threshold so a human reviewer can approve or deny before execution.

## TypeScript (Local YAML + Webhook)

### 1) Configure Veto

Create `veto/veto.config.yaml`:

```yaml
version: "1.0"
mode: "strict"
validation:
  mode: "local"

approval:
  callbackUrl: "http://localhost:8787/approvals"
  timeout: 30000
  timeoutBehavior: "block" # "block" (default) or "allow"
  includeCustomContext: false # opt-in for forwarding context.custom
  responseSchema:
    decisionField: "decision"
    reasonField: "reason"

rules:
  directory: "./rules"
```

Create `veto/rules/payments.yaml`:

```yaml
version: "1.0"
name: payment-approvals
rules:
  - id: require-large-transfer-approval
    name: Require approval for large bank transfers
    description: Escalate transfers above $10,000 for human review
    enabled: true
    action: require_approval
    tools: [bank_transfer]
    conditions:
      - field: arguments.amount
        operator: greater_than
        value: 10000
```

### 2) Implement Approval Webhook

```ts
import express from "express";

const app = express();
app.use(express.json());

app.post("/approvals", async (req, res) => {
  const amount = Number(req.body?.arguments?.amount ?? 0);

  // Example policy: auto-approve <= 25k, deny above that.
  if (amount <= 25000) {
    return res.json({
      decision: "approved",
      reason: "Treasury auto-approval rule",
    });
  }

  return res.json({
    decision: "denied",
    reason: "Amount exceeds treasury auto-limit",
  });
});

app.listen(8787);
```

### 3) Protect Tool and Run

```ts
import { protect } from "veto-sdk";

const tools = await protect([
  {
    name: "bank_transfer",
    inputSchema: {
      type: "object",
      properties: {
        amount: { type: "number" },
        recipient: { type: "string" },
      },
      required: ["amount", "recipient"],
    },
    handler: async ({ amount, recipient }) => {
      return `Transferred ${amount} to ${recipient}`;
    },
  },
]);

await tools[0].handler({ amount: 15000, recipient: "ACME Treasury" });
```

### 4) Advanced: Explicit Instance for Decision Export

Use `Veto.init()` when you need an explicit runtime instance for exports or direct `guard()` calls.

```ts
import { Veto } from "veto-sdk";

const veto = await Veto.init();
const jsonAudit = veto.exportDecisions("json");
const csvAudit = veto.exportDecisions("csv");

console.log(jsonAudit);
console.log(csvAudit);
```

Each record includes:

- `timestamp`
- `tool_name`
- `arguments`
- `policy_version`
- `rule_id`
- `decision`
- `reason`

## Python (Cloud Approval + Decision Export)

Python SDK supports approval flow in cloud mode and uses the same decision export surface.

```python
from veto import protect, Veto, VetoOptions

safe = await protect(tools)

# Advanced: explicit instance for cloud approval callbacks and exports.

def on_approval_required(context, approval_id):
    print(f"Approval needed: {approval_id} for tool={context.tool_name}")

veto = await Veto.init(VetoOptions(
    api_key="veto_...",
    on_approval_required=on_approval_required,
    approval_poll_interval=1.0,
    approval_timeout=60.0,
))

json_audit = veto.export_decisions("json")
csv_audit = veto.export_decisions("csv")
```

## Timeout Behavior

- `timeoutBehavior: block` (default): deny tool call when approval callback times out.
- `timeoutBehavior: allow`: allow tool call if callback does not respond before timeout.
