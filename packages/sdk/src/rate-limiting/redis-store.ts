/**
 * Redis/Valkey-backed sliding window rate limit store.
 *
 * Uses a sorted set per key with timestamps as scores. A Lua script
 * atomically prunes expired entries, checks the count, and records
 * the new call — no TOCTOU race across cluster nodes.
 *
 * Requires the `redis` npm package (^4.0.0) as an optional peer dependency.
 */

type RedisClient = {
  scriptLoad(script: string): Promise<string>;
  evalSha(sha: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
  scan(cursor: number, options: { MATCH: string; COUNT: number }): Promise<{ cursor: number; keys: string[] }>;
  del(keys: string | string[]): Promise<number>;
};

const SLIDING_WINDOW_SCRIPT = `
local key = KEYS[1]
local windowMs = tonumber(ARGV[1])
local maxCalls = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local cutoff = now - windowMs
redis.call('ZREMRANGEBYSCORE', key, '-inf', cutoff)
local count = redis.call('ZCARD', key)
if count >= maxCalls then
  return 0
end
redis.call('ZADD', key, now, now .. '-' .. math.random(1000000))
redis.call('PEXPIRE', key, windowMs)
return 1
`;

import type { RateLimitStore } from './evaluator.js';

export class RedisRateLimitStore implements RateLimitStore {
  private client: RedisClient;
  private scriptSha: string | null = null;
  private keyPrefix: string;

  constructor(client: RedisClient, keyPrefix = 'veto:rl:') {
    this.client = client;
    this.keyPrefix = keyPrefix;
  }

  async checkAndRecord(key: string, maxCalls: number, windowMs: number): Promise<boolean> {
    return this._checkAndRecord(key, maxCalls, windowMs, false);
  }

  private async _checkAndRecord(
    key: string, maxCalls: number, windowMs: number, retried: boolean,
  ): Promise<boolean> {
    const fullKey = this.keyPrefix + key;
    const now = Date.now();

    try {
      if (!this.scriptSha) {
        this.scriptSha = await this.client.scriptLoad(SLIDING_WINDOW_SCRIPT);
      }

      const result = await this.client.evalSha(this.scriptSha, {
        keys: [fullKey],
        arguments: [windowMs.toString(), maxCalls.toString(), now.toString()],
      });

      return result === 1;
    } catch (err: unknown) {
      if (!retried && err instanceof Error && err.message.includes('NOSCRIPT')) {
        this.scriptSha = null;
        return this._checkAndRecord(key, maxCalls, windowMs, true);
      }
      throw err;
    }
  }

  async clear(): Promise<void> {
    let cursor = 0;
    do {
      const result = await this.client.scan(cursor, { MATCH: this.keyPrefix + '*', COUNT: 100 });
      cursor = result.cursor;
      if (result.keys.length > 0) {
        await this.client.del(result.keys);
      }
    } while (cursor !== 0);
  }
}
