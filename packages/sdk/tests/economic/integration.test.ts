import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EconomicEvaluator } from '../../src/economic/evaluator.js';
import { LocalBudgetEngine } from '../../src/economic/budget-engine.js';
import { createX402Connector } from '../../src/economic/connectors/x402.js';
import { createMPPConnector } from '../../src/economic/connectors/mpp.js';
import { createAP2Connector } from '../../src/economic/connectors/ap2.js';
import type { EconomicContext, EconomicPolicyConfig } from '../../src/economic/types.js';
import { VALID_402_USDC_BASE, VALID_402_EXPENSIVE } from '../fixtures/economic/x402-responses.js';
import { VALID_MPP_SESSION, MPP_EXPENSIVE } from '../fixtures/economic/mpp-responses.js';
import { VALID_AP2_MANDATE } from '../fixtures/economic/ap2-responses.js';

const createMockLogger = () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

describe('Economic Integration', () => {
  const policy: EconomicPolicyConfig = {
    budgets: [{
      scope: 'session',
      limit: 50,
      currency: 'USD',
      approval_threshold: 20,
      window: 'session',
    }],
    cost_extraction: {
      default: 'arguments.cost',
    },
    payer: {
      required: true,
      approved: ['wallet_0x123', 'cus_stripe_123', 'user@example.com'],
    },
  };

  let evaluator: EconomicEvaluator;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    logger = createMockLogger();
    const budgetEngine = new LocalBudgetEngine({
      budgets: policy.budgets!,
      logger,
    });
    evaluator = new EconomicEvaluator({
      policy,
      budgetEngine,
      logger,
    });
  });

  describe('end-to-end: connector → evaluator flow', () => {
    it('x402: extract → evaluate → allow cheap action', () => {
      const connector = createX402Connector();
      const ctx = connector.extract(VALID_402_USDC_BASE);
      expect(ctx).not.toBeNull();

      // Add approved payer (x402 doesn't set payer — caller provides it)
      const withPayer: EconomicContext = { ...ctx!, payer: 'wallet_0x123' };
      const result = evaluator.evaluate(withPayer);
      expect(result.decision).toBe('allow');
    });

    it('x402: extract → evaluate → require_approval for expensive action', () => {
      const connector = createX402Connector();
      const ctx = connector.extract(VALID_402_EXPENSIVE);
      expect(ctx).not.toBeNull();
      expect(ctx!.cost).toBe(75);

      const withPayer: EconomicContext = { ...ctx!, payer: 'wallet_0x123' };
      const result = evaluator.evaluate(withPayer);
      // 75 > 50 limit, so deny (not just approval threshold)
      expect(result.decision).toBe('deny');
      expect(result.denial?.reason).toBe('budget_exceeded');
    });

    it('mpp: extract → evaluate → allow with valid session', () => {
      const connector = createMPPConnector();
      const ctx = connector.extract(VALID_MPP_SESSION);
      expect(ctx).not.toBeNull();
      expect(ctx!.payer).toBe('cus_stripe_123');

      const result = evaluator.evaluate(ctx!);
      expect(result.decision).toBe('allow');
    });

    it('ap2: extract → evaluate → allow with valid mandate', () => {
      const connector = createAP2Connector();
      const ctx = connector.extract(VALID_AP2_MANDATE);
      expect(ctx).not.toBeNull();
      expect(ctx!.payer).toBe('user@example.com');

      const result = evaluator.evaluate(ctx!);
      expect(result.decision).toBe('allow');
    });
  });

  describe('budget accumulation across multiple calls', () => {
    it('should track spend across 5 calls and deny on the 6th', () => {
      // Each call costs $10 against $50 budget
      for (let i = 0; i < 5; i++) {
        const ctx: EconomicContext = {
          cost: 10,
          currency: 'USD',
          payer: 'wallet_0x123',
          protocol: 'x402',
        };
        const checkResult = evaluator.evaluate(ctx);
        expect(checkResult.decision).toBe('allow');
        // Reserve the budget
        const reserveResult = evaluator.reserveBudget(10, 'USD');
        expect(reserveResult.decision).toBe('allow');
      }

      // 6th call should be denied (50 spent, 0 remaining)
      const ctx: EconomicContext = {
        cost: 10,
        currency: 'USD',
        payer: 'wallet_0x123',
        protocol: 'x402',
      };
      const result = evaluator.evaluate(ctx);
      expect(result.decision).toBe('deny');
      expect(result.denial?.reason).toBe('budget_exceeded');
    });

    it('should deny 5th $10 call when only $9 remaining', () => {
      // Spend $41
      evaluator.reserveBudget(20, 'USD');
      evaluator.reserveBudget(20, 'USD');
      evaluator.reserveBudget(1, 'USD');

      const ctx: EconomicContext = {
        cost: 10,
        currency: 'USD',
        payer: 'wallet_0x123',
        protocol: 'x402',
      };
      const result = evaluator.evaluate(ctx);
      expect(result.decision).toBe('deny');
      expect(result.denial?.reason).toBe('budget_exceeded');
      expect(result.denial?.budget_remaining).toBe(9);
    });
  });

  describe('mixed protocol calls in same session', () => {
    it('should track budget across x402 and mpp calls together', () => {
      const x402Connector = createX402Connector();
      const mppConnector = createMPPConnector();

      // x402 call: $0.01
      const x402Ctx = x402Connector.extract(VALID_402_USDC_BASE)!;
      const x402WithPayer: EconomicContext = { ...x402Ctx, payer: 'wallet_0x123' };
      expect(evaluator.evaluate(x402WithPayer).decision).toBe('allow');
      evaluator.reserveBudget(x402Ctx.cost, x402Ctx.currency);

      // MPP call: $2.50
      const mppCtx = mppConnector.extract(VALID_MPP_SESSION)!;
      expect(evaluator.evaluate(mppCtx).decision).toBe('allow');
      evaluator.reserveBudget(mppCtx.cost, mppCtx.currency);

      // Total spent: $2.51 out of $50 — still plenty of budget
      const checkCtx: EconomicContext = {
        cost: 47,
        currency: 'USD',
        payer: 'wallet_0x123',
        protocol: 'custom',
      };
      const result = evaluator.evaluate(checkCtx);
      // 47 > 20 threshold → require_approval (but within budget)
      expect(result.decision).toBe('require_approval');
    });

    it('should deny when mpp exhausts budget started by x402', () => {
      // x402: spend $15
      evaluator.reserveBudget(15, 'USD');
      // x402: spend $15
      evaluator.reserveBudget(15, 'USD');
      // mpp: try to spend $40 (only $20 remaining)
      const mppConnector = createMPPConnector();
      const mppCtx = mppConnector.extract(MPP_EXPENSIVE)!;
      // MPP_EXPENSIVE has payer 'cus_stripe_big' which is NOT in approved list
      // Override payer for this test
      const withApprovedPayer: EconomicContext = { ...mppCtx, payer: 'cus_stripe_123' };
      const result = evaluator.evaluate(withApprovedPayer);
      expect(result.decision).toBe('deny');
      expect(result.denial?.reason).toBe('budget_exceeded');
    });
  });

  describe('backward compatibility', () => {
    it('evaluator without payer config allows any payer', () => {
      const noPayer = new EconomicEvaluator({
        policy: {
          budgets: [{
            scope: 'session',
            limit: 100,
            currency: 'USD',
            window: 'session',
          }],
        },
        budgetEngine: new LocalBudgetEngine({
          budgets: [{ scope: 'session', limit: 100, currency: 'USD', window: 'session' }],
          logger,
        }),
        logger,
      });

      const ctx: EconomicContext = {
        cost: 10,
        currency: 'USD',
        protocol: 'x402',
        // No payer — should be fine
      };
      expect(noPayer.evaluate(ctx).decision).toBe('allow');
    });

    it('evaluator without cost_extraction skips implicit cost resolution', () => {
      const noCostExtraction = new EconomicEvaluator({
        policy: {
          budgets: [{
            scope: 'session',
            limit: 100,
            currency: 'USD',
            window: 'session',
          }],
        },
        budgetEngine: new LocalBudgetEngine({
          budgets: [{ scope: 'session', limit: 100, currency: 'USD', window: 'session' }],
          logger,
        }),
        logger,
      });

      const cost = noCostExtraction.resolveCost('some_tool', { cost: 25 });
      expect(cost).toBeUndefined();
    });
  });

  describe('denial details completeness', () => {
    it('payer_missing denial includes budget state', () => {
      const ctx: EconomicContext = {
        cost: 10,
        currency: 'USD',
        protocol: 'x402',
        // No payer
      };
      const result = evaluator.evaluate(ctx);
      expect(result.decision).toBe('deny');
      expect(result.denial).toBeDefined();
      expect(result.denial!.reason).toBe('payer_missing');
      expect(result.denial!.budget_limit).toBe(50);
      expect(result.denial!.budget_spent).toBe(0);
      expect(result.denial!.budget_remaining).toBe(50);
      expect(result.denial!.protocol).toBe('x402');
    });

    it('payer_unauthorized denial includes payer and protocol', () => {
      const ctx: EconomicContext = {
        cost: 10,
        currency: 'USD',
        payer: 'evil_wallet',
        protocol: 'mpp',
      };
      const result = evaluator.evaluate(ctx);
      expect(result.decision).toBe('deny');
      expect(result.denial!.reason).toBe('payer_unauthorized');
      expect(result.denial!.payer).toBe('evil_wallet');
      expect(result.denial!.protocol).toBe('mpp');
      expect(result.denial!.budget_limit).toBe(50);
    });

    it('budget_exceeded denial includes accurate spend state', () => {
      evaluator.reserveBudget(20, 'USD');
      evaluator.reserveBudget(20, 'USD');

      const ctx: EconomicContext = {
        cost: 15,
        currency: 'USD',
        payer: 'wallet_0x123',
        protocol: 'x402',
      };
      const result = evaluator.evaluate(ctx);
      expect(result.decision).toBe('deny');
      expect(result.denial!.reason).toBe('budget_exceeded');
      expect(result.denial!.budget_spent).toBe(40);
      expect(result.denial!.budget_remaining).toBe(10);
      expect(result.denial!.budget_limit).toBe(50);
      expect(result.denial!.cost).toBe(15);
    });

    it('currency_mismatch denial includes context', () => {
      const ctx: EconomicContext = {
        cost: 10,
        currency: 'EUR',
        payer: 'wallet_0x123',
        protocol: 'ap2',
      };
      const result = evaluator.evaluate(ctx);
      expect(result.decision).toBe('deny');
      expect(result.denial!.reason).toBe('currency_mismatch');
      expect(result.denial!.currency).toBe('EUR');
    });
  });

  describe('refund and recovery', () => {
    it('refund allows previously-blocked calls', () => {
      // Exhaust budget
      evaluator.reserveBudget(20, 'USD');
      evaluator.reserveBudget(20, 'USD');
      evaluator.reserveBudget(10, 'USD');

      // Budget exhausted — deny
      const ctx: EconomicContext = {
        cost: 5,
        currency: 'USD',
        payer: 'wallet_0x123',
        protocol: 'x402',
      };
      expect(evaluator.evaluate(ctx).decision).toBe('deny');

      // Refund $20
      evaluator.refundBudget(20);

      // Now allow
      expect(evaluator.evaluate(ctx).decision).toBe('allow');
    });
  });
});
