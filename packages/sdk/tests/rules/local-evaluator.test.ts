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

  it('condition without field/operator returns true', () => {
    expect(evaluateCondition({}, { x: 1 })).toBe(true);
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
});
