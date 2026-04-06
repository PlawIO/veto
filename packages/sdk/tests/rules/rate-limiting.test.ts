import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { checkAndRecord, clearStore } from '../../src/rate-limiting/store.js';
import { buildScopeKey, evaluateRateLimits, type RateLimitStore } from '../../src/rate-limiting/evaluator.js';
import type { RateLimitEntry } from '../../src/rate-limiting/types.js';
import type { ValidationContext } from '../../src/types/config.js';
import { silentLogger, createMemoryLogger } from '../../src/utils/logger.js';
import type { Rule } from '../../src/rules/types.js';
import { Veto } from '../../src/core/veto.js';

// Minimal context factory
function makeCtx(overrides: Partial<ValidationContext> = {}): ValidationContext {
  return {
    toolName: 'search_web',
    arguments: {},
    callId: 'c1',
    timestamp: new Date(),
    callHistory: [],
    agentId: 'agent-1',
    userId: 'user-1',
    sessionId: 'session-1',
    ...overrides,
  };
}

describe('rate limiting store', () => {
  beforeEach(() => clearStore());
  afterEach(() => clearStore());

  it('concurrent synchronous calls on the same key — no double-decrement', () => {
    const key = 'concurrent-key';
    const maxCalls = 1;
    const windowMs = 60_000;

    const r1 = checkAndRecord(key, maxCalls, windowMs);
    const r2 = checkAndRecord(key, maxCalls, windowMs);

    expect(r1).toBe(true);
    expect(r2).toBe(false);
    const r3 = checkAndRecord(key, 2, windowMs);
    expect(r3).toBe(true);
  });

  it('allows N-1 calls under limit', () => {
    for (let i = 0; i < 4; i++) {
      expect(checkAndRecord('key', 5, 60_000)).toBe(true);
    }
  });

  it('blocks at the Nth call', () => {
    for (let i = 0; i < 5; i++) {
      checkAndRecord('key', 5, 60_000);
    }
    expect(checkAndRecord('key', 5, 60_000)).toBe(false);
  });

  it('excludes calls outside the window from the count', () => {
    vi.useFakeTimers();
    const now = Date.now();

    for (let i = 0; i < 5; i++) {
      checkAndRecord('key2', 5, 1_000);
    }
    expect(checkAndRecord('key2', 5, 1_000)).toBe(false);

    vi.setSystemTime(now + 2_000);
    expect(checkAndRecord('key2', 5, 1_000)).toBe(true);

    vi.useRealTimers();
  });

  it('sweep clears stale keys after window expires', () => {
    vi.useFakeTimers();
    const now = Date.now();

    checkAndRecord('stale-key', 10, 1_000);
    vi.setSystemTime(now + 2_000);
    clearStore();
    expect(checkAndRecord('stale-key', 1, 1_000)).toBe(true);

    vi.useRealTimers();
  });
});

describe('buildScopeKey', () => {
  beforeEach(() => clearStore());
  afterEach(() => clearStore());

  it('builds agent-scoped key with agentId present', () => {
    const entry: RateLimitEntry = { scope: 'agent', max_calls: 10, window_seconds: 60 };
    const key = buildScopeKey(entry, { agentId: 'a1', userId: undefined, sessionId: undefined }, 'search', silentLogger);
    expect(key).toBe('agent:a1:search');
  });

  it('falls back to global when agentId missing and logs warn', () => {
    const { logger, entries } = createMemoryLogger('warn');
    const entry: RateLimitEntry = { scope: 'agent', max_calls: 10, window_seconds: 60 };
    const key = buildScopeKey(entry, { agentId: undefined, userId: undefined, sessionId: undefined }, 'search', logger);
    expect(key).toBe('agent:global:search');
    expect(entries.some(e => e.level === 'warn')).toBe(true);
  });

  it('builds user-scoped key', () => {
    const entry: RateLimitEntry = { scope: 'user', max_calls: 5, window_seconds: 30 };
    const key = buildScopeKey(entry, { agentId: undefined, userId: 'u1', sessionId: undefined }, 'tool', silentLogger);
    expect(key).toBe('user:u1:tool');
  });

  it('builds session-scoped key', () => {
    const entry: RateLimitEntry = { scope: 'session', max_calls: 5, window_seconds: 30 };
    const key = buildScopeKey(entry, { agentId: undefined, userId: undefined, sessionId: 'sess1' }, 'tool', silentLogger);
    expect(key).toBe('session:sess1:tool');
  });

  it('builds global-scoped key', () => {
    const entry: RateLimitEntry = { scope: 'global', max_calls: 100, window_seconds: 60 };
    const key = buildScopeKey(entry, { agentId: 'a1', userId: 'u1', sessionId: 's1' }, 'tool', silentLogger);
    expect(key).toBe('global:global:tool');
  });

  it('includes ruleId in key when provided to prevent cross-rule collision', () => {
    const entry: RateLimitEntry = { scope: 'user', max_calls: 5, window_seconds: 30 };
    const keyA = buildScopeKey(entry, { agentId: undefined, userId: 'u1', sessionId: undefined }, 'tool', silentLogger, 'rule-a');
    const keyB = buildScopeKey(entry, { agentId: undefined, userId: 'u1', sessionId: undefined }, 'tool', silentLogger, 'rule-b');
    expect(keyA).toBe('rule-a:user:u1:tool');
    expect(keyB).toBe('rule-b:user:u1:tool');
    expect(keyA).not.toBe(keyB);
  });
});

