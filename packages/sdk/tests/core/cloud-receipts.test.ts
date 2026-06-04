import { describe, expect, it, vi } from 'vitest';
import { Veto } from '../../src/core/veto.js';
import type { VetoCloudClient } from '../../src/cloud/client.js';

const receiptSummary = {
  receipt_id: 'rcp_000000000000000000000001',
  receipt_hash: `sha256:${'1'.repeat(64)}`,
  previous_receipt_hash: `sha256:${'0'.repeat(64)}`,
  merkle_root: `sha256:${'2'.repeat(64)}`,
};

describe('cloud decision receipts', () => {
  it('surfaces cloud receipt summaries on guard results', async () => {
    const cloudClient = {
      validate: vi.fn().mockResolvedValue({
        decision: 'allow',
        reason: 'Allowed',
        receipt: receiptSummary,
      }),
    } as unknown as VetoCloudClient;

    const veto = await Veto.init({
      apiKey: 'veto_test',
      cloudClient,
      configDir: `/tmp/veto-cloud-receipts-test-${Date.now()}`,
      logLevel: 'silent',
    });

    const result = await veto.guard('send_email', { to: 'test@example.com' });

    expect(result.decision).toBe('allow');
    expect(result.receipt).toEqual(receiptSummary);
  });
});
