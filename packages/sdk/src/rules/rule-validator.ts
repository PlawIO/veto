/**
 * Rule-based validator.
 *
 * This validator loads rules from YAML files and validates tool calls
 * by sending them to an external API.
 *
 * @module rules/rule-validator
 */

import type { Logger } from '../utils/logger.js';
import type {
  ValidationContext,
  ValidationResult,
  NamedValidator,
} from '../types/config.js';
import type { ToolCallHistoryEntry } from '../types/config.js';
import type { Rule, ToolCallContext, ToolCallHistorySummary } from './types.js';
import { RuleLoader, type YamlParser } from './loader.js';
import { ValidationAPIClient, type ValidationAPIConfig } from './api-client.js';

/**
 * Configuration for the rule-based validator.
 */
export interface RuleValidatorConfig {
  /** API configuration */
  api: ValidationAPIConfig;
  /** Path to directory containing rule YAML files */
  rulesDir?: string;
  /** YAML parser function (e.g., from js-yaml) */
  yamlParser?: YamlParser;
  /** Whether to search subdirectories for rules */
  recursiveRuleSearch?: boolean;
  /** Whether rule load errors should abort initialization */
  strictRuleLoading?: boolean;
  /** Behavior when API is unavailable */
  failMode?: 'open' | 'closed';
  /** Session ID for tracking */
  sessionId?: string;
  /** Agent ID for tracking */
  agentId?: string;
  /** User ID for tracking */
  userId?: string;
  /** Role for tracking */
  role?: string;
}

/**
 * Options for the rule validator.
 */
export interface RuleValidatorOptions {
  /** Configuration */
  config: RuleValidatorConfig;
  /** Logger instance */
  logger: Logger;
}

/**
 * Rule-based validator that uses an external API for decisions.
 *
 * This validator:
 * 1. Loads rules from YAML files
 * 2. For each tool call, finds applicable rules
 * 3. Sends the context and rules to an API
 * 4. Returns the decision from the API
 */
export class RuleValidator {
  private readonly logger: Logger;
  private readonly config: RuleValidatorConfig;
  private readonly ruleLoader: RuleLoader;
  private readonly apiClient: ValidationAPIClient;
  private readonly sessionId?: string;
  private readonly agentId?: string;
  private readonly userId?: string;
  private readonly role?: string;
  private isInitialized = false;

  constructor(options: RuleValidatorOptions) {
    this.logger = options.logger;
    this.config = options.config;
    this.sessionId = options.config.sessionId;
    this.agentId = options.config.agentId;
    this.userId = options.config.userId;
    this.role = options.config.role;

    // Initialize rule loader
    this.ruleLoader = new RuleLoader({ logger: this.logger });

    // Set YAML parser if provided
    if (this.config.yamlParser) {
      this.ruleLoader.setYamlParser(this.config.yamlParser);
    }

    // Initialize API client
    this.apiClient = new ValidationAPIClient({
      config: this.config.api,
      logger: this.logger,
      failMode: this.config.failMode,
    });

    this.logger.info('Rule validator created', {
      rulesDir: this.config.rulesDir,
      apiEndpoint: this.config.api.baseUrl + (this.config.api.endpoint ?? '/tool/call/check'),
    });
  }

  /**
   * Initialize the validator by loading rules.
   *
   * Call this before using the validator if rules are loaded from files.
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    if (this.config.rulesDir) {
      if (!this.config.yamlParser) {
        this.logger.warn(
          'Rules directory specified but no YAML parser provided. ' +
          'Call setYamlParser() before initialize() or use addRules().'
        );
      } else {
        this.ruleLoader.loadFromDirectory(
          this.config.rulesDir,
          this.config.recursiveRuleSearch ?? true,
          this.config.strictRuleLoading ?? false
        );
      }
    }

    this.isInitialized = true;
    this.logger.info('Rule validator initialized', {
      totalRules: this.ruleLoader.getRules().allRules.length,
    });
  }

  /**
   * Set the YAML parser.
   */
  setYamlParser(parser: YamlParser): void {
    this.ruleLoader.setYamlParser(parser);
  }

  /**
   * Add rules programmatically.
   */
  addRules(rules: Rule[], setName?: string): void {
    this.ruleLoader.addRules(rules, setName);
  }