describe('evaluateRateLimits', () => {
  beforeEach(() => clearStore());
  afterEach(() => clearStore());

  it('returns null when all limits pass', async () => {
    const ctx = makeCtx();
    const limits: RateLimitEntry[] = [{ scope: 'global', max_calls: 5, window_seconds: 60 }];
    expect(await evaluateRateLimits(limits, ctx, 'search_web', silentLogger)).toBeNull();
  });

  it('returns denial message when limit exceeded', async () => {
    const ctx = makeCtx();
    const limits: RateLimitEntry[] = [{ scope: 'user', max_calls: 2, window_seconds: 60 }];
    await evaluateRateLimits(limits, ctx, 'search_web', silentLogger);
    await evaluateRateLimits(limits, ctx, 'search_web', silentLogger);
    const result = await evaluateRateLimits(limits, ctx, 'search_web', silentLogger);
    expect(result).toMatch(/Rate limit exceeded/);
    expect(result).toMatch(/max 2 calls per 60s/);
    expect(result).toMatch(/scope: user/);
  });

  it('global scope shares counter across all agents', async () => {
    const limits: RateLimitEntry[] = [{ scope: 'global', max_calls: 1, window_seconds: 60 }];
    const ctx1 = makeCtx({ agentId: 'agent-a' });
    const ctx2 = makeCtx({ agentId: 'agent-b' });
    expect(await evaluateRateLimits(limits, ctx1, 'search_web', silentLogger)).toBeNull();
    expect(await evaluateRateLimits(limits, ctx2, 'search_web', silentLogger)).not.toBeNull();
  });

  it('returns fail-closed denial when store throws', async () => {
    const ctx = makeCtx();
    const limits: RateLimitEntry[] = [{ scope: 'global', max_calls: 5, window_seconds: 60 }];
    const throwingStore: RateLimitStore = {
      checkAndRecord: () => { throw new Error('store unavailable'); },
      clear: () => {},
    };
    const { logger, entries } = createMemoryLogger('error');
    const result = await evaluateRateLimits(limits, ctx, 'search_web', logger, undefined, throwingStore);
    expect(result).toBe('Rate limit check failed (fail-closed)');
    expect(entries.some(e => e.level === 'error')).toBe(true);
  });

  it('returns fail-closed denial when async store rejects', async () => {
    const ctx = makeCtx();
    const limits: RateLimitEntry[] = [{ scope: 'global', max_calls: 5, window_seconds: 60 }];
    const rejectingStore: RateLimitStore = {
      checkAndRecord: () => Promise.reject(new Error('connection lost')),
      clear: () => {},
    };
    const { logger, entries } = createMemoryLogger('error');
    const result = await evaluateRateLimits(limits, ctx, 'search_web', logger, undefined, rejectingStore);
    expect(result).toBe('Rate limit check failed (fail-closed)');
    expect(entries.some(e => e.level === 'error')).toBe(true);
  });

  it('uses custom store when provided', async () => {
    const ctx = makeCtx();
    const limits: RateLimitEntry[] = [{ scope: 'global', max_calls: 5, window_seconds: 60 }];
    let recorded = 0;
    const customStore: RateLimitStore = {
      checkAndRecord: () => { recorded++; return true; },
      clear: () => {},
    };
    await evaluateRateLimits(limits, ctx, 'search_web', silentLogger, undefined, customStore);
    expect(recorded).toBe(1);
  });

  it('empty rate_limits array allows through', async () => {
    const ctx = makeCtx();
    expect(await evaluateRateLimits([], ctx, 'search_web', silentLogger)).toBeNull();
  });
});

