import type { RateLimitEntry } from './types.js';
import type { ValidationContext } from '../types/config.js';
import { checkAndRecord as memoryCheckAndRecord } from './store.js';
import type { Logger } from '../utils/logger.js';

export interface RateLimitStore {
  checkAndRecord(key: string, maxCalls: number, windowMs: number): boolean | Promise<boolean>;
  clear(): void | Promise<void>;
}

export function buildScopeKey(
  entry: RateLimitEntry,
  ctx: Pick<ValidationContext, 'agentId' | 'userId' | 'sessionId'>,
  toolName: string,
  logger: Logger,
  ruleId?: string,
): string {
  let scopeId: string | null;
  switch (entry.scope) {
    case 'agent': scopeId = ctx.agentId ?? null; break;
    case 'user': scopeId = ctx.userId ?? null; break;
    case 'session': scopeId = ctx.sessionId ?? null; break;
    default: scopeId = 'global';
  }
  if (scopeId === null) {
    logger.warn(
      `[veto] rate_limit scope '${entry.scope}' requires ${entry.scope}Id in context. Falling back to global.`
    );
    scopeId = 'global';
  }
  const prefix = ruleId ? `${ruleId}:` : '';
  return `${prefix}${entry.scope}:${scopeId}:${toolName}`;
}

/**
 * Evaluate rate limits for a tool call.
 * Returns null if all limits pass, or a denial reason string if any limit is exceeded.
 *
 * When no store is provided, falls back to the built-in in-memory sliding window store.
 * Accepts async stores (e.g. Redis) — callers must await the result.
 */
export async function evaluateRateLimits(
  rateLimits: RateLimitEntry[],
  ctx: Pick<ValidationContext, 'agentId' | 'userId' | 'sessionId'>,
  toolName: string,
  logger: Logger,
  ruleId?: string,
  store?: RateLimitStore,
): Promise<string | null> {
  const check = store ? store.checkAndRecord.bind(store) : memoryCheckAndRecord;
  for (const entry of rateLimits) {
    const key = buildScopeKey(entry, ctx, toolName, logger, ruleId);
    const windowMs = entry.window_seconds * 1000;
    try {
      const allowed = await check(key, entry.max_calls, windowMs);
      if (!allowed) {
        return `Rate limit exceeded: max ${entry.max_calls} calls per ${entry.window_seconds}s (scope: ${entry.scope})`;
      }
    } catch (err) {
      logger.error('[veto] rate limit store error, failing closed', { err: String(err) });
      return 'Rate limit check failed (fail-closed)';
    }
  }
  return null;
}
