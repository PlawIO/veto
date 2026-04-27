/**
 * Cross-SDK regex behavior parity tests.
 *
 * The expression DSL `matches` operator must produce the same decision in
 * the TS and Python SDKs given the same policy and input — otherwise a
 * policy that's tested against one SDK silently behaves differently in
 * the other. Default is case-INsensitive (matches Python).
 */
import { describe, it, expect } from 'vitest';
import { compile, evaluate } from '../../src/compiler/index.js';

const run = (expr: string, ctx: Record<string, unknown>) => evaluate(compile(expr), ctx);

describe('regex parity — `matches` operator (compiler/evaluator)', () => {
  it('is case-insensitive by default (matches Python re.IGNORECASE)', () => {
    expect(run(`args.s matches 'hello'`, { args: { s: 'HELLO' } })).toBe(true);
    expect(run(`args.s matches 'HELLO'`, { args: { s: 'hello' } })).toBe(true);
  });

  it('opt-in case-sensitive via `(?-i)` prefix', () => {
    expect(run(`args.s matches '(?-i)hello'`, { args: { s: 'HELLO' } })).toBe(false);
    expect(run(`args.s matches '(?-i)HELLO'`, { args: { s: 'HELLO' } })).toBe(true);
  });

  it('preserves character-class case rules under default insensitivity', () => {
    // `[a-z]` would normally not match uppercase, but with `i` flag it does.
    // Document the chosen default behaviour clearly via a test.
    expect(run(`args.s matches '^[a-z]+$'`, { args: { s: 'HELLO' } })).toBe(true);
    expect(run(`args.s matches '(?-i)^[a-z]+$'`, { args: { s: 'HELLO' } })).toBe(false);
  });
});
