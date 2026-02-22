import { isSafePattern } from '../deterministic/regex-safety.js';
import type { ConditionOperator, RuleCondition } from './types.js';

export interface ConditionEvaluationOptions {
  evaluateExpression?: (expression: string, context: Record<string, unknown>) => boolean;
}

/**
 * Resolve a dot-notation field path from an evaluation context.
 */
export function resolveFieldPath(
  field: string,
  context: Record<string, unknown>
): unknown {
  const parts = field.split('.');
  let current: unknown = context;

  for (const part of parts) {
    if (current === null || current === undefined) {
      return undefined;
    }
    if (typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

/**
 * Compile a regex pattern only if it passes safety checks.
 */
export function createSafeRegex(
  pattern: string,
  flags?: string
): RegExp | null {
  if (pattern.length > 256 || !isSafePattern(pattern)) {
    return null;
  }

  try {
    return new RegExp(pattern, flags);
  } catch {
    return null;
  }
}

/**
 * Evaluate a single legacy field/operator/value condition.
 */
export function evaluateLegacyCondition(
  fieldValue: unknown,
  operator: ConditionOperator,
  expected: unknown
): boolean {
  switch (operator) {
    case 'equals':
      return fieldValue === expected;
    case 'not_equals':
      return fieldValue !== expected;
    case 'contains':
      if (typeof fieldValue === 'string' && typeof expected === 'string') {
        return fieldValue.includes(expected);
      }
      if (Array.isArray(fieldValue)) {
        return fieldValue.includes(expected);
      }
      return false;
    case 'not_contains':
      if (typeof fieldValue === 'string' && typeof expected === 'string') {
        return !fieldValue.includes(expected);
      }
      if (Array.isArray(fieldValue)) {
        return !fieldValue.includes(expected);
      }
      return true;
    case 'starts_with':
      return typeof fieldValue === 'string' && typeof expected === 'string'
        && fieldValue.startsWith(expected);
    case 'ends_with':
      return typeof fieldValue === 'string' && typeof expected === 'string'
        && fieldValue.endsWith(expected);
    case 'matches':
      if (typeof fieldValue !== 'string' || typeof expected !== 'string') {
        return false;
      }
      return createSafeRegex(expected)?.test(fieldValue) ?? false;
    case 'greater_than':
      return Number(fieldValue) > Number(expected);
    case 'less_than':
      return Number(fieldValue) < Number(expected);
    case 'in':
      return Array.isArray(expected) && expected.includes(fieldValue);
    case 'not_in':
      return Array.isArray(expected) && !expected.includes(fieldValue);
    default:
      return false;
  }
}

/**
 * Evaluate a single condition, supporting expression-based and legacy conditions.
 */
export function evaluateCondition(
  condition: RuleCondition,
  context: Record<string, unknown>,
  options: ConditionEvaluationOptions = {}
): boolean {
  if (condition.expression) {
    if (!options.evaluateExpression) return false;
    return options.evaluateExpression(condition.expression, context);
  }

  if (condition.field && condition.operator) {
    const fieldValue = resolveFieldPath(condition.field, context);
    return evaluateLegacyCondition(fieldValue, condition.operator, condition.value);
  }

  return true;
}

/**
 * Evaluate a rule-like condition collection:
 * - `conditions`: AND semantics
 * - `conditionGroups`: OR semantics, each group is AND
 */
export function evaluateConditionCollections(
  conditions: RuleCondition[] | undefined,
  conditionGroups: RuleCondition[][] | undefined,
  context: Record<string, unknown>,
  options: ConditionEvaluationOptions = {}
): boolean {
  if (conditions && conditions.length > 0) {
    return conditions.every((condition) => evaluateCondition(condition, context, options));
  }

  if (conditionGroups && conditionGroups.length > 0) {
    return conditionGroups.some((group) =>
      group.every((condition) => evaluateCondition(condition, context, options))
    );
  }

  return true;
}
