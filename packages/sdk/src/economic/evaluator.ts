/**
 * Economic policy evaluator.
 *
 * Evaluates economic authorization policies against an EconomicContext.
 * Runs payer checks, currency checks, and budget checks in order.
 * Returns a result that composes with the behavioral guard() flow.
 *
 *   EconomicContext (from connector)
 *        │
 *        ▼
 *   ┌─────────────────────────────────────┐
 *   │         Economic Evaluator           │
 *   │                                      │
 *   │  1. Payer check                      │
 *   │     ├── payer present? ──N──▶ deny   │
 *   │     └── payer in approved? ──N──▶ deny│
 *   │                                      │
 *   │  2. Currency check                   │
 *   │     └── matches budget? ──N──▶ deny  │
 *   │                                      │
 *   │  3. Budget check (BudgetEngine)      │
 *   │     ├── exceeded ──▶ deny            │
 *   │     ├── threshold ──▶ require_approval│
 *   │     └── within ──▶ allow             │
 *   └─────────────────────────────────────┘
 *
 * @module economic/evaluator
 */

import type {
  BudgetEngine,
  BudgetScope,
  DenialReasonTemplates,
  EconomicContext,
  EconomicDenialDetails,
  EconomicPolicyConfig,
  PayerConfig,
} from './types.js';
import type { Logger } from '../utils/logger.js';
import { resolveFieldPath } from '../rules/condition-evaluator.js';

/**
 * Result of economic evaluation.
 */
export interface EconomicEvaluationResult {
  decision: 'allow' | 'deny' | 'require_approval';
  denial?: EconomicDenialDetails;
}

export interface EconomicEvaluatorOptions {
  policy: EconomicPolicyConfig;
  budgetEngine: BudgetEngine;
  logger: Logger;
}

export class EconomicEvaluator {
  private readonly policy: EconomicPolicyConfig;
  private readonly budgetEngine: BudgetEngine;
  private readonly logger: Logger;

  constructor(options: EconomicEvaluatorOptions) {
    this.policy = options.policy;
    this.budgetEngine = options.budgetEngine;
    this.logger = options.logger;
  }

  /**
   * Evaluate economic policies against the given context.
   *
   * Checks run in order: cost validation → payer → currency → budget.
   * First failure short-circuits.
   */
  evaluate(economicContext: EconomicContext): EconomicEvaluationResult {
    // 0. Cost validation — reject non-finite/negative costs hard
    if (!Number.isFinite(economicContext.cost) || economicContext.cost < 0) {
      this.logger.warn('Economic context has invalid cost', {
        cost: economicContext.cost,
        protocol: economicContext.protocol,
      });
      const firstBudget = this.policy.budgets?.[0];
      const status = firstBudget
        ? this.budgetEngine.getStatus(firstBudget.scope)
        : null;
      return {
        decision: 'deny',
        denial: {
          reason: 'budget_exceeded',
          cost: economicContext.cost,
          currency: economicContext.currency,
          budget_scope: firstBudget?.scope ?? 'session',
          budget_limit: status?.limit ?? 0,
          budget_spent: status?.spent ?? 0,
          budget_remaining: status?.remaining ?? 0,
          protocol: economicContext.protocol,
          message: 'Invalid cost: must be a finite non-negative number',
        },
      };
    }

    // 1. Payer check
    if (this.policy.payer) {
      const payerResult = this.checkPayer(economicContext, this.policy.payer);
      if (payerResult) return payerResult;
    }

    // 2. Budget checks (one per configured budget scope)
    const budgets = this.policy.budgets ?? [];
    for (const budgetConfig of budgets) {
      const result = this.budgetEngine.check(
        economicContext.cost,
        economicContext.currency,
        budgetConfig.scope,
      );

      if (!result.allowed) {
        this.logger.warn('Economic budget check failed', {
          scope: budgetConfig.scope,
          decision: result.decision,
          cost: economicContext.cost,
          reason: result.denial?.reason,
        });

        const denial = result.denial;
        if (denial) {
          const message = this.renderDenialMessage(denial);
          if (message) denial.message = message;
        }

        return {
          decision: result.decision,
          denial,
        };
      }
    }

    return { decision: 'allow' };
  }

  /**
   * Resolve cost from tool call arguments using cost_extraction config.
   *
   * Reuses resolveFieldPath from the condition evaluator (DRY).
   */
  resolveCost(
    toolName: string,
    args: Record<string, unknown>,
  ): number | undefined {
    const extraction = this.policy.cost_extraction;
    if (!extraction) return undefined;

    // Per-tool override or default path
    const path = extraction.overrides?.[toolName] ?? extraction.default;
    if (!path) return undefined;

    // Use the condition evaluator's field resolver
    const value = resolveFieldPath(path, { arguments: args });
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      return value;
    }

