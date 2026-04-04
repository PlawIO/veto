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
import type { Rule } from './types.js';
import { RuleLoader, type YamlParser } from './loader.js';
import { compile, evaluate } from '../compiler/index.js';
import type { ASTNode } from '../compiler/index.js';
import { evaluateConditionCollections } from './condition-evaluator.js';

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
      arguments: context.arguments,
      ...context.arguments,
    };

    for (const rule of rules) {
      const matched = evaluateConditionCollections(
        rule.conditions,
        rule.condition_groups,
        evalContext,
        {
          now: context.timestamp,
          evaluateExpression: (expression, expressionContext) =>
            this.evaluateExpression(expression, expressionContext),
        }
      );

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

  private evaluateExpression(expression: string, ctx: Record<string, unknown>): boolean {
    let ast = this.compiledCache.get(expression);
    if (!ast) {
      ast = compile(expression);
      if (this.compiledCache.size >= 10_000) {
        const firstKey = this.compiledCache.keys().next().value;
        if (firstKey !== undefined) this.compiledCache.delete(firstKey);
      }
      this.compiledCache.set(expression, ast);
    }

    const result = evaluate(ast, ctx);
    return Boolean(result);
  }
}

export function createExpressionValidator(
  options: ExpressionValidatorOptions,
): ExpressionValidator {
  return new ExpressionValidator(options);
}
