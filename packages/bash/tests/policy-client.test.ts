import { describe, expect, it, vi } from 'vitest';
import { BashPolicyClient, PolicyHttpError } from '../src/policy-client.js';

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

  it('fails fast on non-retriable approval polling http errors', async () => {
    const fetch = vi.fn(async () => ({
      ok: false,
      status: 404,
      text: async () => 'not found',
    })) as unknown as typeof globalThis.fetch;

    const client = new BashPolicyClient({
      apiKey: 'test-key',
      apiUrl: 'https://api.veto.so',
      fetch,
    });

    await expect(
      client.pollApproval('appr-404', { pollIntervalMs: 1, timeoutMs: 50 })
    ).rejects.toBeInstanceOf(PolicyHttpError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('retries retriable approval polling errors before succeeding', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: async () => 'temporarily unavailable',
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'appr-123',
          status: 'approved',
          resolvedBy: 'admin@example.com',
        }),
      }) as unknown as typeof globalThis.fetch;

    const client = new BashPolicyClient({
      apiKey: 'test-key',
      apiUrl: 'https://api.veto.so',
      fetch,
    });

    const result = await client.pollApproval('appr-123', { pollIntervalMs: 1, timeoutMs: 100 });

    expect(result.status).toBe('approved');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
