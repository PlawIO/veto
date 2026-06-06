import type { Logger } from '../utils/logger.js';
import {
  createSafeRegex,
  evaluateCondition,
  evaluateConditionCollections,
} from '../rules/condition-evaluator.js';
import type { FeedProvider, OutputRule, RuleCondition } from '../rules/types.js';
import { isConditionValueRef } from '../rules/types.js';
import { isSemanticOutputRule } from './output-rule-detectors.js';

const DEFAULT_REDACT_WITH = '[REDACTED]';

export interface RedactionTrace {
  ruleId: string;
  ruleName: string;
  field: string;
  pattern: string;
  redactedCount: number;
  replacement: string;
}

export interface OutputRuleLiftTrace {
  ruleId: string;
  ruleName: string;
  lifted: true;
  conditions: Array<{
    field?: string;
    operator?: string;
    valueRef?: 'feed' | 'pipeline';
    refId?: string;
    matched: boolean;
  }>;
}

export interface OutputValidationResult {
  decision: 'allow' | 'block';
  output: unknown;
  reason?: string;
  matchedRuleIds: string[];
  liftedRuleIds: string[];
  redactions: number;
  trace: RedactionTrace[];
  liftTrace: OutputRuleLiftTrace[];
}

export interface OutputValidationContext {
  arguments?: Record<string, unknown>;
  custom?: Record<string, unknown>;
  now?: Date;
  nowMs?: number;
}

export interface OutputValidatorOptions {
  logger: Logger;
  getRulesForTool: (toolName: string) => OutputRule[];
  feedProvider?: FeedProvider;
}

export interface OutputRuleLiftOptions {
  feedProvider?: FeedProvider;
  now?: Date;
  nowMs?: number;
}

export function buildOutputEvaluationContext(
  toolName: string,
  output: unknown,
  validationContext: OutputValidationContext = {}
): Record<string, unknown> {
  const custom = validationContext.custom ?? {};
  const args = validationContext.arguments ?? {};
  const base: Record<string, unknown> = {
    output,
    arguments: args,
    tool_name: toolName,
    toolName,
    custom,
  };

  if (output && typeof output === 'object' && !Array.isArray(output)) {
    return {
      ...output as Record<string, unknown>,
      ...base,
    };
  }

  return base;
}

export function evaluateOutputRuleLift(
  rule: OutputRule,
  context: Record<string, unknown>,
  options: OutputRuleLiftOptions = {}
): OutputRuleLiftTrace | undefined {
  if (!rule.unless || rule.unless.length === 0) {
    return undefined;
  }

  const conditionResults = rule.unless.map((condition) => ({
    condition,
    matched: evaluateCondition(condition, context, {
      allowNestedObjectStringSearch: true,
      feedProvider: options.feedProvider,
      now: options.now,
      nowMs: options.nowMs,
      feedRefMissing: 'noMatch',
    }),
  }));

  if (!conditionResults.every((result) => result.matched)) {
    return undefined;
  }

  return {
    ruleId: rule.id,
    ruleName: rule.name,
    lifted: true,
    conditions: conditionResults.map(({ condition, matched }) => {
      const ref = isConditionValueRef(condition.value) ? condition.value : undefined;
      return {
        field: condition.field,
        operator: condition.operator,
        valueRef: ref?.kind,
        refId: ref?.kind === 'feed' ? ref.feed_id : ref?.pipeline_id,
        matched,
      };
    }),
  };
}

export class OutputValidator {
  private readonly logger: Logger;
  private readonly getRulesForTool: (toolName: string) => OutputRule[];
  private readonly feedProvider?: FeedProvider;

  constructor(options: OutputValidatorOptions) {
    this.logger = options.logger;
    this.getRulesForTool = options.getRulesForTool;
    this.feedProvider = options.feedProvider;
  }