describe('Rule TypeScript schema', () => {
  it('Rule interface accepts rate_limits field', () => {
    const rule: Rule = {
      id: 'limit-searches',
      name: 'Limit Searches',
      enabled: true,
      severity: 'medium',
      action: 'block',
      tools: ['search_web'],
      rate_limits: [
        { scope: 'user', max_calls: 10, window_seconds: 60 },
      ],
    };
    expect(rule.rate_limits).toHaveLength(1);
    expect(rule.rate_limits![0]!.scope).toBe('user');
  });

  it('Rule interface works without rate_limits (optional field)', () => {
    const rule: Rule = {
      id: 'simple-rule',
      name: 'Simple Rule',
      enabled: true,
      severity: 'low',
      action: 'allow',
    };
    expect(rule.rate_limits).toBeUndefined();
  });
});

describe('rate limit window boundary', () => {
  beforeEach(() => clearStore());
  afterEach(() => clearStore());

  it('call at exactly window_seconds old is expired (excluded from count)', () => {
    vi.useFakeTimers();
    const windowMs = 1_000;
    const t0 = Date.now();

    checkAndRecord('boundary', 1, windowMs);
    expect(checkAndRecord('boundary', 1, windowMs)).toBe(false);

    vi.setSystemTime(t0 + windowMs);
    expect(checkAndRecord('boundary', 1, windowMs)).toBe(true);

    vi.useRealTimers();
  });

  it('call just inside window (999ms) is still counted', () => {
    vi.useFakeTimers();
    const windowMs = 1_000;
    const t0 = Date.now();

    checkAndRecord('inside', 1, windowMs);

    vi.setSystemTime(t0 + 999);
    expect(checkAndRecord('inside', 1, windowMs)).toBe(false);

    vi.useRealTimers();
  });
});

describe('rate_limits + conditions integration via veto.guard()', () => {
  const TMP = '/tmp/veto-ratelimit-integration-' + Date.now();

  function setupDir(ruleYaml: string): string {
    const configDir = join(TMP, Math.random().toString(36).slice(2));
    const rulesDir = join(configDir, 'rules');
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(
      join(configDir, 'veto.config.yaml'),
      [
        'version: "1.0"',
        'mode: "strict"',
        'validation:',
        '  mode: "local"',
        'logging:',
        '  level: "silent"',
        'rules:',
        '  directory: "./rules"',
      ].join('\n'),
      'utf-8',
    );
    writeFileSync(join(rulesDir, 'rules.yaml'), ruleYaml, 'utf-8');
    return configDir;
  }

  beforeEach(() => clearStore());
  afterEach(() => {
    clearStore();
    rmSync(TMP, { recursive: true, force: true });
  });

  it('rate limit applies after condition passes', async () => {
    const configDir = setupDir(`
version: "1.0"
name: test
rules:
  - id: limit-search
    name: Limit search
    enabled: true
    severity: medium
    action: block
    tools: [search_web]
    rate_limits:
      - scope: global
        max_calls: 2
        window_seconds: 60
`);
    const veto = await Veto.init({ configDir });

    const r1 = await veto.guard('search_web', {});
    const r2 = await veto.guard('search_web', {});
    const r3 = await veto.guard('search_web', {});

    expect(r1.decision).toBe('allow');
    expect(r2.decision).toBe('allow');
    expect(r3.decision).toBe('deny');
    expect(r3.reason).toMatch(/Rate limit exceeded/);
  });

  it('condition failure skips rate limit check (counter not incremented)', async () => {
    const configDir = setupDir(`
version: "1.0"
name: test
rules:
  - id: limit-admin-delete
    name: Limit admin deletes
    enabled: true
    severity: high
    action: block
    tools: [delete_file]
    conditions:
      - field: role
        operator: equals
        value: admin
    rate_limits:
      - scope: global
        max_calls: 1
        window_seconds: 60
`);
    const veto = await Veto.init({ configDir });

    const r1 = await veto.guard('delete_file', {}, { role: 'user' });
    const r2 = await veto.guard('delete_file', {}, { role: 'user' });
    const r3 = await veto.guard('delete_file', {}, { role: 'user' });

    expect(r1.decision).toBe('allow');
    expect(r2.decision).toBe('allow');
    expect(r3.decision).toBe('allow');

    const r4 = await veto.guard('delete_file', {}, { role: 'admin' });
    const r5 = await veto.guard('delete_file', {}, { role: 'admin' });

    expect(r4.decision).toBe('allow');
    expect(r5.decision).toBe('deny');
    expect(r5.reason).toMatch(/Rate limit exceeded/);
  });

  it('tool not in rule tools list skips rate limit entirely', async () => {
    const configDir = setupDir(`
version: "1.0"
name: test
rules:
  - id: limit-search
    name: Limit search only
    enabled: true
    severity: low
    action: block
    tools: [search_web]
    rate_limits:
      - scope: global
        max_calls: 1
        window_seconds: 60
`);
    const veto = await Veto.init({ configDir });

    for (let i = 0; i < 5; i++) {
      const r = await veto.guard('read_file', {});
      expect(r.decision).toBe('allow');
    }
  });
});
