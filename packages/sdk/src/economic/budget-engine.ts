/**
 * Local budget engine — in-memory, session scope only.
 *
 * Implements the BudgetEngine interface for standalone SDK mode.
 * Only materializes 'session' scope; agent/user/global require
 * CloudBudgetEngine (platform).
 *
 * @module economic/budget-engine
 */

import type {
  BudgetEngine,
  BudgetCheckResult,
  BudgetScope,
  EconomicBudgetConfig,
  EconomicBudgetStatus,
  EconomicDenialDetails,
} from './types.js';
import type { Logger } from '../utils/logger.js';

interface BudgetState {
  spent: number;
  limit: number;
  currency: string;
  approval_threshold?: number;
}

export interface LocalBudgetEngineOptions {
  budgets: EconomicBudgetConfig[];
  logger: Logger;
}

export class LocalBudgetEngine implements BudgetEngine {
  private readonly state: Map<BudgetScope, BudgetState> = new Map();
  private readonly logger: Logger;

  constructor(options: LocalBudgetEngineOptions) {
    this.logger = options.logger;

    for (const budget of options.budgets) {
      if (budget.window !== 'session') {
        this.logger.warn(
          'LocalBudgetEngine only supports session scope — ' +
          `ignoring ${budget.scope} budget with window '${budget.window}'. ` +
          'Use Veto Cloud for agent/user/global scopes.',
          { scope: budget.scope, window: budget.window }
        );
        continue;
      }

      this.state.set(budget.scope, {
        spent: 0,
        limit: budget.limit,
        currency: budget.currency,
        approval_threshold: budget.approval_threshold,
      });
    }
  }

  check(cost: number, currency: string, scope: BudgetScope): BudgetCheckResult {
    const safeCost = this.sanitizeCost(cost);
    const budget = this.state.get(scope);

    if (!budget) {
      // No budget configured for this scope — allow by default
      return { allowed: true, decision: 'allow' };
    }

    // Currency mismatch check
    if (currency.toUpperCase() !== budget.currency.toUpperCase()) {
      return {
        allowed: false,
        decision: 'deny',
        denial: this.buildDenial('currency_mismatch', safeCost, currency, budget, scope),
      };
    }

    const remaining = budget.limit - budget.spent;

    // Budget exceeded
    if (safeCost > remaining) {
      this.logger.warn('Budget would be exceeded', {
        scope, cost: safeCost, spent: budget.spent, limit: budget.limit,
      });
      return {
        allowed: false,
        decision: 'deny',
        denial: this.buildDenial('budget_exceeded', safeCost, currency, budget, scope),
      };
    }

    // Approval threshold
    if (budget.approval_threshold !== undefined && safeCost > budget.approval_threshold) {
      this.logger.info('Cost exceeds approval threshold', {
        scope, cost: safeCost, threshold: budget.approval_threshold,
      });
      return {
        allowed: false,
        decision: 'require_approval',
        denial: this.buildDenial('approval_required', safeCost, currency, budget, scope),
      };
    }

    return { allowed: true, decision: 'allow' };
  }

  reserve(cost: number, currency: string, scope: BudgetScope): BudgetCheckResult {
    const result = this.check(cost, currency, scope);
    if (!result.allowed) return result;

    const safeCost = this.sanitizeCost(cost);
    const budget = this.state.get(scope);
    if (budget && safeCost > 0) {
      budget.spent += safeCost;
      this.logger.debug('Budget reserved', {
        scope, cost: safeCost, totalSpent: budget.spent,
        remaining: budget.limit - budget.spent,
      });
    }

    return result;
  }

  record(cost: number, _currency: string, scope: BudgetScope): void {
    const safeCost = this.sanitizeCost(cost);
    const budget = this.state.get(scope);
    if (budget && safeCost > 0) {
      budget.spent += safeCost;
      this.logger.debug('Budget charge recorded', {
        scope, cost: safeCost, totalSpent: budget.spent,
        remaining: budget.limit - budget.spent,
      });
    }
  }

  refund(amount: number, scope: BudgetScope): void {
    if (amount <= 0) return;
    const budget = this.state.get(scope);
    if (budget) {
      budget.spent = Math.max(0, budget.spent - amount);
      this.logger.debug('Budget refunded', {
        scope, amount, totalSpent: budget.spent,
        remaining: budget.limit - budget.spent,
      });
    }
  }

  getStatus(scope: BudgetScope): EconomicBudgetStatus | null {
    const budget = this.state.get(scope);
    if (!budget) return null;
    return {
      scope,
      spent: budget.spent,
      limit: budget.limit,
      remaining: Math.max(0, budget.limit - budget.spent),
      currency: budget.currency,
    };
  }

  reset(scope: BudgetScope): void {
    const budget = this.state.get(scope);
    if (budget) {
      const previous = budget.spent;
      budget.spent = 0;
      this.logger.debug('Budget reset', { scope, previousSpent: previous });
    }
  }

  private sanitizeCost(cost: number): number {
    if (!Number.isFinite(cost) || cost < 0) return 0;
    return cost;
  }

  private buildDenial(
    reason: EconomicDenialDetails['reason'],
    cost: number,
    currency: string,
    budget: BudgetState,
    scope: BudgetScope,
  ): EconomicDenialDetails {
    return {
      reason,
      cost,
      currency,
      budget_scope: scope,
      budget_limit: budget.limit,
      budget_spent: budget.spent,
      budget_remaining: Math.max(0, budget.limit - budget.spent),
      approval_threshold: budget.approval_threshold,
    };
  }
}
