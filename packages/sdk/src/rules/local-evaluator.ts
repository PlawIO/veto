/**
 * Local rule evaluator — evaluate Rule[] against a tool call without cloud.
 *
 * Supports 16 operators, dot-notation field resolution, AND/OR condition
 * groups, and tool filtering. Designed for sub-millisecond local evaluation.
 *
 * Key behavior: undefined fields NEVER match. This prevents false positives
 * on negative operators like not_equals, not_contains, not_in.
 *
 * **Divergences from canonical condition-evaluator.ts:**
 * - All string comparisons are case-insensitive (canonical is case-sensitive).
 * - `within_hours`/`outside_hours` use wall clock time with "HH:MM-HH:MM"
 *   strings (canonical uses field values as timestamps with structured
 *   {@link TimeWindowConditionValue} objects including timezone/day support).
 * - `percent_of` falls back to simplified `fieldValue >= expected` when
 *   no `reference` field is provided (canonical requires `reference`).
 *
 * @module rules/local-evaluator
 */

import type { Rule, RuleCondition } from './types.js';
import { createSafeRegex } from './condition-evaluator.js';

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
    if (!Object.prototype.hasOwnProperty.call(current, part)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Evaluate a single condition against a context object.
 *
 * All string comparisons are case-insensitive. This differs from the
 * canonical `condition-evaluator.ts` which is case-sensitive.
 *
 * **`within_hours` / `outside_hours` divergence:**
 * The local evaluator uses wall clock time (not the field value).
 * Expected format is a simple `"HH:MM-HH:MM"` string. There is no
 * timezone or day-of-week support. This intentionally diverges from the
 * canonical evaluator which interprets the field value as a timestamp
 * and uses structured `TimeWindowConditionValue` objects with timezone
 * and day support. The simplified approach is designed for local/browser
 * use where wall clock checks are sufficient.
 *
 * **`percent_of` divergence:**
 * When a `reference` field is present on the condition, the local
 * evaluator resolves it and computes `fieldValue / referenceValue * 100`,
 * returning true when the percentage exceeds `expected`. When no
 * `reference` field exists, it falls back to a simplified comparison:
 * `fieldValue >= expected`. The canonical evaluator always requires a
 * `reference` field and returns false without one.
 *
 * Unknown operators return false.
 */
export function evaluateCondition(
  condition: RuleCondition,
  context: Record<string, unknown>,
): boolean {
  if (!condition.field || !condition.operator) return false;

  const fieldValue = resolveFieldPath(condition.field, context);
  const expected = condition.value;

  if (fieldValue === undefined) return false;

  switch (condition.operator) {
    case 'equals':
      if (typeof fieldValue === 'string' && typeof expected === 'string') {
        return fieldValue.toLowerCase() === expected.toLowerCase();
      }
      return fieldValue === expected;
    case 'not_equals':
      if (typeof fieldValue === 'string' && typeof expected === 'string') {
        return fieldValue.toLowerCase() !== expected.toLowerCase();
      }
      return fieldValue !== expected;
    case 'contains':
      if (typeof fieldValue === 'string' && typeof expected === 'string') {
        return fieldValue.toLowerCase().includes(expected.toLowerCase());
      }
      if (Array.isArray(fieldValue)) {
        if (typeof expected === 'string') {
          const lower = expected.toLowerCase();
          return fieldValue.some((e: unknown) => typeof e === 'string' ? e.toLowerCase() === lower : e === expected);
        }
        return fieldValue.includes(expected);
      }
      return false;
    case 'not_contains':
      if (typeof fieldValue === 'string' && typeof expected === 'string') {
        return !fieldValue.toLowerCase().includes(expected.toLowerCase());
      }
      if (Array.isArray(fieldValue)) {
        if (typeof expected === 'string') {
          const lower = expected.toLowerCase();
          return !fieldValue.some((e: unknown) => typeof e === 'string' ? e.toLowerCase() === lower : e === expected);
        }
        return !fieldValue.includes(expected);
      }
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
        const regex = createSafeRegex(expected, 'i');
        return regex !== null && regex.test(fieldValue);
      }
      return false;
    case 'greater_than':
      return typeof fieldValue === 'number' && typeof expected === 'number' && fieldValue > expected;
    case 'less_than':
      return typeof fieldValue === 'number' && typeof expected === 'number' && fieldValue < expected;
    case 'in':
      if (!Array.isArray(expected)) return false;
      if (typeof fieldValue === 'string') {
        const lower = fieldValue.toLowerCase();
        return expected.some((e: unknown) => typeof e === 'string' ? e.toLowerCase() === lower : e === fieldValue);
      }
      return expected.includes(fieldValue);
    case 'not_in':
      if (!Array.isArray(expected)) return false;
      if (typeof fieldValue === 'string') {
        const lower = fieldValue.toLowerCase();
        return !expected.some((e: unknown) => typeof e === 'string' ? e.toLowerCase() === lower : e === fieldValue);
      }
      return !expected.includes(fieldValue);
    case 'length_greater_than':
      if (typeof fieldValue === 'string' || Array.isArray(fieldValue)) {
        return typeof expected === 'number' && fieldValue.length > expected;
      }
      return false;
    case 'percent_of': {
      if (typeof fieldValue !== 'number' || typeof expected !== 'number') return false;
      if (typeof condition.reference === 'string') {
        const referenceValue = resolveFieldPath(condition.reference, context);
        if (typeof referenceValue !== 'number' || referenceValue === 0) return false;
        return (fieldValue / referenceValue) * 100 > expected;
      }
      return fieldValue >= expected;
    }
    /**
     * `within_hours` / `outside_hours` — wall clock check.
     *
     * Uses the current wall clock time, NOT the field value. Expected
     * value is a simple `"HH:MM-HH:MM"` string (24h format). No
     * timezone or day-of-week support. Wrap-around ranges (e.g.
     * `"22:00-06:00"`) are supported. This intentionally diverges
     * from the canonical `condition-evaluator.ts`.
     */
    case 'within_hours':
    case 'outside_hours': {
      if (typeof expected !== 'string') return false;
      const parts = expected.split('-');
      if (parts.length !== 2) return false;
      const startParts = parts[0].split(':').map(Number);
      const endParts = parts[1].split(':').map(Number);
      const [sH, sM] = startParts;
      const [eH, eM] = endParts;
      if (isNaN(sH) || isNaN(sM) || isNaN(eH) || isNaN(eM)) return false;
      if (sH < 0 || sH > 23 || eH < 0 || eH > 23) return false;
      if (sM < 0 || sM > 59 || eM < 0 || eM > 59) return false;
      const now = new Date();
      const nowMins = now.getHours() * 60 + now.getMinutes();
      const startMins = sH * 60 + sM;
      const endMins = eH * 60 + eM;
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

    // Conditions-first fallthrough: matches canonical evaluateConditionCollections.
    // If `conditions` is present and non-empty, evaluate only those.
    // Otherwise fall through to `condition_groups`.
    if (rule.conditions && rule.conditions.length > 0) {
      const allMatch = rule.conditions.every(c => evaluateCondition(c, args));
      if (!allMatch) continue;
    } else if (rule.condition_groups && rule.condition_groups.length > 0) {
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
