import { Veto } from './veto.js';
import { ToolCallDeniedError } from '../core/interceptor.js';
import type { ValidationResult } from '../types/config.js';

export { Veto };
export type {
  VetoBrowserOptions,
  GuardResult,
  GuardContext,
} from './types.js';
export type {
  Rule,
  OutputRule,
  RuleCondition,
  RuleSeverity,
  RuleAction,
} from '../rules/types.js';
export type { OutputValidationResult } from '../core/output-validator.js';
export { ToolCallDeniedError } from '../core/interceptor.js';
export { OutputValidator } from '../core/output-validator.js';
export { validateDeterministic } from '../deterministic/validator.js';
export { evaluateConditionCollections } from '../rules/condition-evaluator.js';

function toDeniedValidationResult(
  result: Awaited<ReturnType<Veto['guard']>>
): ValidationResult {
  const decision: ValidationResult['decision'] = result.decision === 'require_approval'
    ? 'require_approval'
    : 'deny';

  return {
    decision,
    reason: result.reason,
    metadata: {
      ruleId: result.ruleId,
      severity: result.severity,
      approvalId: result.approvalId,
    },
  };
}

export function wrapAction<T>(
  veto: Veto,
  toolName: string,
  handler: (args: Record<string, unknown>) => T | Promise<T>
): (args: Record<string, unknown>) => Promise<T> {
  return async (args) => {
    const result = await veto.guard(toolName, args);
    if (result.decision === 'deny' || result.decision === 'require_approval') {
      throw new ToolCallDeniedError(toolName, 'guard', toDeniedValidationResult(result));
    }
    return await handler(args);
  };
}

export function wrapActions(
  veto: Veto,
  actions: Record<string, (args: Record<string, unknown>) => unknown>
): Record<string, (args: Record<string, unknown>) => Promise<unknown>> {
  const wrapped: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {};

  for (const [name, handler] of Object.entries(actions)) {
    wrapped[name] = wrapAction(
      veto,
      name,
      async (args) => await handler(args)
    );
  }

  return wrapped;
}
