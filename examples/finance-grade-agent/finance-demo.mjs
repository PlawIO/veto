import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXAMPLE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(EXAMPLE_DIR, '..', '..');
const OUTPUT_DIR = resolve(process.env.VETO_FINANCE_DEMO_OUT ?? join(EXAMPLE_DIR, 'demo-output'));
const RECEIPTS_PATH = join(OUTPUT_DIR, 'receipts.ndjson');
const POLICY_PATH = join(OUTPUT_DIR, 'policy-bundle.json');
const APPROVAL_PATH = join(OUTPUT_DIR, 'approval-request.json');
const SUMMARY_PATH = join(OUTPUT_DIR, 'summary.json');

async function importWithFallback(packageName, fallbackPath) {
  try {
    return await import(packageName);
  } catch (packageError) {
    try {
      return await import(fallbackPath);
    } catch (fallbackError) {
      throw new Error(
        `Unable to load ${packageName}. Run "pnpm install --frozen-lockfile && pnpm build" from ${REPO_ROOT}. ` +
        `Package import failed: ${packageError.message}. Local fallback failed: ${fallbackError.message}`,
      );
    }
  }
}

const { Veto } = await importWithFallback('veto-sdk', '../../packages/sdk/dist/index.js');
const {
  buildDecisionReceipt,
  formatReceiptNdjson,
  hashCanonical,
  hashDecisionReceipt,
  verifyDecisionReceiptChain,
} = await importWithFallback('veto-receipt-protocol', '../../packages/receipt-protocol/dist/index.js');

const POLICY_ID = 'finance-grade-agent-demo';
const POLICY_VERSION = '2026-06-05.demo';
const ORGANIZATION_ID = 'org_finance_demo';
const PROJECT_ID = 'project_ap_demo';
const SESSION_ID = 'sess_finance_demo_001';
const AGENT_ID = 'agent_ap_copilot';
const CLIENT_ID = 'local-finance-demo';
const TIMESTAMPS = [
  '2026-06-05T12:00:00.000Z',
  '2026-06-05T12:00:01.000Z',
  '2026-06-05T12:00:02.000Z',
];

const policyBundle = {
  id: POLICY_ID,
  version: POLICY_VERSION,
  rules: [
    {
      id: 'deny-unapproved-vendor-payment',
      name: 'Deny unapproved vendor payment release',
      description: 'Vendor is not approved for payment release',
      enabled: true,
      severity: 'critical',
      action: 'block',
      tools: ['release_payment'],
      conditions: [
        {
          field: 'arguments.vendorStatus',
          operator: 'not_equals',
          value: 'approved',
        },
      ],
    },
    {
      id: 'require-refund-controller-approval',
      name: 'Require controller approval for material refunds',
      description: 'Refund exceeds the local autonomous threshold',
      enabled: true,
      severity: 'critical',
      action: 'require_approval',
      tools: ['issue_refund'],
      conditions: [
        {
          field: 'arguments.amountUsd',
          operator: 'greater_than',
          value: 1000,
        },
      ],
    },
    {
      id: 'allow-low-risk-purchase-order',
      name: 'Allow low-risk purchase order creation',
      description: 'Approved vendor and amount are inside the autonomous purchase order limit',
      enabled: true,
      severity: 'low',
      action: 'allow',
      tools: ['create_purchase_order'],
      conditions: [
        {
          field: 'arguments.vendorStatus',
          operator: 'equals',
          value: 'approved',
        },
        {
          field: 'arguments.amountUsd',
          operator: 'less_than_or_equal',
          value: 1000,
        },
      ],
    },
  ],
};

const toolSchemas = {
  create_purchase_order: {
    name: 'create_purchase_order',
    required: ['vendorId', 'amountUsd', 'currency', 'category'],
  },
  release_payment: {
    name: 'release_payment',
    required: ['vendorId', 'invoiceId', 'amountUsd', 'currency'],
  },
  issue_refund: {
    name: 'issue_refund',
    required: ['customerId', 'refundId', 'amountUsd', 'currency', 'reason'],
  },
};

const scenarios = [
  {
    id: 'allow-office-supplies-po',
    receiptId: 'rcp_000000000000000000000001',
    decisionId: 'dec_allow_office_supplies_po',
    tool: 'create_purchase_order',
    expected: 'allow',
    args: {
      vendorId: 'vnd_approved_001',
      vendorStatus: 'approved',
      amountUsd: 740,
      currency: 'USD',
      category: 'office_supplies',
    },
    result: {
      purchaseOrderId: 'po_demo_001',
      status: 'created',
    },
  },
  {
    id: 'deny-unapproved-vendor-payment',
    receiptId: 'rcp_000000000000000000000002',
    decisionId: 'dec_deny_unapproved_vendor_payment',
    tool: 'release_payment',
    expected: 'deny',
    args: {
      vendorId: 'vnd_unknown_404',
      vendorStatus: 'unapproved',
      invoiceId: 'inv_demo_404',
      amountUsd: 12000,
      currency: 'USD',
      bankAccountLast4: '9821',
    },
    result: null,
  },
  {
    id: 'require-approval-enterprise-refund',
    receiptId: 'rcp_000000000000000000000003',
    decisionId: 'dec_require_approval_refund',
    approvalId: 'appr_demo_refund_001',
    tool: 'issue_refund',
    expected: 'require_approval',
    args: {
      customerId: 'cus_enterprise_007',
      refundId: 'ref_demo_001',
      customerTier: 'enterprise',
      amountUsd: 1850,
      currency: 'USD',
      reason: 'contract_credit',
    },
    result: null,
  },
];

