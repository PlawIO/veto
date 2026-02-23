/**
 * Main Veto guardrail class.
 *
 * This is the primary entry point for using Veto. It automatically loads
 * configuration and rules from the veto/ directory and validates tool calls.
 *
 * @module core/veto
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type {
  ToolDefinition,
  ToolCall,
} from '../types/tool.js';
import type {
  DecisionExportFormat,
  Validator,
  NamedValidator,
  ValidationContext,
  ValidationResult,
  LogLevel,
  ToolCallHistoryEntry,
} from '../types/config.js';
import { createLogger, type Logger } from '../utils/logger.js';
import { generateId, generateToolCallId } from '../utils/id.js';
import { ValidationEngine } from './validator.js';
import { HistoryTracker, type HistoryStats } from './history.js';
import { BudgetTracker, BudgetExceededError, type BudgetStatus } from './budget.js';
import { Interceptor, ToolCallDeniedError, type InterceptionResult } from './interceptor.js';
import { fromMCP, isMCPTool } from '../providers/adapters.js';
import type { MCPTool, MCPServerClient, MCPToolResult } from '../providers/types.js';
import type {
  Rule,
  RuleSeverity,
  RuleSet,
  OutputRule,
  ToolCallContext,
  ToolCallHistorySummary,
  ValidationAPIResponse,
} from '../rules/types.js';
import { compile, evaluate } from '../compiler/index.js';
import type { ASTNode } from '../compiler/index.js';
import { validatePolicyIR } from '../rules/schema-validator.js';
import { evaluateConditionCollections } from '../rules/condition-evaluator.js';
import { resolvePolicyPackExtends } from '../rules/policy-packs.js';
import type { KernelConfig, KernelToolCall } from '../kernel/types.js';
import { KernelClient } from '../kernel/client.js';
import type { CustomConfig, CustomToolCall, CustomResponse } from '../custom/types.js';
import { CustomClient } from '../custom/client.js';
import type { VetoCloudConfig, ApprovalPollOptions, CloudToolRegistration } from '../cloud/types.js';
import { VetoCloudClient, ApprovalTimeoutError } from '../cloud/client.js';
import { PolicyCache } from '../cloud/policy-cache.js';
import { validateDeterministic } from '../deterministic/validator.js';
import type { LocalValidationResult } from '../deterministic/types.js';
import { OutputValidator, type OutputValidationResult } from './output-validator.js';
import {
  EventWebhookEmitter,
  resolveEventWebhookConfig,
  type VetoWebhookEvent,
  type VetoWebhookEventType,
} from './events.js';

/**
 * Veto operating mode.
 * - "strict": Block tool calls when validation fails
 * - "log": Only log validation failures, allow tool calls to proceed
 */
export type VetoMode = 'strict' | 'log';

/**
 * Validation mode - how tool calls are validated.
 * - "local": Evaluate YAML rules locally with deterministic checks (default)
 * - "api": Use external HTTP API for validation
 * - "kernel": Use local kernel model via Ollama
 * - "custom": Use custom LLM provider (OpenAI, Anthropic, Gemini, OpenRouter)
 * - "cloud": Use Veto Cloud API with approval workflow support
 */
export type ValidationMode = 'local' | 'api' | 'kernel' | 'custom' | 'cloud';

type StartupMode = 'local' | 'cloud' | 'self-hosted' | 'api' | 'kernel' | 'custom';

/**
 * Wrapped handler function type.
 */
export type WrappedHandler = (args: Record<string, unknown>) => Promise<unknown>;

/**
 * Result of wrapping tools with Veto.
 */
export interface WrappedTools {
  /** Tool definitions (schemas) to pass to AI models */
  definitions: ToolDefinition[];
  /** Wrapped handler functions keyed by tool name */
  implementations: Record<string, WrappedHandler>;
}

/**
 * Optional per-call context for standalone guard checks.
 */
export interface GuardContext {
  sessionId?: string;
  agentId?: string;
  userId?: string;
  role?: string;
}

/**
 * Standalone validation result returned by `guard()`.
 */
export interface GuardResult {
  decision: 'allow' | 'deny' | 'require_approval';
  reason?: string;
  ruleId?: string;
  severity?: RuleSeverity;
  approvalId?: string;
}

/**
 * Parsed veto.config.yaml structure.
 */
interface VetoConfigFile {
  version?: string;
  mode?: VetoMode;
  validation?: {
    mode?: ValidationMode;
  };
  api?: {
    baseUrl?: string;
    endpoint?: string;
    timeout?: number;
    retries?: number;
    retryDelay?: number;
  };
  kernel?: {
    baseUrl?: string;
    model?: string;
    temperature?: number;
    maxTokens?: number;
    timeout?: number;
  };
  custom?: {
    provider?: 'gemini' | 'openrouter' | 'openai' | 'anthropic';
    model?: string;
    apiKey?: string;
    temperature?: number;
    maxTokens?: number;
    timeout?: number;
    baseUrl?: string;
  };
  cloud?: {
    apiKey?: string;
    baseUrl?: string;
    timeout?: number;
    retries?: number;
    retryDelay?: number;
  };
  approval?: {
    pollInterval?: number;
    timeout?: number;
    callbackUrl?: string;
    timeoutBehavior?: 'block' | 'allow';
    /** Forward custom context to the approval webhook. Defaults to false to avoid leaking sensitive data. */
    includeCustomContext?: boolean;
    responseSchema?: {
      decisionField?: string;
      reasonField?: string;
    };
  };
  logging?: {
    level?: LogLevel;
  };
  rules?: {
    directory?: string;
    recursive?: boolean;
  };
  budget?: {
    max?: number;
    currency?: string;
    window?: 'session';
  };
  costs?: Record<string, number | string>;
  events?: {
    webhook?: {
      url?: string;
      on?: VetoWebhookEventType[];
      min_severity?: RuleSeverity;
      format?: 'slack' | 'pagerduty' | 'generic' | 'cef';
    };
  };
}

/**
 * Internal state for loaded rules.
 */
interface LoadedRulesState {
  allRules: Rule[];
  allOutputRules: OutputRule[];
  rulesByTool: Map<string, Rule[]>;
  outputRulesByTool: Map<string, OutputRule[]>;
  globalRules: Rule[];
  globalOutputRules: OutputRule[];
}

interface LocalApprovalConfig {
  callbackUrl?: string;
  timeoutMs: number;
  timeoutBehavior: 'block' | 'allow';
  includeCustomContext: boolean;
  responseSchema: {
    decisionField: string;
    reasonField: string;
  };
}

class LocalApprovalTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Approval callback timed out after ${timeoutMs}ms`);
    this.name = 'LocalApprovalTimeoutError';
  }
}

/**
 * Options for creating a Veto instance.
 */
export interface VetoOptions {
  /**
   * Path to the veto directory containing config and rules.
   * Defaults to './veto' relative to current working directory.
   */
  configDir?: string;

  /**
   * Override the operating mode.
   * - "strict": Block tool calls when validation fails
   * - "log": Only log validation failures, allow tool calls to proceed
   */
  mode?: VetoMode;

  /**
   * Override log level.
   * Can also be set via VETO_LOG_LEVEL environment variable.
   */
  logLevel?: LogLevel;

  /**
   * Session ID for tracking.
   * Can also be set via VETO_SESSION_ID environment variable.
   */
  sessionId?: string;

  /**
   * Agent ID for tracking.
   * Can also be set via VETO_AGENT_ID environment variable.
   */
  agentId?: string;

  /**
   * User ID for tracking.
   * Can also be set via VETO_USER_ID environment variable.
   */
  userId?: string;

  /**
   * Role for tracking.
   * Can also be set via VETO_ROLE environment variable.
   */
  role?: string;

  /**
   * Additional validators to run alongside rule-based validation.
   */
  validators?: (Validator | NamedValidator)[];

  /**
   * API key for cloud mode.
   * When set, Veto auto-detects cloud mode.
   */
  apiKey?: string;

  /**
   * Cloud endpoint override.
   * When set, Veto auto-detects self-hosted cloud mode.
   */
  endpoint?: string;

  /**
   * Injected kernel client for testing or custom configurations.
   */
  kernelClient?: KernelClient;

  /**
   * Injected cloud client for testing or custom configurations.
   */
  cloudClient?: VetoCloudClient;

  /**
   * Hook called when a tool call requires human approval.
   * Use this to display approval UI to the user.
   * The SDK blocks until the approval is resolved on the server.
   */
  onApprovalRequired?: (
    context: ValidationContext,
    approvalId: string
  ) => void | Promise<void>;
}

/**
 * Veto - A guardrail system for AI agent tool calls.
 *
 * Veto automatically loads configuration from the veto/ directory and
 * validates tool calls against defined rules via an external API.
 *
 * @example
 * ```typescript
 * import { Veto } from 'veto-sdk';
 *
 * // Initialize Veto (loads config from ./veto automatically)
 * const veto = await Veto.init();
 *
 * // Wrap your tools
 * const wrappedTools = veto.wrapTools(myTools);
 *
 * // Pass to AI provider, then validate calls
 * const result = await veto.validateToolCall(toolCall);
 * ```
 */
export class Veto {
  private static readonly DEFAULT_CLOUD_BASE_URL = 'https://api.runveto.com';

  private readonly logger: Logger;
  private readonly validationEngine: ValidationEngine;
  private readonly historyTracker: HistoryTracker;
  private readonly budgetTracker: BudgetTracker | null;
  private readonly interceptor: Interceptor;
  private readonly outputValidator: OutputValidator;
  private readonly eventWebhookEmitter: EventWebhookEmitter;

  // Configuration
  private readonly configDir: string;
  private readonly mode: VetoMode;
  private readonly validationMode: ValidationMode;
  private readonly startupMode: StartupMode;
  private readonly apiBaseUrl: string;
  private readonly apiEndpoint: string;
  private readonly apiTimeout: number;
  private readonly apiRetries: number;
  private readonly apiRetryDelay: number;
  private readonly sessionId?: string;
  private readonly agentId?: string;
  private readonly userId?: string;
  private readonly role?: string;

  // Kernel client (lazy initialized or injected)
  private kernelClient: KernelClient | null = null;
  private readonly kernelConfig: KernelConfig | null;

  // Custom provider client (lazy initialized)
  private customClient: CustomClient | null = null;
  private readonly customConfig: CustomConfig | null;

  // Cloud client (lazy initialized or injected)
  private cloudClient: VetoCloudClient | null = null;
  private readonly cloudConfig: VetoCloudConfig | null;
  private readonly approvalPollOptions: ApprovalPollOptions;
  private readonly localApprovalConfig: LocalApprovalConfig;
  private readonly onApprovalRequired?: (
    context: ValidationContext,
    approvalId: string
  ) => void | Promise<void>;

  // Approval preference cache: tool name -> 'approve_all' | 'deny_all'
  private readonly approvalPreferences = new Map<string, 'approve_all' | 'deny_all'>();

  // Client-side deterministic validation cache
  private readonly policyCache: PolicyCache | null = null;

  // Loaded rules
  private readonly rules: LoadedRulesState;
  private readonly compiledExpressionCache = new Map<string, ASTNode>();

  private constructor(
    options: VetoOptions,
    config: VetoConfigFile,
    rules: LoadedRulesState,
    logger: Logger
  ) {
    this.logger = logger;
    this.configDir = options.configDir ?? './veto';
    this.rules = rules;

    // Resolve mode (strict blocks, log only logs)
    this.mode = options.mode ?? config.mode ?? 'strict';

    const explicitValidationMode = config.validation?.mode;
    const cloudApiKey = options.apiKey ?? config.cloud?.apiKey ?? process.env.VETO_API_KEY;
    const cloudBaseUrl = options.endpoint ?? config.cloud?.baseUrl;

    if (options.endpoint && options.apiKey) {
      this.logger.warn(
        'Both endpoint and apiKey provided. Using self-hosted mode with endpoint and apiKey authentication.',
        { endpoint: options.endpoint }
      );
    }

    if (options.endpoint) {
      this.validationMode = 'cloud';
      this.startupMode = 'self-hosted';
    } else if (options.apiKey) {
      this.validationMode = 'cloud';
      this.startupMode = 'cloud';
    } else if (explicitValidationMode) {
      this.validationMode = explicitValidationMode;
      if (explicitValidationMode === 'cloud') {
        this.startupMode = Veto.isSelfHostedBaseUrl(cloudBaseUrl)
          ? 'self-hosted'
          : 'cloud';
      } else {
        this.startupMode = explicitValidationMode;
      }
    } else if (cloudApiKey) {
      this.validationMode = 'cloud';
      this.startupMode = 'cloud';
    } else if (cloudBaseUrl) {
      this.validationMode = 'cloud';
      this.startupMode = 'self-hosted';
    } else {
      this.validationMode = 'local';
      this.startupMode = 'local';
    }

    // Resolve API configuration from config file
    this.apiBaseUrl = (config.api?.baseUrl ?? 'http://localhost:8080').replace(/\/$/, '');
    this.apiEndpoint = config.api?.endpoint ?? '/tool/call/check';
    this.apiTimeout = config.api?.timeout ?? 10000;
    this.apiRetries = config.api?.retries ?? 2;
    this.apiRetryDelay = config.api?.retryDelay ?? 1000;

    // Resolve kernel configuration
    if (this.validationMode === 'kernel' && config.kernel?.model) {
      this.kernelConfig = {
        baseUrl: config.kernel.baseUrl ?? 'http://localhost:11434/v1',
        model: config.kernel.model,
        temperature: config.kernel.temperature,
        maxTokens: config.kernel.maxTokens,
        timeout: config.kernel.timeout,
      };
    } else {
      this.kernelConfig = null;
    }

    // Use injected kernel client if provided
    if (options.kernelClient) {
      this.kernelClient = options.kernelClient;
    }

    // Resolve custom provider configuration
    if (this.validationMode === 'custom' && config.custom?.provider && config.custom?.model) {
      this.customConfig = {
        provider: config.custom.provider,
        model: config.custom.model,
        apiKey: config.custom.apiKey,
        temperature: config.custom.temperature,
        maxTokens: config.custom.maxTokens,
        timeout: config.custom.timeout,
        baseUrl: config.custom.baseUrl,
      };
    } else {
      this.customConfig = null;
    }

    // Resolve cloud configuration
    if (this.validationMode === 'cloud') {
      this.cloudConfig = {
        apiKey: cloudApiKey,
        baseUrl: cloudBaseUrl,
        timeout: config.cloud?.timeout,
        retries: config.cloud?.retries,
        retryDelay: config.cloud?.retryDelay,
      };
    } else {
      this.cloudConfig = null;
    }

    // Use injected cloud client if provided
    if (options.cloudClient) {
      this.cloudClient = options.cloudClient;
    }

    // Initialize policy cache for client-side deterministic validation
    if (this.validationMode === 'cloud') {
      this.policyCache = new PolicyCache(this.getCloudClient());
    }

    // Approval polling options
    this.approvalPollOptions = {
      pollInterval: config.approval?.pollInterval,
      timeout: config.approval?.timeout,
    };

    this.localApprovalConfig = {
      callbackUrl: config.approval?.callbackUrl,
      timeoutMs: config.approval?.timeout ?? 30_000,
      timeoutBehavior: config.approval?.timeoutBehavior ?? 'block',
      includeCustomContext: config.approval?.includeCustomContext ?? false,
      responseSchema: {
        decisionField: config.approval?.responseSchema?.decisionField ?? 'decision',
        reasonField: config.approval?.responseSchema?.reasonField ?? 'reason',
      },
    };

    // Approval hook
    this.onApprovalRequired = options.onApprovalRequired;

    this.eventWebhookEmitter = new EventWebhookEmitter(
      resolveEventWebhookConfig(config.events?.webhook, this.logger),
      this.logger
    );

    // Resolve tracking options
    this.sessionId = options.sessionId ?? process.env.VETO_SESSION_ID ?? generateId('session');
    this.agentId = options.agentId ?? process.env.VETO_AGENT_ID;
    this.userId = options.userId ?? process.env.VETO_USER_ID;
    this.role = options.role ?? process.env.VETO_ROLE;

    this.logger.info('Veto configuration loaded', {
      configDir: this.configDir,
      mode: this.mode,
      validationMode: this.validationMode,
      startupMode: this.startupMode,
      apiUrl: this.validationMode === 'api' ? `${this.apiBaseUrl}${this.apiEndpoint}` : undefined,
      kernelModel: this.kernelConfig?.model,
      customProvider: this.customConfig?.provider,
      customModel: this.customConfig?.model,
      cloudBaseUrl: this.cloudConfig?.baseUrl,
      rulesLoaded: rules.allRules.length,
      outputRulesLoaded: rules.allOutputRules.length,
    });

    this.logger.info(`Veto running in ${this.startupMode} mode`);

    // Initialize validation engine
    const defaultDecision = 'allow';
    this.validationEngine = new ValidationEngine({
      logger: this.logger,
      defaultDecision,
    });

    // Add the rule validator based on validation mode
    this.validationEngine.addValidator({
      name: 'veto-rule-validator',
      description: this.validationMode === 'kernel'
        ? 'Validates tool calls via local kernel model'
        : this.validationMode === 'custom'
          ? `Validates tool calls via ${this.customConfig?.provider ?? 'custom'} LLM`
          : this.validationMode === 'cloud'
            ? 'Validates tool calls via Veto Cloud API'
            : this.validationMode === 'local'
              ? 'Validates tool calls via local deterministic rules'
              : 'Validates tool calls via external API',
      priority: 50,
      validate: (ctx) => {
        switch (this.validationMode) {
          case 'local':
            return this.validateWithLocal(ctx);
          case 'kernel':
            return this.validateWithKernel(ctx);
          case 'custom':
            return this.validateWithCustom(ctx);
          case 'cloud':
            return this.validateWithCloud(ctx);
          case 'api':
          default:
            return this.validateWithAPI(ctx);
        }
      },
    });

    // Add any additional validators
    if (options.validators) {
      this.validationEngine.addValidators(options.validators);
    }

    // Initialize history tracker
    this.historyTracker = new HistoryTracker({
      maxSize: 100,
      logger: this.logger,
    });

    // Initialize budget tracker (if configured)
    if (config.budget?.max !== undefined && config.budget.max > 0) {
      this.budgetTracker = new BudgetTracker({
        config: {
          max: config.budget.max,
          currency: config.budget.currency,
          window: config.budget.window,
        },
        costs: config.costs ?? {},
        logger: this.logger,
      });
      this.logger.info('Budget tracking enabled', {
        max: config.budget.max,
        currency: config.budget.currency ?? 'USD',
      });
    } else {
      this.budgetTracker = null;
    }

    // Initialize interceptor
    this.outputValidator = new OutputValidator({
      logger: this.logger,
      getRulesForTool: (toolName) => this.getOutputRulesForTool(toolName),
    });

    this.interceptor = new Interceptor({
      logger: this.logger,
      validationEngine: this.validationEngine,
      historyTracker: this.historyTracker,
      budgetTracker: this.budgetTracker ?? undefined,
      sessionId: this.sessionId,
      agentId: this.agentId,
      userId: this.userId,
      role: this.role,
      onAfterValidation: (context, result) => {
        this.emitDecisionEvent(context, result);
      },
      outputValidator: this.outputValidator,
    });

    this.logger.info('Veto initialized successfully');
  }

  /**
   * Initialize Veto by loading configuration and rules.
   *
   * @param options - Initialization options
   * @returns Initialized Veto instance
   *
   * @example
   * ```typescript
   * // Use defaults (loads from ./veto)
   * const veto = await Veto.init();
   *
   * // Custom config directory
   * const veto = await Veto.init({ configDir: './my-veto-config' });
   *
   * // Cloud mode
   * const cloudVeto = await Veto.init({ apiKey: 'veto_...' });
   *
   * // Self-hosted mode
   * const selfHostedVeto = await Veto.init({ endpoint: 'https://veto.my-company.com' });
   * ```
   */
  static async init(options: VetoOptions = {}): Promise<Veto> {
    const configDir = resolve(options.configDir ?? './veto');

    // Determine log level
    const envLogLevel = process.env.VETO_LOG_LEVEL as LogLevel | undefined;
    let logLevel: LogLevel = options.logLevel ?? envLogLevel ?? 'info';

    // Load config file
    const configPath = join(configDir, 'veto.config.yaml');
    let config: VetoConfigFile = {};

    if (existsSync(configPath)) {
      const configContent = readFileSync(configPath, 'utf-8');
      config = parseYaml(configContent) as VetoConfigFile;
      logLevel = options.logLevel ?? envLogLevel ?? config.logging?.level ?? 'info';
    }

    const logger = createLogger(logLevel);

    if (!existsSync(configPath)) {
      logger.warn('Veto config not found. Run "npx veto init" to initialize.', {
        expected: configPath,
      });
    }

    // Load rules
    const rulesDir = resolve(configDir, config.rules?.directory ?? './rules');
    const recursive = config.rules?.recursive ?? true;
    const rules = Veto.loadRules(rulesDir, recursive, logger);

    return new Veto(options, config, rules, logger);
  }

  private static isSelfHostedBaseUrl(baseUrl?: string): boolean {
    if (!baseUrl) return false;
    return baseUrl.replace(/\/$/, '') !== Veto.DEFAULT_CLOUD_BASE_URL;
  }

  /**
   * Load rules from YAML files.
   */
  private static loadRules(
    rulesDir: string,
    recursive: boolean,
    logger: Logger
  ): LoadedRulesState {
    const state: LoadedRulesState = {
      allRules: [],
      allOutputRules: [],
      rulesByTool: new Map(),
      outputRulesByTool: new Map(),
      globalRules: [],
      globalOutputRules: [],
    };

    if (!existsSync(rulesDir)) {
      logger.debug('Rules directory not found', { path: rulesDir });
      return state;
    }

    const yamlFiles = Veto.findYamlFiles(rulesDir, recursive);
    logger.debug('Found rule files', { count: yamlFiles.length });

    for (const filePath of yamlFiles) {
      try {
        const content = readFileSync(filePath, 'utf-8');
        const parsed = parseYaml(content) as RuleSet | Rule[] | Record<string, unknown>;

        let rules: Rule[] = [];
        let outputRules: OutputRule[] = [];

        if (Array.isArray(parsed)) {
          rules = parsed as Rule[];
        } else if (parsed && typeof parsed === 'object') {
          const parsedObject = resolvePolicyPackExtends(
            parsed as Record<string, unknown>,
            filePath,
            parseYaml
          );

          if ('rules' in parsedObject || 'output_rules' in parsedObject) {
            const normalizedForSchema = 'rules' in parsedObject
              ? parsedObject
              : { ...parsedObject, rules: [] };
            validatePolicyIR(normalizedForSchema);

            rules = Array.isArray(normalizedForSchema.rules)
              ? normalizedForSchema.rules as Rule[]
              : [];
            outputRules = Array.isArray(normalizedForSchema.output_rules)
              ? normalizedForSchema.output_rules as OutputRule[]
              : [];
          } else if ('id' in parsedObject) {
            rules = [parsed as unknown as Rule];
          }
        }

        // Process and index rules
        for (const rule of rules) {
          if (rule.enabled === false) continue;

          state.allRules.push(rule);

          if (!rule.tools || rule.tools.length === 0) {
            state.globalRules.push(rule);
          } else {
            for (const toolName of rule.tools) {
              const existing = state.rulesByTool.get(toolName) ?? [];
              existing.push(rule);
              state.rulesByTool.set(toolName, existing);
            }
          }
        }

        // Process and index output rules
        for (const outputRule of outputRules) {
          if (outputRule.enabled === false) continue;

          state.allOutputRules.push(outputRule);

          if (!outputRule.tools || outputRule.tools.length === 0) {
            state.globalOutputRules.push(outputRule);
          } else {
            for (const toolName of outputRule.tools) {
              const existing = state.outputRulesByTool.get(toolName) ?? [];
              existing.push(outputRule);
              state.outputRulesByTool.set(toolName, existing);
            }
          }
        }

        logger.debug('Loaded rules from file', {
          path: filePath,
          count: rules.length,
          outputCount: outputRules.length,
        });
      } catch (error) {
        logger.error(
          'Failed to load rules file',
          { path: filePath },
          error instanceof Error ? error : new Error(String(error))
        );
      }
    }

    logger.info('Rules loaded', {
      total: state.allRules.length,
      global: state.globalRules.length,
      toolSpecific: state.rulesByTool.size,
      outputTotal: state.allOutputRules.length,
      outputGlobal: state.globalOutputRules.length,
      outputToolSpecific: state.outputRulesByTool.size,
    });

    return state;
  }

  /**
   * Find YAML files in a directory.
   */
  private static findYamlFiles(dir: string, recursive: boolean): string[] {
    const files: string[] = [];

    try {
      const entries = readdirSync(dir);

      for (const entry of entries) {
        const fullPath = join(dir, entry);
        const stat = statSync(fullPath);

        if (stat.isDirectory() && recursive) {
          files.push(...Veto.findYamlFiles(fullPath, recursive));
        } else if (stat.isFile()) {
          const ext = extname(entry).toLowerCase();
          if (ext === '.yaml' || ext === '.yml') {
            files.push(fullPath);
          }
        }
      }
    } catch {
      // Directory doesn't exist or not readable
    }

    return files;
  }

  /**
   * Get rules applicable to a tool.
   */
  private getRulesForTool(toolName: string): Rule[] {
    const toolSpecific = this.rules.rulesByTool.get(toolName) ?? [];
    return [...this.rules.globalRules, ...toolSpecific];
  }

  private getOutputRulesForTool(toolName: string): OutputRule[] {
    const toolSpecific = this.rules.outputRulesByTool.get(toolName) ?? [];
    return [...this.rules.globalOutputRules, ...toolSpecific];
  }

  private isGuardEvaluation(context: ValidationContext): boolean {
    return context.source === 'guard';
  }

  private shouldApplyLogModeOverride(context: ValidationContext): boolean {
    return this.mode === 'log' && !this.isGuardEvaluation(context);
  }

  private resolveSessionId(context: ValidationContext): string | undefined {
    return context.sessionId ?? this.sessionId;
  }

  private resolveAgentId(context: ValidationContext): string | undefined {
    return context.agentId ?? this.agentId;
  }

  private resolveUserId(context: ValidationContext): string | undefined {
    return context.userId ?? this.userId;
  }

  private resolveRole(context: ValidationContext): string | undefined {
    return context.role ?? this.role;
  }

  private toLocalRuleMetadata(rule: Rule): Record<string, unknown> {
    return {
      source: 'local',
      ruleId: rule.id,
      ruleName: rule.name,
      severity: rule.severity,
      policyVersion: '1.0',
    };
  }

  /**
   * Validate a tool call with the external API.
   */
  private async validateWithAPI(context: ValidationContext): Promise<ValidationResult> {
    const rules = this.getRulesForTool(context.toolName);

    // If no rules, allow by default
    if (rules.length === 0) {
      this.logger.debug('No rules for tool, allowing', { tool: context.toolName });
      return { decision: 'allow' };
    }

    // Build API request
    const apiContext: ToolCallContext = {
      call_id: context.callId,
      tool_name: context.toolName,
      arguments: context.arguments,
      timestamp: context.timestamp.toISOString(),
      session_id: this.resolveSessionId(context),
      agent_id: this.resolveAgentId(context),
      user_id: this.resolveUserId(context),
      role: this.resolveRole(context),
      call_history: this.buildHistorySummary(context.callHistory),
      custom: context.custom,
    };

    const url = `${this.apiBaseUrl}${this.apiEndpoint}`;

    // Make API call with retries
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.apiRetries; attempt++) {
      try {
        const response = await this.makeAPIRequest(url, apiContext, rules);
        return this.handleAPIResponse(response, context);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt < this.apiRetries) {
          this.logger.warn('API request failed, retrying', {
            attempt: attempt + 1,
            error: lastError.message,
          });
          await this.delay(this.apiRetryDelay);
        }
      }
    }

    // All retries failed - use fail mode
    return this.handleAPIFailure(lastError?.message ?? 'API unavailable', context);
  }

  /**
   * Make the API request.
   */
  private async makeAPIRequest(
    url: string,
    context: ToolCallContext,
    rules: Rule[]
  ): Promise<ValidationAPIResponse> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.apiTimeout);

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ context, rules }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`API returned status ${response.status}`);
      }

      const data = await response.json() as ValidationAPIResponse;

      // Validate response
      if (data.decision !== 'pass' && data.decision !== 'block') {
        throw new Error('Invalid API response: missing decision');
      }

      return data;
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  /**
   * Handle successful API response.
   */
  private handleAPIResponse(
    response: ValidationAPIResponse,
    context: ValidationContext
  ): ValidationResult {
    const metadata = {
      should_pass_weight: response.should_pass_weight,
      should_block_weight: response.should_block_weight,
      matched_rules: response.matched_rules,
    };

    if (response.decision === 'pass') {
      this.logger.debug('API allowed tool call', {
        tool: context.toolName,
        passWeight: response.should_pass_weight,
      });

      return {
        decision: 'allow',
        reason: response.reasoning,
        metadata,
      };
    } else {
      // API returned block decision
      if (this.shouldApplyLogModeOverride(context)) {
        // Log mode: log the block but allow the call
        this.logger.warn('Tool call would be blocked (log mode)', {
          tool: context.toolName,
          blockWeight: response.should_block_weight,
          reason: response.reasoning,
        });

        return {
          decision: 'allow',
          reason: `[LOG MODE] Would block: ${response.reasoning}`,
          metadata: { ...metadata, blocked_in_strict_mode: true },
        };
      } else {
        // Strict mode: actually block the call
        this.logger.warn('Tool call blocked', {
          tool: context.toolName,
          blockWeight: response.should_block_weight,
          reason: response.reasoning,
        });

        return {
          decision: 'deny',
          reason: response.reasoning,
          metadata,
        };
      }
    }
  }

  /**
   * Handle API failure. In log mode, always allow. In strict mode, block.
   */
  private handleAPIFailure(reason: string, context: ValidationContext): ValidationResult {
    if (this.shouldApplyLogModeOverride(context)) {
      this.logger.warn('API unavailable (log mode, allowing)', { reason });
      return {
        decision: 'allow',
        reason: `API unavailable: ${reason}`,
        metadata: { api_error: true },
      };
    } else {
      this.logger.error('API unavailable (strict mode, blocking)', { reason });
      return {
        decision: 'deny',
        reason: `API unavailable: ${reason}`,
        metadata: { api_error: true },
      };
    }
  }

  /**
   * Validate a tool call locally against YAML rules without network calls.
   */
  private async validateWithLocal(context: ValidationContext): Promise<ValidationResult> {
    const rules = this.getRulesForTool(context.toolName);

    if (rules.length === 0) {
      this.logger.debug('No rules for tool, allowing', { tool: context.toolName });
      return { decision: 'allow' };
    }

    const localContext = this.buildLocalEvaluationContext(context);
    let firstAllowRule: Rule | null = null;

    for (const rule of rules) {
      if (!this.matchesLocalRule(rule, context, localContext)) {
        continue;
      }

      const reason = rule.description ?? `Matched rule: ${rule.name}`;
      const metadata = this.toLocalRuleMetadata(rule);

      if (rule.action === 'require_approval') {
        if (this.shouldApplyLogModeOverride(context)) {
          this.logger.warn('Tool call would require approval locally (log mode)', {
            tool: context.toolName,
            ruleId: rule.id,
            reason,
          });

          return {
            decision: 'allow',
            reason: `[LOG MODE] Would require approval: ${reason}`,
            metadata: {
              blocked_in_strict_mode: true,
              ...metadata,
            },
          };
        }

        if (this.isGuardEvaluation(context)) {
          return {
            decision: 'require_approval',
            reason,
            metadata,
          };
        }

        return this.handleLocalApprovalFlow(context, rule, reason);
      }

      if (rule.action === 'block') {
        if (this.shouldApplyLogModeOverride(context)) {
          this.logger.warn('Tool call would be blocked locally (log mode)', {
            tool: context.toolName,
            ruleId: rule.id,
            reason,
          });
          return {
            decision: 'allow',
            reason: `[LOG MODE] Would block: ${reason}`,
            metadata: {
              blocked_in_strict_mode: true,
              ...metadata,
            },
          };
        }

        this.logger.warn('Tool call blocked by local rule', {
          tool: context.toolName,
          ruleId: rule.id,
          reason,
        });
        return {
          decision: 'deny',
          reason,
          metadata,
        };
      }

      if (rule.action === 'allow' && !firstAllowRule) {
        firstAllowRule = rule;
      }

      if (rule.action === 'warn' || rule.action === 'log') {
        this.logger.warn('Local rule matched with non-blocking action', {
          tool: context.toolName,
          action: rule.action,
          ruleId: rule.id,
        });
      }
    }

    if (firstAllowRule) {
      return {
        decision: 'allow',
        reason: firstAllowRule.description ?? `Allowed by rule: ${firstAllowRule.name}`,
        metadata: this.toLocalRuleMetadata(firstAllowRule),
      };
    }

    return { decision: 'allow' };
  }

  private buildLocalEvaluationContext(context: ValidationContext): Record<string, unknown> {
    return {
      ...context.arguments,
      tool_name: context.toolName,
      arguments: context.arguments,
      session_id: this.resolveSessionId(context),
      agent_id: this.resolveAgentId(context),
      user_id: this.resolveUserId(context),
      role: this.resolveRole(context),
      custom: context.custom,
    };
  }

  private matchesLocalRule(
    rule: Rule,
    validationContext: ValidationContext,
    localContext: Record<string, unknown>
  ): boolean {
    if (!this.matchesLocalRuleAgents(rule, this.resolveAgentId(validationContext))) {
      return false;
    }

    const conditionsMatch = evaluateConditionCollections(
      rule.conditions,
      rule.condition_groups,
      localContext,
      {
        now: validationContext.timestamp,
        evaluateExpression: (expression, evalContext) =>
          this.evaluateLocalExpression(expression, evalContext),
      }
    );

    if (!conditionsMatch) {
      return false;
    }

    return this.matchesLocalSequenceConstraints(
      rule,
      validationContext.callHistory,
      validationContext.timestamp
    );
  }

  private matchesLocalRuleAgents(rule: Rule, agentId?: string): boolean {
    if (!rule.agents) {
      return true;
    }

    if (Array.isArray(rule.agents)) {
      const allowedAgents = this.normalizeAgentScope(rule.agents);
      return agentId !== undefined && allowedAgents.includes(agentId);
    }

    const excludedAgents = this.normalizeAgentScope(rule.agents.not);
    return agentId === undefined || !excludedAgents.includes(agentId);
  }

  private normalizeAgentScope(scope: readonly unknown[]): string[] {
    return scope.filter((value): value is string => typeof value === 'string');
  }

  private matchesLocalSequenceConstraints(
    rule: Rule,
    history: readonly ToolCallHistoryEntry[],
    now: Date
  ): boolean {
    const blockedBy = rule.blocked_by ?? [];
    const requires = rule.requires ?? [];

    if (blockedBy.length === 0 && requires.length === 0) {
      return true;
    }

    const blockedByMatched = blockedBy.some((constraint) =>
      this.hasMatchingHistoryEntry(constraint, history, now)
    );

    const missingRequirement = requires.some((constraint) =>
      !this.hasMatchingHistoryEntry(constraint, history, now)
    );

    return blockedByMatched || missingRequirement;
  }

  private hasMatchingHistoryEntry(
    constraint: NonNullable<Rule['requires']>[number],
    history: readonly ToolCallHistoryEntry[],
    now: Date
  ): boolean {
    const nowMs = now.getTime();
    const withinMs = typeof constraint.within === 'number'
      ? Math.max(0, constraint.within) * 1000
      : null;

    return history.some((entry) => {
      if (entry.toolName !== constraint.tool) {
        return false;
      }

      if (entry.validationResult.decision === 'deny') {
        return false;
      }

      if (withinMs !== null) {
        const ageMs = nowMs - entry.timestamp.getTime();
        if (ageMs < 0 || ageMs > withinMs) {
          return false;
        }
      }

      const historicalContext = this.buildHistoricalEvaluationContext(entry);

      return evaluateConditionCollections(
        constraint.conditions,
        constraint.condition_groups,
        historicalContext,
        {
          now: entry.timestamp,
          evaluateExpression: (expression, evalContext) =>
            this.evaluateLocalExpression(expression, evalContext),
        }
      );
    });
  }

  private buildHistoricalEvaluationContext(
    historyEntry: ToolCallHistoryEntry
  ): Record<string, unknown> {
    return {
      ...historyEntry.arguments,
      tool_name: historyEntry.toolName,
      arguments: historyEntry.arguments,
      decision: historyEntry.validationResult.decision,
      timestamp: historyEntry.timestamp.toISOString(),
    };
  }

  private evaluateLocalExpression(
    expression: string,
    context: Record<string, unknown>
  ): boolean {
    let ast = this.compiledExpressionCache.get(expression);

    if (!ast) {
      try {
        ast = compile(expression);
        this.compiledExpressionCache.set(expression, ast);
      } catch (error) {
        this.logger.warn('Failed to compile local rule expression', {
          expression,
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    }

    try {
      return Boolean(evaluate(ast, context));
    } catch (error) {
      this.logger.warn('Failed to evaluate local rule expression', {
        expression,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Get or create the kernel client.
   */
  private getKernelClient(): KernelClient {
    if (this.kernelClient) {
      return this.kernelClient;
    }

    if (!this.kernelConfig) {
      throw new Error('Kernel configuration not available');
    }

    this.kernelClient = new KernelClient({
      config: this.kernelConfig,
      logger: this.logger,
    });

    return this.kernelClient;
  }

  /**
   * Validate a tool call with the local kernel model.
   */
  private async validateWithKernel(context: ValidationContext): Promise<ValidationResult> {
    const rules = this.getRulesForTool(context.toolName);

    // If no rules, allow by default
    if (rules.length === 0) {
      this.logger.debug('No rules for tool, allowing', { tool: context.toolName });
      return { decision: 'allow' };
    }

    const toolCall: KernelToolCall = {
      tool: context.toolName,
      arguments: context.arguments,
    };

    try {
      const kernelClient = this.getKernelClient();
      const response = await kernelClient.evaluate(toolCall, rules);

      return this.handleKernelResponse(response, context);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return this.handleKernelFailure(reason, context);
    }
  }

  /**
   * Handle successful kernel response.
   */
  private handleKernelResponse(
    response: import('../kernel/types.js').KernelResponse,
    context: ValidationContext
  ): ValidationResult {
    const metadata = {
      pass_weight: response.pass_weight,
      block_weight: response.block_weight,
      matched_rules: response.matched_rules,
    };

    if (response.decision === 'pass') {
      this.logger.debug('Kernel allowed tool call', {
        tool: context.toolName,
        passWeight: response.pass_weight,
      });

      return {
        decision: 'allow',
        reason: response.reasoning,
        metadata,
      };
    } else {
      // Kernel returned block decision
      if (this.shouldApplyLogModeOverride(context)) {
        // Log mode: log the block but allow the call
        this.logger.warn('Tool call would be blocked (log mode)', {
          tool: context.toolName,
          blockWeight: response.block_weight,
          reason: response.reasoning,
        });

        return {
          decision: 'allow',
          reason: `[LOG MODE] Would block: ${response.reasoning}`,
          metadata: { ...metadata, blocked_in_strict_mode: true },
        };
      } else {
        // Strict mode: actually block the call
        this.logger.warn('Tool call blocked by kernel', {
          tool: context.toolName,
          blockWeight: response.block_weight,
          reason: response.reasoning,
        });

        return {
          decision: 'deny',
          reason: response.reasoning,
          metadata,
        };
      }
    }
  }

  /**
   * Handle kernel failure. In log mode, always allow. In strict mode, block.
   */
  private handleKernelFailure(
    reason: string,
    context: ValidationContext
  ): ValidationResult {
    if (this.shouldApplyLogModeOverride(context)) {
      this.logger.warn('Kernel unavailable (log mode, allowing)', { reason });
      return {
        decision: 'allow',
        reason: `Kernel unavailable: ${reason}`,
        metadata: { kernel_error: true },
      };
    } else {
      this.logger.error('Kernel unavailable (strict mode, blocking)', { reason });
      return {
        decision: 'deny',
        reason: `Kernel unavailable: ${reason}`,
        metadata: { kernel_error: true },
      };
    }
  }

  /**
   * Get or create the custom provider client.
   */
  private getCustomClient(): CustomClient {
    if (this.customClient) {
      return this.customClient;
    }

    if (!this.customConfig) {
      throw new Error(
        'Custom validation is not configured. Set validation.mode="custom" and provide custom.provider and custom.model in veto.config.yaml'
      );
    }

    this.customClient = new CustomClient({
      config: this.customConfig,
      logger: this.logger,
    });

    return this.customClient;
  }

  /**
   * Validate a tool call with custom LLM provider.
   */
  private async validateWithCustom(context: ValidationContext): Promise<ValidationResult> {
    const rules = this.getRulesForTool(context.toolName);

    // If no rules, allow by default
    if (rules.length === 0) {
      this.logger.debug('No rules for tool, allowing', { tool: context.toolName });
      return { decision: 'allow' };
    }

    const toolCall: CustomToolCall = {
      tool: context.toolName,
      arguments: context.arguments,
    };

    try {
      const customClient = this.getCustomClient();
      const response = await customClient.evaluate(toolCall, rules);

      return this.handleCustomResponse(response, context);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return this.handleCustomFailure(reason, context);
    }
  }

  /**
   * Handle successful custom provider response.
   */
  private handleCustomResponse(
    response: CustomResponse,
    context: ValidationContext
  ): ValidationResult {
    const metadata = {
      pass_weight: response.pass_weight,
      block_weight: response.block_weight,
      matched_rules: response.matched_rules,
    };

    if (response.decision === 'pass') {
      this.logger.debug('Custom provider allowed tool call', {
        tool: context.toolName,
        passWeight: response.pass_weight,
      });

      return {
        decision: 'allow',
        reason: response.reasoning,
        metadata,
      };
    } else {
      // Custom provider returned block decision
      if (this.shouldApplyLogModeOverride(context)) {
        // Log mode: log the block but allow the call
        this.logger.warn('Tool call would be blocked (log mode)', {
          tool: context.toolName,
          blockWeight: response.block_weight,
          reason: response.reasoning,
        });

        return {
          decision: 'allow',
          reason: `[LOG MODE] Would block: ${response.reasoning}`,
          metadata: { ...metadata, blocked_in_strict_mode: true },
        };
      } else {
        // Strict mode: actually block the call
        this.logger.warn('Tool call blocked by custom provider', {
          tool: context.toolName,
          blockWeight: response.block_weight,
          reason: response.reasoning,
        });

        return {
          decision: 'deny',
          reason: response.reasoning,
          metadata,
        };
      }
    }
  }

  /**
   * Handle custom provider failure. In log mode, always allow. In strict mode, block.
   */
  private handleCustomFailure(
    reason: string,
    context: ValidationContext
  ): ValidationResult {
    if (this.shouldApplyLogModeOverride(context)) {
      this.logger.warn('Custom provider unavailable (log mode, allowing)', { reason });
      return {
        decision: 'allow',
        reason: `Custom provider unavailable: ${reason}`,
        metadata: { custom_provider_failed: true },
      };
    } else {
      this.logger.error('Custom provider unavailable (strict mode, blocking)', { reason });
      return {
        decision: 'deny',
        reason: `Custom provider unavailable: ${reason}`,
        metadata: { custom_provider_failed: true },
      };
    }
  }

  /**
   * Get or create the cloud client.
   */
  private getCloudClient(): VetoCloudClient {
    if (this.cloudClient) {
      return this.cloudClient;
    }

    this.cloudClient = new VetoCloudClient({
      config: this.cloudConfig ?? undefined,
      logger: this.logger,
    });

    return this.cloudClient;
  }

  /**
   * Try client-side deterministic validation for a tool call.
   * Returns null if the policy is not eligible for local validation.
   */
  private tryLocalDeterministic(
    context: ValidationContext
  ): LocalValidationResult | null {
    if (!this.policyCache) return null;

    const policy = this.policyCache.get(context.toolName);
    if (!policy) return null;

    if (policy.mode !== 'deterministic') return null;
    if (policy.hasSessionConstraints || policy.hasRateLimits) return null;

    const result = validateDeterministic(
      context.toolName,
      context.arguments,
      policy.constraints
    );

    this.getCloudClient().logDecision({
      tool_name: context.toolName,
      arguments: context.arguments,
      decision: result.decision,
      reason: result.reason,
      mode: 'deterministic',
      latency_ms: result.latencyMs,
      source: 'client',
      context: {
        session_id: this.resolveSessionId(context),
        agent_id: this.resolveAgentId(context),
        user_id: this.resolveUserId(context),
        role: this.resolveRole(context),
      },
    });

    return result;
  }

  /**
   * Validate a tool call with the Veto Cloud API.
   * Handles require_approval decisions by polling until resolved.
   */
  private async validateWithCloud(
    context: ValidationContext
  ): Promise<ValidationResult> {
    // Fast path: try client-side deterministic validation
    const localResult = this.tryLocalDeterministic(context);
    if (localResult) {
      if (localResult.decision === 'allow') {
        this.logger.debug('Local deterministic validation allowed', {
          tool: context.toolName,
          latencyMs: localResult.latencyMs,
        });
        return { decision: 'allow', reason: localResult.reason };
      }

      if (this.shouldApplyLogModeOverride(context)) {
        this.logger.warn('Tool call would be blocked locally (log mode)', {
          tool: context.toolName,
          reason: localResult.reason,
        });
        return {
          decision: 'allow',
          reason: `[LOG MODE] Would block: ${localResult.reason}`,
          metadata: { blocked_in_strict_mode: true, source: 'client' },
        };
      }

      this.logger.warn('Tool call blocked by local deterministic validation', {
        tool: context.toolName,
        reason: localResult.reason,
      });
      return {
        decision: 'deny',
        reason: localResult.reason,
        metadata: { source: 'client' },
      };
    }

    const client = this.getCloudClient();

    const apiContext: Record<string, unknown> = {
      call_id: context.callId,
      timestamp: context.timestamp.toISOString(),
      session_id: this.resolveSessionId(context),
      agent_id: this.resolveAgentId(context),
      user_id: this.resolveUserId(context),
      role: this.resolveRole(context),
    };
    if (context.custom) {
      apiContext.custom = context.custom;
    }

    try {
      const response = await client.validate(
        context.toolName,
        context.arguments,
        apiContext
      );

      const metadata: Record<string, unknown> = {};
      if (response.failed_constraints) {
        metadata.failed_constraints = response.failed_constraints;
      }
      if (response.metadata) {
        Object.assign(metadata, response.metadata);
      }

      // Handle require_approval decision
      if (response.decision === 'require_approval') {
        const metadataWithApproval = response.approval_id
          ? { ...metadata, approvalId: response.approval_id }
          : metadata;

        if (this.isGuardEvaluation(context)) {
          return {
            decision: 'require_approval',
            reason: response.reason,
            metadata: Object.keys(metadataWithApproval).length > 0
              ? metadataWithApproval
              : undefined,
          };
        }

        if (response.approval_id) {
          return this.handleApprovalFlow(
            context,
            response.approval_id,
            response.reason,
            Object.keys(metadataWithApproval).length > 0
              ? metadataWithApproval
              : undefined
          );
        }
      }

      if (response.decision === 'allow') {
        this.logger.debug('Cloud allowed tool call', {
          tool: context.toolName,
        });
        return {
          decision: 'allow',
          reason: response.reason,
          metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
        };
      }

      // Cloud returned deny
      if (this.shouldApplyLogModeOverride(context)) {
        this.logger.warn('Tool call would be blocked (log mode)', {
          tool: context.toolName,
          reason: response.reason,
        });
        return {
          decision: 'allow',
          reason: `[LOG MODE] Would block: ${response.reason}`,
          metadata: { ...metadata, blocked_in_strict_mode: true },
        };
      }

      this.logger.warn('Tool call blocked by cloud', {
        tool: context.toolName,
        reason: response.reason,
      });
      return {
        decision: 'deny',
        reason: response.reason,
        metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);

      if (this.shouldApplyLogModeOverride(context)) {
        this.logger.warn('Cloud unavailable (log mode, allowing)', {
          reason,
        });
        return {
          decision: 'allow',
          reason: `Cloud unavailable: ${reason}`,
          metadata: { cloud_error: true },
        };
      }

      this.logger.error('Cloud unavailable (strict mode, blocking)', {
        reason,
      });
      return {
        decision: 'deny',
        reason: `Cloud unavailable: ${reason}`,
        metadata: { cloud_error: true },
      };
    }
  }

  /**
   * Handle the approval flow: fire hook, poll until resolved, return decision.
   */
  private async handleApprovalFlow(
    context: ValidationContext,
    approvalId: string,
    reason: string | undefined,
    metadata: Record<string, unknown> | undefined
  ): Promise<ValidationResult> {
    // Check approval preference cache first
    const cachedPref = this.approvalPreferences.get(context.toolName);
    if (cachedPref === 'approve_all') {
      this.logger.info('Auto-approved via cached preference', {
        tool: context.toolName,
      });
      return {
        decision: 'allow',
        reason: 'Auto-approved (approve all preference)',
        metadata,
      };
    } else if (cachedPref === 'deny_all') {
      this.logger.info('Auto-denied via cached preference', {
        tool: context.toolName,
      });
      return {
        decision: 'deny',
        reason: 'Auto-denied (deny all preference)',
        metadata,
      };
    }

    this.logger.info('Awaiting human approval', {
      tool: context.toolName,
      approval_id: approvalId,
    });

    // Fire the approval hook so integrating products can show UI
    if (this.onApprovalRequired) {
      try {
        await this.onApprovalRequired(context, approvalId);
      } catch (error) {
        this.logger.warn('onApprovalRequired hook threw an error', {
          approval_id: approvalId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    try {
      const client = this.getCloudClient();
      const approvalData = await client.pollApproval(
        approvalId,
        this.approvalPollOptions
      );

      const status = approvalData.status;

      if (status === 'approved') {
        this.logger.info('Approval granted', {
          tool: context.toolName,
          approval_id: approvalId,
          resolved_by: approvalData.resolvedBy,
        });
        return {
          decision: 'allow',
          reason: `Approved by human: ${approvalData.resolvedBy ?? 'unknown'}`,
          metadata,
        };
      }

      this.logger.warn('Approval denied or expired', {
        tool: context.toolName,
        approval_id: approvalId,
        status,
      });
      return {
        decision: 'deny',
        reason: `Approval ${status}: ${reason ?? 'no reason provided'}`,
        metadata,
      };
    } catch (error) {
      if (error instanceof ApprovalTimeoutError) {
        this.logger.warn('Approval timed out', {
          tool: context.toolName,
          approval_id: approvalId,
        });
        return {
          decision: 'deny',
          reason: 'Approval timed out waiting for human review',
          metadata,
        };
      }
      throw error;
    }
  }

  private async handleLocalApprovalFlow(
    context: ValidationContext,
    rule: Rule,
    reason: string
  ): Promise<ValidationResult> {
    const metadataBase = this.toLocalRuleMetadata(rule);

    const callbackUrl = this.localApprovalConfig.callbackUrl;
    if (!callbackUrl) {
      this.logger.warn('Local require_approval rule matched without callback URL', {
        tool: context.toolName,
        ruleId: rule.id,
      });

      return {
        decision: 'deny',
        reason: 'Approval callback URL is not configured (approval.callbackUrl)',
        metadata: {
          ...metadataBase,
          approval_error: 'missing_callback_url',
        },
      };
    }

    const approvalContext: Record<string, unknown> = {
      call_id: context.callId,
      timestamp: context.timestamp.toISOString(),
      session_id: this.resolveSessionId(context),
      agent_id: this.resolveAgentId(context),
    };
    if (this.localApprovalConfig.includeCustomContext && context.custom) {
      approvalContext.custom = context.custom;
    }

    const payload: Record<string, unknown> = {
      tool_name: context.toolName,
      arguments: context.arguments,
      reason,
      rule: {
        id: rule.id,
        name: rule.name,
        description: rule.description,
      },
      context: approvalContext,
    };

    try {
      const approvalResponse = await this.sendLocalApprovalRequest(payload);
      const decision = this.normalizeApprovalDecision(
        approvalResponse[this.localApprovalConfig.responseSchema.decisionField]
      );
      const responseReason = this.extractLocalApprovalReason(approvalResponse);

      if (decision === 'allow') {
        return {
          decision: 'allow',
          reason: responseReason ?? `Approved by local approver for rule: ${rule.name}`,
          metadata: {
            ...metadataBase,
            approval_source: callbackUrl,
          },
        };
      }

      if (decision === 'deny') {
        return {
          decision: 'deny',
          reason: responseReason ?? `Denied by local approver for rule: ${rule.name}`,
          metadata: {
            ...metadataBase,
            approval_source: callbackUrl,
          },
        };
      }

      this.logger.warn('Approval callback returned invalid decision payload', {
        tool: context.toolName,
        ruleId: rule.id,
        decisionField: this.localApprovalConfig.responseSchema.decisionField,
      });

      return {
        decision: 'deny',
        reason: `Approval callback response missing valid "${this.localApprovalConfig.responseSchema.decisionField}" decision`,
        metadata: {
          ...metadataBase,
          approval_source: callbackUrl,
          approval_error: 'invalid_response',
        },
      };
    } catch (error) {
      if (error instanceof LocalApprovalTimeoutError) {
        if (this.localApprovalConfig.timeoutBehavior === 'allow') {
          this.logger.warn('Approval callback timed out, allowing by configuration', {
            tool: context.toolName,
            ruleId: rule.id,
            timeoutMs: this.localApprovalConfig.timeoutMs,
          });

          return {
            decision: 'allow',
            reason: 'Approval callback timed out; allowed by timeoutBehavior=allow',
            metadata: {
              ...metadataBase,
              approval_source: callbackUrl,
              approval_timeout: true,
            },
          };
        }

        this.logger.warn('Approval callback timed out, blocking by configuration', {
          tool: context.toolName,
          ruleId: rule.id,
          timeoutMs: this.localApprovalConfig.timeoutMs,
        });

        return {
          decision: 'deny',
          reason: 'Approval callback timed out waiting for human review',
          metadata: {
            ...metadataBase,
            approval_source: callbackUrl,
            approval_timeout: true,
          },
        };
      }

      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn('Approval callback request failed', {
        tool: context.toolName,
        ruleId: rule.id,
        error: message,
      });

      return {
        decision: 'deny',
        reason: `Approval callback failed: ${message}`,
        metadata: {
          ...metadataBase,
          approval_source: callbackUrl,
          approval_error: 'request_failed',
        },
      };
    }
  }

  private async sendLocalApprovalRequest(
    payload: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const callbackUrl = this.localApprovalConfig.callbackUrl;
    if (!callbackUrl) {
      throw new Error('Approval callback URL is not configured');
    }

    const controller = new AbortController();
    const fetchPromise = fetch(callbackUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const response = await this.withTimeout(
      fetchPromise,
      this.localApprovalConfig.timeoutMs,
      () => controller.abort()
    );

    if (!response.ok) {
      throw new Error(`Approval callback returned status ${response.status}`);
    }

    let body: unknown;
    const text = await response.text();

    if (!text.trim()) {
      body = {};
    } else {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        throw new Error('Approval callback must return a JSON object');
      }
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new Error('Approval callback must return a JSON object');
    }

    return body as Record<string, unknown>;
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    onTimeout: () => void
  ): Promise<T> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timeoutId = setTimeout(() => {
            onTimeout();
            reject(new LocalApprovalTimeoutError(timeoutMs));
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  private extractLocalApprovalReason(response: Record<string, unknown>): string | undefined {
    const reason = response[this.localApprovalConfig.responseSchema.reasonField];
    if (typeof reason === 'string' && reason.trim().length > 0) {
      return reason;
    }
    return undefined;
  }

  private normalizeApprovalDecision(value: unknown): 'allow' | 'deny' | null {
    if (typeof value === 'boolean') {
      return value ? 'allow' : 'deny';
    }

    if (typeof value === 'number') {
      if (value === 1) return 'allow';
      if (value === 0) return 'deny';
      return null;
    }

    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim().toLowerCase();
    if (
      normalized === 'allow'
      || normalized === 'allowed'
      || normalized === 'approve'
      || normalized === 'approved'
      || normalized === 'yes'
      || normalized === 'true'
      || normalized === 'ok'
    ) {
      return 'allow';
    }

    if (
      normalized === 'deny'
      || normalized === 'denied'
      || normalized === 'block'
      || normalized === 'blocked'
      || normalized === 'reject'
      || normalized === 'rejected'
      || normalized === 'no'
      || normalized === 'false'
    ) {
      return 'deny';
    }

    return null;
  }

  private isBudgetExceededResult(result: ValidationResult): boolean {
    const metadata = result.metadata;
    if (!metadata) return false;

    const rawFlag = metadata.budgetExceeded ?? metadata.budget_exceeded;
    if (typeof rawFlag === 'boolean') {
      return rawFlag;
    }

    if (typeof rawFlag === 'string') {
      const normalizedFlag = rawFlag.trim().toLowerCase();
      if (
        normalizedFlag === 'true'
        || normalizedFlag === '1'
        || normalizedFlag === 'budget_exceeded'
      ) {
        return true;
      }
    }

    const rawEventType = metadata.eventType ?? metadata.event_type;
    return (
      typeof rawEventType === 'string'
      && rawEventType.trim().toLowerCase() === 'budget_exceeded'
    );
  }

  private resolveDecisionEventType(result: ValidationResult): VetoWebhookEventType | null {
    if (this.isBudgetExceededResult(result)) {
      return 'budget_exceeded';
    }

    if (result.decision === 'deny') {
      return 'deny';
    }

    if (result.decision === 'require_approval') {
      return 'require_approval';
    }

    return null;
  }

  private emitDecisionEvent(
    context: ValidationContext,
    result: ValidationResult
  ): void {
    const eventType = this.resolveDecisionEventType(result);
    if (!eventType) return;

    const severityFromMetadata = this.extractMetadataSeverity(result.metadata);
    const event: VetoWebhookEvent = {
      eventType,
      toolName: context.toolName,
      arguments: context.arguments,
      decision: result.decision,
      reason: result.reason,
      ruleId: this.extractMetadataString(result.metadata, ['ruleId', 'rule_id']),
      severity: eventType === 'budget_exceeded'
        ? severityFromMetadata ?? 'high'
        : severityFromMetadata,
      timestamp: context.timestamp.toISOString(),
    };

    this.eventWebhookEmitter.emit(event);
  }

  private toGuardResult(result: ValidationResult): GuardResult {
    const metadata = result.metadata;
    const ruleId = this.extractMetadataString(metadata, ['ruleId', 'rule_id']);
    const approvalId = this.extractMetadataString(metadata, ['approvalId', 'approval_id']);
    const severity = this.extractMetadataSeverity(metadata);

    const decision: GuardResult['decision'] =
      result.decision === 'deny' || result.decision === 'require_approval'
        ? result.decision
        : 'allow';

    return {
      decision,
      reason: result.reason,
      ruleId,
      severity,
      approvalId,
    };
  }

  private extractMetadataString(
    metadata: Record<string, unknown> | undefined,
    keys: string[]
  ): string | undefined {
    if (!metadata) return undefined;

    for (const key of keys) {
      const value = metadata[key];

      if (typeof value === 'string' && value.trim().length > 0) {
        return value;
      }

      if (typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
      }
    }

    return undefined;
  }

  private extractMetadataSeverity(
    metadata: Record<string, unknown> | undefined
  ): RuleSeverity | undefined {
    if (!metadata) return undefined;

    const raw =
      metadata.severity
      ?? metadata.ruleSeverity
      ?? metadata.rule_severity;

    if (typeof raw !== 'string') return undefined;

    const normalized = raw.trim().toLowerCase();
    if (
      normalized === 'critical'
      || normalized === 'high'
      || normalized === 'medium'
      || normalized === 'low'
      || normalized === 'info'
    ) {
      return normalized;
    }

    return undefined;
  }

  /**
   * Build history summary for API.
   */
  private buildHistorySummary(
    history: readonly import('../types/config.js').ToolCallHistoryEntry[]
  ): ToolCallHistorySummary[] {
    return history.slice(-10).map((entry) => ({
      tool_name: entry.toolName,
      allowed: entry.validationResult.decision !== 'deny',
      timestamp: entry.timestamp.toISOString(),
    }));
  }

  /**
   * Delay helper.
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private validateOutputOrThrow(toolName: string, output: unknown): unknown {
    const outputResult = this.validateOutput(toolName, output);
    if (outputResult.decision === 'block') {
      throw new Error(outputResult.reason ?? `Tool output blocked for ${toolName}`);
    }
    return outputResult.output;
  }


  /**
   * Wrap tools with Veto validation (provider-agnostic).
   *
   * This method accepts tools of any type and returns them with the same type,
   * but with Veto validation injected into the execution function.
   * Works with LangChain tools, custom tools, or any tool that has a callable function.
   *
   * @param tools - Array of tools to wrap (LangChain, custom, etc.)
   * @returns The same tools with Veto validation injected
   *
   * @example
   * ```typescript
   * import { createAgent, tool } from 'langchain';
   * import { Veto } from 'veto-sdk';
   *
   * const tools = [
   *   tool(({ query }) => `Results for: ${query}`, {
   *     name: 'search',
   *     schema: z.object({ query: z.string() }),
   *   }),
   * ];
   *
   * const veto = await Veto.init();
   * const wrappedTools = veto.wrap(tools);
   *
   * const agent = createAgent({
   *   model: 'openai:gpt-4o',
   *   tools: wrappedTools, // Same type as input!
   * });
   * ```
   */
  wrap<T extends { name: string }>(tools: T[]): T[] {
    return tools.map((tool) => this.wrapTool(tool));
  }

  /**
   * Wrap a single tool with Veto validation (provider-agnostic).
   *
   * @param tool - The tool to wrap
   * @returns The same tool with Veto validation injected
   */
  wrapTool<T extends { name: string }>(tool: T): T {
    const toolName = tool.name;
    const toolAny = tool as Record<string, unknown>;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const veto = this;

    // For LangChain tools, we need to wrap the 'func' property
    // and also override 'invoke' to ensure validation happens
    if (typeof toolAny.func === 'function') {
      const originalFunc = toolAny.func as (input: Record<string, unknown>) => unknown;

      // Create a new object that inherits from the original
      const wrapped = Object.create(Object.getPrototypeOf(tool));
      Object.assign(wrapped, tool);

      // Create wrapped func that validates before executing
      const wrappedFunc = async (input: Record<string, unknown>): Promise<unknown> => {
        // Validate with Veto
        const result = await veto.validateToolCall({
          id: generateToolCallId(),
          name: toolName,
          arguments: input,
        });

        if (!result.allowed) {
          throw new ToolCallDeniedError(
            toolName,
            result.originalCall.id || '',
            result.validationResult
          );
        }

        // Execute the original function with potentially modified arguments
        const finalArgs = result.finalArguments ?? input;
        const executionResult = await originalFunc.call(tool, finalArgs);
        return veto.validateOutputOrThrow(toolName, executionResult);
      };

      // Replace func
      wrapped.func = wrappedFunc;

      // Override invoke to use our wrapped func
      if (typeof toolAny.invoke === 'function') {
        const originalInvoke = toolAny.invoke as (...args: unknown[]) => Promise<unknown>;
        wrapped.invoke = async function (input: Record<string, unknown>, ...rest: unknown[]): Promise<unknown> {
          // Validate with Veto first
          const result = await veto.validateToolCall({
            id: generateToolCallId(),
            name: toolName,
            arguments: input,
          });

          if (!result.allowed) {
            throw new ToolCallDeniedError(
              toolName,
              result.originalCall.id || '',
              result.validationResult
            );
          }

          // Call original invoke with potentially modified arguments
          const finalArgs = result.finalArguments ?? input;
          const executionResult = await originalInvoke.call(tool, finalArgs, ...rest);
          return veto.validateOutputOrThrow(toolName, executionResult);
        };
      }

      veto.logger.debug('Tool wrapped', { name: toolName });
      return wrapped as T;
    }

    // Fallback for other tool types (handler, run, execute, etc.)
    const execFunctionKeys = ['handler', 'run', 'execute', 'call', '_call'];

    for (const key of execFunctionKeys) {
      if (typeof toolAny[key] === 'function') {
        const originalFunc = toolAny[key] as (...args: unknown[]) => unknown;

        const wrapped = Object.create(Object.getPrototypeOf(tool));
        Object.assign(wrapped, tool);

        const wrappedFunc = async (...args: unknown[]): Promise<unknown> => {
          let callArgs: Record<string, unknown>;
          if (args.length === 1 && typeof args[0] === 'object' && args[0] !== null) {
            callArgs = args[0] as Record<string, unknown>;
          } else {
            callArgs = { args };
          }

          const result = await veto.validateToolCall({
            id: generateToolCallId(),
            name: toolName,
            arguments: callArgs,
          });

          if (!result.allowed) {
            throw new ToolCallDeniedError(
              toolName,
              result.originalCall.id || '',
              result.validationResult
            );
          }

          const finalArgs = result.finalArguments ?? callArgs;
          if (args.length === 1 && typeof args[0] === 'object') {
            const executionResult = await originalFunc.call(tool, finalArgs);
            return veto.validateOutputOrThrow(toolName, executionResult);
          }
          const executionResult = await originalFunc.apply(tool, args);
          return veto.validateOutputOrThrow(toolName, executionResult);
        };

        wrapped[key] = wrappedFunc;
        veto.logger.debug('Tool wrapped', { name: toolName });
        return wrapped as T;
      }
    }

    // Check if this is an MCP tool (has inputSchema but no execution function)
    if (isMCPTool(tool)) {
      veto.logger.debug('MCP tool detected, no execution function to wrap', { name: toolName });
      return tool;
    }

    // No wrappable function found, return as-is
    veto.logger.warn('No wrappable function found on tool', { name: toolName });
    return tool;
  }

  /**
   * Wrap MCP tools with Veto validation.
   *
   * Returns a wrapped `callTool` function that validates arguments before
   * forwarding to the real MCP server. The original MCP tool definitions
   * are returned unmodified (pass them to the AI model as-is).
   *
   * @param tools - Array of MCP tool definitions from the server
   * @param serverClient - MCP server client with `callTool` method
   * @returns Object with `tools` (original definitions) and `callTool` (validated caller)
   *
   * @example
   * ```typescript
   * import { Veto } from 'veto-sdk';
   *
   * const veto = await Veto.init();
   * const mcpTools = await mcpServer.listTools();
   *
   * const { tools, callTool } = veto.wrapMCPTools(mcpTools, mcpServer);
   *
   * // Pass `tools` to the AI model
   * // Use `callTool` instead of `mcpServer.callTool`
   * const result = await callTool({ name: 'read_file', arguments: { path: '/etc/passwd' } });
   * ```
   */
  wrapMCPTools(
    tools: MCPTool[],
    serverClient: MCPServerClient
  ): {
    tools: MCPTool[];
    callTool: (args: { name: string; arguments?: Record<string, unknown> }) => Promise<MCPToolResult>;
  } {
    const toolDefs = tools.map(fromMCP);

    // Register tool definitions for cloud mode
    if (this.validationMode === 'cloud') {
      this.registerTools(
        toolDefs.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: Object.entries(t.inputSchema.properties ?? {}).map(
            ([name, prop]) => ({
              name,
              type: (prop as Record<string, unknown>).type as string ?? 'string',
              description: (prop as Record<string, unknown>).description as string | undefined,
              required: t.inputSchema.required?.includes(name) ?? false,
            })
          ),
        }))
      ).catch(() => {});
    }

    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const veto = this;

    const callTool = async (args: {
      name: string;
      arguments?: Record<string, unknown>;
    }): Promise<MCPToolResult> => {
      const callArgs = args.arguments ?? {};

      const result = await veto.validateToolCall({
        id: generateToolCallId(),
        name: args.name,
        arguments: callArgs,
      });

      if (!result.allowed) {
        throw new ToolCallDeniedError(
          args.name,
          result.originalCall.id || '',
          result.validationResult
        );
      }

      const finalArgs = result.finalArguments ?? callArgs;
      const executionResult = await serverClient.callTool({ name: args.name, arguments: finalArgs });
      return veto.validateOutputOrThrow(args.name, executionResult) as MCPToolResult;
    };

    this.logger.debug('MCP tools wrapped', { count: tools.length });
    return { tools, callTool };
  }

  /**
   * Validate a tool call through the interceptor pipeline.
   *
   * Used internally by `wrap()` and by framework integrations
   * (Vercel AI SDK, LangChain) to validate tool calls against
   * configured rules and policies.
   */
  async validateToolCall(call: ToolCall): Promise<InterceptionResult> {
    const normalizedCall: ToolCall = {
      ...call,
      id: call.id || generateToolCallId(),
    };

    try {
      return await this.interceptor.intercept(normalizedCall);
    } catch (error) {
      if (error instanceof BudgetExceededError) {
        this.eventWebhookEmitter.emit({
          eventType: 'budget_exceeded',
          toolName: normalizedCall.name,
          arguments: normalizedCall.arguments,
          decision: 'deny',
          reason: error.message,
          severity: 'high',
          timestamp: new Date().toISOString(),
        });
      }
      throw error;
    }
  }

  /**
   * Validate and transform tool output against configured output rules.
   */
  validateOutput(toolName: string, output: unknown): OutputValidationResult {
    return this.outputValidator.validate(toolName, output);
  }

  /**
   * Run a standalone guard check without wrapping or executing a tool.
   *
   * Unlike interceptor execution, this returns raw validation outcomes in log mode.
   */
  async guard(
    toolName: string,
    args: Record<string, unknown>,
    context: GuardContext = {}
  ): Promise<GuardResult> {
    const validationContext: ValidationContext = {
      toolName,
      arguments: args,
      callId: generateToolCallId(),
      timestamp: new Date(),
      callHistory: this.historyTracker.getAll(),
      sessionId: context.sessionId ?? this.sessionId,
      agentId: context.agentId ?? this.agentId,
      userId: context.userId ?? this.userId,
      role: context.role ?? this.role,
      source: 'guard',
    };

    const aggregatedResult = await this.validationEngine.validate(validationContext);
    const validationResult = aggregatedResult.finalResult;

    this.historyTracker.record(
      toolName,
      args,
      validationResult,
      aggregatedResult.totalDurationMs
    );

    this.emitDecisionEvent(validationContext, validationResult);

    return this.toGuardResult(validationResult);
  }



  /**
   * Cache an approval preference for a tool.
   *
   * When set, subsequent require_approval decisions for this tool
   * are auto-resolved from the cache without polling the server.
   *
   * @param toolName - The tool to set the preference for
   * @param preference - 'approve_all' or 'deny_all'
   */
  setApprovalPreference(
    toolName: string,
    preference: 'approve_all' | 'deny_all'
  ): void {
    this.approvalPreferences.set(toolName, preference);
    this.logger.info('Approval preference set', {
      tool: toolName,
      preference,
    });
  }

  /**
   * Clear cached approval preferences.
   *
   * @param toolName - If provided, clear only for this tool. Otherwise clear all.
   */
  clearApprovalPreferences(toolName?: string): void {
    if (toolName) {
      this.approvalPreferences.delete(toolName);
    } else {
      this.approvalPreferences.clear();
    }
  }

  /**
   * Get the cached approval preference for a tool, if any.
   */
  getApprovalPreference(
    toolName: string
  ): 'approve_all' | 'deny_all' | undefined {
    return this.approvalPreferences.get(toolName);
  }

  /**
   * Register tool schemas with Veto Cloud for dashboard policy configuration.
   * No-op if not in cloud mode or if registrations array is empty.
   */
  async registerTools(registrations: CloudToolRegistration[]): Promise<void> {
    if (this.validationMode !== 'cloud' || registrations.length === 0) return;
    try {
      await this.getCloudClient().registerTools(registrations);
    } catch {
      this.logger.debug('Cloud tool registration failed (best-effort)');
    }
  }

  /**
   * Get history statistics.
   */
  getHistoryStats(): HistoryStats {
    return this.historyTracker.getStats();
  }

  /**
   * Export decision history as JSON or CSV.
   */
  exportDecisions(format: DecisionExportFormat = 'json'): string {
    return this.historyTracker.exportDecisions(format);
  }

  /**
   * Clear call history.
   */
  clearHistory(): void {
    this.historyTracker.clear();
  }

  getBudgetStatus(): BudgetStatus | null {
    return this.budgetTracker?.getStatus() ?? null;
  }

  resetBudget(): void {
    this.budgetTracker?.reset();
  }
}

// Re-export error classes
export { ToolCallDeniedError };
export { BudgetExceededError };
