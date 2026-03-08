/**
 * Client-side evaluation engine using the Veto browser SDK.
 */

import { Veto } from 'veto-sdk/browser';
import { parse as parseYaml } from 'yaml';
import type { Rule } from 'veto-sdk/browser';

export interface EvalTrace {
  ruleId: string;
  ruleName: string;
  action: string;
  matched: boolean;
  tools?: string[];
  conditions?: Array<{
    field?: string;
    operator?: string;
    value?: unknown;
    expression?: string;
  }>;
}

export interface EvalResult {
  decision: 'allow' | 'deny' | 'require_approval';
  reason?: string;
  ruleId?: string;
  ruleName?: string;
  severity?: string;
  latencyMs: number;
  trace: EvalTrace[];
  error?: string;
}

interface ParsedPolicy {
  rules: Rule[];
  name?: string;
}

export function parsePolicy(yamlStr: string): ParsedPolicy {
  const doc = parseYaml(yamlStr);

  if (!doc || typeof doc !== 'object') {
    throw new Error('Invalid YAML: expected a document object');
  }

  const rules = (doc as Record<string, unknown>).rules;
  if (!Array.isArray(rules)) {
    throw new Error('Invalid policy: missing "rules" array');
  }

  return {
    rules: rules as Rule[],
    name: (doc as Record<string, unknown>).name as string | undefined,
  };
}

function buildTrace(rules: Rule[], toolName: string, args: Record<string, unknown>): EvalTrace[] {
  return rules.map((rule) => {
    const appliesToTool = !rule.tools || rule.tools.length === 0 || rule.tools.includes(toolName);

    let conditionsMatch = appliesToTool;
    if (appliesToTool && rule.conditions && rule.conditions.length > 0) {
      conditionsMatch = rule.conditions.every((cond) => {
        if (!cond.field) return true;
        const fieldPath = cond.field.replace(/^arguments\./, '');
        const value = getNestedValue(args, fieldPath);
        return evaluateCondition(value, cond.operator, cond.value);
      });
    }

    return {
      ruleId: rule.id,
      ruleName: rule.name,
      action: rule.action,
      matched: conditionsMatch && appliesToTool,
      tools: rule.tools,
      conditions: rule.conditions?.map((c) => ({
        field: c.field,
        operator: c.operator,
        value: c.value,
        expression: c.expression,
      })),
    };
  });
}

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function evaluateCondition(value: unknown, operator?: string, expected?: unknown): boolean {
  if (!operator) return true;

  switch (operator) {
    case 'equals':
      return value === expected;
    case 'not_equals':
      return value !== expected;
    case 'greater_than':
      return typeof value === 'number' && typeof expected === 'number' && value > expected;
    case 'less_than':
      return typeof value === 'number' && typeof expected === 'number' && value < expected;
    case 'contains':
      return typeof value === 'string' && typeof expected === 'string' && value.includes(expected);
    case 'not_contains':
      return typeof value === 'string' && typeof expected === 'string' && !value.includes(expected);
    case 'starts_with':
      return typeof value === 'string' && typeof expected === 'string' && value.startsWith(expected);
    case 'ends_with':
      return typeof value === 'string' && typeof expected === 'string' && value.endsWith(expected);
    case 'matches':
      try {
        return typeof value === 'string' && typeof expected === 'string' && new RegExp(expected).test(value);
      } catch {
        return false;
      }
    case 'in':
      return Array.isArray(expected) && expected.includes(value);
    case 'not_in':
      return Array.isArray(expected) && !expected.includes(value);
    case 'length_greater_than':
      return Array.isArray(value) && typeof expected === 'number' && value.length > expected;
    default:
      return false;
  }
}

export async function evaluate(
  yamlStr: string,
  toolName: string,
  argsStr: string
): Promise<EvalResult> {
  const startMs = performance.now();

  try {
    const { rules } = parsePolicy(yamlStr);
    const args = JSON.parse(argsStr);

    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
      throw new Error('Arguments must be a JSON object');
    }

    const veto = Veto.fromRules({ rules, mode: 'strict' });
    const result = await veto.guard(toolName, args);
    const latencyMs = Math.round((performance.now() - startMs) * 100) / 100;
    const trace = buildTrace(rules, toolName, args);

    return {
      decision: result.decision,
      reason: result.reason,
      ruleId: result.ruleId,
      severity: result.severity,
      latencyMs,
      trace,
      ruleName: trace.find((t) => t.ruleId === result.ruleId)?.ruleName,
    };
  } catch (err) {
    return {
      decision: 'allow',
      latencyMs: Math.round((performance.now() - startMs) * 100) / 100,
      trace: [],
      error: (err as Error).message,
    };
  }
}

// ---------------------------------------------------------------------------
// URL state sharing
// ---------------------------------------------------------------------------

export interface PlaygroundState {
  policy: string;
  toolName: string;
  args: string;
}

export function encodeState(state: PlaygroundState): string {
  try {
    const json = JSON.stringify(state);
    return btoa(unescape(encodeURIComponent(json)));
  } catch {
    return '';
  }
}

export function decodeState(hash: string): PlaygroundState | null {
  try {
    const json = decodeURIComponent(escape(atob(hash)));
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed.policy === 'string') {
      return parsed as PlaygroundState;
    }
  } catch {
    // ignore
  }
  return null;
}
