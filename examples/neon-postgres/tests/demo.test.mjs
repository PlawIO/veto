import { describe, expect, it } from 'vitest';
import { createDemoReceipts, requireDatabaseUrl, runDemo, verifyReadback } from '../demo.mjs';

const TEST_URL = 'postgresql://test:secret@example.neon.tech/test?sslmode=require';

// This test double exercises the SQL boundary; it is not a live database test.
function memorySql({ corrupt = false, fail = false } = {}) {
  const rows = [];
  const statements = [];
  function sql(strings, ...values) {
    const text = strings.join('?');
    statements.push(text);
    if (fail) throw Object.assign(new Error(`Connection failed: ${TEST_URL}`), { code: '08006' });
    if (text.includes('CREATE TABLE')) return Promise.resolve([]);
    if (text.includes('INSERT INTO')) {
      const [runId, sequence, receipt_id, decision, receipt_hash, payload] = values;
      return { runId, sequence, receipt_id, decision, receipt_hash, receipt: JSON.parse(payload) };
    }
    if (text.includes('SELECT sequence')) {
      const result = structuredClone(rows.filter((row) => row.runId === values[0]));
      if (corrupt && result[0]) result[0].receipt.decision = 'deny';
      return Promise.resolve(result);
    }
    throw new Error('Unexpected SQL');
  }
  sql.transaction = async (queries) => { rows.push(...queries); };
  return { sql, rows, statements };
}

describe('Neon receipt example', () => {
  it('runs real local allow/deny policy checks and verifies persisted JSON receipts', async () => {
    const { sql, rows, statements } = memorySql();
    const result = await runDemo({ databaseUrl: TEST_URL, sqlFactory: () => sql });
    expect(result).toMatchObject({ ok: true, receiptCount: 2, decisions: ['allow', 'deny'], verified: true });
    expect(rows[0].receipt.reason_code).toBe('allow-public-export');
    expect(rows[1].receipt.reason_code).toBe('deny-confidential-export');
    expect(rows[0].receipt.result_hash).toBeNull();
    expect(statements[0]).toContain('CREATE TABLE IF NOT EXISTS');
    expect(statements.join('\n')).not.toContain(TEST_URL);
  });

  it('uses separate run IDs on repeat execution without mixing chains', async () => {
    const { sql, rows } = memorySql();
    const first = await runDemo({ databaseUrl: TEST_URL, sqlFactory: () => sql });
    const second = await runDemo({ databaseUrl: TEST_URL, sqlFactory: () => sql });
    expect(first.runId).not.toBe(second.runId);
    expect(second.receiptCount).toBe(2);
    expect(rows).toHaveLength(4);
  });

  it('rejects missing and malformed connection strings without echoing them', () => {
    expect(() => requireDatabaseUrl('')).toThrow('DATABASE_URL is required');
    expect(() => requireDatabaseUrl('secret-invalid-url')).toThrow('must be a valid');
    expect(() => requireDatabaseUrl('https://test:secret@example.com/db')).toThrow('must be a valid');
  });

  it('does not claim success or leak credentials after a database error', async () => {
    const { sql } = memorySql({ fail: true });
    await expect(runDemo({ databaseUrl: TEST_URL, sqlFactory: () => sql })).rejects.toThrow('SQLSTATE 08006');
    try {
      await runDemo({ databaseUrl: TEST_URL, sqlFactory: () => sql });
    } catch (error) {
      expect(error.message).not.toContain('secret');
      expect(error.message).not.toContain('example.neon.tech');
    }
  });

  it('rejects a changed JSONB receipt after readback', async () => {
    const { sql } = memorySql({ corrupt: true });
    await expect(runDemo({ databaseUrl: TEST_URL, sqlFactory: () => sql })).rejects.toThrow('does not match');
  });

  it('rejects incomplete readback instead of accepting an empty chain', async () => {
    const receipts = await createDemoReceipts('test-session');
    expect(() => verifyReadback([], receipts)).toThrow('expected 2');
  });
});
