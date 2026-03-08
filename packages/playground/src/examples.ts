export interface Example {
  id: string;
  name: string;
  description: string;
  policy: string;
  toolName: string;
  args: string;
}

export const EXAMPLES: Example[] = [
  {
    id: 'financial-limits',
    name: 'Financial Agent',
    description: 'Transfer limits and approval thresholds',
    policy: `version: "1.0"
name: financial-guardrails
description: Safety rules for a financial agent

rules:
  - id: transfer-limit
    name: Transfer limit
    description: Block transfers over $10,000
    enabled: true
    severity: high
    action: block
    tools:
      - transfer_funds
    conditions:
      - field: arguments.amount
        operator: greater_than
        value: 10000

  - id: large-transfer-approval
    name: Large transfer approval
    description: Require approval for transfers over $5,000
    enabled: true
    severity: medium
    action: require_approval
    tools:
      - transfer_funds
    conditions:
      - field: arguments.amount
        operator: greater_than
        value: 5000

  - id: wire-known-accounts
    name: Wire to unknown accounts
    description: Block wire transfers to unrecognized accounts
    enabled: true
    severity: critical
    action: block
    tools:
      - wire_transfer
    conditions:
      - field: arguments.account_id
        operator: not_in
        value: ["ACC-001", "ACC-002", "ACC-003"]`,
    toolName: 'transfer_funds',
    args: JSON.stringify({ amount: 12000, to: 'vendor-x', memo: 'equipment' }, null, 2),
  },
  {
    id: 'browser-agent',
    name: 'Browser Agent',
    description: 'URL blocking and navigation safety',
    policy: `version: "1.0"
name: browser-safety
description: Safety rules for a browser automation agent

rules:
  - id: block-internal-urls
    name: Block internal URLs
    description: Prevent navigation to internal/admin domains
    enabled: true
    severity: critical
    action: block
    tools:
      - navigate
    conditions:
      - field: arguments.url
        operator: matches
        value: "https?://(admin|internal|staging)\\\\."

  - id: block-file-protocol
    name: Block file protocol
    description: Never allow file:// URLs
    enabled: true
    severity: critical
    action: block
    tools:
      - navigate
    conditions:
      - field: arguments.url
        operator: starts_with
        value: "file://"

  - id: form-pii-block
    name: Block PII in forms
    description: Prevent entering SSN-like patterns in forms
    enabled: true
    severity: high
    action: block
    tools:
      - fill_form
    conditions:
      - field: arguments.value
        operator: matches
        value: "\\\\d{3}-\\\\d{2}-\\\\d{4}"`,
    toolName: 'navigate',
    args: JSON.stringify({ url: 'https://admin.internal-tools.com/dashboard' }, null, 2),
  },
  {
    id: 'support-agent',
    name: 'Support Agent',
    description: 'Scope restrictions and data access limits',
    policy: `version: "1.0"
name: support-guardrails
description: Safety rules for a customer support agent

rules:
  - id: no-delete-accounts
    name: Block account deletion
    description: Support agents cannot delete user accounts
    enabled: true
    severity: critical
    action: block
    tools:
      - delete_account

  - id: refund-limit
    name: Refund limit
    description: Require approval for refunds over $500
    enabled: true
    severity: high
    action: require_approval
    tools:
      - issue_refund
    conditions:
      - field: arguments.amount
        operator: greater_than
        value: 500

  - id: no-password-reset-bulk
    name: Block bulk password resets
    description: Cannot reset more than one password at a time
    enabled: true
    severity: high
    action: block
    tools:
      - reset_password
    conditions:
      - field: arguments.user_ids
        operator: length_greater_than
        value: 1`,
    toolName: 'issue_refund',
    args: JSON.stringify({ amount: 750, reason: 'customer complaint', order_id: 'ORD-9923' }, null, 2),
  },
  {
    id: 'deploy-agent',
    name: 'Deploy Agent',
    description: 'Production deployment gates',
    policy: `version: "1.0"
name: deployment-policy
description: Guardrails for CI/CD automation agents

rules:
  - id: prod-approval
    name: Production approval required
    description: All production deployments need human approval
    enabled: true
    severity: high
    action: require_approval
    tools:
      - deploy
    conditions:
      - field: arguments.env
        operator: equals
        value: prod

  - id: no-force-deploy
    name: Block force deploys
    description: Never allow force-push deployments
    enabled: true
    severity: critical
    action: block
    tools:
      - deploy
    conditions:
      - field: arguments.force
        operator: equals
        value: true

  - id: no-rollback-prod
    name: Block prod rollback without approval
    description: Require approval for production rollbacks
    enabled: true
    severity: high
    action: require_approval
    tools:
      - rollback
    conditions:
      - field: arguments.env
        operator: equals
        value: prod`,
    toolName: 'deploy',
    args: JSON.stringify({ env: 'prod', version: '2.1.0', force: false }, null, 2),
  },
];