function redactArguments(args) {
  const {
    amountUsd,
    currency,
    vendorId,
    vendorStatus,
    invoiceId,
    category,
    customerTier,
    refundId,
    reason,
  } = args;
  return Object.fromEntries(
    Object.entries({
      amountUsd,
      currency,
      vendorId,
      vendorStatus,
      invoiceId,
      category,
      customerTier,
      refundId,
      reason,
    }).filter(([, value]) => value !== undefined),
  );
}

function approvalArtifactFor(scenario, decision) {
  if (decision.decision !== 'require_approval') return null;
  return {
    approval_id: scenario.approvalId,
    requested_at: TIMESTAMPS[2],
    approver_role: 'finance_controller',
    expires_at: '2026-06-06T12:00:00.000Z',
    action: scenario.tool,
    amountUsd: scenario.args.amountUsd,
    currency: scenario.args.currency,
    reason: decision.reason,
    policy_rule_id: decision.ruleId,
  };
}

function buildReceipt({ scenario, decision, approvalArtifact, index, previous, policyHash }) {
  return buildDecisionReceipt({
    previous,
    draft: {
      receipt_id: scenario.receiptId,
      organization_id: ORGANIZATION_ID,
      project_id: PROJECT_ID,
      decision_id: scenario.decisionId,
      approval_id: approvalArtifact ? scenario.approvalId : null,
      session_id: SESSION_ID,
      agent_id: AGENT_ID,
      client_id: CLIENT_ID,
      connection_id: null,
      upstream_id: 'local',
      tool_name: scenario.tool,
      tool_schema_hash: hashCanonical(toolSchemas[scenario.tool]),
      policy_id: POLICY_ID,
      policy_version: POLICY_VERSION,
      policy_hash: policyHash,
      decision: decision.decision,
      reason_code: decision.ruleId ?? decision.decision,
      reason_detail: decision.reason ?? null,
      redacted_arguments: redactArguments(scenario.args),
      argument_hash: hashCanonical(scenario.args),
      result_hash: scenario.result ? hashCanonical(scenario.result) : null,
      approval_hash: approvalArtifact ? hashCanonical(approvalArtifact) : null,
      timestamp: TIMESTAMPS[index],
      trace_id: `trace_finance_demo_${String(index + 1).padStart(2, '0')}`,
    },
  });
}

const policyHash = hashCanonical(policyBundle);
const veto = Veto.local({
  bundle: policyBundle,
  logLevel: 'silent',
  sessionId: SESSION_ID,
  agentId: AGENT_ID,
});

const receipts = [];
const summary = [];
let approvalArtifact = null;
let previous = null;

for (let index = 0; index < scenarios.length; index += 1) {
  const scenario = scenarios[index];
  const decision = await veto.validate(scenario.tool, scenario.args, {
    sessionId: SESSION_ID,
    agentId: AGENT_ID,
    role: 'ap_operator',
    custom: {
      scenario: scenario.id,
      irreversible: true,
      source: 'finance-grade-agent-demo',
    },
  });

  if (decision.decision !== scenario.expected) {
    throw new Error(`${scenario.id}: expected ${scenario.expected}, got ${decision.decision}`);
  }

  const scenarioApprovalArtifact = approvalArtifactFor(scenario, decision);
  if (scenarioApprovalArtifact) approvalArtifact = scenarioApprovalArtifact;

  const receipt = buildReceipt({
    scenario,
    decision,
    approvalArtifact: scenarioApprovalArtifact,
    index,
    previous,
    policyHash,
  });
  receipts.push(receipt);
  previous = receipt;

  summary.push({
    scenario: scenario.id,
    tool: scenario.tool,
    decision: decision.decision,
    ruleId: decision.ruleId ?? null,
    reason: decision.reason ?? null,
    receiptId: receipt.receipt_id,
    receiptHash: hashDecisionReceipt(receipt),
    approvalId: scenarioApprovalArtifact?.approval_id ?? null,
  });
}

const verified = verifyDecisionReceiptChain(receipts);
if (!verified.ok) {
  throw new Error(`Receipt chain failed offline verification: ${verified.reason}`);
}

mkdirSync(OUTPUT_DIR, { recursive: true });
writeFileSync(RECEIPTS_PATH, formatReceiptNdjson(receipts), 'utf-8');
writeFileSync(POLICY_PATH, `${JSON.stringify(policyBundle, null, 2)}\n`, 'utf-8');
if (approvalArtifact) {
  writeFileSync(APPROVAL_PATH, `${JSON.stringify(approvalArtifact, null, 2)}\n`, 'utf-8');
}
writeFileSync(
  SUMMARY_PATH,
  `${JSON.stringify({
    ok: true,
    outputDir: OUTPUT_DIR,
    receiptsPath: RECEIPTS_PATH,
    policyHash,
    receiptCount: receipts.length,
    finalReceiptHash: hashDecisionReceipt(receipts[receipts.length - 1]),
    verified,
    decisions: summary,
  }, null, 2)}\n`,
  'utf-8',
);

console.log('Veto financial-grade agent demo');
for (const row of summary) {
  const approval = row.approvalId ? ` approval=${row.approvalId}` : '';
  console.log(`- ${row.tool}: ${row.decision} rule=${row.ruleId ?? 'default'} receipt=${row.receiptId}${approval}`);
}
console.log(`Receipt chain verified offline: ${receipts.length} receipts`);
console.log(`Wrote ${RECEIPTS_PATH}`);