    return undefined;
  }

  /**
   * Reserve budget for a cost (atomic check + deduct).
   * Rolls back previously reserved scopes if a later scope fails.
   */
  reserveBudget(cost: number, currency: string): EconomicEvaluationResult {
    const budgets = this.policy.budgets ?? [];
    const reservedScopes: BudgetScope[] = [];

    for (const budgetConfig of budgets) {
      const result = this.budgetEngine.reserve(cost, currency, budgetConfig.scope);
      if (!result.allowed) {
        // Rollback all previously reserved scopes
        for (const scope of reservedScopes) {
          this.budgetEngine.refund(cost, scope);
        }
        return { decision: result.decision, denial: result.denial };
      }
      reservedScopes.push(budgetConfig.scope);
    }
    return { decision: 'allow' };
  }

  /**
   * Refund budget across all configured scopes.
   */
  refundBudget(amount: number): void {
    const budgets = this.policy.budgets ?? [];
    for (const budgetConfig of budgets) {
      this.budgetEngine.refund(amount, budgetConfig.scope);
    }
  }

  /**
   * Render a denial message template with context variables.
   * Templates use {variable} syntax: "Would exceed {scope} budget ({spent}/{limit} {currency})"
   */
  renderDenialMessage(denial: EconomicDenialDetails): string | undefined {
    const templates = this.policy.denial_reasons;
    if (!templates) return undefined;

    const template = templates[denial.reason as keyof DenialReasonTemplates];
    if (!template) return undefined;

    return template
      .replace(/\{cost\}/g, String(denial.cost))
      .replace(/\{currency\}/g, denial.currency)
      .replace(/\{scope\}/g, denial.budget_scope)
      .replace(/\{limit\}/g, String(denial.budget_limit))
      .replace(/\{spent\}/g, String(denial.budget_spent))
      .replace(/\{remaining\}/g, String(denial.budget_remaining))
      .replace(/\{payer\}/g, denial.payer ?? 'unknown')
      .replace(/\{threshold\}/g, String(denial.approval_threshold ?? denial.budget_limit));
  }

  private checkPayer(
    context: EconomicContext,
    payerConfig: PayerConfig,
  ): EconomicEvaluationResult | null {
    // Payer required but missing
    if (payerConfig.required && !context.payer) {
      this.logger.warn('Payer required but missing', {
        protocol: context.protocol,
      });
      // Use first budget's state for denial details, or zeros if no budgets
      const firstBudget = this.policy.budgets?.[0];
      const status = firstBudget
        ? this.budgetEngine.getStatus(firstBudget.scope)
        : null;
      const payerMissingDenial: EconomicDenialDetails = {
        reason: 'payer_missing',
        cost: context.cost,
        currency: context.currency,
        budget_scope: firstBudget?.scope ?? 'session',
        budget_limit: status?.limit ?? 0,
        budget_spent: status?.spent ?? 0,
        budget_remaining: status?.remaining ?? 0,
        payer: undefined,
        protocol: context.protocol,
      };
      const payerMissingMsg = this.renderDenialMessage(payerMissingDenial);
      if (payerMissingMsg) payerMissingDenial.message = payerMissingMsg;
      return { decision: 'deny', denial: payerMissingDenial };
    }

    // Payer not in approved list
    if (
      payerConfig.approved
      && payerConfig.approved.length > 0
      && context.payer
      && !payerConfig.approved.includes(context.payer)
    ) {
      this.logger.warn('Payer not in approved list', {
        payer: context.payer,
        protocol: context.protocol,
      });
      const firstBudget = this.policy.budgets?.[0];
      const status = firstBudget
        ? this.budgetEngine.getStatus(firstBudget.scope)
        : null;
      const payerUnauthorizedDenial: EconomicDenialDetails = {
        reason: 'payer_unauthorized',
        cost: context.cost,
        currency: context.currency,
        budget_scope: firstBudget?.scope ?? 'session',
        budget_limit: status?.limit ?? 0,
        budget_spent: status?.spent ?? 0,
        budget_remaining: status?.remaining ?? 0,
        payer: context.payer,
        protocol: context.protocol,
      };
      const payerUnauthorizedMsg = this.renderDenialMessage(payerUnauthorizedDenial);
      if (payerUnauthorizedMsg) payerUnauthorizedDenial.message = payerUnauthorizedMsg;
      return { decision: 'deny', denial: payerUnauthorizedDenial };
    }

    return null; // Payer OK
  }
}
