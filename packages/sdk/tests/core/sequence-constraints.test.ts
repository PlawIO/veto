import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Veto } from '../../src/core/veto.js';

const TEST_DIR = '/tmp/veto-sequence-constraints-' + Date.now();
const VETO_DIR = join(TEST_DIR, 'veto');
const RULES_DIR = join(VETO_DIR, 'rules');

function writeLocalConfig(): void {
  writeFileSync(
    join(VETO_DIR, 'veto.config.yaml'),
    `
version: "1.0"
mode: "strict"
validation:
  mode: "local"
logging:
  level: "silent"
rules:
  directory: "./rules"
`,
    'utf-8'
  );
}

function writeRuleFile(content: string): void {
  writeFileSync(join(RULES_DIR, 'policy.yaml'), content, 'utf-8');
}

describe('Local Sequence Constraints', () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
    mkdirSync(RULES_DIR, { recursive: true });
    writeLocalConfig();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  it('blocks with blocked_by without conditions', async () => {
    writeRuleFile(
      `
version: "1.0"
rules:
  - id: block-after-read
    name: Block send after read
    description: Sending is blocked after read_file
    action: block
    tools: [send_email]
    blocked_by:
      - tool: read_file
`
    );

    const veto = await Veto.init({ configDir: VETO_DIR });

    const beforeRead = await veto.guard('send_email', { to: 'ops@example.com' });
    expect(beforeRead.decision).toBe('allow');

    await veto.guard('read_file', { path: '/tmp/report.txt' });
    const afterRead = await veto.guard('send_email', { to: 'ops@example.com' });
    expect(afterRead).toMatchObject({
      decision: 'deny',
      ruleId: 'block-after-read',
    });
  });

  it('respects blocked_by conditions against historical arguments', async () => {
    writeRuleFile(
      `
version: "1.0"
rules:
  - id: block-after-sensitive-read
    name: Block send after sensitive read
    action: block
    tools: [send_email]
    blocked_by:
      - tool: read_file
        conditions:
          - field: arguments.path
            operator: starts_with
            value: /etc/secrets
`
    );

    const veto = await Veto.init({ configDir: VETO_DIR });

    await veto.guard('read_file', { path: '/tmp/public.txt' });
    const afterPublicRead = await veto.guard('send_email', { to: 'team@example.com' });
    expect(afterPublicRead.decision).toBe('allow');

    await veto.guard('read_file', { path: '/etc/secrets/token.txt' });
    const afterSensitiveRead = await veto.guard('send_email', { to: 'team@example.com' });
    expect(afterSensitiveRead).toMatchObject({
      decision: 'deny',
      ruleId: 'block-after-sensitive-read',
    });
  });

  it('requires a previous tool call when requires has no window', async () => {
    writeRuleFile(
      `
version: "1.0"
rules:
  - id: require-verify
    name: Require identity check
    action: block
    tools: [transfer_funds]
    requires:
      - tool: verify_identity
`
    );

    const veto = await Veto.init({ configDir: VETO_DIR });

    const beforeVerify = await veto.guard('transfer_funds', { amount: 5000 });
    expect(beforeVerify).toMatchObject({
      decision: 'deny',
      ruleId: 'require-verify',
    });

    await veto.guard('verify_identity', { user_id: 'u-1' });
    const afterVerify = await veto.guard('transfer_funds', { amount: 5000 });
    expect(afterVerify.decision).toBe('allow');
  });

  it('enforces requires.within time windows', async () => {
    writeRuleFile(
      `
version: "1.0"
rules:
  - id: require-recent-verify
    name: Require recent identity check
    action: block
    tools: [transfer_funds]
    requires:
      - tool: verify_identity
        within: 300
`
    );

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));

    const veto = await Veto.init({ configDir: VETO_DIR });
    await veto.guard('verify_identity', { user_id: 'u-2' });

    vi.setSystemTime(new Date('2025-01-01T00:04:59.000Z'));
    const withinWindow = await veto.guard('transfer_funds', { amount: 3000 });
    expect(withinWindow.decision).toBe('allow');

    vi.setSystemTime(new Date('2025-01-01T00:05:01.000Z'));
    const outsideWindow = await veto.guard('transfer_funds', { amount: 3000 });
    expect(outsideWindow).toMatchObject({
      decision: 'deny',
      ruleId: 'require-recent-verify',
    });
  });

  it('supports multiple sequence rules for the same tool', async () => {
    writeRuleFile(
      `
version: "1.0"
rules:
  - id: require-verify-first
    name: Require verify first
    action: block
    tools: [send_email]
    requires:
      - tool: verify_identity
  - id: block-after-read
    name: Block after read
    action: block
    tools: [send_email]
    blocked_by:
      - tool: read_file
`
    );

    const veto = await Veto.init({ configDir: VETO_DIR });

    const missingVerify = await veto.guard('send_email', { to: 'ops@example.com' });
    expect(missingVerify).toMatchObject({
      decision: 'deny',
      ruleId: 'require-verify-first',
    });

    await veto.guard('verify_identity', { user_id: 'u-3' });
    const afterVerify = await veto.guard('send_email', { to: 'ops@example.com' });
    expect(afterVerify.decision).toBe('allow');

    await veto.guard('read_file', { path: '/tmp/log.txt' });
    const afterRead = await veto.guard('send_email', { to: 'ops@example.com' });
    expect(afterRead).toMatchObject({
      decision: 'deny',
      ruleId: 'block-after-read',
    });
  });

  it('combines sequence checks with existing rule conditions', async () => {
    writeRuleFile(
      `
version: "1.0"
rules:
  - id: high-value-transfer-needs-verify
    name: High value transfer needs verify
    action: block
    tools: [transfer_funds]
    conditions:
      - field: arguments.amount
        operator: greater_than
        value: 1000
    requires:
      - tool: verify_identity
`
    );

    const veto = await Veto.init({ configDir: VETO_DIR });

    const deniedHighValue = await veto.guard('transfer_funds', { amount: 5000 });
    expect(deniedHighValue.decision).toBe('deny');

    const lowValueBypassesRule = await veto.guard('transfer_funds', { amount: 100 });
    expect(lowValueBypassesRule.decision).toBe('allow');

    await veto.guard('verify_identity', { user_id: 'u-4' });
    const allowedAfterVerify = await veto.guard('transfer_funds', { amount: 5000 });
    expect(allowedAfterVerify.decision).toBe('allow');
  });

  it('applies sequence checks only to retained history entries', async () => {
    writeRuleFile(
      `
version: "1.0"
rules:
  - id: require-bootstrap
    name: Require bootstrap call
    action: block
    tools: [launch_job]
    requires:
      - tool: bootstrap
`
    );

    const veto = await Veto.init({ configDir: VETO_DIR });

    await veto.guard('bootstrap', { ok: true });
    for (let i = 0; i < 100; i++) {
      await veto.guard('noop', { i });
    }

    const result = await veto.guard('launch_job', { id: 'job-1' });
    expect(result).toMatchObject({
      decision: 'deny',
      ruleId: 'require-bootstrap',
    });
  });
});
