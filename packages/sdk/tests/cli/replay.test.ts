import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { replay } from '../../src/cli/replay.js';

const TMP = join(__dirname, '__replay_tmp__');

function writeFile(name: string, content: string): string {
  const path = join(TMP, name);
  writeFileSync(path, content, 'utf-8');
  return path;
}

beforeAll(() => {
  mkdirSync(TMP, { recursive: true });
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Simple policy: block transfer_funds with amount > 10000
// ---------------------------------------------------------------------------

const POLICY_YAML = `
version: "1.0"
name: financial-limits
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
  - id: prod-approval
    name: Production approval
    description: Require approval for prod deployments
    enabled: true
    severity: high
    action: require_approval
    tools:
      - deploy
    conditions:
      - field: arguments.env
        operator: equals
        value: prod
`;

// ---------------------------------------------------------------------------
// JSONL log with mixed calls
// ---------------------------------------------------------------------------

function makeLog(lines: object[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

const LOG_LINES = [
  { toolName: 'transfer_funds', arguments: { amount: 5000, to: 'alice' }, timestamp: '2024-01-01T00:00:00Z', decision: 'allow' },
  { toolName: 'transfer_funds', arguments: { amount: 12000, to: 'bob' }, timestamp: '2024-01-01T00:01:00Z', decision: 'allow' },
  { toolName: 'transfer_funds', arguments: { amount: 15000, to: 'charlie' }, timestamp: '2024-01-01T00:02:00Z', decision: 'allow' },
  { toolName: 'deploy', arguments: { env: 'staging', version: '1.2.3' }, timestamp: '2024-01-01T00:03:00Z', decision: 'allow' },
  { toolName: 'deploy', arguments: { env: 'prod', version: '1.2.3' }, timestamp: '2024-01-01T00:04:00Z', decision: 'allow' },
  { toolName: 'read_file', arguments: { path: '/tmp/readme.txt' }, timestamp: '2024-01-01T00:05:00Z', decision: 'allow' },
  { toolName: 'transfer_funds', arguments: { amount: 500, to: 'dave' }, timestamp: '2024-01-01T00:06:00Z', decision: 'deny' },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('veto replay', () => {
  it('produces correct summary counts', async () => {
    const policyPath = writeFile('financial.yaml', POLICY_YAML);
    const logPath = writeFile('calls.jsonl', makeLog(LOG_LINES));

    const result = await replay({ policy: policyPath, log: logPath, quiet: true });

    expect(result.success).toBe(true);
    expect(result.report).not.toBeNull();
    const report = result.report!;

    expect(report.totalCalls).toBe(7);
    // transfer_funds 5000 → allow, 12000 → deny, 15000 → deny, 500 → allow
    // deploy staging → allow, deploy prod → require_approval
    // read_file → allow
    expect(report.decisions.allow).toBe(4);
    expect(report.decisions.deny).toBe(2);
    expect(report.decisions.require_approval).toBe(1);
  });

  it('detects changed decisions', async () => {
    const policyPath = writeFile('financial.yaml', POLICY_YAML);
    const logPath = writeFile('calls.jsonl', makeLog(LOG_LINES));

    const result = await replay({ policy: policyPath, log: logPath, quiet: true });
    const report = result.report!;

    expect(report.hasOriginalDecisions).toBe(true);
    // Line 2: was allow, now deny (12000 > 10000)
    // Line 3: was allow, now deny (15000 > 10000)
    // Line 5: was allow, now require_approval (deploy to prod)
    // Line 7: was deny, now allow (500 is under limit) — also changed
    expect(report.changed.total).toBe(4);

    const toolNames = report.changed.calls.map((c) => c.tool);
    expect(toolNames).toContain('transfer_funds');
    expect(toolNames).toContain('deploy');

    const nowDenied = report.changed.calls.filter(
      (c) => c.replayedDecision === 'deny' && c.originalDecision === 'allow'
    );
    expect(nowDenied.length).toBe(2);
  });

  it('groups top denied by tool', async () => {
    const policyPath = writeFile('financial.yaml', POLICY_YAML);
    const logPath = writeFile('calls.jsonl', makeLog(LOG_LINES));

    const result = await replay({ policy: policyPath, log: logPath, quiet: true });
    const report = result.report!;

    expect(report.topDenied.length).toBeGreaterThan(0);
    expect(report.topDenied[0].tool).toBe('transfer_funds');
    expect(report.topDenied[0].count).toBe(2);
  });

  it('outputs JSON format', async () => {
    const policyPath = writeFile('financial.yaml', POLICY_YAML);
    const logPath = writeFile('calls.jsonl', makeLog(LOG_LINES));

    const chunks: string[] = [];
    const origWrite = process.stdout.write;
    process.stdout.write = ((chunk: string) => {
      chunks.push(chunk);
      return true;
    }) as typeof process.stdout.write;

    try {
      await replay({ policy: policyPath, log: logPath, format: 'json' });
    } finally {
      process.stdout.write = origWrite;
    }

    const output = chunks.join('');
    const parsed = JSON.parse(output);
    expect(parsed.totalCalls).toBe(7);
    expect(parsed.decisions.deny).toBe(2);
  });

  it('outputs text format with summary', async () => {
    const policyPath = writeFile('financial.yaml', POLICY_YAML);
    const logPath = writeFile('calls.jsonl', makeLog(LOG_LINES));

    const chunks: string[] = [];
    const origWrite = process.stdout.write;
    process.stdout.write = ((chunk: string) => {
      chunks.push(chunk);
      return true;
    }) as typeof process.stdout.write;

    try {
      await replay({ policy: policyPath, log: logPath });
    } finally {
      process.stdout.write = origWrite;
    }

    const output = chunks.join('');
    expect(output).toContain('Replaying 7 tool calls');
    expect(output).toContain('allowed');
    expect(output).toContain('denied');
    expect(output).toContain('Top denied');
    expect(output).toContain('transfer_funds');
  });

  it('outputs diff-only text when --diff is set', async () => {
    const policyPath = writeFile('financial.yaml', POLICY_YAML);
    const logPath = writeFile('calls.jsonl', makeLog(LOG_LINES));

    const chunks: string[] = [];
    const origWrite = process.stdout.write;
    process.stdout.write = ((chunk: string) => {
      chunks.push(chunk);
      return true;
    }) as typeof process.stdout.write;

    try {
      await replay({ policy: policyPath, log: logPath, diff: true });
    } finally {
      process.stdout.write = origWrite;
    }

    const output = chunks.join('');
    expect(output).toContain('CHANGED');
    expect(output).toContain('allow');
    expect(output).toContain('deny');
    // Should not contain summary header
    expect(output).not.toContain('Replaying');
  });

  it('works with log entries that have no original decision', async () => {
    const policyPath = writeFile('financial.yaml', POLICY_YAML);
    const noDecisionLog = makeLog([
      { toolName: 'transfer_funds', arguments: { amount: 50000 }, timestamp: '2024-01-01T00:00:00Z' },
      { toolName: 'read_file', arguments: { path: '/tmp/x' }, timestamp: '2024-01-01T00:01:00Z' },
    ]);
    const logPath = writeFile('no-decision.jsonl', noDecisionLog);

    const result = await replay({ policy: policyPath, log: logPath, quiet: true });
    const report = result.report!;

    expect(report.hasOriginalDecisions).toBe(false);
    expect(report.changed.total).toBe(0);
    expect(report.decisions.deny).toBe(1);
    expect(report.decisions.allow).toBe(1);
  });

  it('works with directory of policy files', async () => {
    const policyDir = join(TMP, 'policies');
    mkdirSync(policyDir, { recursive: true });
    writeFileSync(join(policyDir, 'financial.yaml'), POLICY_YAML, 'utf-8');

    const logPath = writeFile('calls-dir.jsonl', makeLog(LOG_LINES));

    const result = await replay({ policy: policyDir, log: logPath, quiet: true });
    expect(result.success).toBe(true);
    expect(result.report!.decisions.deny).toBe(2);
  });

  it('returns error for missing policy', async () => {
    const logPath = writeFile('calls-err.jsonl', makeLog(LOG_LINES));
    const result = await replay({ policy: '/nonexistent/policy.yaml', log: logPath, quiet: true });

    expect(result.success).toBe(false);
    expect(result.errors[0]).toContain('Failed to load policy');
  });

  it('returns error for missing log file', async () => {
    const policyPath = writeFile('financial.yaml', POLICY_YAML);
    const result = await replay({ policy: policyPath, log: '/nonexistent/calls.jsonl', quiet: true });

    expect(result.success).toBe(false);
    expect(result.errors[0]).toContain('Failed to parse log');
  });

  it('returns error when --policy is missing', async () => {
    const result = await replay({ policy: '', log: 'some.jsonl', quiet: true });
    expect(result.success).toBe(false);
    expect(result.errors[0]).toContain('--policy is required');
  });

  it('accepts flexible field names in log', async () => {
    const policyPath = writeFile('financial.yaml', POLICY_YAML);
    const flexLog = makeLog([
      { tool: 'transfer_funds', args: { amount: 20000 }, timestamp: '2024-01-01T00:00:00Z' },
      { tool_name: 'read_file', arguments: { path: '/x' }, timestamp: '2024-01-01T00:01:00Z' },
    ]);
    const logPath = writeFile('flex.jsonl', flexLog);

    const result = await replay({ policy: policyPath, log: logPath, quiet: true });
    expect(result.success).toBe(true);
    expect(result.report!.decisions.deny).toBe(1);
    expect(result.report!.decisions.allow).toBe(1);
  });

  it('handles invalid lines gracefully', async () => {
    const policyPath = writeFile('financial.yaml', POLICY_YAML);
    const badLog = [
      'not json',
      JSON.stringify({ toolName: 'transfer_funds', arguments: { amount: 100 }, timestamp: '2024-01-01T00:00:00Z' }),
      '{"incomplete": true}',
      JSON.stringify({ toolName: 'read_file', arguments: { path: '/x' }, timestamp: '2024-01-01T00:01:00Z' }),
    ].join('\n');
    const logPath = writeFile('bad.jsonl', badLog);

    const result = await replay({ policy: policyPath, log: logPath, quiet: true });
    expect(result.success).toBe(true);
    expect(result.report!.totalCalls).toBe(2);
    expect(result.report!.invalidLines).toBe(2);
  });
});
