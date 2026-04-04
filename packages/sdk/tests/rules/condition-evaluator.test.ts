import { describe, expect, it } from 'vitest';
import {
  createSafeRegex,
  evaluateCondition,
  evaluateConditionCollections,
  evaluateLegacyCondition,
} from '../../src/rules/condition-evaluator.js';
import type { RuleCondition } from '../../src/rules/types.js';

describe('condition evaluator', () => {
  it('does not scan nested object strings for contains on input conditions by default', () => {
    const condition: RuleCondition = {
      field: 'arguments.payload',
      operator: 'contains',
      value: 'Acme',
    };

    const matched = evaluateCondition(condition, {
      arguments: {
        payload: {
          nested: 'Acme Inc.',
        },
      },
    });

    expect(matched).toBe(false);
  });

  it('does not scan nested object strings for matches on input conditions by default', () => {
    const condition: RuleCondition = {
      field: 'arguments.payload',
      operator: 'matches',
      value: '(?i)\\bacme\\b',
    };

    const matched = evaluateCondition(condition, {
      arguments: {
        payload: {
          nested: 'Acme Inc.',
        },
      },
    });

    expect(matched).toBe(false);
  });

  it('rejects incompatible unicode regex flags explicitly', () => {
    expect(createSafeRegex('(?uv)acme')).toBeNull();
    expect(createSafeRegex('(?vu)acme')).toBeNull();
  });

  it('rejects sticky regex flags explicitly', () => {
    expect(createSafeRegex('(?y)acme')).toBeNull();
  });

  it('supports percent_of conditions against a reference field', () => {
    const condition: RuleCondition = {
      field: 'arguments.amount_usd',
      operator: 'percent_of',
      value: 15,
      reference: 'budget.remaining',
    };

    expect(evaluateCondition(condition, {
      arguments: { amount_usd: 80 },
      budget: { remaining: 500 },
    })).toBe(true);

    expect(evaluateCondition(condition, {
      arguments: { amount_usd: 70 },
      budget: { remaining: 500 },
    })).toBe(false);
  });

  it('does not match percent_of conditions when the reference is missing', () => {
    const condition: RuleCondition = {
      field: 'arguments.amount_usd',
      operator: 'percent_of',
      value: 15,
      reference: 'budget.remaining',
    };

    expect(evaluateCondition(condition, {
      arguments: { amount_usd: 80 },
    })).toBe(false);
  });

  it('percent_of returns false when reference is zero', () => {
    const condition: RuleCondition = {
      field: 'arguments.spent',
      operator: 'percent_of',
      value: 50,
      reference: 'budget.remaining',
    };

    expect(evaluateCondition(condition, {
      arguments: { spent: 10 },
      budget: { remaining: 0 },
    })).toBe(false);
  });

  it('not_contains returns false for non-string non-array field values', () => {
    expect(evaluateLegacyCondition(42, 'not_contains', 'foo')).toBe(false);
    expect(evaluateLegacyCondition(true, 'not_contains', 'bar')).toBe(false);
  });

  it('malformed condition without field/operator/expression returns false', () => {
    expect(evaluateCondition({} as RuleCondition, {})).toBe(false);
  });
});

describe('evaluateConditionCollections', () => {
  it('returns true with empty conditions array', () => {
    expect(evaluateConditionCollections([], undefined, {})).toBe(true);
  });

  it('returns true with undefined conditions and undefined condition_groups', () => {
    expect(evaluateConditionCollections(undefined, undefined, {})).toBe(true);
  });
});

describe('evaluateLegacyCondition case-insensitive string operations', () => {
  it('equals is case-insensitive for strings', () => {
    expect(evaluateLegacyCondition('Hello', 'equals', 'hello')).toBe(true);
    expect(evaluateLegacyCondition('HELLO', 'equals', 'hello')).toBe(true);
  });

  it('not_equals is case-insensitive for strings', () => {
    expect(evaluateLegacyCondition('Hello', 'not_equals', 'hello')).toBe(false);
    expect(evaluateLegacyCondition('Hello', 'not_equals', 'world')).toBe(true);
  });

  it('contains is case-insensitive for strings', () => {
    expect(evaluateLegacyCondition('Hello World', 'contains', 'hello')).toBe(true);
    expect(evaluateLegacyCondition('hello world', 'contains', 'WORLD')).toBe(true);
  });

  it('not_contains is case-insensitive for strings', () => {
    expect(evaluateLegacyCondition('Hello World', 'not_contains', 'hello')).toBe(false);
    expect(evaluateLegacyCondition('hello world', 'not_contains', 'missing')).toBe(true);
  });

  it('starts_with is case-insensitive for strings', () => {
    expect(evaluateLegacyCondition('HTTPS://example.com', 'starts_with', 'https')).toBe(true);
  });

  it('ends_with is case-insensitive for strings', () => {
    expect(evaluateLegacyCondition('example.COM', 'ends_with', '.com')).toBe(true);
  });

  it('matches is case-insensitive', () => {
    expect(evaluateLegacyCondition('Hello World', 'matches', 'hello')).toBe(true);
  });

  it('in is case-insensitive for strings', () => {
    expect(evaluateLegacyCondition('admin', 'in', ['Admin', 'User'])).toBe(true);
    expect(evaluateLegacyCondition('ADMIN', 'in', ['admin', 'user'])).toBe(true);
  });

  it('not_in is case-insensitive for strings', () => {
    expect(evaluateLegacyCondition('admin', 'not_in', ['Admin', 'User'])).toBe(false);
    expect(evaluateLegacyCondition('guest', 'not_in', ['Admin', 'User'])).toBe(true);
  });

  it('contains is case-insensitive for arrays with string elements', () => {
    expect(evaluateLegacyCondition(['Admin', 'User'], 'contains', 'admin')).toBe(true);
    expect(evaluateLegacyCondition(['admin', 'user'], 'contains', 'ADMIN')).toBe(true);
  });

  it('not_contains is case-insensitive for arrays with string elements', () => {
    expect(evaluateLegacyCondition(['Admin', 'User'], 'not_contains', 'admin')).toBe(false);
    expect(evaluateLegacyCondition(['admin', 'user'], 'not_contains', 'guest')).toBe(true);
  });

  it('equals uses strict comparison for non-strings', () => {
    expect(evaluateLegacyCondition(1, 'equals', 1)).toBe(true);
    expect(evaluateLegacyCondition(1, 'equals', '1')).toBe(false);
  });
});

