import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LocalBudgetEngine } from '../../src/economic/budget-engine.js';
import type { EconomicBudgetConfig } from '../../src/economic/types.js';

const createMockLogger = () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

describe('LocalBudgetEngine', () => {
  let engine: LocalBudgetEngine;
  let logger: ReturnType<typeof createMockLogger>;

  const sessionBudget: EconomicBudgetConfig = {
    scope: 'session',
    limit: 50,
    currency: 'USD',
    approval_threshold: 20,
    window: 'session',
  };

  beforeEach(() => {
    logger = createMockLogger();
    engine = new LocalBudgetEngine({
      budgets: [sessionBudget],
      logger,
    });
  });

  describe('check', () => {
    it('should allow cost within budget', () => {
      const result = engine.check(10, 'USD', 'session');
      expect(result.allowed).toBe(true);
      expect(result.decision).toBe('allow');
      expect(result.denial).toBeUndefined();
    });

    it('should deny cost exceeding budget', () => {
      const result = engine.check(60, 'USD', 'session');
      expect(result.allowed).toBe(false);
      expect(result.decision).toBe('deny');
      expect(result.denial?.reason).toBe('budget_exceeded');
      expect(result.denial?.budget_limit).toBe(50);
    });

    it('should require approval above threshold', () => {
      const result = engine.check(25, 'USD', 'session');
      expect(result.allowed).toBe(false);
      expect(result.decision).toBe('require_approval');
      expect(result.denial?.reason).toBe('approval_required');
    });

    it('should allow cost exactly at budget limit', () => {
      const result = engine.check(50, 'USD', 'session');
      // 50 > 20 threshold, so require_approval
      expect(result.decision).toBe('require_approval');
    });

    it('should allow cost exactly at threshold', () => {
      const result = engine.check(20, 'USD', 'session');
      // 20 is NOT greater than 20, so allowed
      expect(result.allowed).toBe(true);
      expect(result.decision).toBe('allow');
    });

    it('should allow zero cost', () => {
      const result = engine.check(0, 'USD', 'session');
      expect(result.allowed).toBe(true);
      expect(result.decision).toBe('allow');
    });

    it('should treat negative cost as zero', () => {
      const result = engine.check(-10, 'USD', 'session');
      expect(result.allowed).toBe(true);
    });

    it('should treat NaN cost as zero', () => {
      const result = engine.check(NaN, 'USD', 'session');
      expect(result.allowed).toBe(true);
    });

    it('should treat Infinity cost as zero', () => {
      const result = engine.check(Infinity, 'USD', 'session');
      expect(result.allowed).toBe(true);
    });

    it('should deny on currency mismatch', () => {
      const result = engine.check(10, 'EUR', 'session');
      expect(result.allowed).toBe(false);
      expect(result.decision).toBe('deny');
      expect(result.denial?.reason).toBe('currency_mismatch');
    });

    it('should allow for unconfigured scope', () => {
      const result = engine.check(10, 'USD', 'agent');
      expect(result.allowed).toBe(true);
    });

    it('should be case-insensitive for currency', () => {
      const result = engine.check(10, 'usd', 'session');
      expect(result.allowed).toBe(true);
    });
  });

  describe('reserve', () => {
    it('should reserve and track spending', () => {
      const result = engine.reserve(10, 'USD', 'session');
      expect(result.allowed).toBe(true);

      const status = engine.getStatus('session')!;
      expect(status.spent).toBe(10);
      expect(status.remaining).toBe(40);
    });

    it('should deny reservation exceeding budget', () => {
      // Use amounts at or below threshold (20) to avoid require_approval
      engine.reserve(20, 'USD', 'session');
      engine.reserve(20, 'USD', 'session');
      const result = engine.reserve(15, 'USD', 'session');
      expect(result.allowed).toBe(false);
      expect(result.denial?.reason).toBe('budget_exceeded');
    });

    it('should accumulate across reservations', () => {
      engine.reserve(15, 'USD', 'session');
      engine.reserve(15, 'USD', 'session');
      const status = engine.getStatus('session')!;
      expect(status.spent).toBe(30);
    });
  });

  describe('record', () => {
    it('should record charge', () => {
      engine.record(10, 'USD', 'session');
      const status = engine.getStatus('session')!;
      expect(status.spent).toBe(10);
    });
  });

  describe('refund', () => {
    it('should refund within spent amount', () => {
      // Use amount at threshold (20) to avoid require_approval
      engine.reserve(20, 'USD', 'session');
      engine.refund(10, 'session');
      const status = engine.getStatus('session')!;
      expect(status.spent).toBe(10);
    });

    it('should clamp refund to zero', () => {
      engine.reserve(10, 'USD', 'session');
      engine.refund(20, 'session');
      const status = engine.getStatus('session')!;
      expect(status.spent).toBe(0);
    });

    it('should ignore zero/negative refunds', () => {
      engine.reserve(10, 'USD', 'session');
      engine.refund(0, 'session');
      engine.refund(-5, 'session');
      const status = engine.getStatus('session')!;
      expect(status.spent).toBe(10);
    });
  });

  describe('getStatus', () => {
    it('should return null for unconfigured scope', () => {
      expect(engine.getStatus('agent')).toBeNull();
    });

    it('should return correct initial status', () => {
      const status = engine.getStatus('session')!;
      expect(status.scope).toBe('session');
      expect(status.spent).toBe(0);
      expect(status.limit).toBe(50);
      expect(status.remaining).toBe(50);
      expect(status.currency).toBe('USD');
    });
  });

  describe('reset', () => {
    it('should reset spent to zero', () => {
      engine.reserve(30, 'USD', 'session');
      engine.reset('session');
      const status = engine.getStatus('session')!;
      expect(status.spent).toBe(0);
    });
  });

  describe('non-session scope warning', () => {
    it('should warn about non-session scopes', () => {
      const _engine = new LocalBudgetEngine({
        budgets: [
          { scope: 'agent', limit: 100, currency: 'USD', window: '24h' },
        ],
        logger,
      });
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('only supports session scope'),
        expect.any(Object),
      );
    });
  });
});
