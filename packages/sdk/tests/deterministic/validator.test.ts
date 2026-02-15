import { describe, it, expect } from 'vitest';
import { validateDeterministic } from '../../src/deterministic/validator.js';
import type { ArgumentConstraint } from '../../src/deterministic/types.js';

function makeConstraint(overrides: Partial<ArgumentConstraint> & { argumentName: string }): ArgumentConstraint {
  return { enabled: true, ...overrides };
}

describe('validateDeterministic', () => {
  describe('number constraints', () => {
    it('should allow values within range', () => {
      const constraints = [makeConstraint({ argumentName: 'amount', minimum: 0, maximum: 1000 })];
      const result = validateDeterministic('tool', { amount: 500 }, constraints);
      expect(result.decision).toBe('allow');
    });

    it('should deny values below minimum', () => {
      const constraints = [makeConstraint({ argumentName: 'amount', minimum: 10 })];
      const result = validateDeterministic('tool', { amount: 5 }, constraints);
      expect(result.decision).toBe('deny');
      expect(result.failedArgument).toBe('amount');
    });

    it('should deny values above maximum', () => {
      const constraints = [makeConstraint({ argumentName: 'amount', maximum: 100 })];
      const result = validateDeterministic('tool', { amount: 150 }, constraints);
      expect(result.decision).toBe('deny');
    });

    it('should enforce greaterThan (exclusive)', () => {
      const constraints = [makeConstraint({ argumentName: 'val', greaterThan: 10 })];
      expect(validateDeterministic('tool', { val: 10 }, constraints).decision).toBe('deny');
      expect(validateDeterministic('tool', { val: 11 }, constraints).decision).toBe('allow');
    });

    it('should enforce lessThan (exclusive)', () => {
      const constraints = [makeConstraint({ argumentName: 'val', lessThan: 10 })];
      expect(validateDeterministic('tool', { val: 10 }, constraints).decision).toBe('deny');
      expect(validateDeterministic('tool', { val: 9 }, constraints).decision).toBe('allow');
    });

    it('should enforce greaterThanOrEqual', () => {
      const constraints = [makeConstraint({ argumentName: 'val', greaterThanOrEqual: 10 })];
      expect(validateDeterministic('tool', { val: 9 }, constraints).decision).toBe('deny');
      expect(validateDeterministic('tool', { val: 10 }, constraints).decision).toBe('allow');
    });

    it('should enforce lessThanOrEqual', () => {
      const constraints = [makeConstraint({ argumentName: 'val', lessThanOrEqual: 10 })];
      expect(validateDeterministic('tool', { val: 11 }, constraints).decision).toBe('deny');
      expect(validateDeterministic('tool', { val: 10 }, constraints).decision).toBe('allow');
    });
  });

  describe('string constraints', () => {
    it('should enforce minLength', () => {
      const constraints = [makeConstraint({ argumentName: 'name', minLength: 3 })];
      expect(validateDeterministic('tool', { name: 'ab' }, constraints).decision).toBe('deny');
      expect(validateDeterministic('tool', { name: 'abc' }, constraints).decision).toBe('allow');
    });

    it('should enforce maxLength', () => {
      const constraints = [makeConstraint({ argumentName: 'name', maxLength: 5 })];
      expect(validateDeterministic('tool', { name: 'abcdef' }, constraints).decision).toBe('deny');
      expect(validateDeterministic('tool', { name: 'abcde' }, constraints).decision).toBe('allow');
    });

    it('should enforce regex pattern', () => {
      const constraints = [makeConstraint({ argumentName: 'email', regex: '^[^@]+@[^@]+$' })];
      expect(validateDeterministic('tool', { email: 'user@example.com' }, constraints).decision).toBe('allow');
      expect(validateDeterministic('tool', { email: 'invalid' }, constraints).decision).toBe('deny');
    });

    it('should deny on unsafe regex (ReDoS risk)', () => {
      const constraints = [makeConstraint({ argumentName: 'val', regex: '(a+)+' })];
      const result = validateDeterministic('tool', { val: 'anything' }, constraints);
      expect(result.decision).toBe('deny');
      expect(result.reason).toContain('unsafe');
    });

    it('should deny on invalid regex', () => {
      const constraints = [makeConstraint({ argumentName: 'val', regex: '[invalid' })];
      const result = validateDeterministic('tool', { val: 'anything' }, constraints);
      expect(result.decision).toBe('deny');
      expect(result.reason).toContain('invalid regex');
    });

    it('should deny on regex pattern exceeding 256 chars', () => {
      const constraints = [makeConstraint({ argumentName: 'val', regex: 'a'.repeat(257) })];
      const result = validateDeterministic('tool', { val: 'a' }, constraints);
      expect(result.decision).toBe('deny');
      expect(result.reason).toContain('too long');
    });

    it('should enforce enum', () => {
      const constraints = [makeConstraint({ argumentName: 'color', enum: ['red', 'blue', 'green'] })];
      expect(validateDeterministic('tool', { color: 'red' }, constraints).decision).toBe('allow');
      expect(validateDeterministic('tool', { color: 'purple' }, constraints).decision).toBe('deny');
    });
  });

  describe('in/notIn constraints', () => {
    it('should allow values in the allowed list (strings)', () => {
      const constraints = [makeConstraint({ argumentName: 'currency', in: ['usd', 'eur', 'gbp'] })];
      expect(validateDeterministic('tool', { currency: 'usd' }, constraints).decision).toBe('allow');
    });

    it('should deny values not in the allowed list (strings)', () => {
      const constraints = [makeConstraint({ argumentName: 'currency', in: ['usd', 'eur', 'gbp'] })];
      const result = validateDeterministic('tool', { currency: 'btc' }, constraints);
      expect(result.decision).toBe('deny');
      expect(result.reason).toContain('not in allowed list');
    });

    it('should allow values in the allowed list (numbers)', () => {
      const constraints = [makeConstraint({ argumentName: 'tier', in: [1, 2, 3] })];
      expect(validateDeterministic('tool', { tier: 2 }, constraints).decision).toBe('allow');
    });

    it('should deny values not in the allowed list (numbers)', () => {
      const constraints = [makeConstraint({ argumentName: 'tier', in: [1, 2, 3] })];
      expect(validateDeterministic('tool', { tier: 4 }, constraints).decision).toBe('deny');
    });

    it('should deny values in the denied list (notIn)', () => {
      const constraints = [makeConstraint({ argumentName: 'action', notIn: ['delete', 'drop', 'truncate'] })];
      const result = validateDeterministic('tool', { action: 'delete' }, constraints);
      expect(result.decision).toBe('deny');
      expect(result.reason).toContain('in denied list');
    });

    it('should allow values not in the denied list (notIn)', () => {
      const constraints = [makeConstraint({ argumentName: 'action', notIn: ['delete', 'drop', 'truncate'] })];
      expect(validateDeterministic('tool', { action: 'select' }, constraints).decision).toBe('allow');
    });

    it('should work with mixed types in the list', () => {
      const constraints = [makeConstraint({ argumentName: 'val', in: ['a', 1, true] })];
      expect(validateDeterministic('tool', { val: 'a' }, constraints).decision).toBe('allow');
      expect(validateDeterministic('tool', { val: 1 }, constraints).decision).toBe('allow');
      expect(validateDeterministic('tool', { val: true }, constraints).decision).toBe('allow');
      expect(validateDeterministic('tool', { val: 'b' }, constraints).decision).toBe('deny');
    });

    it('should combine in with other string constraints', () => {
      const constraints = [makeConstraint({ argumentName: 'code', minLength: 2, in: ['us', 'eu', 'uk'] })];
      expect(validateDeterministic('tool', { code: 'us' }, constraints).decision).toBe('allow');
      expect(validateDeterministic('tool', { code: 'jp' }, constraints).decision).toBe('deny');
    });

    it('should combine in with number constraints', () => {
      const constraints = [makeConstraint({ argumentName: 'port', greaterThan: 0, in: [80, 443, 8080] })];
      expect(validateDeterministic('tool', { port: 443 }, constraints).decision).toBe('allow');
      expect(validateDeterministic('tool', { port: 22 }, constraints).decision).toBe('deny');
    });

    it('should handle empty in list (deny all)', () => {
      const constraints = [makeConstraint({ argumentName: 'val', in: [] })];
      expect(validateDeterministic('tool', { val: 'anything' }, constraints).decision).toBe('deny');
    });

    it('should handle empty notIn list (allow all)', () => {
      const constraints = [makeConstraint({ argumentName: 'val', notIn: [] })];
      expect(validateDeterministic('tool', { val: 'anything' }, constraints).decision).toBe('allow');
    });
  });

  describe('array constraints', () => {
    it('should enforce minItems', () => {
      const constraints = [makeConstraint({ argumentName: 'tags', minItems: 2 })];
      expect(validateDeterministic('tool', { tags: ['a'] }, constraints).decision).toBe('deny');
      expect(validateDeterministic('tool', { tags: ['a', 'b'] }, constraints).decision).toBe('allow');
    });

    it('should enforce maxItems', () => {
      const constraints = [makeConstraint({ argumentName: 'tags', maxItems: 3 })];
      expect(validateDeterministic('tool', { tags: ['a', 'b', 'c', 'd'] }, constraints).decision).toBe('deny');
      expect(validateDeterministic('tool', { tags: ['a', 'b', 'c'] }, constraints).decision).toBe('allow');
    });
  });

  describe('presence constraints', () => {
    it('should deny missing required arguments', () => {
      const constraints = [makeConstraint({ argumentName: 'name', required: true })];
      expect(validateDeterministic('tool', {}, constraints).decision).toBe('deny');
      expect(validateDeterministic('tool', { name: 'test' }, constraints).decision).toBe('allow');
    });

    it('should deny null when notNull is set', () => {
      const constraints = [makeConstraint({ argumentName: 'name', notNull: true })];
      expect(validateDeterministic('tool', { name: null }, constraints).decision).toBe('deny');
    });

    it('should skip undefined values for non-required fields', () => {
      const constraints = [makeConstraint({ argumentName: 'optional', minimum: 0, maximum: 100 })];
      expect(validateDeterministic('tool', {}, constraints).decision).toBe('allow');
    });
  });

  describe('disabled constraints', () => {
    it('should skip disabled constraints', () => {
      const constraints: ArgumentConstraint[] = [
        { argumentName: 'val', enabled: false, maximum: 10 },
      ];
      expect(validateDeterministic('tool', { val: 999 }, constraints).decision).toBe('allow');
    });
  });

  describe('multiple constraints', () => {
    it('should short-circuit on first failure', () => {
      const constraints = [
        makeConstraint({ argumentName: 'a', minimum: 10 }),
        makeConstraint({ argumentName: 'b', minimum: 10 }),
      ];
      const result = validateDeterministic('tool', { a: 5, b: 5 }, constraints);
      expect(result.decision).toBe('deny');
      expect(result.failedArgument).toBe('a');
      expect(result.validations).toHaveLength(1);
    });

    it('should validate all passing constraints', () => {
      const constraints = [
        makeConstraint({ argumentName: 'a', minimum: 0 }),
        makeConstraint({ argumentName: 'b', minimum: 0 }),
      ];
      const result = validateDeterministic('tool', { a: 5, b: 5 }, constraints);
      expect(result.decision).toBe('allow');
      expect(result.validations).toHaveLength(2);
    });
  });

  describe('latency tracking', () => {
    it('should include latencyMs in result', () => {
      const result = validateDeterministic('tool', {}, []);
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('edge cases', () => {
    it('should allow empty constraints array', () => {
      const result = validateDeterministic('tool', { a: 1, b: 'x' }, []);
      expect(result.decision).toBe('allow');
      expect(result.validations).toHaveLength(0);
    });

    it('should pass required check for falsy but present values', () => {
      const constraints = [makeConstraint({ argumentName: 'val', required: true })];
      expect(validateDeterministic('tool', { val: 0 }, constraints).decision).toBe('allow');
      expect(validateDeterministic('tool', { val: '' }, constraints).decision).toBe('allow');
      expect(validateDeterministic('tool', { val: false }, constraints).decision).toBe('allow');
    });

    it('should pass notNull check for falsy but non-null values', () => {
      const constraints = [makeConstraint({ argumentName: 'val', notNull: true })];
      expect(validateDeterministic('tool', { val: 0 }, constraints).decision).toBe('allow');
      expect(validateDeterministic('tool', { val: '' }, constraints).decision).toBe('allow');
      expect(validateDeterministic('tool', { val: false }, constraints).decision).toBe('allow');
    });

    it('should pass through unknown types without checking', () => {
      const constraints = [makeConstraint({ argumentName: 'val', minimum: 5 })];
      expect(validateDeterministic('tool', { val: true }, constraints).decision).toBe('allow');
      expect(validateDeterministic('tool', { val: { nested: 1 } }, constraints).decision).toBe('allow');
    });

    it('should deny invalid regex combined with other string constraints', () => {
      const constraints = [makeConstraint({ argumentName: 'val', regex: '[bad', minLength: 3 })];
      const result = validateDeterministic('tool', { val: 'abcdef' }, constraints);
      expect(result.decision).toBe('deny');
      expect(result.reason).toContain('invalid regex');
    });

    it('should deny NaN values', () => {
      const constraints = [makeConstraint({ argumentName: 'val', minimum: 0, maximum: 100 })];
      const result = validateDeterministic('tool', { val: NaN }, constraints);
      expect(result.decision).toBe('deny');
      expect(result.reason).toContain('NaN');
    });

    it('should deny Infinity values', () => {
      const constraints = [makeConstraint({ argumentName: 'val', minimum: 0 })];
      expect(validateDeterministic('tool', { val: Infinity }, constraints).decision).toBe('deny');
      expect(validateDeterministic('tool', { val: -Infinity }, constraints).decision).toBe('deny');
    });

    it('should use notNull (not required) when key is present with null value', () => {
      const constraints = [makeConstraint({ argumentName: 'val', required: true, notNull: true })];
      const result = validateDeterministic('tool', { val: null }, constraints);
      expect(result.decision).toBe('deny');
      expect(result.reason).toContain('cannot be null');
    });
  });
});
