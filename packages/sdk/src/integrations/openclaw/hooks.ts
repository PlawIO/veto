import { ApprovalTimeoutError } from '../../cloud/client.js';
import type { ApprovalPollOptions } from '../../cloud/types.js';
import type { Veto } from '../../core/veto.js';
import { generateToolCallId } from '../../utils/id.js';

export interface OpenClawToolCallContext {
  toolName: string;
  toolArgs: Record<string, unknown>;
  toolCallId?: string;
  sessionId?: string;
  agentId?: string;
}

export interface OpenClawBeforeToolCallResult {
  block?: boolean;
  requireApproval?: boolean;
  message?: string;
}

export type OpenClawBeforeToolCallHook = (
  context: OpenClawToolCallContext,
) => Promise<OpenClawBeforeToolCallResult | void>;

export type OpenClawAfterToolCallHook = (
  context: OpenClawToolCallContext & { result?: unknown; error?: unknown },
) => Promise<void>;

export type VetoApprovalMode = 'openclaw-native' | 'veto-cloud';

export interface CreateVetoOpenClawHookOptions {
  approvalMode?: VetoApprovalMode;
  onAllow?: (toolName: string, args: Record<string, unknown>) => void | Promise<void>;
  onDeny?: (toolName: string, args: Record<string, unknown>, reason: string) => void | Promise<void>;
  onApprovalRequired?: (
    toolName: string,
    args: Record<string, unknown>,
    approvalId?: string,
  ) => void | Promise<void>;
  sessionId?: string;
  agentId?: string;
}

interface VetoExecutionLogger {
  logToolExecution?: (
    toolName: string,
    args: Record<string, unknown>,
    result: unknown,
    context?: {
      toolCallId?: string;
      sessionId?: string;
      agentId?: string;
      error?: unknown;
    },
  ) => void;
  historyTracker?: {
    record: (
      toolName: string,
      args: Record<string, unknown>,
      result: { decision: 'allow'; reason?: string; metadata?: Record<string, unknown> },
      durationMs?: number,
    ) => void;
  };
}

interface VetoApprovalWaiter {
  waitForApproval?: (approvalId: string, options?: ApprovalPollOptions) => Promise<{
    status: 'pending' | 'approved' | 'denied' | 'expired';
    resolvedBy?: string;
  }>;
}

function resolveSessionId(
  context: OpenClawToolCallContext,
  options?: CreateVetoOpenClawHookOptions,
): string | undefined {
  return options?.sessionId ?? context.sessionId;
}

function resolveAgentId(
  context: OpenClawToolCallContext,
  options?: CreateVetoOpenClawHookOptions,
): string | undefined {
  return options?.agentId ?? context.agentId;
}

function resolveApprovalMode(options?: CreateVetoOpenClawHookOptions): VetoApprovalMode {
  return options?.approvalMode ?? 'openclaw-native';
}

function resolveToolCallId(context: OpenClawToolCallContext): string {
  return context.toolCallId ?? generateToolCallId();
}

export function createVetoBeforeToolCallHook(
  veto: Veto,
  options?: CreateVetoOpenClawHookOptions,
): OpenClawBeforeToolCallHook {
  const approvalMode = resolveApprovalMode(options);
  const onAllow = options?.onAllow;
  const onDeny = options?.onDeny;
  const onApprovalRequired = options?.onApprovalRequired;
  const approvalWaiter = veto as unknown as VetoApprovalWaiter;

  return async (context) => {
    const toolName = context.toolName;
    const args = context.toolArgs ?? {};
    resolveToolCallId(context);

    const result = await veto.guard(toolName, args, {
      sessionId: resolveSessionId(context, options),
      agentId: resolveAgentId(context, options),
    });

    if (result.shadow === true) {
      if (onAllow) await onAllow(toolName, args);
      return undefined;
    }

    if (result.decision === 'allow') {
      if (onAllow) await onAllow(toolName, args);
      return undefined;
    }

    if (result.decision === 'deny') {
      const reason = result.reason ?? 'Policy violation';
      if (onDeny) await onDeny(toolName, args, reason);
      return { block: true, message: reason };
    }

    if (onApprovalRequired) {
      await onApprovalRequired(toolName, args, result.approvalId);
    }

    if (approvalMode === 'openclaw-native') {
      return {
        requireApproval: true,
        message: result.reason,
      };
    }

    if (!result.approvalId) {
      const reason = result.reason ?? 'Approval required';
      if (onDeny) await onDeny(toolName, args, reason);
      return { block: true, message: reason };
    }

    if (!approvalWaiter.waitForApproval) {
      throw new Error('veto.waitForApproval() is required for approvalMode="veto-cloud"');
    }

    try {
      const approval = await approvalWaiter.waitForApproval(result.approvalId);

      if (approval.status === 'approved') {
        return undefined;
      }

      if (approval.status === 'expired') {
        const reason = 'Approval expired';
        if (onDeny) await onDeny(toolName, args, reason);
        return { block: true, message: reason };
      }

      const reason = result.reason ?? 'Approval denied';
      if (onDeny) await onDeny(toolName, args, reason);
      return { block: true, message: reason };
    } catch (error) {
      if (error instanceof ApprovalTimeoutError) {
        const reason = 'Approval expired';
        if (onDeny) await onDeny(toolName, args, reason);
        return { block: true, message: reason };
      }
      throw error;
    }
  };
}

export function createVetoAfterToolCallHook(
  veto: Veto,
  options?: CreateVetoOpenClawHookOptions,
): OpenClawAfterToolCallHook {
  const vetoWithLogger = veto as unknown as VetoExecutionLogger;

  return async (context) => {
    const toolCallId = resolveToolCallId(context);
    const toolName = context.toolName;
    const args = context.toolArgs ?? {};
    const metadata: Record<string, unknown> = {
      toolCallId,
      source: 'openclaw-after-tool-call',
    };

    const sessionId = resolveSessionId(context, options);
    const agentId = resolveAgentId(context, options);

    if (sessionId) metadata.sessionId = sessionId;
    if (agentId) metadata.agentId = agentId;

    if (context.error !== undefined) {
      metadata.executionError = context.error instanceof Error
        ? { name: context.error.name, message: context.error.message }
        : String(context.error);
    }

    if (vetoWithLogger.logToolExecution) {
      vetoWithLogger.logToolExecution(toolName, args, context.result, {
        toolCallId,
        sessionId,
        agentId,
        error: context.error,
      });
      return;
    }

    vetoWithLogger.historyTracker?.record(toolName, args, {
      decision: 'allow',
      reason: context.error === undefined ? 'Tool execution completed' : 'Tool execution failed',
      metadata: {
        ...metadata,
        executionResult: context.result,
      },
    });
  };
}
