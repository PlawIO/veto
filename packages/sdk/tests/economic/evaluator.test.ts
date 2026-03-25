import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EconomicEvaluator } from '../../src/economic/evaluator.js';
import { LocalBudgetEngine } from '../../src/economic/budget-engine.js';
import type { EconomicContext, EconomicPolicyConfig, BudgetScope } from '../../src/economic/types.js';

const createMockLogger = () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

describe('EconomicEvaluator', () => {
  let evaluator: EconomicEvaluator;
  let logger: ReturnType<typeof createMockLogger>;

  const defaultPolicy: EconomicPolicyConfig = {
    budgets: [{
      scope: 'session',
      limit: 100,
      currency: 'USD',
      approval_threshold: 50,
      window: 'session',
    }],
    cost_extraction: {
      default: 'arguments.cost',
      overrides: {
        search_api: 'arguments.price_usd',
      },
    },
    payer: {
      required: true,
      approved: ['wallet_0x123', 'cus_stripe_456'],
    },
  };

  beforeEach(() => {
    logger = createMockLogger();
    const budgetEngine = new LocalBudgetEngine({
      budgets: defaultPolicy.budgets!,
      logger,
    });
    evaluator = new EconomicEvaluator({
      policy: defaultPolicy,
      budgetEngine,
      logger,
    });
  });

  describe('evaluate', () => {
    it('should allow valid economic context within budget', () => {
      const ctx: EconomicContext = {
        cost: 10,
        currency: 'USD',
        payer: 'wallet_0x123',
        protocol: 'x402',
      };
      const result = evaluator.evaluate(ctx);
      expect(result.decision).toBe('allow');
    });

    it('should deny when payer is missing and required', () => {
      const ctx: EconomicContext = {
        cost: 10,
        currency: 'USD',
        protocol: 'x402',
      };
      const result = evaluator.evaluate(ctx);
      expect(result.decision).toBe('deny');
      expect(result.denial?.reason).toBe('payer_missing');
    });

    it('should deny when payer is not in approved list', () => {
      const ctx: EconomicContext = {
        cost: 10,
        currency: 'USD',
        payer: 'unknown_wallet',
        protocol: 'x402',
      };
      const result = evaluator.evaluate(ctx);
      expect(result.decision).toBe('deny');
      expect(result.denial?.reason).toBe('payer_unauthorized');
    });

    it('should deny when cost exceeds budget', () => {
      const ctx: EconomicContext = {
        cost: 150,
        currency: 'USD',
        payer: 'wallet_0x123',
        protocol: 'x402',
      };
      const result = evaluator.evaluate(ctx);
      expect(result.decision).toBe('deny');
      expect(result.denial?.reason).toBe('budget_exceeded');
    });

    it('should require approval above threshold', () => {
      const ctx: EconomicContext = {
        cost: 60,
        currency: 'USD',
        payer: 'wallet_0x123',
        protocol: 'x402',
      };
      const result = evaluator.evaluate(ctx);
      expect(result.decision).toBe('require_approval');
      expect(result.denial?.reason).toBe('approval_required');
    });

    it('should include approval_threshold in denial details', () => {
      const ctx: EconomicContext = {
        cost: 60,
        currency: 'USD',
        payer: 'wallet_0x123',
        protocol: 'x402',
      };
      const result = evaluator.evaluate(ctx);
      expect(result.denial?.approval_threshold).toBe(50);
    });

    it('should deny on currency mismatch', () => {
      const ctx: EconomicContext = {
        cost: 10,
        currency: 'EUR',
        payer: 'wallet_0x123',
        protocol: 'mpp',
      };
      const result = evaluator.evaluate(ctx);
      expect(result.decision).toBe('deny');
      expect(result.denial?.reason).toBe('currency_mismatch');
    });

    it('should allow zero cost with valid payer', () => {
      const ctx: EconomicContext = {
        cost: 0,
        currency: 'USD',
        payer: 'wallet_0x123',
        protocol: 'ap2',
      };
      const result = evaluator.evaluate(ctx);
      expect(result.decision).toBe('allow');
    });
  });

  describe('resolveCost', () => {
    it('should resolve cost from default path', () => {
      const cost = evaluator.resolveCost('some_tool', { cost: 25 });
      expect(cost).toBe(25);
    });

    it('should resolve cost from per-tool override', () => {
      const cost = evaluator.resolveCost('search_api', { price_usd: 0.05 });
      expect(cost).toBe(0.05);
    });

    it('should return undefined for missing cost', () => {
      const cost = evaluator.resolveCost('some_tool', {});
      expect(cost).toBeUndefined();
    });

    it('should return undefined for non-numeric cost', () => {
      const cost = evaluator.resolveCost('some_tool', { cost: 'expensive' });
      expect(cost).toBeUndefined();
    });

    it('should return undefined for negative cost', () => {
      const cost = evaluator.resolveCost('some_tool', { cost: -10 });
      expect(cost).toBeUndefined();
    });
  });

  describe('reserveBudget', () => {
    it('should reserve and track spending', () => {
      const result = evaluator.reserveBudget(20, 'USD');
      expect(result.decision).toBe('allow');
    });

    it('should deny when budget exhausted', () => {
      evaluator.reserveBudget(40, 'USD');
      evaluator.reserveBudget(40, 'USD');
      const result = evaluator.reserveBudget(30, 'USD');
      expect(result.decision).toBe('deny');
    });
  });

  describe('refundBudget', () => {
    it('should restore budget capacity', () => {
      evaluator.reserveBudget(40, 'USD');
      evaluator.refundBudget(20);
      // Budget: 100 limit, 20 spent after refund, 80 remaining
      const ctx: EconomicContext = {
        cost: 75,
        currency: 'USD',
        payer: 'wallet_0x123',
        protocol: 'x402',
      };
      // 75 > 50 threshold, so require_approval — but within budget
      const result = evaluator.evaluate(ctx);
      expect(result.decision).toBe('require_approval');
    });
  });

  describe('renderDenialMessage', () => {
    it('should render budget_exceeded template with context variables', () => {
      const withTemplates = new EconomicEvaluator({
        policy: {
          ...defaultPolicy,
          denial_reasons: {
            budget_exceeded: 'Would exceed {scope} budget ({spent}/{limit} {currency})',
          },
        },
        budgetEngine: new LocalBudgetEngine({
          budgets: defaultPolicy.budgets!,
          logger,
        }),
        logger,
      });

      const message = withTemplates.renderDenialMessage({
        reason: 'budget_exceeded',
        cost: 50,
        currency: 'USD',
        budget_scope: 'session',
        budget_limit: 100,
        budget_spent: 80,
        budget_remaining: 20,
      });
      expect(message).toBe('Would exceed session budget (80/100 USD)');
    });

    it('should render payer_missing template', () => {
      const withTemplates = new EconomicEvaluator({
        policy: {
          ...defaultPolicy,
          denial_reasons: {
            payer_missing: 'No payer identified for {cost} {currency} charge',
          },
        },
        budgetEngine: new LocalBudgetEngine({
          budgets: defaultPolicy.budgets!,
          logger,
        }),
        logger,
      });

      const message = withTemplates.renderDenialMessage({
        reason: 'payer_missing',
        cost: 25,
        currency: 'EUR',
        budget_scope: 'session',
        budget_limit: 100,
        budget_spent: 0,
        budget_remaining: 100,
      });
      expect(message).toBe('No payer identified for 25 EUR charge');
    });

    it('should return undefined when no templates configured', () => {
      const message = evaluator.renderDenialMessage({
        reason: 'budget_exceeded',
        cost: 50,
        currency: 'USD',
        budget_scope: 'session',
        budget_limit: 100,
        budget_spent: 80,
        budget_remaining: 20,
      });
      expect(message).toBeUndefined();
    });

    it('should return undefined when reason has no matching template', () => {
      const withTemplates = new EconomicEvaluator({
        policy: {
          ...defaultPolicy,
          denial_reasons: {
            budget_exceeded: 'Over budget',
          },
        },
        budgetEngine: new LocalBudgetEngine({
          budgets: defaultPolicy.budgets!,
          logger,
        }),
        logger,
      });

      const message = withTemplates.renderDenialMessage({
        reason: 'payer_missing',
        cost: 10,
        currency: 'USD',
        budget_scope: 'session',
        budget_limit: 100,
        budget_spent: 0,
        budget_remaining: 100,
      });
      expect(message).toBeUndefined();
    });

    it('should render {threshold} with approval_threshold, not budget_limit', () => {
      const withTemplates = new EconomicEvaluator({
        policy: {
          ...defaultPolicy,
          denial_reasons: {
            approval_required: 'Cost {cost} exceeds threshold {threshold} (limit is {limit})',
          },
        },
        budgetEngine: new LocalBudgetEngine({
          budgets: defaultPolicy.budgets!,
          logger,
        }),
        logger,
      });

      const message = withTemplates.renderDenialMessage({
        reason: 'approval_required',
        cost: 60,
        currency: 'USD',
        budget_scope: 'session',
        budget_limit: 100,
        budget_spent: 0,
        budget_remaining: 100,
        approval_threshold: 50,
      });
      // {threshold} should be 50 (approval_threshold), NOT 100 (budget_limit)
      expect(message).toBe('Cost 60 exceeds threshold 50 (limit is 100)');
    });

    it('should fallback {threshold} to budget_limit when approval_threshold is absent', () => {
      const withTemplates = new EconomicEvaluator({
        policy: {
          ...defaultPolicy,
          denial_reasons: {
            budget_exceeded: 'Threshold: {threshold}',
          },
        },
        budgetEngine: new LocalBudgetEngine({
          budgets: defaultPolicy.budgets!,
          logger,
        }),
        logger,
      });

      const message = withTemplates.renderDenialMessage({
        reason: 'budget_exceeded',
        cost: 150,
        currency: 'USD',
        budget_scope: 'session',
        budget_limit: 100,
        budget_spent: 0,
        budget_remaining: 100,
      });
      expect(message).toBe('Threshold: 100');
    });
  });

  describe('evaluate with denial templates', () => {
    it('should attach message to denial when templates exist', () => {
      const withTemplates = new EconomicEvaluator({
        policy: {
          ...defaultPolicy,
          denial_reasons: {
            budget_exceeded: 'Cost {cost} exceeds {scope} budget ({spent}/{limit} {currency})',
            payer_missing: 'Payer required but not provided',
          },
        },
        budgetEngine: new LocalBudgetEngine({
          budgets: defaultPolicy.budgets!,
          logger,
        }),
        logger,
      });

      const ctx: EconomicContext = {
        cost: 150,
        currency: 'USD',
        payer: 'wallet_0x123',
        protocol: 'x402',
      };
      const result = withTemplates.evaluate(ctx);
      expect(result.decision).toBe('deny');
      expect(result.denial?.reason).toBe('budget_exceeded');
      expect(result.denial?.message).toContain('Cost 150 exceeds session budget');
    });

    it('should attach message to payer_missing denial when templates exist', () => {
      const withTemplates = new EconomicEvaluator({
        policy: {
          ...defaultPolicy,
          denial_reasons: {
            payer_missing: 'No payer for {cost} {currency}',
          },
        },
        budgetEngine: new LocalBudgetEngine({
          budgets: defaultPolicy.budgets!,
          logger,
        }),
        logger,
      });

      const ctx: EconomicContext = {
        cost: 10,
        currency: 'USD',
        protocol: 'x402',
      };
      const result = withTemplates.evaluate(ctx);
      expect(result.decision).toBe('deny');
      expect(result.denial?.reason).toBe('payer_missing');
      expect(result.denial?.message).toBe('No payer for 10 USD');
    });

    it('should have no message on denial when no templates configured', () => {
      const ctx: EconomicContext = {
        cost: 150,
        currency: 'USD',
        payer: 'wallet_0x123',
        protocol: 'x402',
      };
      const result = evaluator.evaluate(ctx);
      expect(result.decision).toBe('deny');
      expect(result.denial?.message).toBeUndefined();
    });
  });

  describe('without payer config', () => {
    it('should allow when no payer policy configured', () => {
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
        protocol: 'custom',
        // No payer — should be fine since payer policy is not set
      };
      expect(noPayer.evaluate(ctx).decision).toBe('allow');
    });
  });

  describe('NaN/invalid cost rejection', () => {
    it('should deny NaN cost', () => {
      const ctx: EconomicContext = {
        cost: NaN,
        currency: 'USD',
        payer: 'wallet_0x123',
        protocol: 'x402',
      };
      const result = evaluator.evaluate(ctx);
      expect(result.decision).toBe('deny');
      expect(result.denial?.message).toContain('Invalid cost');
    });

    it('should deny Infinity cost', () => {
      const ctx: EconomicContext = {
        cost: Infinity,
        currency: 'USD',
        payer: 'wallet_0x123',
        protocol: 'x402',
      };
      const result = evaluator.evaluate(ctx);
      expect(result.decision).toBe('deny');
      expect(result.denial?.message).toContain('Invalid cost');
    });

    it('should deny negative cost', () => {
      const ctx: EconomicContext = {
        cost: -5,
        currency: 'USD',
        payer: 'wallet_0x123',
        protocol: 'x402',
      };
      const result = evaluator.evaluate(ctx);
      expect(result.decision).toBe('deny');
      expect(result.denial?.message).toContain('Invalid cost');
    });

    it('should allow zero cost', () => {
      const ctx: EconomicContext = {
        cost: 0,
        currency: 'USD',
        payer: 'wallet_0x123',
        protocol: 'x402',
      };
      const result = evaluator.evaluate(ctx);
      expect(result.decision).toBe('allow');
    });
  });

  describe('multi-scope reserve rollback', () => {
    it('should rollback first scope when second scope fails', () => {
      const multiScopePolicy: EconomicPolicyConfig = {
        budgets: [
          { scope: 'session', limit: 100, currency: 'USD', window: 'session' },
          { scope: 'agent', limit: 20, currency: 'USD', window: 'session' },
        ],
      };
      const engine = new LocalBudgetEngine({
        budgets: multiScopePolicy.budgets!,
        logger,
      });
      const multiEval = new EconomicEvaluator({
        policy: multiScopePolicy,
        budgetEngine: engine,
        logger,
      });

      // $30 fits session (100) but not agent (20) — should deny and rollback session
      const result = multiEval.reserveBudget(30, 'USD');
      expect(result.decision).toBe('deny');

      // Session scope should be rolled back to 0 spent
      const sessionStatus = engine.getStatus('session');
      expect(sessionStatus!.spent).toBe(0);
      expect(sessionStatus!.remaining).toBe(100);
    });

    it('should keep all reservations when all scopes succeed', () => {
      const multiScopePolicy: EconomicPolicyConfig = {
        budgets: [
          { scope: 'session', limit: 100, currency: 'USD', window: 'session' },
          { scope: 'agent', limit: 50, currency: 'USD', window: 'session' },
        ],
      };
      const engine = new LocalBudgetEngine({
        budgets: multiScopePolicy.budgets!,
        logger,
      });
      const multiEval = new EconomicEvaluator({
        policy: multiScopePolicy,
        budgetEngine: engine,
        logger,
      });

      // $10 fits both scopes
      const result = multiEval.reserveBudget(10, 'USD');
      expect(result.decision).toBe('allow');

      expect(engine.getStatus('session')!.spent).toBe(10);
      expect(engine.getStatus('agent')!.spent).toBe(10);
    });
  });
});
