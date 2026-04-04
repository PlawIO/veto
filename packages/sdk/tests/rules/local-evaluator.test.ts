import { describe, it, expect } from 'vitest';
import type { Rule } from '../../src/rules/types.js';
import {
  evaluateRulesLocally,
  evaluateCondition,
  resolveFieldPath,
} from '../../src/rules/local-evaluator.js';

describe('resolveFieldPath', () => {
  it('resolves top-level fields', () => {
    expect(resolveFieldPath('name', { name: 'test' })).toBe('test');
  });

  it('resolves nested fields', () => {
    expect(resolveFieldPath('a.b.c', { a: { b: { c: 42 } } })).toBe(42);
  });

  it('returns undefined for missing paths', () => {
    expect(resolveFieldPath('a.b.c', { a: {} })).toBeUndefined();
  });

  it('returns undefined for null in path', () => {
    expect(resolveFieldPath('a.b', { a: null })).toBeUndefined();
  });
});

describe('evaluateCondition', () => {
  it('equals operator', () => {
    expect(evaluateCondition(
      { field: 'x', operator: 'equals', value: 'foo' },
      { x: 'foo' },
    )).toBe(true);
    expect(evaluateCondition(
      { field: 'x', operator: 'equals', value: 'foo' },
      { x: 'bar' },
    )).toBe(false);
  });

  it('not_equals operator', () => {
    expect(evaluateCondition(
      { field: 'x', operator: 'not_equals', value: 'foo' },
      { x: 'bar' },
    )).toBe(true);
  });

  it('undefined fields never match', () => {
    expect(evaluateCondition(
      { field: 'missing', operator: 'not_equals', value: 'foo' },
      { x: 'bar' },
    )).toBe(false);
    expect(evaluateCondition(
      { field: 'missing', operator: 'not_contains', value: 'foo' },
      {},
    )).toBe(false);
    expect(evaluateCondition(
      { field: 'missing', operator: 'not_in', value: ['a'] },
      {},
    )).toBe(false);
  });

  it('contains operator (case-insensitive string)', () => {
    expect(evaluateCondition(
      { field: 'url', operator: 'contains', value: 'amazon' },
      { url: 'https://AMAZON.com/products' },
    )).toBe(true);
  });

  it('contains operator (array)', () => {
    expect(evaluateCondition(
      { field: 'tags', operator: 'contains', value: 'admin' },
      { tags: ['user', 'admin'] },
    )).toBe(true);
  });

  it('not_contains operator (case-insensitive string)', () => {
    expect(evaluateCondition(
      { field: 'url', operator: 'not_contains', value: 'evil' },
      { url: 'https://safe.com' },
    )).toBe(true);
  });

  it('starts_with operator (case-insensitive)', () => {
    expect(evaluateCondition(
      { field: 'url', operator: 'starts_with', value: 'https' },
      { url: 'HTTPS://example.com' },
    )).toBe(true);
  });

  it('ends_with operator (case-insensitive)', () => {
    expect(evaluateCondition(
      { field: 'url', operator: 'ends_with', value: '.com' },
      { url: 'https://example.COM' },
    )).toBe(true);
  });

  it('matches operator (regex)', () => {
    expect(evaluateCondition(
      { field: 'url', operator: 'matches', value: 'amazon\\.com' },
      { url: 'https://amazon.com/cart' },
    )).toBe(true);
  });

  it('matches operator returns false for invalid regex', () => {
    expect(evaluateCondition(
      { field: 'x', operator: 'matches', value: '[invalid' },
      { x: 'test' },
    )).toBe(false);
  });

  it('greater_than operator', () => {
    expect(evaluateCondition(
      { field: 'price', operator: 'greater_than', value: 100 },
      { price: 150 },
    )).toBe(true);
    expect(evaluateCondition(
      { field: 'price', operator: 'greater_than', value: 100 },
      { price: 50 },
    )).toBe(false);
  });

  it('less_than operator', () => {
    expect(evaluateCondition(
      { field: 'price', operator: 'less_than', value: 100 },
      { price: 50 },
    )).toBe(true);
  });

  it('in operator', () => {
    expect(evaluateCondition(
      { field: 'status', operator: 'in', value: ['active', 'pending'] },
      { status: 'active' },
    )).toBe(true);
    expect(evaluateCondition(
      { field: 'status', operator: 'in', value: ['active', 'pending'] },
      { status: 'deleted' },
    )).toBe(false);
  });

  it('not_in operator', () => {
    expect(evaluateCondition(
      { field: 'status', operator: 'not_in', value: ['blocked', 'banned'] },
      { status: 'active' },
    )).toBe(true);
  });

  it('length_greater_than operator (string)', () => {
    expect(evaluateCondition(
      { field: 'name', operator: 'length_greater_than', value: 3 },
      { name: 'hello' },
    )).toBe(true);
    expect(evaluateCondition(
      { field: 'name', operator: 'length_greater_than', value: 10 },
      { name: 'hi' },
    )).toBe(false);
  });

  it('length_greater_than operator (array)', () => {
    expect(evaluateCondition(
      { field: 'items', operator: 'length_greater_than', value: 2 },
      { items: [1, 2, 3] },
    )).toBe(true);
  });

  it('percent_of operator', () => {
    expect(evaluateCondition(
      { field: 'spent', operator: 'percent_of', value: 80 },
      { spent: 90 },
    )).toBe(true);
    expect(evaluateCondition(
      { field: 'spent', operator: 'percent_of', value: 80 },
      { spent: 50 },
    )).toBe(false);
  });

  it('unknown operator returns false', () => {
    expect(evaluateCondition(
      { field: 'x', operator: 'fancy_op' as any, value: 'y' },
      { x: 'y' },
    )).toBe(false);
  });

  it('condition without field/operator returns false', () => {
    expect(evaluateCondition({}, { x: 1 })).toBe(false);
  });

  it('equals is case-insensitive for strings', () => {
    expect(evaluateCondition(
      { field: 'x', operator: 'equals', value: 'Foo' },
      { x: 'foo' },
    )).toBe(true);
    expect(evaluateCondition(
      { field: 'x', operator: 'equals', value: 'FOO' },
      { x: 'foo' },
    )).toBe(true);
  });

  it('not_equals is case-insensitive for strings', () => {
    expect(evaluateCondition(
      { field: 'x', operator: 'not_equals', value: 'Foo' },
      { x: 'foo' },
    )).toBe(false);
  });

  it('equals uses strict comparison for non-strings', () => {
    expect(evaluateCondition(
      { field: 'x', operator: 'equals', value: 1 },
      { x: 1 },
    )).toBe(true);
    expect(evaluateCondition(
      { field: 'x', operator: 'equals', value: '1' },
      { x: 1 },
    )).toBe(false);
  });

  it('within_hours matches current time window', () => {
    const now = new Date();
    const h = now.getHours();
    const range = `${String(h).padStart(2, '0')}:00-${String((h + 1) % 24).padStart(2, '0')}:00`;
    expect(evaluateCondition(
      { field: 'x', operator: 'within_hours', value: range },
      { x: 'ignored' },
    )).toBe(true);
  });

  it('outside_hours is inverse of within_hours', () => {
    const now = new Date();
    const h = now.getHours();
    const range = `${String(h).padStart(2, '0')}:00-${String((h + 1) % 24).padStart(2, '0')}:00`;
    expect(evaluateCondition(
      { field: 'x', operator: 'outside_hours', value: range },
      { x: 'ignored' },
    )).toBe(false);
  });

  it('within_hours supports structured TimeWindowValue', () => {
    const now = new Date();
    const h = now.getUTCHours();
    const nextH = (h + 2) % 24;
    expect(evaluateCondition(
      {
        field: 'x',
        operator: 'within_hours',
        value: {
          start: `${String(h).padStart(2, '0')}:00`,
          end: `${String(nextH).padStart(2, '0')}:00`,
          timezone: 'UTC',
        },
      },
      { x: now.toISOString() },
    )).toBe(true);
  });

  it('outside_hours supports structured TimeWindowValue', () => {
    const now = new Date();
    const h = now.getUTCHours();
    const prevH = (h + 22) % 24;
    expect(evaluateCondition(
      {
        field: 'x',
        operator: 'outside_hours',
        value: {
          start: `${String(prevH).padStart(2, '0')}:00`,
          end: `${String(prevH).padStart(2, '0')}:30`,
          timezone: 'UTC',
        },
      },
      { x: now.toISOString() },
    )).toBe(true);
  });

  it('within_hours structured format returns false for invalid timestamp', () => {
    expect(evaluateCondition(
      {
        field: 'x',
        operator: 'within_hours',
        value: {
          start: '09:00',
          end: '17:00',
          timezone: 'UTC',
        },
      },
      { x: 'not-a-date' },
    )).toBe(false);
  });

  it('within_hours structured format supports day-of-week filtering', () => {
    const now = new Date();
    const dayNames = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    const wrongDay = dayNames[(now.getUTCDay() + 1) % 7];
    expect(evaluateCondition(
      {
        field: 'x',
        operator: 'within_hours',
        value: {
          start: '00:00',
          end: '23:59',
          timezone: 'UTC',
          days: [wrongDay],
        },
      },
      { x: now.toISOString() },
    )).toBe(false);
  });

  it('within_hours returns false for malformed input', () => {
    expect(evaluateCondition(
      { field: 'x', operator: 'within_hours', value: 'abc:def-09:00' },
      { x: 'ignored' },
    )).toBe(false);
    expect(evaluateCondition(
      { field: 'x', operator: 'within_hours', value: '25:00-09:00' },
      { x: 'ignored' },
    )).toBe(false);
    expect(evaluateCondition(
      { field: 'x', operator: 'within_hours', value: '09:00' },
      { x: 'ignored' },
    )).toBe(false);
  });

  it('percent_of with reference field computes percentage', () => {
    expect(evaluateCondition(
      { field: 'spent', operator: 'percent_of', value: 80, reference: 'budget' },
      { spent: 90, budget: 100 },
    )).toBe(true);
    expect(evaluateCondition(
      { field: 'spent', operator: 'percent_of', value: 80, reference: 'budget' },
      { spent: 50, budget: 100 },
    )).toBe(false);
  });

  it('percent_of returns false when reference is zero', () => {
    expect(evaluateCondition(
      { field: 'spent', operator: 'percent_of', value: 50, reference: 'budget' },
      { spent: 10, budget: 0 },
    )).toBe(false);
  });

  it('in returns false for non-array expected', () => {
    expect(evaluateCondition(
      { field: 'x', operator: 'in', value: 'not-an-array' },
      { x: 'test' },
    )).toBe(false);
  });

  it('not_in returns false for non-array expected', () => {
    expect(evaluateCondition(
      { field: 'x', operator: 'not_in', value: 'not-an-array' },
      { x: 'test' },
    )).toBe(false);
  });

  it('greater_than rejects string values', () => {
    expect(evaluateCondition(
      { field: 'x', operator: 'greater_than', value: 100 },
      { x: '150' },
    )).toBe(false);
  });

  it('less_than rejects string values', () => {
    expect(evaluateCondition(
      { field: 'x', operator: 'less_than', value: 100 },
      { x: '50' },
    )).toBe(false);
  });

  it('greater_than rejects Infinity', () => {
    expect(evaluateCondition(
      { field: 'x', operator: 'greater_than', value: 100 },
      { x: Infinity },
    )).toBe(false);
  });

  it('less_than rejects -Infinity', () => {
    expect(evaluateCondition(
      { field: 'x', operator: 'less_than', value: 100 },
      { x: -Infinity },
    )).toBe(false);
  });

  it('matches rejects ReDoS patterns via createSafeRegex', () => {
    expect(evaluateCondition(
      { field: 'x', operator: 'matches', value: '(a+)+$' },
      { x: 'aaaaaaaaaaaaaaaaaaaaa!' },
    )).toBe(false);
  });
});

