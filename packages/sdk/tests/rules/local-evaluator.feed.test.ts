import { describe, it, expect, beforeEach } from 'vitest';
import type { FeedConditionValue, Rule } from '../../src/rules/types.js';
import { InMemoryFeedProvider } from '../../src/rules/feed-provider.js';
import {
  evaluateCondition,
  evaluateRulesLocally,
} from '../../src/rules/local-evaluator.js';

const feedRef = (overrides: Partial<FeedConditionValue> = {}): FeedConditionValue => ({
  kind: 'feed',
  feed_id: 'gambling-sites',
  version: 'latest',
  max_staleness_sec: 3600,
  fallback: 'fail_open',
  ...overrides,
});

describe('evaluateCondition with FeedRef', () => {
  let provider: InMemoryFeedProvider;
  const now_ms = 1_700_000_000_000;

  beforeEach(() => {
    provider = new InMemoryFeedProvider();
  });

  it('`in` operator resolves feed snapshot and matches when present', () => {
    provider.put('gambling-sites', {
      data: ['bet365.com', 'draftkings.com'],
      refreshed_at_ms: now_ms,
    });
    const matched = evaluateCondition(
      { field: 'url', operator: 'in', value: feedRef() },
      { url: 'bet365.com' },
      { feedProvider: provider, now_ms },
    );
    expect(matched).toBe(true);
  });

  it('`in` returns false when fieldValue missing from feed', () => {
    provider.put('gambling-sites', {
      data: ['bet365.com'],
      refreshed_at_ms: now_ms,
    });
    expect(evaluateCondition(
      { field: 'url', operator: 'in', value: feedRef() },
      { url: 'example.com' },
      { feedProvider: provider, now_ms },
    )).toBe(false);
  });

  it('applies fail_open when snapshot missing', () => {
    expect(evaluateCondition(
      { field: 'url', operator: 'in', value: feedRef({ fallback: 'fail_open' }) },
      { url: 'bet365.com' },
      { feedProvider: provider, now_ms },
    )).toBe(false);
  });

  it('applies fail_closed when snapshot missing', () => {
    expect(evaluateCondition(
      { field: 'url', operator: 'in', value: feedRef({ fallback: 'fail_closed' }) },
      { url: 'bet365.com' },
      { feedProvider: provider, now_ms },
    )).toBe(true);
  });

  it('applies fail_open when no provider injected', () => {
    expect(evaluateCondition(
      { field: 'url', operator: 'in', value: feedRef() },
      { url: 'bet365.com' },
      {},
    )).toBe(false);
  });

  it('treats stale snapshot as missing for fail_open', () => {
    provider.put('gambling-sites', {
      data: ['bet365.com'],
      refreshed_at_ms: now_ms - 7200 * 1000, // 2h old, max=1h
    });
    expect(evaluateCondition(
      { field: 'url', operator: 'in', value: feedRef() },
      { url: 'bet365.com' },
      { feedProvider: provider, now_ms },
    )).toBe(false);
  });

  it('last_known_good uses stale snapshot regardless of age', () => {
    provider.put('gambling-sites', {
      data: ['bet365.com'],
      refreshed_at_ms: now_ms - 86400 * 1000,
    });
    expect(evaluateCondition(
      {
        field: 'url',
        operator: 'in',
        value: feedRef({ fallback: 'last_known_good' }),
      },
      { url: 'bet365.com' },
      { feedProvider: provider, now_ms },
    )).toBe(true);
  });

  it('`not_in` with feed returns true when not matched', () => {
    provider.put('allowlist', {
      data: ['@theo'],
      refreshed_at_ms: now_ms,
    });
    expect(evaluateCondition(
      {
        field: 'handle',
        operator: 'not_in',
        value: feedRef({ feed_id: 'allowlist' }),
      },
      { handle: '@someone_else' },
      { feedProvider: provider, now_ms },
    )).toBe(true);
  });

  it('treats non-finite now_ms as a broken clock and applies fallback', () => {
    provider.put('gambling-sites', {
      data: ['bet365.com'],
      refreshed_at_ms: now_ms,
    });
    expect(evaluateCondition(
      { field: 'url', operator: 'in', value: feedRef({ fallback: 'fail_open' }) },
      { url: 'bet365.com' },
      { feedProvider: provider, now_ms: NaN },
    )).toBe(false);
    expect(evaluateCondition(
      { field: 'url', operator: 'in', value: feedRef({ fallback: 'fail_closed' }) },
      { url: 'bet365.com' },
      { feedProvider: provider, now_ms: NaN },
    )).toBe(true);
  });

  it('non-finite now_ms with last_known_good still returns the snapshot', () => {
    provider.put('gambling-sites', {
      data: ['bet365.com'],
      refreshed_at_ms: now_ms,
    });
    expect(evaluateCondition(
      { field: 'url', operator: 'in', value: feedRef({ fallback: 'last_known_good' }) },
      { url: 'bet365.com' },
      { feedProvider: provider, now_ms: NaN },
    )).toBe(true);
  });

  it('case-insensitive string membership preserved for feed comparands', () => {
    provider.put('gambling-sites', {
      data: ['Bet365.com'],
      refreshed_at_ms: now_ms,
    });
    expect(evaluateCondition(
      { field: 'url', operator: 'in', value: feedRef() },
      { url: 'bet365.com' },
      { feedProvider: provider, now_ms },
    )).toBe(true);
  });
});

describe('evaluateRulesLocally with FeedRef', () => {
  it('threads feedProvider into every condition', () => {
    const provider = new InMemoryFeedProvider();
    provider.put('gambling-sites', {
      data: ['bet365.com'],
      refreshed_at_ms: Date.now(),
    });

    const rule: Rule = {
      id: 'block-gambling',
      name: 'Block gambling sites',
      enabled: true,
      severity: 'high',
      action: 'block',
      tools: ['browser_goto'],
      conditions: [
        { field: 'arguments.url', operator: 'in', value: feedRef() },
      ],
    };

    const result = evaluateRulesLocally(
      [rule],
      'browser_goto',
      { arguments: { url: 'bet365.com' } },
      { feedProvider: provider },
    );

    expect(result.decision).toBe('deny');
    expect(result.ruleId).toBe('block-gambling');
  });

  it('fails open with no provider — rule does not trigger', () => {
    const rule: Rule = {
      id: 'block-gambling',
      name: 'Block gambling sites',
      enabled: true,
      severity: 'high',
      action: 'block',
      tools: ['browser_goto'],
      conditions: [
        { field: 'arguments.url', operator: 'in', value: feedRef() },
      ],
    };

    const result = evaluateRulesLocally(
      [rule],
      'browser_goto',
      { arguments: { url: 'bet365.com' } },
      {},
    );

    expect(result.decision).toBe(null);
  });
});