  validate(
    toolName: string,
    output: unknown,
    validationContext: OutputValidationContext = {}
  ): OutputValidationResult {
    const rules = this.getRulesForTool(toolName);
    if (rules.length === 0) {
      return this.allowResult(output);
    }

    const context = buildOutputEvaluationContext(toolName, output, validationContext);
    const evaluations = rules.map((rule) => this.evaluateRule(rule, context, validationContext));
    const matchedRules = evaluations
      .filter((evaluation) => evaluation.matched && !evaluation.liftTrace)
      .map((evaluation) => evaluation.rule);
    const liftTrace = evaluations
      .flatMap((evaluation) => evaluation.liftTrace ? [evaluation.liftTrace] : []);
    const liftedRuleIds = liftTrace.map((trace) => trace.ruleId);

    if (matchedRules.length === 0) {
      return this.allowResult(output, liftedRuleIds, liftTrace);
    }

    const matchedRuleIds = matchedRules.map((rule) => rule.id);
    const blockRule = matchedRules.find((rule) => rule.action === 'block');
    if (blockRule) {
      const reason = blockRule.description ?? `Output blocked by rule: ${blockRule.name}`;
      this.logger.warn('Tool output blocked by output rule', {
        tool: toolName,
        ruleId: blockRule.id,
        reason,
      });
      return {
        decision: 'block',
        output: null,
        reason,
        matchedRuleIds,
        liftedRuleIds,
        redactions: 0,
        trace: [],
        liftTrace,
      };
    }

    let transformedOutput = output;
    let redactions = 0;
    const trace: RedactionTrace[] = [];

    for (const rule of matchedRules) {
      if (rule.action === 'log') {
        this.logger.warn('Tool output matched log-only output rule', {
          tool: toolName,
          ruleId: rule.id,
          ruleName: rule.name,
        });
        continue;
      }

      if (rule.action === 'redact') {
        const redactResult = this.applyRedaction(rule, transformedOutput);
        transformedOutput = redactResult.output;
        redactions += redactResult.redactions;
        trace.push(...redactResult.trace);

        if (redactResult.redactions > 0) {
          this.logger.info('Tool output redacted by output rule', {
            tool: toolName,
            ruleId: rule.id,
            redactions: redactResult.redactions,
          });
        }
      }
    }

    return {
      decision: 'allow',
      output: transformedOutput,
      matchedRuleIds,
      liftedRuleIds,
      redactions,
      trace,
      liftTrace,
    };
  }

  private allowResult(
    output: unknown,
    liftedRuleIds: string[] = [],
    liftTrace: OutputRuleLiftTrace[] = []
  ): OutputValidationResult {
    return {
      decision: 'allow',
      output,
      matchedRuleIds: [],
      liftedRuleIds,
      redactions: 0,
      trace: [],
      liftTrace,
    };
  }

  private evaluateRule(
    rule: OutputRule,
    context: Record<string, unknown>,
    validationContext: OutputValidationContext
  ): { rule: OutputRule; matched: boolean; liftTrace?: OutputRuleLiftTrace } {
    if (!this.matchesRule(rule, context, validationContext)) {
      return { rule, matched: false };
    }

    const liftTrace = evaluateOutputRuleLift(rule, context, {
      feedProvider: this.feedProvider,
      now: validationContext.now,
      nowMs: validationContext.nowMs,
    });

    return { rule, matched: true, liftTrace };
  }

  private matchesRule(
    rule: OutputRule,
    context: Record<string, unknown>,
    validationContext: OutputValidationContext
  ): boolean {
    if (isSemanticOutputRule(rule) && !this.hasFallbackConditions(rule)) {
      return false;
    }

    return evaluateConditionCollections(
      rule.output_conditions,
      rule.output_condition_groups,
      context,
      {
        allowNestedObjectStringSearch: true,
        feedProvider: this.feedProvider,
        now: validationContext.now,
        nowMs: validationContext.nowMs,
        feedRefMissing: 'useFallback',
      }
    );
  }

  private hasFallbackConditions(rule: OutputRule): boolean {
    return (rule.output_conditions?.length ?? 0) > 0
      || (rule.output_condition_groups?.length ?? 0) > 0;
  }

  private applyRedaction(
    rule: OutputRule,
    output: unknown
  ): { output: unknown; redactions: number; trace: RedactionTrace[] } {
    const redactWith = rule.redact_with ?? DEFAULT_REDACT_WITH;
    const candidateConditions = this.collectRedactionConditions(rule);
    if (candidateConditions.length === 0) {
      return { output, redactions: 0, trace: [] };
    }

    let mutableOutput = output;
    let cloned = false;
    let totalRedactions = 0;
    const trace: RedactionTrace[] = [];

    const ensureClone = (): unknown => {
      if (!cloned) {
        const clonedOutput = this.cloneOutput(output);
        if (clonedOutput === null) {
          return null;
        }

        mutableOutput = clonedOutput;
        cloned = true;
      }
      return mutableOutput;
    };

    for (const condition of candidateConditions) {
      const field = condition.field;
      const pattern = condition.value;
      if (!field || typeof pattern !== 'string') continue;

      const path = this.toOutputPath(field);
      if (path === null) continue;

      const regex = createSafeRegex(pattern, 'g');
      if (!regex) {
        this.logger.warn('Skipping unsafe output redaction regex pattern', {
          ruleId: rule.id,
          pattern,
        });
        continue;
      }

      const clonedOutput = ensureClone();
      if (clonedOutput === null) {
        this.logger.warn('Skipping output redaction because output could not be cloned', {
          ruleId: rule.id,
        });
        return { output, redactions: 0, trace: [] };
      }

      const result = this.redactAtPath(clonedOutput, path, regex, redactWith);
      mutableOutput = result.output;
      totalRedactions += result.redactions;

      if (result.redactions > 0) {
        trace.push({
          ruleId: rule.id,
          ruleName: rule.name,
          field,
          pattern,
          redactedCount: result.redactions,
          replacement: redactWith,
        });
      }
    }

    if (!cloned) {
      return { output, redactions: 0, trace: [] };
    }

    return { output: mutableOutput, redactions: totalRedactions, trace };
  }

