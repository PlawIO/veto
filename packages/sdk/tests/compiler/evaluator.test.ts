import { describe, it, expect } from 'vitest';
import { compile, evaluate } from '../../src/compiler/index.js';
import { EvaluationError } from '../../src/compiler/evaluator.js';

describe('Evaluator', () => {
  describe('literals', () => {
    it('should evaluate number', () => {
      expect(evaluate(compile('42'), {})).toBe(42);
    });

    it('should evaluate string', () => {
      expect(evaluate(compile('"hello"'), {})).toBe('hello');
    });

    it('should evaluate boolean', () => {
      expect(evaluate(compile('true'), {})).toBe(true);
      expect(evaluate(compile('false'), {})).toBe(false);
    });
  });

  describe('paths', () => {
    it('should resolve simple path', () => {
      expect(evaluate(compile('x'), { x: 10 })).toBe(10);
    });

    it('should resolve dotted path', () => {
      expect(evaluate(compile('a.b'), { a: { b: 42 } })).toBe(42);
    });

    it('should resolve array index', () => {
      expect(evaluate(compile('items[0]'), { items: ['a', 'b'] })).toBe('a');
    });

    it('should resolve wildcard to array', () => {
      expect(evaluate(compile('items[*]'), { items: [1, 2, 3] })).toEqual([1, 2, 3]);
    });

    it('should resolve deeply nested path', () => {
      const ctx = { a: { b: { c: { d: 'deep' } } } };
      expect(evaluate(compile('a.b.c.d'), ctx)).toBe('deep');
    });

    it('should return undefined for missing path', () => {
      expect(evaluate(compile('x.y.z'), { x: {} })).toBeUndefined();
    });

    it('should return undefined for null in path', () => {
      expect(evaluate(compile('x.y'), { x: null })).toBeUndefined();
    });
  });

  describe('arithmetic', () => {
    it('should add numbers', () => {
      expect(evaluate(compile('2 + 3'), {})).toBe(5);
    });

    it('should subtract numbers', () => {
      expect(evaluate(compile('10 - 4'), {})).toBe(6);
    });

    it('should multiply numbers', () => {
      expect(evaluate(compile('3 * 7'), {})).toBe(21);
    });

    it('should divide numbers', () => {
      expect(evaluate(compile('15 / 3'), {})).toBe(5);
    });

    it('should respect operator precedence', () => {
      expect(evaluate(compile('2 + 3 * 4'), {})).toBe(14);
    });

    it('should handle parentheses', () => {
      expect(evaluate(compile('(2 + 3) * 4'), {})).toBe(20);
    });

    it('should concatenate strings with +', () => {
      expect(evaluate(compile('"hello" + " " + "world"'), {})).toBe('hello world');
    });

    it('should throw on division by zero', () => {
      expect(() => evaluate(compile('1 / 0'), {})).toThrow(EvaluationError);
    });
  });

  describe('comparison', () => {
    it('should compare equal', () => {
      expect(evaluate(compile('x == 5'), { x: 5 })).toBe(true);
      expect(evaluate(compile('x == 5'), { x: 6 })).toBe(false);
    });

    it('should compare not equal', () => {
      expect(evaluate(compile('x != 5'), { x: 6 })).toBe(true);
    });

    it('should compare less than', () => {
      expect(evaluate(compile('x < 5'), { x: 3 })).toBe(true);
      expect(evaluate(compile('x < 5'), { x: 5 })).toBe(false);
    });

    it('should compare greater than', () => {
      expect(evaluate(compile('x > 5'), { x: 10 })).toBe(true);
    });

    it('should compare less than or equal', () => {
      expect(evaluate(compile('x <= 5'), { x: 5 })).toBe(true);
      expect(evaluate(compile('x <= 5'), { x: 6 })).toBe(false);
    });

    it('should compare greater than or equal', () => {
      expect(evaluate(compile('x >= 5'), { x: 5 })).toBe(true);
    });

    it('should compare strings', () => {
      expect(evaluate(compile('name == "alice"'), { name: 'alice' })).toBe(true);
    });
  });

  describe('logical operators', () => {
    it('should evaluate AND', () => {
      expect(evaluate(compile('true && true'), {})).toBe(true);
      expect(evaluate(compile('true && false'), {})).toBe(false);
    });

    it('should evaluate OR', () => {
      expect(evaluate(compile('false || true'), {})).toBe(true);
      expect(evaluate(compile('false || false'), {})).toBe(false);
    });

    it('should evaluate NOT', () => {
      expect(evaluate(compile('!true'), {})).toBe(false);
      expect(evaluate(compile('!false'), {})).toBe(true);
    });

    it('should short-circuit AND', () => {
      // If left is false, right should not be evaluated
      // (no error from division by zero)
      expect(evaluate(compile('false && x > 0'), {})).toBe(false);
    });

    it('should short-circuit OR', () => {
      expect(evaluate(compile('true || x > 0'), {})).toBe(true);
    });
  });

  describe('set operators', () => {
    it('should evaluate in', () => {
      expect(evaluate(compile('x in items'), { x: 'a', items: ['a', 'b'] })).toBe(true);
      expect(evaluate(compile('x in items'), { x: 'c', items: ['a', 'b'] })).toBe(false);
    });

    it('should evaluate not_in', () => {
      expect(evaluate(compile('x not_in items'), { x: 'c', items: ['a', 'b'] })).toBe(true);
    });

    it('should throw when in used with non-array', () => {
      expect(() => evaluate(compile('x in y'), { x: 1, y: 'not array' })).toThrow(EvaluationError);
    });
  });

  describe('contains operator', () => {
    it('should check string contains', () => {
      expect(evaluate(compile('name contains "test"'), { name: 'my-test-file' })).toBe(true);
      expect(evaluate(compile('name contains "xyz"'), { name: 'my-test-file' })).toBe(false);
    });

    it('should check array contains', () => {
      expect(evaluate(compile('tags contains "urgent"'), { tags: ['urgent', 'bug'] })).toBe(true);
    });
  });

  describe('matches operator', () => {
    it('should match regex', () => {
      expect(evaluate(compile('email matches "^[a-z]+@"'), { email: 'user@test.com' })).toBe(true);
      expect(evaluate(compile('email matches "^[0-9]+$"'), { email: 'abc' })).toBe(false);
    });

    it('should work with safe regex patterns', () => {
      expect(evaluate(compile('name matches "^test$"'), { name: 'test' })).toBe(true);
    });

    it('should throw EvaluationError for unsafe regex patterns', () => {
      expect(() => evaluate(compile('name matches "(a+)+"'), { name: 'aaa' })).toThrow(EvaluationError);
    });
  });

  describe('unary negation', () => {
    it('should negate number', () => {
      expect(evaluate(compile('-5'), {})).toBe(-5);
    });

    it('should negate variable', () => {
      expect(evaluate(compile('-x'), { x: 10 })).toBe(-10);
    });

    it('should throw on negating non-number', () => {
      expect(() => evaluate(compile('-x'), { x: 'hello' })).toThrow(EvaluationError);
    });
  });

  describe('function calls', () => {
    it('should evaluate len() on string', () => {
      expect(evaluate(compile('len("hello")'), {})).toBe(5);
    });

    it('should evaluate len() on array', () => {
      expect(evaluate(compile('len(items)'), { items: [1, 2, 3] })).toBe(3);
    });

    it('should evaluate lower()', () => {
      expect(evaluate(compile('lower("HELLO")'), {})).toBe('hello');
    });

    it('should evaluate upper()', () => {
      expect(evaluate(compile('upper("hello")'), {})).toBe('HELLO');
    });

    it('should evaluate abs()', () => {
      expect(evaluate(compile('abs(-5)'), {})).toBe(5);
    });

    it('should evaluate min()', () => {
      expect(evaluate(compile('min(3, 1, 2)'), {})).toBe(1);
    });

    it('should evaluate max()', () => {
      expect(evaluate(compile('max(3, 1, 2)'), {})).toBe(3);
    });

    it('should evaluate starts_with()', () => {
      expect(evaluate(compile('starts_with(path, "/etc")'), { path: '/etc/passwd' })).toBe(true);
    });

    it('should evaluate ends_with()', () => {
      expect(evaluate(compile('ends_with(file, ".js")'), { file: 'app.js' })).toBe(true);
    });

    it('should throw on unknown function', () => {
      expect(() => evaluate(compile('unknown(1)'), {})).toThrow(EvaluationError);
    });
  });

  describe('complex expressions', () => {
    it('should evaluate policy-like expression', () => {
      const expr = 'amount > 1000 && currency == "USD"';
      const ctx = { amount: 1500, currency: 'USD' };
      expect(evaluate(compile(expr), ctx)).toBe(true);
    });

    it('should evaluate nested path comparison', () => {
      const expr = 'user.role == "admin" || user.permissions contains "write"';
      const ctx = {
        user: {
          role: 'user',
          permissions: ['read', 'write'],
        },
      };
      expect(evaluate(compile(expr), ctx)).toBe(true);
    });

    it('should evaluate with function in condition', () => {
      const expr = 'len(recipients) <= 10 && !body contains "password"';
      const ctx = {
        recipients: ['a@b.com', 'c@d.com'],
        body: 'Hello, here is the update.',
      };
      expect(evaluate(compile(expr), ctx)).toBe(true);
    });

    it('should evaluate arithmetic in comparison', () => {
      const expr = 'price * quantity > budget';
      const ctx = { price: 50, quantity: 3, budget: 100 };
      expect(evaluate(compile(expr), ctx)).toBe(true);
    });
  });
});
