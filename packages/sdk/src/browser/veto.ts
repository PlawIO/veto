import type { ValidationContext, ValidationResult, Validator, NamedValidator, LogLevel } from '../types/config.js';
import type { OutputRule, Rule, RuleSeverity } from '../rules/types.js';
import { createLogger, type Logger } from '../utils/logger.js';
import { generateId, generateToolCallId } from '../utils/id.js';
import { evaluateConditionCollections } from '../rules/condition-evaluator.js';
import { compile, evaluate } from '../compiler/index.js';
import type { ASTNode } from '../compiler/index.js';
import { HistoryTracker, type HistoryStats } from '../core/history.js';
import { BudgetTracker, type BudgetStatus, type BudgetConfig, type ToolCostMap } from '../core/budget.js';
import { OutputValidator, type OutputValidationResult } from '../core/output-validator.js';
import { ToolCallDeniedError } from '../core/interceptor.js';

export type VetoMode = 'strict' | 'log';

export interface GuardContext {
  sessionId?: string;
  agentId?: string;
  userId?: string;
  role?: string;
}

export interface GuardResult {
  decision: 'allow' | 'deny' | 'require_approval';
  reason?: string;
  ruleId?: string;
  severity?: RuleSeverity;
  approvalId?: string;
}

export interface BrowserCloudPoliciesResponse {
  policies: Rule[];
  outputRules?: OutputRule[];
}

export interface BrowserCloudClient {
  fetchPolicies: () => Promise<BrowserCloudPoliciesResponse>;
  logDecision: (request: {
    tool_name: string;
    arguments: Record<string, unknown>;
    decision: 'allow' | 'deny';
    reason?: string;
    mode: 'deterministic';
    latency_ms: number;
    source: 'client';
    context?: Record<string, unknown>;
  }) => void;
}

export interface VetoBrowserOptions {
  rules: Rule[];
  outputRules?: OutputRule[];
  mode?: VetoMode;
  logLevel?: LogLevel;
  sessionId?: string;
  agentId?: string;
  userId?: string;
  role?: string;
  validators?: (Validator | NamedValidator)[];
  apiKey?: string;
  endpoint?: string;
  cloudClient?: BrowserCloudClient;
  onApprovalRequired?: (
    context: ValidationContext,
    approvalId: string
  ) => void | Promise<void>;
  budget?: BudgetConfig;
  costs?: ToolCostMap;
}

interface LoadedRulesState {
  allRules: Rule[];
  allOutputRules: OutputRule[];
  rulesByTool: Map<string, Rule[]>;
  outputRulesByTool: Map<string, OutputRule[]>;
  globalRules: Rule[];
  globalOutputRules: OutputRule[];
}

interface VetoFromCloudOptions {
  apiKey: string;
  endpoint?: string;
  refreshIntervalMs?: number;
}

function toNamedValidators(
  validators: (Validator | NamedValidator)[] | undefined
): NamedValidator[] {
  if (!validators || validators.length === 0) {
    return [];
  }

  return validators.map((validator, index) => {
    if (typeof validator === 'function') {
      return {
        name: `validator-${index}`,
        validate: validator,
        priority: 100,
      };
    }

    return {
      priority: validator.priority ?? 100,
      ...validator,
    };
  }).sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
}

function createEmptyState(): LoadedRulesState {
  return {
    allRules: [],
    allOutputRules: [],
    rulesByTool: new Map(),
    outputRulesByTool: new Map(),
    globalRules: [],
    globalOutputRules: [],
  };
}

function indexRules(rules: Rule[], outputRules: OutputRule[]): LoadedRulesState {
  const state = createEmptyState();

  for (const rule of rules) {
    if (rule.enabled === false) continue;
    state.allRules.push(rule);

    if (!rule.tools || rule.tools.length === 0) {
      state.globalRules.push(rule);
      continue;
    }

    for (const tool of rule.tools) {
      const existing = state.rulesByTool.get(tool) ?? [];
      existing.push(rule);
      state.rulesByTool.set(tool, existing);
    }
  }

  for (const outputRule of outputRules) {
    if (outputRule.enabled === false) continue;
    state.allOutputRules.push(outputRule);

    if (!outputRule.tools || outputRule.tools.length === 0) {
      state.globalOutputRules.push(outputRule);
      continue;
    }

    for (const tool of outputRule.tools) {
      const existing = state.outputRulesByTool.get(tool) ?? [];
      existing.push(outputRule);
      state.outputRulesByTool.set(tool, existing);
    }
  }

  return state;
}

