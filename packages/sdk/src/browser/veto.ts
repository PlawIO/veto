import type {
  NamedValidator,
  ValidationContext,
  ValidationResult,
  Validator,
} from '../types/config.js';
import type { OutputRule, Rule, RuleSeverity } from '../rules/types.js';
import { createLogger, type Logger } from '../utils/logger.js';
import { generateId, generateToolCallId } from '../utils/id.js';
import { evaluateConditionCollections } from '../rules/condition-evaluator.js';
import { compile, evaluate } from '../compiler/index.js';
import type { ASTNode } from '../compiler/index.js';
import { HistoryTracker, type HistoryStats } from '../core/history.js';
import { BudgetTracker, type BudgetStatus } from '../core/budget.js';
import { OutputValidator, type OutputValidationResult } from '../core/output-validator.js';
import { ToolCallDeniedError } from '../core/interceptor.js';
import type {
  BrowserCloudClient,
  BrowserCloudDecisionRequest,
  BrowserCloudPoliciesResponse,
  GuardContext,
  GuardResult,
  VetoBrowserOptions,
  VetoFromCloudOptions,
  VetoMode,
} from './types.js';

interface LoadedRulesState {
  allRules: Rule[];
  allOutputRules: OutputRule[];
  rulesByTool: Map<string, Rule[]>;
  outputRulesByTool: Map<string, OutputRule[]>;
  globalRules: Rule[];
  globalOutputRules: OutputRule[];
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
  const baseUrl = (endpoint ?? 'https://api.veto.so').replace(/\/$/, '');
  const headers = {
    'Content-Type': 'application/json',
    'X-Veto-API-Key': apiKey,
  };
  const maxRetries = 3;
  const baseRetryDelayMs = 500;
  const queue: Array<{ request: BrowserCloudDecisionRequest; attempts: number }> = [];
  let flushTimeoutId: ReturnType<typeof setTimeout> | null = null;
  let isFlushing = false;

  const scheduleFlush = (delayMs = 0): void => {
    if (flushTimeoutId) return;

    flushTimeoutId = setTimeout(() => {
      flushTimeoutId = null;
      void flushQueue();
    }, delayMs);
  };

  const sendDecision = async (request: BrowserCloudDecisionRequest): Promise<void> => {
    const response = await fetch(`${baseUrl}/v1/decisions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      throw new Error(`API returned status ${response.status}`);
    }
  };

  const flushQueue = async (): Promise<void> => {
    if (isFlushing) return;
    isFlushing = true;

    try {
      const passLimit = queue.length;
      let processed = 0;

      while (queue.length > 0 && processed < passLimit) {
        const item = queue[0];
        if (!item) break;
        processed += 1;

        try {
          await sendDecision(item.request);
          queue.shift();
        } catch (error) {
          item.attempts += 1;
          queue.shift();

          if (item.attempts > maxRetries) {
            logger.warn('Dropping cloud decision log after retries', {
              attempts: item.attempts - 1,
              error: error instanceof Error ? error.message : String(error),
            });
            continue;
          }

          queue.push(item);

          const retryDelayMs = Math.min(
            30_000,
            baseRetryDelayMs * (2 ** (item.attempts - 1))
          );

          logger.debug('Retrying cloud decision log', {
            attempt: item.attempts,
            retryDelayMs,
          });
          scheduleFlush(retryDelayMs);
        }
      }
    } finally {
      isFlushing = false;
    }

    if (queue.length > 0 && !flushTimeoutId) {
      scheduleFlush();
    }
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
      queue.push({ request, attempts: 0 });
      scheduleFlush();
    },

    dispose(): void {
      if (flushTimeoutId) {
        clearTimeout(flushTimeoutId);
        flushTimeoutId = null;
      }
      queue.length = 0;
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
  private readonly onDecisionMade?: (result: GuardResult & { toolName: string }) => void;

  private rulesState: LoadedRulesState;
  private readonly compiledExpressionCache = new Map<string, ASTNode>();
  private refreshIntervalId: ReturnType<typeof setInterval> | null = null;

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
    this.onDecisionMade = options.onDecisionMade;

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

    veto.setRefreshInterval(options.refreshIntervalMs);

    return veto;
  }

  private setRefreshInterval(refreshIntervalMs?: number): void {
    if (this.refreshIntervalId) {
      clearInterval(this.refreshIntervalId);
      this.refreshIntervalId = null;
    }

    if (!refreshIntervalMs || refreshIntervalMs <= 0) {
      return;
    }

    this.refreshIntervalId = setInterval(() => {
      void this.refreshRules().catch((error) => {
        this.logger.warn('Failed to refresh cloud policies', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, refreshIntervalMs);
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
    return (this.mode === 'log' || this.mode === 'shadow') && source !== 'guard';
  }

  private applyShadowOverride(
    toolName: string,
    decision: 'deny' | 'require_approval',
    reason: string | undefined,
    metadata?: Record<string, unknown>,
    ruleId?: string
  ): ValidationResult {
    this.logger.warn(
      decision === 'deny'
        ? '[shadow] Tool call would be denied'
        : '[shadow] Tool call would require approval',
      {
        tool: toolName,
        decision,
        reason,
        ruleId,
        shadow: true,
      }
    );

    return {
      decision,
      reason,
      metadata: {
        ...(metadata ?? {}),
        shadow: true,
        shadow_decision: decision,
        shadow_reason: reason,
        shadow_rule_id: ruleId,
      },
    };
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
          if (this.mode === 'shadow') {
            return this.applyShadowOverride(
              toolName,
              'require_approval',
              reason,
              metadata,
              rule.id
            );
          }

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
          if (this.mode === 'shadow') {
            return this.applyShadowOverride(
              toolName,
              'deny',
              reason,
              metadata,
              rule.id
            );
          }

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
      shadow: this.mode === 'shadow' ? true : undefined,
      shadowDecision: (
        this.mode === 'shadow'
        && (result.decision === 'deny' || result.decision === 'require_approval')
      )
        ? result.decision
        : undefined,
    };
  }

  private reportDecision(
    validationContext: ValidationContext,
    result: ValidationResult,
    durationMs: number
  ): void {
    if (!this.cloudClient) return;
    const decision = result.decision === 'allow' ? 'allow' : 'deny';
    const shadowContext = this.mode === 'shadow'
      ? {
          shadow: true,
          shadow_decision: typeof result.metadata?.shadow_decision === 'string'
            ? result.metadata.shadow_decision
            : result.decision,
        }
      : {};

    this.cloudClient.logDecision({
      tool_name: validationContext.toolName,
      arguments: validationContext.arguments,
      decision,
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
        ...shadowContext,
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

    const guardResult = this.toGuardResult(result);
    try {
      const maybePromise = this.onDecisionMade?.({ ...guardResult, toolName });
      if (maybePromise && typeof (maybePromise as any).catch === 'function') {
        (maybePromise as any).catch(() => {});
      }
    } catch {
      // swallow — callback errors must not break guard flow
    }
    return guardResult;
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
        shadow: guardResult.shadow === true ? true : undefined,
        shadow_decision: guardResult.shadowDecision,
      },
    };

    return {
      allowed: validationResult.decision !== 'deny' || guardResult.shadow === true,
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

      if (guardResult.decision === 'deny' && guardResult.shadow !== true) {
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

      if (guardResult.decision === 'require_approval' && guardResult.shadow !== true) {
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

  dispose(): void {
    if (this.refreshIntervalId) {
      clearInterval(this.refreshIntervalId);
      this.refreshIntervalId = null;
    }

    this.cloudClient?.dispose?.();
  }
}

export { ToolCallDeniedError };
