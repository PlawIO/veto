/**
 * Local rule evaluator — evaluate Rule[] against a tool call without cloud.
 *
 * Supports 16 operators, dot-notation field resolution, AND/OR condition
 * groups, and tool filtering. Designed for sub-millisecond local evaluation.
 *
 * Key behavior: undefined fields NEVER match. This prevents false positives
 * on negative operators like not_equals, not_contains, not_in.
 *
 * **Alignment with canonical condition-evaluator.ts:**
 * - All string comparisons are case-insensitive (aligned with canonical).
 * - `within_hours`/`outside_hours` support structured TimeWindowValue objects
 *   with timezone/day support (aligned with canonical), plus simple
 *   "HH:MM-HH:MM" wall clock strings for backwards compatibility.
 * - `percent_of` falls back to simplified `fieldValue >= expected` when
 *   no `reference` field is provided (canonical requires `reference`).
 *
 * @module rules/local-evaluator
 */

import type { FeedProvider, Rule, RuleCondition } from './types.js';
import { isConditionValueRef } from './types.js';
import { createSafeRegex, evaluateTimeWindow } from './condition-evaluator.js';
import { resolveFeedRef } from './feed-provider.js';

export interface LocalEvalResult {
  decision: 'allow' | 'deny' | 'require_approval' | null;
  reason?: string;
  ruleId?: string;
}

/**
 * Optional knobs for local evaluation.
 *
 * `feedProvider` is required for rules whose condition values reference
 * dynamic feeds. When absent, feed-backed conditions apply their
 * `fallback` behavior exactly as if the snapshot were missing.
 */
export interface LocalEvalOptions {
  feedProvider?: FeedProvider;
  now_ms?: number;
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
 * All string comparisons are case-insensitive (aligned with canonical evaluator).
 *
 * **`within_hours` / `outside_hours`:**
 * Supports two formats:
 * 1. Structured TimeWindowValue objects with timezone/day support (aligned
 *    with canonical evaluator, uses field value as timestamp).
 * 2. Simple `"HH:MM-HH:MM"` strings for backwards-compatible wall clock mode.
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
  options: LocalEvalOptions = {},
): boolean {
  if (!condition.field || !condition.operator) return false;

  const fieldValue = resolveFieldPath(condition.field, context);
  let expected = condition.value;

  if (fieldValue === undefined) return false;

  // Resolve typed FeedRef / PipelineRef comparands against the injected
  // provider. On miss/stale we apply the fallback and return. On hit,
  // `expected` is reassigned to the resolved array — set-membership
  // operators use it normally; other operators compare against the
  // array and correctly fail their type checks below.
  if (isConditionValueRef(expected)) {
    const outcome = resolveFeedRef(expected, options.feedProvider, options.now_ms);
    if ('fallback' in outcome) {
      // fail_open: do not match. fail_closed: match.
      return outcome.fallback === 'fail_closed';
    }
    expected = outcome.resolved;
  }

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
      return typeof fieldValue === 'number' && typeof expected === 'number'
        && Number.isFinite(fieldValue) && Number.isFinite(expected) && fieldValue > expected;
    case 'less_than':
      return typeof fieldValue === 'number' && typeof expected === 'number'
        && Number.isFinite(fieldValue) && Number.isFinite(expected) && fieldValue < expected;
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
     * `within_hours` / `outside_hours` — supports two formats:
     *
     * 1. Structured TimeWindowValue object (aligned with canonical evaluator):
     *    `{ start: "09:00", end: "17:00", timezone: "America/New_York", days?: ["mon","tue",...] }`
     *    Uses the field value as a timestamp, with timezone and day-of-week support.
     *
     * 2. Simple "HH:MM-HH:MM" string (backwards-compatible wall clock mode):
     *    Uses the current wall clock time, NOT the field value. No timezone
     *    or day-of-week support. Wrap-around ranges (e.g. "22:00-06:00")
     *    are supported.
     */
    case 'within_hours':
    case 'outside_hours': {
      if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
        const result = evaluateTimeWindow(fieldValue, expected);
        if (result === null) return false;
        return condition.operator === 'within_hours'
          ? result.inScope && result.withinWindow
          : result.inScope && !result.withinWindow;
      }
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
  options: LocalEvalOptions = {},
): LocalEvalResult {
  for (const rule of rules) {
    if (!rule.enabled) continue;

    if (rule.tools && rule.tools.length > 0 && !rule.tools.includes(toolName)) continue;

    // Conditions-first fallthrough: matches canonical evaluateConditionCollections.
    // If `conditions` is present and non-empty, evaluate only those.
    // Otherwise fall through to `condition_groups`.
    if (rule.conditions && rule.conditions.length > 0) {
      const allMatch = rule.conditions.every(c => evaluateCondition(c, args, options));
      if (!allMatch) continue;
    } else if (rule.condition_groups && rule.condition_groups.length > 0) {
      const anyGroupMatch = rule.condition_groups.some(group =>
        group.every(c => evaluateCondition(c, args, options)),
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