describe('evaluateRulesLocally', () => {
  const makeRule = (overrides: Partial<Rule> & Pick<Rule, 'id' | 'name'>): Rule => ({
    enabled: true,
    severity: 'high',
    action: 'block',
    ...overrides,
  });

  it('returns deny for matching block rule', () => {
    const rules: Rule[] = [
      makeRule({
        id: 'r1',
        name: 'Block Amazon',
        action: 'block',
        tools: ['browser_click'],
        conditions: [{ field: 'arguments.current_url', operator: 'contains', value: 'amazon.com' }],
      }),
    ];

    const result = evaluateRulesLocally(rules, 'browser_click', {
      arguments: { current_url: 'https://amazon.com/cart' },
    });

    expect(result.decision).toBe('deny');
    expect(result.ruleId).toBe('r1');
  });

  it('returns allow for matching allow rule', () => {
    const rules: Rule[] = [
      makeRule({
        id: 'r1',
        name: 'Allow safe',
        action: 'allow',
        conditions: [{ field: 'arguments.current_url', operator: 'contains', value: 'safe.com' }],
      }),
    ];

    const result = evaluateRulesLocally(rules, 'any_tool', {
      arguments: { current_url: 'https://safe.com' },
    });

    expect(result.decision).toBe('allow');
  });

  it('returns require_approval for matching rule', () => {
    const rules: Rule[] = [
      makeRule({
        id: 'r1',
        name: 'Approve purchases',
        action: 'require_approval',
        conditions: [{ field: 'arguments.extracted_entities.max_price', operator: 'greater_than', value: 100 }],
      }),
    ];

    const result = evaluateRulesLocally(rules, 'browser_click', {
      arguments: { extracted_entities: { max_price: 200 } },
    });

    expect(result.decision).toBe('require_approval');
  });

  it('returns null when no rules match', () => {
    const rules: Rule[] = [
      makeRule({
        id: 'r1',
        name: 'Block evil',
        action: 'block',
        tools: ['browser_click'],
        conditions: [{ field: 'arguments.current_url', operator: 'contains', value: 'evil.com' }],
      }),
    ];

    const result = evaluateRulesLocally(rules, 'browser_click', {
      arguments: { current_url: 'https://safe.com' },
    });

    expect(result.decision).toBeNull();
  });

  it('skips disabled rules', () => {
    const rules: Rule[] = [
      makeRule({
        id: 'r1',
        name: 'Disabled',
        enabled: false,
        action: 'block',
      }),
    ];

    const result = evaluateRulesLocally(rules, 'any_tool', {});
    expect(result.decision).toBeNull();
  });

  it('filters by tool name', () => {
    const rules: Rule[] = [
      makeRule({
        id: 'r1',
        name: 'Only for navigation',
        action: 'block',
        tools: ['browser_goToUrl'],
      }),
    ];

    const result = evaluateRulesLocally(rules, 'browser_click', {});
    expect(result.decision).toBeNull();
  });

  it('rule with no tools applies to all tools', () => {
    const rules: Rule[] = [
      makeRule({
        id: 'r1',
        name: 'Global block',
        action: 'block',
      }),
    ];

    const result = evaluateRulesLocally(rules, 'any_tool', {});
    expect(result.decision).toBe('deny');
  });

  it('evaluates condition_groups with OR logic', () => {
    const rules: Rule[] = [
      makeRule({
        id: 'r1',
        name: 'Block multiple',
        action: 'block',
        condition_groups: [
          [{ field: 'arguments.current_url', operator: 'contains', value: 'evil.com' }],
          [{ field: 'arguments.current_url', operator: 'contains', value: 'bad.com' }],
        ],
      }),
    ];

    const result = evaluateRulesLocally(rules, 'browser_click', {
      arguments: { current_url: 'https://bad.com' },
    });

    expect(result.decision).toBe('deny');
  });

  it('AND logic within conditions', () => {
    const rules: Rule[] = [
      makeRule({
        id: 'r1',
        name: 'Block expensive clicks on Amazon',
        action: 'block',
        conditions: [
          { field: 'arguments.current_url', operator: 'contains', value: 'amazon.com' },
          { field: 'arguments.extracted_entities.max_price', operator: 'greater_than', value: 100 },
        ],
      }),
    ];

    // Only URL matches, not price
    const result1 = evaluateRulesLocally(rules, 'browser_click', {
      arguments: { current_url: 'https://amazon.com', extracted_entities: { max_price: 50 } },
    });
    expect(result1.decision).toBeNull();

    // Both match
    const result2 = evaluateRulesLocally(rules, 'browser_click', {
      arguments: { current_url: 'https://amazon.com', extracted_entities: { max_price: 200 } },
    });
    expect(result2.decision).toBe('deny');
  });

  it('warn/log rules do not block', () => {
    const rules: Rule[] = [
      makeRule({
        id: 'r1',
        name: 'Warn only',
        action: 'warn',
      }),
      makeRule({
        id: 'r2',
        name: 'Log only',
        action: 'log',
      }),
    ];

    const result = evaluateRulesLocally(rules, 'any_tool', {});
    expect(result.decision).toBeNull();
  });

  it('first matching rule wins', () => {
    const rules: Rule[] = [
      makeRule({
        id: 'r1',
        name: 'Allow first',
        action: 'allow',
      }),
      makeRule({
        id: 'r2',
        name: 'Block second',
        action: 'block',
      }),
    ];

    const result = evaluateRulesLocally(rules, 'any_tool', {});
    expect(result.decision).toBe('allow');
    expect(result.ruleId).toBe('r1');
  });

  it('uses description as reason when available', () => {
    const rules: Rule[] = [
      makeRule({
        id: 'r1',
        name: 'Rule Name',
        description: 'Detailed reason',
        action: 'block',
      }),
    ];

    const result = evaluateRulesLocally(rules, 'any_tool', {});
    expect(result.reason).toBe('Detailed reason');
  });

  it('falls back to name as reason', () => {
    const rules: Rule[] = [
      makeRule({
        id: 'r1',
        name: 'Rule Name',
        action: 'block',
      }),
    ];

    const result = evaluateRulesLocally(rules, 'any_tool', {});
    expect(result.reason).toBe('Rule Name');
  });

  it('conditions-first fallthrough: ignores condition_groups when conditions present', () => {
    const rules: Rule[] = [
      makeRule({
        id: 'r1',
        name: 'Both fields',
        action: 'block',
        conditions: [{ field: 'x', operator: 'equals', value: 'yes' }],
        condition_groups: [
          [{ field: 'y', operator: 'equals', value: 'impossible' }],
        ],
      }),
    ];

    // conditions pass, condition_groups would fail if evaluated
    const result = evaluateRulesLocally(rules, 'any_tool', { x: 'yes', y: 'nope' });
    expect(result.decision).toBe('deny');
  });

  it('falls through to condition_groups when no conditions', () => {
    const rules: Rule[] = [
      makeRule({
        id: 'r1',
        name: 'Groups only',
        action: 'block',
        condition_groups: [
          [{ field: 'x', operator: 'equals', value: 'match' }],
        ],
      }),
    ];

    const result = evaluateRulesLocally(rules, 'any_tool', { x: 'match' });
    expect(result.decision).toBe('deny');
  });

  it('empty tools array applies to all tools', () => {
    const rules: Rule[] = [
      makeRule({
        id: 'r1',
        name: 'Empty tools',
        action: 'block',
        tools: [],
      }),
    ];

    const result = evaluateRulesLocally(rules, 'any_tool', {});
    expect(result.decision).toBe('deny');
  });
});