describe('evaluateLegacyCondition type guards', () => {
  it('greater_than returns false for string "Infinity"', () => {
    expect(evaluateLegacyCondition('Infinity', 'greater_than', 100)).toBe(false);
  });

  it('greater_than returns false for non-numeric string "abc"', () => {
    expect(evaluateLegacyCondition('abc', 'greater_than', 100)).toBe(false);
  });

  it('less_than returns false for non-numeric string "abc"', () => {
    expect(evaluateLegacyCondition('abc', 'less_than', 100)).toBe(false);
  });

  it('greater_than works for valid numeric inputs', () => {
    expect(evaluateLegacyCondition(200, 'greater_than', 100)).toBe(true);
    expect(evaluateLegacyCondition(50, 'greater_than', 100)).toBe(false);
  });

  it('less_than works for valid numeric inputs', () => {
    expect(evaluateLegacyCondition(50, 'less_than', 100)).toBe(true);
    expect(evaluateLegacyCondition(200, 'less_than', 100)).toBe(false);
  });

  it('greater_than rejects null (no coercion to 0)', () => {
    expect(evaluateLegacyCondition(null, 'greater_than', -1)).toBe(false);
  });

  it('greater_than rejects booleans (no coercion to 0/1)', () => {
    expect(evaluateLegacyCondition(true, 'greater_than', 0.5)).toBe(false);
    expect(evaluateLegacyCondition(false, 'greater_than', -1)).toBe(false);
  });

  it('greater_than rejects numeric strings (strict typeof number)', () => {
    expect(evaluateLegacyCondition('42', 'greater_than', 10)).toBe(false);
  });

  it('less_than rejects null and booleans', () => {
    expect(evaluateLegacyCondition(null, 'less_than', 1)).toBe(false);
    expect(evaluateLegacyCondition(true, 'less_than', 2)).toBe(false);
  });

  it('greater_than rejects Infinity', () => {
    expect(evaluateLegacyCondition(Infinity, 'greater_than', 100)).toBe(false);
  });

  it('less_than rejects -Infinity', () => {
    expect(evaluateLegacyCondition(-Infinity, 'less_than', 100)).toBe(false);
  });

  it('contains returns false for non-string non-array field', () => {
    expect(evaluateLegacyCondition(42, 'contains', '4')).toBe(false);
  });

  it('not_contains returns false for non-string non-array field', () => {
    expect(evaluateLegacyCondition(42, 'not_contains', 'foo')).toBe(false);
  });

  it('starts_with returns false for non-string inputs', () => {
    expect(evaluateLegacyCondition(123, 'starts_with', '1')).toBe(false);
  });

  it('ends_with returns false for non-string inputs', () => {
    expect(evaluateLegacyCondition(123, 'ends_with', '3')).toBe(false);
  });

  it('matches returns false when expected is not a string', () => {
    expect(evaluateLegacyCondition('hello', 'matches', 42)).toBe(false);
  });

  it('in returns false for non-array expected', () => {
    expect(evaluateLegacyCondition('admin', 'in', 'admin')).toBe(false);
  });

  it('not_in returns false for non-array expected', () => {
    expect(evaluateLegacyCondition('admin', 'not_in', 'admin')).toBe(false);
  });

  it('in works with non-string field values', () => {
    expect(evaluateLegacyCondition(2, 'in', [1, 2, 3])).toBe(true);
    expect(evaluateLegacyCondition(4, 'in', [1, 2, 3])).toBe(false);
  });

  it('not_in works with non-string field values', () => {
    expect(evaluateLegacyCondition(4, 'not_in', [1, 2, 3])).toBe(true);
    expect(evaluateLegacyCondition(2, 'not_in', [1, 2, 3])).toBe(false);
  });

  it('unknown operator returns false', () => {
    expect(evaluateLegacyCondition('x', 'unknown_op' as 'equals', 'y')).toBe(false);
  });
});
