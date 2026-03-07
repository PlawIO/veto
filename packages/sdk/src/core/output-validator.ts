import type { Logger } from '../utils/logger.js';
import {
  createSafeRegex,
  evaluateConditionCollections,
} from '../rules/condition-evaluator.js';
import type { OutputRule, RuleCondition } from '../rules/types.js';

const DEFAULT_REDACT_WITH = '[REDACTED]';

export interface RedactionTrace {
  ruleId: string;
  ruleName: string;
  field: string;
  pattern: string;
  redactedCount: number;
  replacement: string;
}

export interface OutputValidationResult {
  decision: 'allow' | 'block';
  output: unknown;
  reason?: string;
  matchedRuleIds: string[];
  redactions: number;
  trace: RedactionTrace[];
}

export interface OutputValidatorOptions {
  logger: Logger;
  getRulesForTool: (toolName: string) => OutputRule[];
}

export class OutputValidator {
  private readonly logger: Logger;
  private readonly getRulesForTool: (toolName: string) => OutputRule[];

  constructor(options: OutputValidatorOptions) {
    this.logger = options.logger;
    this.getRulesForTool = options.getRulesForTool;
  }

  validate(toolName: string, output: unknown): OutputValidationResult {
    const rules = this.getRulesForTool(toolName);
    if (rules.length === 0) {
      return {
        decision: 'allow',
        output,
        matchedRuleIds: [],
        redactions: 0,
        trace: [],
      };
    }

    const context = this.buildEvaluationContext(toolName, output);
    const matchedRules = rules.filter((rule) => this.matchesRule(rule, context));

    if (matchedRules.length === 0) {
      return {
        decision: 'allow',
        output,
        matchedRuleIds: [],
        redactions: 0,
        trace: [],
      };
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
        redactions: 0,
        trace: [],
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
      redactions,
      trace,
    };
  }

  private matchesRule(
    rule: OutputRule,
    context: Record<string, unknown>
  ): boolean {
    return evaluateConditionCollections(
      rule.output_conditions,
      rule.output_condition_groups,
      context
    );
  }

  private buildEvaluationContext(
    toolName: string,
    output: unknown
  ): Record<string, unknown> {
    const base: Record<string, unknown> = {
      output,
      tool_name: toolName,
      toolName,
    };

    if (output && typeof output === 'object' && !Array.isArray(output)) {
      return {
        ...output as Record<string, unknown>,
        ...base,
      };
    }

    return base;
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
        mutableOutput = this.cloneOutput(output);
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

  private cloneOutput(output: unknown): unknown {
    try {
      return structuredClone(output);
    } catch {
      try {
        return JSON.parse(JSON.stringify(output)) as unknown;
      } catch {
        return output;
      }
    }
  }
}
