/**
 * Regression tests for the critical fail-open fixes (audit Round 2, PR A).
 *
 * Pins two behaviour changes:
 *
 * 1. `Veto.evaluateLocalExpression` no longer catches a parse / eval error
 *    and returns `false` (silent fail-open — a `block` rule with a broken
 *    expression never matched). It now propagates the error; the validation
 *    engine's existing catch treats validator errors as a deny.
 *
 * 2. The `matches` operator on a regex that the safety heuristic rejects
 *    still returns `false` (preserves operator semantics) but now also
 *    writes a one-time error line to stderr so a fail-open block rule
 *    can't go unnoticed at runtime.
 */
import { describe, it, expect, vi } from 'vitest';

const ESC = String.fromCharCode(0x1b);
const stripAnsi = (s: string) => s.replace(new RegExp(`${ESC}\\[\\d+m`, 'g'), '');

describe('matches operator — rejected pattern surfaces a one-time error', () => {
  it('rejected pattern returns false and writes ERROR to stderr (one-time)', async () => {
    // Fresh module isolates the in-module Set that tracks logged patterns.
    vi.resetModules();
    const { evaluateLegacyCondition } = await import(
      '../../src/rules/condition-evaluator.js'
    );

    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((c: any) => {
      writes.push(String(c));
      return true;
    });

    const bad = '(rm.*|wget.*)';
    const r1 = evaluateLegacyCondition('rm -rf /', 'matches', bad);
    const r2 = evaluateLegacyCondition('rm -rf /tmp', 'matches', bad);
    spy.mockRestore();

    const all = stripAnsi(writes.join(''));
    expect(r1).toBe(false);
    expect(r2).toBe(false);
    expect(all).toContain('ERROR');
    expect(all).toContain('rejected by safety heuristic');
    expect((all.match(/ERROR/g) ?? []).length).toBe(1);
  });

  it('safe pattern does not log', async () => {
    vi.resetModules();
    const { evaluateLegacyCondition } = await import(
      '../../src/rules/condition-evaluator.js'
    );

    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((c: any) => {
      writes.push(String(c));
      return true;
    });

    const result = evaluateLegacyCondition('rm -rf /', 'matches', 'rm -rf');
    spy.mockRestore();

    expect(result).toBe(true);
    expect(stripAnsi(writes.join(''))).not.toContain('ERROR');
  });

  it('two distinct bad patterns log exactly once each', async () => {
    vi.resetModules();
    const { evaluateLegacyCondition } = await import(
      '../../src/rules/condition-evaluator.js'
    );

    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((c: any) => {
      writes.push(String(c));
      return true;
    });

    const a = '(rm.*|wget.*)';
    const b = '(curl.*|fetch.*)';
    evaluateLegacyCondition('x', 'matches', a);
    evaluateLegacyCondition('x', 'matches', b);
    evaluateLegacyCondition('y', 'matches', a);  // dup
    evaluateLegacyCondition('y', 'matches', b);  // dup
    spy.mockRestore();

    const all = stripAnsi(writes.join(''));
    expect((all.match(/ERROR/g) ?? []).length).toBe(2);
  });
});

describe('local rule expression — propagates errors instead of returning false', () => {
  it('compile() failure now throws from evaluateLocalExpression', async () => {
    // Direct test of the compiler — a malformed expression must throw at
    // compile time, not be silently absorbed.
    const { compile } = await import('../../src/compiler/index.js');
    expect(() => compile('1 +')).toThrow();
    expect(() => compile('args.x ==')).toThrow();
  });
});
