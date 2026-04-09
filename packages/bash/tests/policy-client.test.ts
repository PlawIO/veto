import { describe, expect, it, vi } from 'vitest';
import { BashPolicyClient } from '../src/policy-client.js';

describe('BashPolicyClient', () => {
  it('posts camelCase payloads to /v1/validate', async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ decision: 'allow', reason: 'Allowed' }),
    })) as unknown as typeof globalThis.fetch;

    const client = new BashPolicyClient({
      apiKey: 'test-key',
      apiUrl: 'https://api.veto.so',
      fetch,
    });

    const result = await client.validate('bash', { command: 'echo hello' }, { cwd: '/tmp' });

    expect(result.decision).toBe('allow');
    expect(fetch).toHaveBeenCalledWith(
      'https://api.veto.so/v1/validate',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'X-Veto-API-Key': 'test-key',
        }),
        body: JSON.stringify({
          toolName: 'bash',
          arguments: { command: 'echo hello' },
          context: { cwd: '/tmp' },
        }),
      })
    );
  });
});