  /**
   * Load rules from a YAML string.
   */
  loadRulesFromString(yamlContent: string, sourceName?: string): void {
    this.ruleLoader.loadFromString(yamlContent, sourceName);
  }

  /**
   * Get the rule loader for direct access.
   */
  getRuleLoader(): RuleLoader {
    return this.ruleLoader;
  }

  /**
   * Get the API client for direct access.
   */
  getAPIClient(): ValidationAPIClient {
    return this.apiClient;
  }

  /**
   * Validate a tool call.
   *
   * @param context - Validation context from Veto
   * @returns Validation result
   */
  async validate(context: ValidationContext): Promise<ValidationResult> {
    // Auto-initialize if not already done
    if (!this.isInitialized) {
      await this.initialize();
    }

    // Get applicable rules
    const rules = this.ruleLoader.getRulesForTool(context.toolName);

    this.logger.debug('Validating tool call with rules', {
      toolName: context.toolName,
      callId: context.callId,
      applicableRules: rules.length,
    });

    // If no rules, allow by default
    if (rules.length === 0) {
      this.logger.debug('No rules applicable, allowing by default', {
        toolName: context.toolName,
      });
      return { decision: 'allow' };
    }

    // Build API context
    const apiContext = this.buildToolCallContext(context);

    // Call the API
    const response = await this.apiClient.validate(apiContext, rules);

    // Convert API response to ValidationResult
    if (response.decision === 'pass') {
      this.logger.info('Tool call allowed by API', {
        toolName: context.toolName,
        callId: context.callId,
        passWeight: response.should_pass_weight,
        reasoning: response.reasoning,
      });

      return {
        decision: 'allow',
        reason: response.reasoning,
        metadata: {
          should_pass_weight: response.should_pass_weight,
          should_block_weight: response.should_block_weight,
          matched_rules: response.matched_rules,
          ...response.metadata,
        },
      };
    } else {
      this.logger.warn('Tool call blocked by API', {
        toolName: context.toolName,
        callId: context.callId,
        blockWeight: response.should_block_weight,
        reasoning: response.reasoning,
        matchedRules: response.matched_rules,
      });

      return {
        decision: 'deny',
        reason: response.reasoning,
        metadata: {
          should_pass_weight: response.should_pass_weight,
          should_block_weight: response.should_block_weight,
          matched_rules: response.matched_rules,
          ...response.metadata,
        },
      };
    }
  }

  /**
   * Create a NamedValidator for use with Veto.
   *
   * @returns Named validator instance
   */
  toNamedValidator(): NamedValidator {
    return {
      name: 'rule-validator',
      description: 'Validates tool calls using YAML rules and external API',
      priority: 50, // Run in the middle
      validate: (context) => this.validate(context),
    };
  }

  /**
   * Build the API context from the validation context.
   */
  private buildToolCallContext(context: ValidationContext): ToolCallContext {
    return {
      call_id: context.callId,
      tool_name: context.toolName,
      arguments: context.arguments,
      timestamp: context.timestamp.toISOString(),
      session_id: context.sessionId ?? this.sessionId,
      agent_id: context.agentId ?? this.agentId,
      user_id: context.userId ?? this.userId,
      role: context.role ?? this.role,
      call_history: this.buildHistorySummary(context.callHistory),
      custom: context.custom,
    };
  }

  /**
   * Build a summary of call history for the API.
   */
  private buildHistorySummary(
    history: readonly ToolCallHistoryEntry[]
  ): ToolCallHistorySummary[] {
    return history.slice(-10).map((entry) => ({
      tool_name: entry.toolName,
      allowed: entry.validationResult.decision !== 'deny',
      timestamp: entry.timestamp.toISOString(),
    }));
  }
}

/**
 * Create a rule-based validator.
 *
 * @param options - Validator options
 * @returns RuleValidator instance
 *
 * @example
 * ```typescript
 * import yaml from 'js-yaml';
 *
 * const ruleValidator = createRuleValidator({
 *   config: {
 *     api: { baseUrl: 'http://localhost:8080' },
 *     rulesDir: './rules',
 *     yamlParser: yaml.load,
 *   },
 *   logger: createLogger('info'),
 * });
 *
 * await ruleValidator.initialize();
 *
 * const veto = new Veto({
 *   validators: [ruleValidator.toNamedValidator()],
 * });
 * ```
 */
export function createRuleValidator(options: RuleValidatorOptions): RuleValidator {
  return new RuleValidator(options);
}
