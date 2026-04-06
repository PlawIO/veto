import { describe, expect, it, vi, beforeEach } from 'vitest';
import { RedisRateLimitStore } from '../../src/rate-limiting/redis-store.js';

function createMockClient() {
  let scriptSha = 'abc123';
  const stored = new Map<string, { score: number; member: string }[]>();

  const client = {
    scriptLoad: vi.fn(async () => scriptSha),
    evalSha: vi.fn(async (sha: string, opts: { keys: string[]; arguments: string[] }) => {
      if (sha !== scriptSha) {
        throw new Error('NOSCRIPT No matching script');
      }
      const key = opts.keys[0]!;
      const windowMs = Number(opts.arguments[0]);
      const maxCalls = Number(opts.arguments[1]);
      const now = Number(opts.arguments[2]);
      const cutoff = now - windowMs;

      let entries = stored.get(key) ?? [];
      entries = entries.filter(e => e.score > cutoff);

      if (entries.length >= maxCalls) {
        stored.set(key, entries);
        return 0;
      }

      entries.push({ score: now, member: `${now}-${Math.random()}` });
      stored.set(key, entries);
      return 1;
    }),
    scan: vi.fn(async (_cursor: number, _opts: { MATCH: string; COUNT: number }) => ({
      cursor: 0,
      keys: [...stored.keys()],
    })),
    del: vi.fn(async (keys: string[]) => {
      for (const k of keys) stored.delete(k);
      return keys.length;
    }),
    _forceScriptFlush: () => { scriptSha = 'def456'; },
    _stored: stored,
  };
  return client;
}

describe('RedisRateLimitStore', () => {
  let client: ReturnType<typeof createMockClient>;
  let store: RedisRateLimitStore;

  beforeEach(() => {
    client = createMockClient();
    store = new RedisRateLimitStore(client as any);
  });

  it('allows calls under the limit', async () => {
    expect(await store.checkAndRecord('k', 3, 60_000)).toBe(true);
    expect(await store.checkAndRecord('k', 3, 60_000)).toBe(true);
    expect(await store.checkAndRecord('k', 3, 60_000)).toBe(true);
  });

  it('blocks at the limit', async () => {
    await store.checkAndRecord('k', 2, 60_000);
    await store.checkAndRecord('k', 2, 60_000);
    expect(await store.checkAndRecord('k', 2, 60_000)).toBe(false);
  });

  it('loads script on first call via scriptLoad', async () => {
    await store.checkAndRecord('k', 5, 60_000);
    expect(client.scriptLoad).toHaveBeenCalledOnce();
    await store.checkAndRecord('k', 5, 60_000);
    expect(client.scriptLoad).toHaveBeenCalledOnce();
  });

  it('reloads script on NOSCRIPT error', async () => {
    await store.checkAndRecord('k', 5, 60_000);
    expect(client.scriptLoad).toHaveBeenCalledTimes(1);

    client._forceScriptFlush();
    await store.checkAndRecord('k', 5, 60_000);
    expect(client.scriptLoad).toHaveBeenCalledTimes(2);
  });

  it('propagates non-NOSCRIPT errors', async () => {
    // Prime the scriptSha with a successful call
    await store.checkAndRecord('k', 5, 60_000);
    // Now inject a non-NOSCRIPT failure
    client.evalSha.mockRejectedValueOnce(new Error('Connection refused'));
    await expect(store.checkAndRecord('k', 5, 60_000)).rejects.toThrow('Connection refused');
  });

  it('uses custom key prefix', async () => {
    const prefixed = new RedisRateLimitStore(client as any, 'custom:');
    await prefixed.checkAndRecord('mykey', 5, 60_000);
    const evalCall = client.evalSha.mock.calls[0]!;
    expect(evalCall[1].keys[0]).toBe('custom:mykey');
  });

  it('uses default veto:rl: prefix', async () => {
    await store.checkAndRecord('mykey', 5, 60_000);
    const evalCall = client.evalSha.mock.calls[0]!;
    expect(evalCall[1].keys[0]).toBe('veto:rl:mykey');
  });

  it('clear() scans and deletes all prefixed keys', async () => {
    await store.checkAndRecord('a', 5, 60_000);
    await store.checkAndRecord('b', 5, 60_000);
    expect(client._stored.size).toBe(2);

    await store.clear();
    expect(client.del).toHaveBeenCalled();
    expect(client._stored.size).toBe(0);
  });

  it('clear() is a no-op when no keys exist', async () => {
    await store.clear();
    expect(client.del).not.toHaveBeenCalled();
  });
});
