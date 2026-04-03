/**
 * Local rule evaluator — evaluate Rule[] against a tool call without cloud.
 *
 * Supports 16 operators, dot-notation field resolution, AND/OR condition
 * groups, and tool filtering. Designed for sub-millisecond local evaluation.
 *
 * Key behavior: undefined fields NEVER match. This prevents false positives
 * on negative operators like not_equals, not_contains, not_in.
 *
 * @module rules/local-evaluator
 */

import type { Rule, RuleCondition } from './types.js';

export interface LocalEvalResult {
  decision: 'allow' | 'deny' | 'require_approval' | null;
  reason?: string;
  ruleId?: string;
}

/**
 * Resolve a dot-notation field path in a nested object.
 *
 * Returns `undefined` for any broken path segment.
 */
export function resolveFieldPath(
  path: string,
  obj: Record<string, unknown>,
): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Evaluate a single condition against a context object.
 *
 * Case-insensitive string matching. Unknown operators return false.
 */
export function evaluateCondition(
  condition: RuleCondition,
  context: Record<string, unknown>,
): boolean {
  if (!condition.field || !condition.operator) return true;

  const fieldValue = resolveFieldPath(condition.field, context);
  const expected = condition.value;

  if (fieldValue === undefined) return false;

  switch (condition.operator) {
    case 'equals':
      return fieldValue === expected;
    case 'not_equals':
      return fieldValue !== expected;
    case 'contains':
      if (typeof fieldValue === 'string' && typeof expected === 'string') {
        return fieldValue.toLowerCase().includes(expected.toLowerCase());
      }
      if (Array.isArray(fieldValue)) return fieldValue.includes(expected);
      return false;
    case 'not_contains':
      if (typeof fieldValue === 'string' && typeof expected === 'string') {
        return !fieldValue.toLowerCase().includes(expected.toLowerCase());
      }
      if (Array.isArray(fieldValue)) return !fieldValue.includes(expected);
      return false;
    case 'starts_with':
      return (
        typeof fieldValue === 'string' &&
        typeof expected === 'string' &&
        fieldValue.toLowerCase().startsWith(expected.toLowerCase())
      );
    case 'ends_with':
      return (
        typeof fieldValue === 'string' &&
        typeof expected === 'string' &&
        fieldValue.toLowerCase().endsWith(expected.toLowerCase())
      );
    case 'matches':
      if (typeof fieldValue === 'string' && typeof expected === 'string') {
        try {
          return new RegExp(expected, 'i').test(fieldValue);
        } catch {
          return false;
        }
      }
      return false;
    case 'greater_than':
      return typeof fieldValue === 'number' && typeof expected === 'number' && fieldValue > expected;
    case 'less_than':
      return typeof fieldValue === 'number' && typeof expected === 'number' && fieldValue < expected;
    case 'in':
      return Array.isArray(expected) && expected.includes(fieldValue);
    case 'not_in':
      return Array.isArray(expected) && !expected.includes(fieldValue);
    case 'length_greater_than':
      if (typeof fieldValue === 'string' || Array.isArray(fieldValue)) {
        return typeof expected === 'number' && fieldValue.length > expected;
      }
      return false;
    case 'percent_of':
      return typeof fieldValue === 'number' && typeof expected === 'number' && fieldValue >= expected;
    case 'within_hours':
    case 'outside_hours': {
      if (typeof expected !== 'string') return false;
      const parts = expected.split('-');
      if (parts.length !== 2) return false;
      const [sH, sM] = parts[0].split(':').map(Number);
      const [eH, eM] = parts[1].split(':').map(Number);
      if (isNaN(sH) || isNaN(eH)) return false;
      const now = new Date();
      const nowMins = now.getHours() * 60 + now.getMinutes();
      const startMins = sH * 60 + (sM || 0);
      const endMins = eH * 60 + (eM || 0);
      let within: boolean;
      if (startMins <= endMins) {
        within = nowMins >= startMins && nowMins < endMins;
      } else {
        within = nowMins >= startMins || nowMins < endMins;
      }
      return condition.operator === 'within_hours' ? within : !within;
    }
    default:
      return false;
  }
}

/**
 * Evaluate an array of rules against a tool call.
 *
 * Rules are evaluated in order. First matching rule wins.
 * Returns `null` if no rule matched (caller should fall through to cloud).
 *
 * @param rules - Rules to evaluate (only enabled rules are considered)
 * @param toolName - The tool being called (e.g. "browser_click")
 * @param args - Context object for field resolution (typically `{ arguments: { ... } }`)
 */
export function evaluateRulesLocally(
  rules: Rule[],
  toolName: string,
  args: Record<string, unknown>,
): LocalEvalResult {
  for (const rule of rules) {
    if (!rule.enabled) continue;

    if (rule.tools && rule.tools.length > 0 && !rule.tools.includes(toolName)) continue;

    if (rule.conditions && rule.conditions.length > 0) {
      const allMatch = rule.conditions.every(c => evaluateCondition(c, args));
      if (!allMatch) continue;
    }

    if (rule.condition_groups && rule.condition_groups.length > 0) {
      const anyGroupMatch = rule.condition_groups.some(group =>
        group.every(c => evaluateCondition(c, args)),
      );
      if (!anyGroupMatch) continue;
    }

    const action = rule.action;
    if (action === 'block') {
      return { decision: 'deny', reason: rule.description || rule.name, ruleId: rule.id };
    }
    if (action === 'require_approval') {
      return { decision: 'require_approval', reason: rule.description || rule.name, ruleId: rule.id };
    }
    if (action === 'allow') {
      return { decision: 'allow', ruleId: rule.id };
    }
    // warn/log: no enforcement, continue to next rule
  }

  return { decision: null };
}
