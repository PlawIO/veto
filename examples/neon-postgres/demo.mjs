import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { neon } from '@neondatabase/serverless';
import { Veto } from '../../packages/sdk/dist/index.js';
import {
  buildDecisionReceipt,
  createReceiptId,
  hashCanonical,
  hashDecisionReceipt,
  verifyDecisionReceiptChain,
} from '../../packages/receipt-protocol/dist/index.js';

const POLICY = {
  id: 'neon-receipts-example',
  version: '2026-10-09.demo',
  rules: [
    {
      id: 'deny-confidential-export',
      name: 'Block confidential report exports',
      enabled: true,
      severity: 'critical',
      action: 'block',
      tools: ['export_report'],
      conditions: [{ field: 'arguments.classification', operator: 'equals', value: 'confidential' }],
    },
    {
      id: 'allow-public-export',
      name: 'Allow public report exports',
      enabled: true,
      severity: 'low',
      action: 'allow',
      tools: ['export_report'],
      conditions: [{ field: 'arguments.classification', operator: 'equals', value: 'public' }],
    },
  ],
};

export class DemoError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DemoError';
  }
}

export function requireDatabaseUrl(value) {
  if (!value?.trim()) {
    throw new DemoError('DATABASE_URL is required. Set it to the connection string from your Neon project.');
  }
  try {
    const url = new URL(value);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || !url.pathname.slice(1)) {
      throw new Error('Invalid Postgres URL');
    }
  } catch {
    throw new DemoError('DATABASE_URL must be a valid postgres:// or postgresql:// connection string.');
  }
  return value;
}

/** Run actual local policy checks. No report is exported or external tool executed. */
export async function createDemoReceipts(runId) {
  const veto = Veto.local({ bundle: POLICY, logLevel: 'silent', sessionId: runId });
  const receipts = [];
  const scenarios = [
    { classification: 'public', expected: 'allow' },
    { classification: 'confidential', expected: 'deny' },
  ];

  for (const [index, scenario] of scenarios.entries()) {
    const args = { reportId: `synthetic-report-${index + 1}`, classification: scenario.classification };
    const result = await veto.validate('export_report', args);
    if (result.decision !== scenario.expected) {
      throw new DemoError(`Policy check ${index + 1}: expected ${scenario.expected}, got ${result.decision}.`);
    }
    // Local validation returns a decision; the receipt protocol constructs the
    // portable receipt from that actual result, matching the finance demo.
    receipts.push(buildDecisionReceipt({
      previous: receipts.at(-1) ?? null,
      draft: {
        receipt_id: createReceiptId(),
        organization_id: 'org_neon_example',
        project_id: 'project_synthetic_reports',
        decision_id: `dec_${randomUUID()}`,
        session_id: runId,
        agent_id: 'agent_neon_example',
        client_id: 'local-neon-example',
        upstream_id: 'local',
        tool_name: 'export_report',
        tool_schema_hash: hashCanonical({ name: 'export_report', required: ['reportId', 'classification'] }),
        policy_id: POLICY.id,
        policy_version: POLICY.version,
        policy_hash: hashCanonical(POLICY),
        decision: result.decision,
        reason_code: result.ruleId ?? result.decision,
        reason_detail: result.reason ?? null,
        redacted_arguments: args,
        argument_hash: hashCanonical(args),
        result_hash: null,
        approval_hash: null,
        timestamp: new Date().toISOString(),
      },
    }));
  }
  const verified = verifyDecisionReceiptChain(receipts);
  if (!verified.ok) throw new DemoError('Locally generated receipt chain failed verification.');
  return receipts;
}

/** Keep the SQL explicit and parameterized; the driver transports it over HTTPS. */
export async function persistAndReadReceipts(sql, runId, receipts) {
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS veto_neon_demo_receipts (
        run_id UUID NOT NULL,
        sequence INTEGER NOT NULL CHECK (sequence > 0),
        receipt_id TEXT NOT NULL UNIQUE,
        decision TEXT NOT NULL CHECK (decision IN ('allow', 'deny')),
        receipt_hash TEXT NOT NULL,
        receipt JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (run_id, sequence)
      )
    `;
    // This transaction covers only the two audit inserts, not an external action.
    await sql.transaction(receipts.map((receipt, index) => sql`
      INSERT INTO veto_neon_demo_receipts
        (run_id, sequence, receipt_id, decision, receipt_hash, receipt)
      VALUES (${runId}::uuid, ${index + 1}, ${receipt.receipt_id}, ${receipt.decision},
        ${hashDecisionReceipt(receipt)}, ${JSON.stringify(receipt)}::jsonb)
    `));
    return await sql`
      SELECT sequence, receipt_id, decision, receipt_hash, receipt
      FROM veto_neon_demo_receipts
      WHERE run_id = ${runId}::uuid
      ORDER BY sequence
    `;
  } catch (error) {
    // Driver errors may include credentials, SQL parameters, or hostnames.
    // Only an exact PostgreSQL SQLSTATE is safe to include in CLI output.
    const code = typeof error?.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code)
      ? ` (SQLSTATE ${error.code})` : '';
    throw new DemoError(`Neon persistence failed${code}. Check DATABASE_URL, network access, and CREATE/INSERT/SELECT permissions. No verified result was produced.`);
  }
}

export function verifyReadback(rows, expectedReceipts) {
  if (rows.length !== expectedReceipts.length) {
    throw new DemoError(`Readback returned ${rows.length} receipts; expected ${expectedReceipts.length}.`);
  }
  const receipts = rows.map((row, index) => {
    const expected = expectedReceipts[index];
    const expectedHash = hashDecisionReceipt(expected);
    if (row.sequence !== index + 1 || row.receipt_id !== expected.receipt_id ||
        row.decision !== expected.decision || row.receipt_hash !== expectedHash ||
        hashDecisionReceipt(row.receipt) !== expectedHash) {
      throw new DemoError(`Stored receipt ${index + 1} does not match the local decision receipt.`);
    }
    return row.receipt;
  });
  const verified = verifyDecisionReceiptChain(receipts);
  if (!verified.ok) throw new DemoError('Stored receipt chain failed verification.');
  return verified;
}

export async function runDemo({ databaseUrl = process.env.DATABASE_URL, sqlFactory = neon } = {}) {
  requireDatabaseUrl(databaseUrl);
  let sql;
  try {
    // Bound the entire demo's database work to 30 seconds.
    sql = sqlFactory(databaseUrl, { fetchOptions: { signal: AbortSignal.timeout(30_000) } });
  } catch {
    throw new DemoError('Unable to initialize the Neon driver. Check DATABASE_URL.');
  }
  const runId = randomUUID();
  const receipts = await createDemoReceipts(runId);
  const rows = await persistAndReadReceipts(sql, runId, receipts);
  const verified = verifyReadback(rows, receipts);
  return {
    ok: true,
    runId,
    receiptCount: rows.length,
    decisions: rows.map((row) => row.decision),
    verified: verified.ok,
    finalReceiptHash: rows.at(-1).receipt_hash,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(await runDemo(), null, 2));
  } catch (error) {
    console.error(error instanceof DemoError ? error.message : 'Example failed before verification. Check the build and example setup.');
    process.exitCode = 1;
  }
}