function normalizePoliciesResponse(payload: unknown): BrowserCloudPoliciesResponse {
  const objectPayload = (payload && typeof payload === 'object' && !Array.isArray(payload))
    ? payload as Record<string, unknown>
    : {};

  const rules = Array.isArray(objectPayload.policies)
    ? objectPayload.policies as Rule[]
    : Array.isArray(objectPayload.rules)
      ? objectPayload.rules as Rule[]
      : Array.isArray(objectPayload.data)
        ? objectPayload.data as Rule[]
        : [];

  const outputRules = Array.isArray(objectPayload.outputRules)
    ? objectPayload.outputRules as OutputRule[]
    : Array.isArray(objectPayload.output_rules)
      ? objectPayload.output_rules as OutputRule[]
      : [];

  return {
    policies: rules,
    outputRules,
  };
}

function createInlineCloudClient(
  apiKey: string,
  endpoint: string | undefined,
  logger: Logger
): BrowserCloudClient {
  const baseUrl = (endpoint ?? 'https://api.runveto.com').replace(/\/$/, '');
  const headers = {
    'Content-Type': 'application/json',
    'X-Veto-API-Key': apiKey,
  };

  return {
    async fetchPolicies(): Promise<BrowserCloudPoliciesResponse> {
      const response = await fetch(`${baseUrl}/v1/policies`, {
        method: 'GET',
        headers,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(`API returned status ${response.status}: ${errorText}`);
      }

      const payload = await response.json() as unknown;
      return normalizePoliciesResponse(payload);
    },

    logDecision(request): void {
      fetch(`${baseUrl}/v1/decisions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(request),
      }).catch((error) => {
        logger.debug('Cloud decision logging failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    },
  };
}

export class Veto {
  private readonly logger: Logger;
  private readonly mode: VetoMode;
  private readonly sessionId?: string;
  private readonly agentId?: string;
  private readonly userId?: string;
  private readonly role?: string;
  private readonly validators: NamedValidator[];
  private readonly historyTracker: HistoryTracker;
  private readonly budgetTracker: BudgetTracker | null;
  private readonly outputValidator: OutputValidator;
  private readonly cloudClient: BrowserCloudClient | null;
  private readonly onApprovalRequired?: (
    context: ValidationContext,
    approvalId: string
  ) => void | Promise<void>;

  private rulesState: LoadedRulesState;
  private readonly compiledExpressionCache = new Map<string, ASTNode>();

  private constructor(options: VetoBrowserOptions, logger: Logger) {
    this.logger = logger;
    this.mode = options.mode ?? 'strict';
    this.sessionId = options.sessionId ?? generateId('session');
    this.agentId = options.agentId;
    this.userId = options.userId;
    this.role = options.role;
    this.validators = toNamedValidators(options.validators);
    this.rulesState = indexRules(options.rules, options.outputRules ?? []);
    this.cloudClient = options.cloudClient ?? (
      options.apiKey
        ? createInlineCloudClient(options.apiKey, options.endpoint, logger)
        : null
    );
    this.onApprovalRequired = options.onApprovalRequired;

    this.historyTracker = new HistoryTracker({
      maxSize: 100,
      logger: this.logger,
    });

    this.budgetTracker = options.budget && options.budget.max > 0
      ? new BudgetTracker({
          config: options.budget,
          costs: options.costs ?? {},
          logger: this.logger,
        })
      : null;

    this.outputValidator = new OutputValidator({
      logger: this.logger,
      getRulesForTool: (toolName) => this.getOutputRulesForTool(toolName),
    });
  }

  static fromRules(options: VetoBrowserOptions): Veto {
    const logger = createLogger(options.logLevel ?? 'warn');
    return new Veto(options, logger);
  }

  static async fromCloud(options: VetoFromCloudOptions): Promise<Veto> {
    const logger = createLogger('warn');
    const cloudClient = createInlineCloudClient(options.apiKey, options.endpoint, logger);
    const policies = await cloudClient.fetchPolicies();

    const veto = Veto.fromRules({
      rules: policies.policies,
      outputRules: policies.outputRules,
      apiKey: options.apiKey,
      endpoint: options.endpoint,
      cloudClient,
    });

    if (options.refreshIntervalMs && options.refreshIntervalMs > 0) {
      setInterval(() => {
        void veto.refreshRules().catch((error) => {
          veto.logger.warn('Failed to refresh cloud policies', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }, options.refreshIntervalMs);
    }

    return veto;
  }

  private getRulesForTool(toolName: string): Rule[] {
    const toolSpecific = this.rulesState.rulesByTool.get(toolName) ?? [];
    return [...this.rulesState.globalRules, ...toolSpecific];
  }

  private getOutputRulesForTool(toolName: string): OutputRule[] {
    const toolSpecific = this.rulesState.outputRulesByTool.get(toolName) ?? [];
    return [...this.rulesState.globalOutputRules, ...toolSpecific];
  }

  private resolveSessionId(context: GuardContext): string | undefined {
    return context.sessionId ?? this.sessionId;
  }

  private resolveAgentId(context: GuardContext): string | undefined {
    return context.agentId ?? this.agentId;
  }

  private resolveUserId(context: GuardContext): string | undefined {
    return context.userId ?? this.userId;
  }

  private resolveRole(context: GuardContext): string | undefined {
    return context.role ?? this.role;
  }

  private shouldApplyLogOverride(source: 'guard' | 'interceptor'): boolean {
    return this.mode === 'log' && source !== 'guard';
  }

  private toRuleMetadata(rule: Rule): Record<string, unknown> {
    return {
      source: 'local',
      ruleId: rule.id,
      severity: rule.severity,
      ruleName: rule.name,
    };
  }

  private normalizeAgentScope(scope: readonly unknown[]): string[] {
    return scope.filter((value): value is string => typeof value === 'string');
  }

  private matchesRuleAgents(rule: Rule, agentId?: string): boolean {
    if (!rule.agents) return true;

    if (Array.isArray(rule.agents)) {
      const allowed = this.normalizeAgentScope(rule.agents);
      return agentId !== undefined && allowed.includes(agentId);
    }

    const excluded = this.normalizeAgentScope(rule.agents.not);
    return agentId === undefined || !excluded.includes(agentId);
  }

  private evaluateExpression(
    expression: string,
    context: Record<string, unknown>
  ): boolean {
    let ast = this.compiledExpressionCache.get(expression);

    if (!ast) {
      try {
        ast = compile(expression);
        this.compiledExpressionCache.set(expression, ast);
      } catch {
        return false;
      }
    }

    try {
      return Boolean(evaluate(ast, context));
    } catch {
      return false;
    }
  }

  private buildEvaluationContext(
    toolName: string,
    args: Record<string, unknown>,
    context: GuardContext
  ): Record<string, unknown> {
    return {
      ...args,
      tool_name: toolName,
      arguments: args,
      session_id: this.resolveSessionId(context),
      agent_id: this.resolveAgentId(context),
      user_id: this.resolveUserId(context),
      role: this.resolveRole(context),
    };
  }

  private validateLocal(
    toolName: string,
    args: Record<string, unknown>,
    context: GuardContext,
    source: 'guard' | 'interceptor'
  ): ValidationResult {
    const rules = this.getRulesForTool(toolName);

    if (rules.length === 0) {
      return { decision: 'allow' };
    }

    const evaluationContext = this.buildEvaluationContext(toolName, args, context);
    let firstAllowRule: Rule | null = null;

    for (const rule of rules) {
      if (!this.matchesRuleAgents(rule, this.resolveAgentId(context))) {
        continue;
      }

      const matches = evaluateConditionCollections(
        rule.conditions,
        rule.condition_groups,
        evaluationContext,
        {
          now: new Date(),
          evaluateExpression: (expression, evalContext) =>
            this.evaluateExpression(expression, evalContext),
        }
      );

      if (!matches) continue;

      const reason = rule.description ?? `Matched rule: ${rule.name}`;
      const metadata = this.toRuleMetadata(rule);

      if (rule.action === 'require_approval') {
        if (this.shouldApplyLogOverride(source)) {
          return {
            decision: 'allow',
            reason: `[LOG MODE] Would require approval: ${reason}`,
            metadata: { ...metadata, blocked_in_strict_mode: true },
          };
        }

        if (source === 'guard') {
          return {
            decision: 'require_approval',
            reason,
            metadata,
          };
        }

        return {
          decision: 'deny',
          reason: `Approval required: ${reason}`,
          metadata: {
            ...metadata,
            approval_required: true,
          },
        };
      }

      if (rule.action === 'block') {
        if (this.shouldApplyLogOverride(source)) {
          return {
            decision: 'allow',
            reason: `[LOG MODE] Would block: ${reason}`,
            metadata: { ...metadata, blocked_in_strict_mode: true },
          };
        }

        return {
          decision: 'deny',
          reason,
          metadata,
        };
      }

      if (rule.action === 'allow' && !firstAllowRule) {
        firstAllowRule = rule;
      }
    }

    if (firstAllowRule) {
      return {
        decision: 'allow',
        reason: firstAllowRule.description ?? `Allowed by rule: ${firstAllowRule.name}`,
        metadata: this.toRuleMetadata(firstAllowRule),
      };
    }

    return { decision: 'allow' };
  }

  private async runValidators(context: ValidationContext): Promise<ValidationResult | null> {
    for (const validator of this.validators) {
      if (validator.toolFilter && !validator.toolFilter.includes(context.toolName)) {
        continue;
      }

      const result = await validator.validate(context);
      if (
        result.decision === 'deny'
        || result.decision === 'require_approval'
        || result.decision === 'modify'
      ) {
        return result;
      }
    }

    return null;
  }

  private toGuardResult(result: ValidationResult): GuardResult {
    const metadata = result.metadata;
    const ruleId = typeof metadata?.ruleId === 'string'
      ? metadata.ruleId
      : typeof metadata?.rule_id === 'string'
        ? metadata.rule_id
        : undefined;

    const severity = typeof metadata?.severity === 'string'
      ? metadata.severity as RuleSeverity
      : typeof metadata?.ruleSeverity === 'string'
        ? metadata.ruleSeverity as RuleSeverity
        : typeof metadata?.rule_severity === 'string'
          ? metadata.rule_severity as RuleSeverity
          : undefined;

    const approvalId = typeof metadata?.approvalId === 'string'
      ? metadata.approvalId
      : typeof metadata?.approval_id === 'string'
        ? metadata.approval_id
        : undefined;

    return {
      decision: result.decision === 'deny' || result.decision === 'require_approval'
        ? result.decision
        : 'allow',
      reason: result.reason,
      ruleId,
      severity,
      approvalId,
    };
  }

  private reportDecision(
    validationContext: ValidationContext,
    result: ValidationResult,
    durationMs: number
  ): void {
    if (!this.cloudClient) return;

    this.cloudClient.logDecision({
      tool_name: validationContext.toolName,
      arguments: validationContext.arguments,
      decision: result.decision === 'deny' ? 'deny' : 'allow',
      reason: result.reason,
      mode: 'deterministic',
      latency_ms: durationMs,
      source: 'client',
      context: {
        call_id: validationContext.callId,
        timestamp: validationContext.timestamp.toISOString(),
        session_id: validationContext.sessionId,
        agent_id: validationContext.agentId,
        user_id: validationContext.userId,
        role: validationContext.role,
      },
    });
  }

  async guard(
    toolName: string,
    args: Record<string, unknown>,
    context: GuardContext = {}
  ): Promise<GuardResult> {
    const start = Date.now();
    const validationContext: ValidationContext = {
      toolName,
      arguments: args,
      callId: generateToolCallId(),
      timestamp: new Date(),
      callHistory: this.historyTracker.getAll(),
      sessionId: this.resolveSessionId(context),
      agentId: this.resolveAgentId(context),
      userId: this.resolveUserId(context),
      role: this.resolveRole(context),
      source: 'guard',
    };

    let result = this.validateLocal(toolName, args, context, 'guard');
    const validatorResult = await this.runValidators(validationContext);
    if (validatorResult) {
      result = validatorResult;
    }

    const durationMs = Date.now() - start;
    this.historyTracker.record(toolName, args, result, durationMs);
    this.reportDecision(validationContext, result, durationMs);

    return this.toGuardResult(result);
  }

  async validateToolCall(call: {
    id?: string;
    name: string;
    arguments: Record<string, unknown>;
  }): Promise<{
    allowed: boolean;
    validationResult: ValidationResult;
    originalCall: { id?: string; name: string; arguments: Record<string, unknown> };
    finalArguments: Record<string, unknown>;
  }> {
    const guardResult = await this.guard(call.name, call.arguments);
    const validationResult: ValidationResult = {
      decision: guardResult.decision === 'deny' || guardResult.decision === 'require_approval'
        ? guardResult.decision
        : 'allow',
      reason: guardResult.reason,
      metadata: {
        ruleId: guardResult.ruleId,
        severity: guardResult.severity,
        approvalId: guardResult.approvalId,
      },
    };

    return {
      allowed: validationResult.decision !== 'deny',
      validationResult,
      originalCall: call,
      finalArguments: call.arguments,
    };
  }

  private async denyWithApprovalHook(
    toolName: string,
    reason: string | undefined,
    context: ValidationContext,
    approvalId?: string
  ): Promise<never> {
    if (approvalId && this.onApprovalRequired) {
      await this.onApprovalRequired(context, approvalId);
    }

    throw new ToolCallDeniedError(
      toolName,
      context.callId,
      {
        decision: 'deny',
        reason,
        metadata: { approvalId },
      }
    );
  }

  wrap<T extends { name: string }>(tools: T[]): T[] {
    return tools.map((tool) => this.wrapTool(tool));
  }

  wrapTool<T extends { name: string }>(tool: T): T {
    const toolAny = tool as Record<string, unknown>;
    const execKeys = ['func', 'handler', 'run', 'execute', 'call', '_call'];
    const executableKey = execKeys.find((key) => typeof toolAny[key] === 'function');

    if (!executableKey) {
      return tool;
    }

    const wrapped = Object.create(Object.getPrototypeOf(tool));
    Object.assign(wrapped, tool);
    const original = toolAny[executableKey] as (...args: unknown[]) => unknown;
    const toolName = tool.name;

    wrapped[executableKey] = async (...args: unknown[]): Promise<unknown> => {
      const callArgs = args.length === 1 && typeof args[0] === 'object' && args[0] !== null
        ? args[0] as Record<string, unknown>
        : { args };

      const callId = generateToolCallId();
      const validationContext: ValidationContext = {
        toolName,
        arguments: callArgs,
        callId,
        timestamp: new Date(),
        callHistory: this.historyTracker.getAll(),
        sessionId: this.sessionId,
        agentId: this.agentId,
        userId: this.userId,
        role: this.role,
        source: 'interceptor',
      };

      const reserved = this.budgetTracker?.reserve(toolName, callArgs) ?? 0;
      const guardResult = await this.guard(toolName, callArgs, {
        sessionId: this.sessionId,
        agentId: this.agentId,
        userId: this.userId,
        role: this.role,
      });

      if (guardResult.decision === 'deny') {
        if (reserved > 0) this.budgetTracker?.refund(reserved);
        throw new ToolCallDeniedError(toolName, callId, {
          decision: 'deny',
          reason: guardResult.reason,
          metadata: {
            ruleId: guardResult.ruleId,
            severity: guardResult.severity,
          },
        });
      }

      if (guardResult.decision === 'require_approval') {
        if (reserved > 0) this.budgetTracker?.refund(reserved);
        await this.denyWithApprovalHook(
          toolName,
          guardResult.reason,
          validationContext,
          guardResult.approvalId
        );
      }

      const executionResult = args.length === 1 && typeof args[0] === 'object' && args[0] !== null
        ? await original.call(tool, callArgs)
        : await original.apply(tool, args);
      const outputResult = this.validateOutput(toolName, executionResult);

      if (outputResult.decision === 'block') {
        throw new Error(outputResult.reason ?? `Tool output blocked for ${toolName}`);
      }

      return outputResult.output;
    };

    return wrapped as T;
  }

  validateOutput(toolName: string, output: unknown): OutputValidationResult {
    return this.outputValidator.validate(toolName, output);
  }

  async refreshRules(): Promise<void> {
    if (!this.cloudClient) {
      throw new Error('No cloud client configured');
    }

    const remote = await this.cloudClient.fetchPolicies();
    this.rulesState = indexRules(remote.policies, remote.outputRules ?? []);
    this.compiledExpressionCache.clear();
  }

  getHistoryStats(): HistoryStats {
    return this.historyTracker.getStats();
  }

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

export { ToolCallDeniedError };