describe('malformed condition handling', () => {
  it('returns false when field is missing', () => {
    expect(evaluateCondition({ field: '', operator: 'equals', value: 'x' } as any, {})).toBe(false);
  });

  it('returns false when operator is missing', () => {
    expect(evaluateCondition({ field: 'x', operator: '', value: 'y' } as any, {})).toBe(false);
  });
});

describe('in/not_in case insensitivity', () => {
  it('in operator matches case-insensitively for strings', () => {
    expect(evaluateCondition(
      { field: 'role', operator: 'in', value: ['Admin', 'User'] },
      { role: 'admin' }
    )).toBe(true);
  });

  it('not_in operator matches case-insensitively for strings', () => {
    expect(evaluateCondition(
      { field: 'role', operator: 'not_in', value: ['Admin', 'User'] },
      { role: 'admin' }
    )).toBe(false);
  });

  it('in operator still works for non-string values', () => {
    expect(evaluateCondition(
      { field: 'code', operator: 'in', value: [1, 2, 3] },
      { code: 2 }
    )).toBe(true);
  });
});

describe('contains/not_contains array case insensitivity', () => {
  it('contains matches case-insensitively in string arrays', () => {
    expect(evaluateCondition(
      { field: 'roles', operator: 'contains', value: 'admin' },
      { roles: ['Admin', 'User'] }
    )).toBe(true);
  });

  it('not_contains matches case-insensitively in string arrays', () => {
    expect(evaluateCondition(
      { field: 'roles', operator: 'not_contains', value: 'admin' },
      { roles: ['Admin', 'User'] }
    )).toBe(false);
  });
});

describe('prototype chain safety', () => {
  it('resolveFieldPath does not resolve prototype properties', () => {
    expect(resolveFieldPath('constructor', { name: 'test' })).toBeUndefined();
  });

  it('resolveFieldPath does not resolve __proto__', () => {
    expect(resolveFieldPath('__proto__', { name: 'test' })).toBeUndefined();
  });

  it('resolveFieldPath still resolves own properties', () => {
    expect(resolveFieldPath('name', { name: 'test' })).toBe('test');
  });
});
