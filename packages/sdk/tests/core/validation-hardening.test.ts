/**
 * Regression tests for validation hardening (audit follow-up).
 */
import { describe, it, expect, vi } from 'vitest';
import { BudgetTracker } from '../../src/core/budget.js';
import { Veto } from '../../src/core/veto.js';
import type { Logger } from '../../src/utils/logger.js';

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

describe('validation hardening — budget tokens', () => {
  it('reserveCall returns a token; releaseReservation is idempotent', () => {
    const t = new BudgetTracker({
      config: { max: 100 },
      costs: { tool_a: 30 },
      logger: silentLogger,
    });

    const a = t.reserveCall('tool_a', {});
    t.reserveCall('tool_a', {});  // second outstanding reservation
    expect(t.getStatus().spent).toBe(60);

    t.releaseReservation(a);
    t.releaseReservation(a);  // double-release is a no-op
    t.releaseReservation(a);  // …and again
    expect(t.getStatus().spent).toBe(30); // exactly one cost-30 release applied
  });

  it('reserveCall returns null for zero-cost tools, releaseReservation tolerates null', () => {
    const t = new BudgetTracker({
      config: { max: 100 },
      costs: {},  // no cost defined → 0
      logger: silentLogger,
    });
    const r = t.reserveCall('unknown_tool', {});
    expect(r).toBeNull();
    expect(() => t.releaseReservation(r)).not.toThrow();
  });

  it('catches unsafe `matches` regex in `condition_groups` (OR-of-AND)', () => {
    // The warn helper logs through Veto's internal logger, which goes
    // through console.error. Capture that.
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((msg: any) => {
      errors.push(String(msg));
    });

    Veto.fromRules({
      rules: [
        {
          id: 'groups-broken',
          tools: ['x'],
          action: 'block',
          // Using condition_groups (OR-of-AND), not the flat `conditions`.
          condition_groups: [
            [
              {
                field: 'arguments.cmd',
                operator: 'matches',
                value: '(rm.*|wget.*)',  // rejected by ReDoS-safety heuristic
              },
            ],
          ],
        },
      ] as any,
      logLevel: 'error',
    });

    spy.mockRestore();

    const matched = errors.find(
      (line) =>
        line.includes('unsafe `matches` regex') &&
        line.includes('"ruleId":"groups-broken"'),
    );
    expect(matched).toBeDefined();
  });

  it('legacy reserve(number) + refund(number) still works', () => {
    const t = new BudgetTracker({
      config: { max: 100 },
      costs: { tool_a: 30 },
      logger: silentLogger,
    });
    const cost = t.reserve('tool_a', {});
    expect(cost).toBe(30);
    t.refund(cost);
    expect(t.getStatus().spent).toBe(0);
  });
});
