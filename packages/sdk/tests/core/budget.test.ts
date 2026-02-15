import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BudgetTracker, BudgetExceededError } from '../../src/core/budget.js';

const createMockLogger = () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

describe('BudgetTracker', () => {
  let tracker: BudgetTracker;
  let mockLogger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    mockLogger = createMockLogger();
    tracker = new BudgetTracker({
      config: { max: 50, currency: 'USD', window: 'session' },
      costs: {
        send_email: 0,
        api_call: 0.01,
        purchase: 'args.amount',
        nested_cost: 'args.order.total',
      },
      logger: mockLogger,
    });
  });

  describe('resolveCost', () => {
    it('should return 0 for tools not in cost map', () => {
      expect(tracker.resolveCost('unknown_tool', {})).toBe(0);
    });

    it('should return 0 for tools with zero cost', () => {
      expect(tracker.resolveCost('send_email', {})).toBe(0);
    });

    it('should return fixed numeric cost', () => {
      expect(tracker.resolveCost('api_call', {})).toBe(0.01);
    });

    it('should resolve dynamic cost from args', () => {
      expect(tracker.resolveCost('purchase', { amount: 25.50 })).toBe(25.50);
    });

    it('should resolve nested arg paths', () => {
      expect(tracker.resolveCost('nested_cost', { order: { total: 99.99 } })).toBe(99.99);
    });

    it('should return 0 for missing arg path', () => {
      expect(tracker.resolveCost('purchase', {})).toBe(0);
    });

    it('should return 0 for non-numeric resolved value', () => {
      expect(tracker.resolveCost('purchase', { amount: 'not-a-number' })).toBe(0);
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    it('should return 0 for negative resolved value', () => {
      expect(tracker.resolveCost('purchase', { amount: -5 })).toBe(0);
    });

    it('should return 0 for NaN resolved value', () => {
      expect(tracker.resolveCost('purchase', { amount: NaN })).toBe(0);
    });

    it('should return 0 for Infinity resolved value', () => {
      expect(tracker.resolveCost('purchase', { amount: Infinity })).toBe(0);
    });
  });

  describe('check', () => {
    it('should not throw when within budget', () => {
      expect(() => tracker.check('api_call', {})).not.toThrow();
    });

    it('should not throw for zero-cost tools', () => {
      expect(() => tracker.check('send_email', {})).not.toThrow();
    });

    it('should throw BudgetExceededError when over budget', () => {
      // Spend most of the budget
      tracker.record('purchase', { amount: 49 });

      expect(() => tracker.check('purchase', { amount: 2 })).toThrow(BudgetExceededError);
    });

    it('should include correct fields in BudgetExceededError', () => {
      tracker.record('purchase', { amount: 45 });

      try {
        tracker.check('purchase', { amount: 10 });
        expect.fail('Should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(BudgetExceededError);
        const err = e as BudgetExceededError;
        expect(err.toolName).toBe('purchase');
        expect(err.toolCost).toBe(10);
        expect(err.spent).toBe(45);
        expect(err.limit).toBe(50);
        expect(err.remaining).toBe(5);
      }
    });

    it('should not throw for unknown tools (cost is 0)', () => {
      tracker.record('purchase', { amount: 50 });
      expect(() => tracker.check('unknown_tool', {})).not.toThrow();
    });
  });

  describe('record', () => {
    it('should accumulate costs', () => {
      tracker.record('api_call', {});
      tracker.record('api_call', {});
      tracker.record('api_call', {});

      const status = tracker.getStatus();
      expect(status.spent).toBeCloseTo(0.03);
    });

    it('should return the cost that was recorded', () => {
      const cost = tracker.record('purchase', { amount: 10 });
      expect(cost).toBe(10);
    });

    it('should return 0 for zero-cost tools', () => {
      const cost = tracker.record('send_email', {});
      expect(cost).toBe(0);
    });

    it('should handle dynamic costs from arguments', () => {
      tracker.record('purchase', { amount: 15 });
      tracker.record('purchase', { amount: 20 });

      const status = tracker.getStatus();
      expect(status.spent).toBe(35);
      expect(status.remaining).toBe(15);
    });
  });

  describe('getStatus', () => {
    it('should return initial status', () => {
      const status = tracker.getStatus();

      expect(status.spent).toBe(0);
      expect(status.limit).toBe(50);
      expect(status.remaining).toBe(50);
      expect(status.currency).toBe('USD');
    });

    it('should reflect spending', () => {
      tracker.record('purchase', { amount: 30 });

      const status = tracker.getStatus();
      expect(status.spent).toBe(30);
      expect(status.remaining).toBe(20);
    });

    it('should clamp remaining to 0 when overspent', () => {
      // Record at exactly the limit
      tracker.record('purchase', { amount: 50 });

      const status = tracker.getStatus();
      expect(status.remaining).toBe(0);
    });

    it('should default currency to USD', () => {
      const noCurrencyTracker = new BudgetTracker({
        config: { max: 100 },
        costs: {},
        logger: mockLogger,
      });

      expect(noCurrencyTracker.getStatus().currency).toBe('USD');
    });
  });

  describe('reset', () => {
    it('should clear spent amount', () => {
      tracker.record('purchase', { amount: 30 });
      tracker.reset();

      const status = tracker.getStatus();
      expect(status.spent).toBe(0);
      expect(status.remaining).toBe(50);
    });

    it('should allow spending again after reset', () => {
      tracker.record('purchase', { amount: 49 });
      tracker.reset();

      expect(() => tracker.check('purchase', { amount: 49 })).not.toThrow();
    });
  });

  describe('BudgetExceededError', () => {
    it('should have correct name', () => {
      const err = new BudgetExceededError('tool', 10, 45, 50);
      expect(err.name).toBe('BudgetExceededError');
    });

    it('should have descriptive message', () => {
      const err = new BudgetExceededError('purchase', 10, 45, 50);
      expect(err.message).toContain('purchase');
      expect(err.message).toContain('10');
      expect(err.message).toContain('5.00');
      expect(err.message).toContain('50.00');
    });

    it('should be instanceof Error', () => {
      const err = new BudgetExceededError('tool', 1, 0, 0);
      expect(err).toBeInstanceOf(Error);
    });
  });
});
