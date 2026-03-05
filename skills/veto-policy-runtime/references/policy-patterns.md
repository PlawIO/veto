# Policy Patterns

Use deterministic policies by default when constraints are structurally expressible.

## Block High-Risk Amounts

Prompt:

`do not approve invoices above 50 dollars`

Expected action:

- `block`
- Tool: `approve_invoice`
- Condition: `arguments.amount > 50`

## Require Approval Above Threshold

Prompt:

`require approval for transfer_funds above 1000`

Expected action:

- `require_approval`
- Tool: `transfer_funds`
- Condition: `arguments.amount > 1000`

## Domain Allowlist

Prompt:

`only allow outbound_email to company.com and partner.org`

Expected deterministic strategy:

- `block` on non-matching domains
- Condition on `arguments.to` using allowlist logic

## Time Window Restriction

Prompt:

`deny deployment actions outside business hours`

Expected deterministic strategy:

- `block`
- Tool: deployment tool names
- Time-based condition using `within_hours` / `outside_hours`

## Escalation vs Blocking

- Use `block` when action must never proceed automatically.
- Use `require_approval` when action can proceed with human sign-off.
- Use `warn` or `log` for rollout and observation phases.

## Mode Selection

- Choose `deterministic` for thresholds, enums, range checks, and structured conditions.
- Choose `llm` only for semantic checks not safely captured by deterministic rules.
