/**
 * Local expression-based rule validator.
 *
 * Evaluates rules that use AST-compiled expressions locally,
 * without requiring an external API call. Rules with traditional
 * field/operator/value conditions are evaluated using simple comparison.
 *
 * @module rules/expression-validator
 */

import type { Logger } from '../utils/logger.js';
import type {
  ValidationContext,
  ValidationResult,
  NamedValidator,
} from '../types/config.js';
import type { Rule, RuleCondition } from './types.js';
import { RuleLoader, type YamlParser } from './loader.js';
import { compile, evaluate } from '../compiler/index.js';
import type { ASTNode } from '../compiler/index.js';
import { isSafePattern } from '../deterministic/regex-safety.js';

export interface ExpressionValidatorConfig {
  rulesDir?: string;
  yamlParser?: YamlParser;
  recursiveRuleSearch?: boolean;
}

export interface ExpressionValidatorOptions {
  config: ExpressionValidatorConfig;
  logger: Logger;
}

/**
 * Validates tool calls using compiled expressions evaluated locally.
 *
 * Supports both legacy conditions (field/operator/value) and new
 * expression-based conditions.
 */
export class ExpressionValidator {
  private readonly logger: Logger;
  private readonly config: ExpressionValidatorConfig;
  private readonly ruleLoader: RuleLoader;
  private readonly compiledCache = new Map<string, ASTNode>();
  private isInitialized = false;

  constructor(options: ExpressionValidatorOptions) {
    this.logger = options.logger;
    this.config = options.config;
    this.ruleLoader = new RuleLoader({ logger: this.logger });

    if (this.config.yamlParser) {
      this.ruleLoader.setYamlParser(this.config.yamlParser);
    }
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    if (this.config.rulesDir && this.config.yamlParser) {
      this.ruleLoader.loadFromDirectory(
        this.config.rulesDir,
        this.config.recursiveRuleSearch ?? true,
      );
    }

    this.isInitialized = true;
  }

  addRules(rules: Rule[], setName?: string): void {
    this.ruleLoader.addRules(rules, setName);
  }

  getRuleLoader(): RuleLoader {
    return this.ruleLoader;
  }

  async validate(context: ValidationContext): Promise<ValidationResult> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    const rules = this.ruleLoader.getRulesForTool(context.toolName);

    if (rules.length === 0) {
      return { decision: 'allow' };
    }

    const evalContext = {
      tool_name: context.toolName,
      ...context.arguments,
    };

    for (const rule of rules) {
      const matched = this.evaluateRule(rule, evalContext);

      if (matched) {
        if (rule.action === 'block') {
          this.logger.info('Expression rule denied tool call', {
            ruleId: rule.id,
            ruleName: rule.name,
            toolName: context.toolName,
          });
          return {
            decision: 'deny',
            reason: rule.description ?? `Blocked by rule: ${rule.name}`,
            metadata: { ruleId: rule.id, ruleName: rule.name },
          };
        }

        if (rule.action === 'allow') {
          return {
            decision: 'allow',
            metadata: { ruleId: rule.id, ruleName: rule.name },
          };
        }
      }
    }

    return { decision: 'allow' };
  }

  toNamedValidator(): NamedValidator {
    return {
      name: 'expression-validator',
      description: 'Validates tool calls using compiled AST expressions',
      priority: 40,
      validate: (context) => this.validate(context),
    };
  }

  private evaluateRule(rule: Rule, ctx: Record<string, unknown>): boolean {
    if (rule.conditions && rule.conditions.length > 0) {
      return rule.conditions.every((c) => this.evaluateCondition(c, ctx));
    }

    if (rule.condition_groups && rule.condition_groups.length > 0) {
      return rule.condition_groups.some((group) =>
        group.every((c) => this.evaluateCondition(c, ctx)),
      );
    }

    return true;
  }

  private evaluateCondition(condition: RuleCondition, ctx: Record<string, unknown>): boolean {
    if (condition.expression) {
      return this.evaluateExpression(condition.expression, ctx);
    }

    if (condition.field && condition.operator) {
      return this.evaluateLegacyCondition(condition, ctx);
    }

    return true;
  }

  private evaluateExpression(expression: string, ctx: Record<string, unknown>): boolean {
    let ast = this.compiledCache.get(expression);
    if (!ast) {
      ast = compile(expression);
      this.compiledCache.set(expression, ast);
    }

    const result = evaluate(ast, ctx);
    return Boolean(result);
  }

  private evaluateLegacyCondition(
    condition: RuleCondition,
    ctx: Record<string, unknown>,
  ): boolean {
    const fieldValue = this.resolveField(condition.field!, ctx);
    const expected = condition.value;

    switch (condition.operator) {
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
        if (typeof fieldValue !== 'string' || typeof expected !== 'string') return false;
        if (expected.length > 256 || !isSafePattern(expected)) return false;
        try {
          return new RegExp(expected).test(fieldValue);
        } catch {
          return false;
        }
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

  private resolveField(field: string, ctx: Record<string, unknown>): unknown {
    const parts = field.split('.');
    let current: unknown = ctx;

    for (const part of parts) {
      if (current === null || current === undefined) return undefined;
      if (typeof current !== 'object') return undefined;
      current = (current as Record<string, unknown>)[part];
    }

    return current;
  }
}

export function createExpressionValidator(
  options: ExpressionValidatorOptions,
): ExpressionValidator {
  return new ExpressionValidator(options);
}
