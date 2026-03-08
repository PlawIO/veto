import { describe, expect, it } from 'vitest';
import {
  createSafeRegex,
  evaluateCondition,
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
});
