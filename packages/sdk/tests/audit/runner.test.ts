/**
 * End-to-end audit trail tests.
 *
 * These tests create real Veto instances, write decisions to a real audit log,
 * and verify the chain via the same logic used by `veto audit verify`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { Veto } from '../../src/core/veto.js';
import { computeChainHash, GENESIS_HASH } from '../../src/audit/chain.js';

const TMP = '/tmp/veto-audit-e2e-' + Date.now();

afterEach(() => {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
});

function setupVetoDir(extraConfig = ''): { configDir: string; auditLog: string } {
  const configDir = join(TMP, 'veto');
  const rulesDir = join(configDir, 'rules');
  const auditLog = join(TMP, 'audit.log');
  mkdirSync(rulesDir, { recursive: true });

  writeFileSync(join(configDir, 'veto.config.yaml'), `
version: "1.0"
mode: "strict"
validation:
  mode: "local"
logging:
  level: "silent"
rules:
  directory: "./rules"
audit:
  enabled: true
  path: "${auditLog}"
${extraConfig}
`, 'utf-8');

  writeFileSync(join(rulesDir, 'rules.yaml'), `
version: "1.0"
name: test
rules:
  - id: block-delete
    name: Block delete
    enabled: true
    severity: high
    action: block
    tools: [delete_file]
`, 'utf-8');

  return { configDir, auditLog };
}

function verifyChain(logPath: string): { valid: boolean; records: number; brokenAt?: number } {
  const lines = readFileSync(logPath, 'utf-8').split('\n').filter(l => l.trim());
  if (lines.length === 0) return { valid: true, records: 0 };

  let prevHash = GENESIS_HASH;
  for (let i = 0; i < lines.length; i++) {
    const parsed = JSON.parse(lines[i]) as Record<string, unknown>;
    const storedHash = parsed['chain_hash'] as string;
    const { chain_hash: _, ...record } = parsed;
    const expected = computeChainHash(prevHash, record);
    if (expected !== storedHash) {
      return { valid: false, records: lines.length, brokenAt: i + 1 };
    }
    prevHash = storedHash;
  }
  return { valid: true, records: lines.length };
}

describe('audit log — end-to-end', () => {
  it('writes decisions to audit.log and chain verifies PASS', async () => {
    const { configDir, auditLog } = setupVetoDir();
    const veto = await Veto.init({ configDir });

    await veto.guard('read_file', { path: '/etc/hosts' });
    await veto.guard('delete_file', { path: '/etc/hosts' });
    await veto.guard('read_file', { path: '/tmp/safe' });
    await veto.flushAuditLog();

    expect(existsSync(auditLog)).toBe(true);
    const result = verifyChain(auditLog);
    expect(result.valid).toBe(true);
    expect(result.records).toBe(3);
  });

  it('empty audit log (0 decisions) → graceful PASS', async () => {
    const { configDir, auditLog } = setupVetoDir();
    await Veto.init({ configDir });
    // No guard calls — log file may not even exist (no decisions written)
    if (existsSync(auditLog)) {
      const result = verifyChain(auditLog);
      expect(result.valid).toBe(true);
      expect(result.records).toBe(0);
    } else {
      // File not created until first decision — that's correct behaviour
      expect(true).toBe(true);
    }
  });

  it('tampered record breaks the chain at the right entry number', async () => {
    const { configDir, auditLog } = setupVetoDir();
    const veto = await Veto.init({ configDir });

    await veto.guard('read_file', { path: '/a' });
    await veto.guard('read_file', { path: '/b' });
    await veto.guard('read_file', { path: '/c' });
    await veto.flushAuditLog();

    // Tamper: read all lines, modify the second record's decision
    const lines = readFileSync(auditLog, 'utf-8').split('\n').filter(l => l.trim());
    const record2 = JSON.parse(lines[1]) as Record<string, unknown>;
    record2['decision'] = 'allow-tampered'; // mutate
    lines[1] = JSON.stringify(record2);
    writeFileSync(auditLog, lines.join('\n') + '\n', 'utf-8');

    const result = verifyChain(auditLog);
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(2); // second record
  });

  it('audit config via VetoOptions.audit (not YAML)', async () => {
    const configDir = join(TMP, 'veto-opts');
    const rulesDir = join(configDir, 'rules');
    const auditLog = join(TMP, 'opts-audit.log');
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(join(configDir, 'veto.config.yaml'), `
version: "1.0"
mode: "strict"
validation:
  mode: "local"
logging:
  level: "silent"
rules:
  directory: "./rules"
`, 'utf-8');
    writeFileSync(join(rulesDir, 'rules.yaml'), `
version: "1.0"
name: test
rules: []
`, 'utf-8');

    const veto = await Veto.init({
      configDir,
      audit: { enabled: true, path: auditLog },
    });

    await veto.guard('my_tool', { x: 1 });
    await veto.flushAuditLog();
    expect(existsSync(auditLog)).toBe(true);
    const result = verifyChain(auditLog);
    expect(result.valid).toBe(true);
    expect(result.records).toBe(1);
  });

  it('each audit record contains tool_name, decision, timestamp, chain_hash', async () => {
    const { configDir, auditLog } = setupVetoDir();
    const veto = await Veto.init({ configDir });
    await veto.guard('delete_file', { path: '/x' });
    await veto.flushAuditLog();

    const line = readFileSync(auditLog, 'utf-8').trim();
    const record = JSON.parse(line) as Record<string, unknown>;
    expect(record['tool_name']).toBe('delete_file');
    expect(record['decision']).toBeDefined();
    expect(record['timestamp']).toBeDefined();
    expect(record['chain_hash']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('block decisions are recorded in the audit log', async () => {
    const { configDir, auditLog } = setupVetoDir();
    const veto = await Veto.init({ configDir });
    const result = await veto.guard('delete_file', { path: '/etc/hosts' });

    expect(result.decision).toBe('deny');
    await veto.flushAuditLog();
    const line = readFileSync(auditLog, 'utf-8').trim();
    const record = JSON.parse(line) as Record<string, unknown>;
    expect(record['decision']).toBe('deny');
    expect(record['rule_id']).toBe('block-delete');
  });
});