  private collectRedactionConditions(rule: OutputRule): RuleCondition[] {
    const direct = (rule.output_conditions ?? [])
      .filter((condition) => condition.operator === 'matches');
    const grouped = (rule.output_condition_groups ?? [])
      .flatMap((group) => group)
      .filter((condition) => condition.operator === 'matches');
    return [...direct, ...grouped];
  }

  private toOutputPath(field: string): string | null {
    if (field === 'output') return '';
    if (field.startsWith('output.')) return field.slice('output.'.length);

    if (field === 'tool_name' || field === 'toolName') {
      return null;
    }

    return field;
  }

  private redactAtPath(
    output: unknown,
    path: string,
    regex: RegExp,
    replacement: string
  ): { output: unknown; redactions: number } {
    if (path === '') {
      if (typeof output === 'string') {
        return this.redactStringValue(output, regex, replacement);
      }

      if (!output || typeof output !== 'object') {
        return { output, redactions: 0 };
      }

      return {
        output,
        redactions: this.redactNestedStrings(output, regex, replacement),
      };
    }

    const parentAndKey = this.resolveMutableParent(output, path);
    if (!parentAndKey) {
      return { output, redactions: 0 };
    }

    const { parent, key } = parentAndKey;
    const current = parent[key];
    if (typeof current === 'string') {
      const result = this.redactStringValue(current, regex, replacement);
      parent[key] = result.output;
      return { output, redactions: result.redactions };
    }

    if (!current || typeof current !== 'object') {
      return { output, redactions: 0 };
    }

    return {
      output,
      redactions: this.redactNestedStrings(current, regex, replacement),
    };
  }

  private redactStringValue(
    value: string,
    regex: RegExp,
    replacement: string
  ): { output: string; redactions: number } {
    let redactions = 0;
    const output = value.replace(regex, () => {
      redactions += 1;
      return replacement;
    });

    return { output, redactions };
  }

  private redactNestedStrings(
    value: unknown,
    regex: RegExp,
    replacement: string,
    seen: Set<object> = new Set()
  ): number {
    if (!value || typeof value !== 'object') {
      return 0;
    }

    if (seen.has(value)) {
      return 0;
    }

    seen.add(value);

    if (Array.isArray(value)) {
      let total = 0;
      for (let index = 0; index < value.length; index += 1) {
        const current = value[index];
        if (typeof current === 'string') {
          const result = this.redactStringValue(current, regex, replacement);
          value[index] = result.output;
          total += result.redactions;
          continue;
        }

        total += this.redactNestedStrings(current, regex, replacement, seen);
      }

      return total;
    }

    let total = 0;
    for (const [key, current] of Object.entries(value as Record<string, unknown>)) {
      if (typeof current === 'string') {
        const result = this.redactStringValue(current, regex, replacement);
        (value as Record<string, unknown>)[key] = result.output;
        total += result.redactions;
        continue;
      }

      total += this.redactNestedStrings(current, regex, replacement, seen);
    }

    return total;
  }

  private resolveMutableParent(
    root: unknown,
    path: string
  ): { parent: Record<string, unknown>; key: string } | null {
    if (!root || typeof root !== 'object') return null;

    const parts = path.split('.');
    if (parts.length === 0) return null;

    let current: unknown = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const segment = parts[i];
      if (!current || typeof current !== 'object') return null;
      current = (current as Record<string, unknown>)[segment];
    }

    if (!current || typeof current !== 'object') return null;
    return {
      parent: current as Record<string, unknown>,
      key: parts[parts.length - 1],
    };
  }

  private cloneOutput(output: unknown): unknown | null {
    try {
      return structuredClone(output);
    } catch {
      try {
        return JSON.parse(JSON.stringify(output)) as unknown;
      } catch {
        return null;
      }
    }
  }
}
