import type { GuardContext, GuardResult, Veto } from '../core/veto.js';

export interface RuntimeToolCall {
  name: string;
  arguments: Record<string, unknown>;
  id?: string;
}

export interface RuntimeGuardOptions {
  context?: GuardContext | ((call: RuntimeToolCall) => GuardContext | undefined);
  onAllow?: (toolName: string, args: Record<string, unknown>) => void | Promise<void>;
  onDeny?: (toolName: string, args: Record<string, unknown>, reason: string) => void | Promise<void>;
  onApprovalRequired?: (
    toolName: string,
    args: Record<string, unknown>,
    approvalId?: string,
  ) => void | Promise<void>;
}

export interface RuntimeGuardDecision {
  decision: GuardResult['decision'];
  allowed: boolean;
  toolName: string;
  arguments: Record<string, unknown>;
  reason?: string;
  approvalId?: string;
  result: GuardResult;
}

export interface GuardedRuntimeExecutionOptions<TResult> extends RuntimeGuardOptions {
  onBlocked?: (decision: RuntimeGuardDecision) => TResult | Promise<TResult>;
}

export class VetoRuntimeAdapterError extends Error {
  readonly decision: GuardResult['decision'];
  readonly toolName: string;
  readonly reason?: string;
  readonly approvalId?: string;

  constructor(decision: RuntimeGuardDecision) {
    const reason = decision.reason ?? (decision.decision === 'require_approval'
      ? 'Approval required'
      : 'Policy violation');
    super(`Tool call ${decision.decision}: ${decision.toolName} - ${reason}`);
    this.name = 'VetoRuntimeAdapterError';
    this.decision = decision.decision;
    this.toolName = decision.toolName;
    this.reason = decision.reason;
    this.approvalId = decision.approvalId;
  }
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

export function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') {
    return asRecord(value);
  }

  if (value.length === 0) {
    return {};
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    return {};
  }
}

export async function guardRuntimeToolCall(
  veto: Veto,
  call: RuntimeToolCall,
  options?: RuntimeGuardOptions,
): Promise<RuntimeGuardDecision> {
  const context = typeof options?.context === 'function'
    ? options.context(call)
    : options?.context;
  const result = await veto.guard(call.name, call.arguments, context ?? {});
  const allowed = result.shadow === true || result.decision === 'allow';
  const reason = result.reason
    ?? (result.decision === 'require_approval' ? 'Approval required' : undefined)
    ?? (result.decision === 'deny' ? 'Policy violation' : undefined);
  const decision: RuntimeGuardDecision = {
    decision: result.decision,
    allowed,
    toolName: call.name,
    arguments: call.arguments,
    reason,
    approvalId: result.approvalId,
    result,
  };

  if (allowed) {
    if (options?.onAllow) await options.onAllow(call.name, call.arguments);
    return decision;
  }

  if (result.decision === 'require_approval') {
    if (options?.onApprovalRequired) {
      await options.onApprovalRequired(call.name, call.arguments, result.approvalId);
    }
    return decision;
  }

  if (options?.onDeny) await options.onDeny(call.name, call.arguments, reason ?? 'Policy violation');
  return decision;
}

export async function executeGuardedRuntimeToolCall<TResult>(
  veto: Veto,
  call: RuntimeToolCall,
  execute: (args: Record<string, unknown>) => TResult | Promise<TResult>,
  options?: GuardedRuntimeExecutionOptions<TResult>,
): Promise<TResult> {
  const decision = await guardRuntimeToolCall(veto, call, options);
  if (decision.allowed) {
    return await execute(call.arguments);
  }

  if (options?.onBlocked) {
    return await options.onBlocked(decision);
  }

  throw new VetoRuntimeAdapterError(decision);
}
