import type { Veto } from '../../core/veto.js';

export interface GuardrailFunctionOutput {
  tripwireTriggered: boolean;
  outputInfo?: {
    reason?: string;
    matched_rules?: string[];
  };
}

export interface InputGuardrail<TContext = unknown, TAgent = unknown, TResponseInputItem = unknown> {
  name: string;
  guardrailFunction: (
    ctx: TContext,
    agent: TAgent,
    input: string | TResponseInputItem[],
  ) => Promise<GuardrailFunctionOutput>;
  execute: (args: {
    context: TContext;
    agent: TAgent;
    input: string | TResponseInputItem[];
  }) => Promise<GuardrailFunctionOutput>;
}

export interface OutputGuardrail<TContext = unknown, TAgent = unknown, TOutput = unknown> {
  name: string;
  guardrailFunction: (
    ctx: TContext,
    agent: TAgent,
    output: TOutput,
  ) => Promise<GuardrailFunctionOutput>;
  execute: (args: {
    context: TContext;
    agent: TAgent;
    output: TOutput;
  }) => Promise<GuardrailFunctionOutput>;
}

export interface ToolGuardrailContext {
  tool_name?: string;
  toolName?: string;
  tool_arguments?: string;
  toolArguments?: string;
}

export interface ToolInputGuardrailData {
  context: ToolGuardrailContext;
}

export interface ToolOutputGuardrailData extends ToolInputGuardrailData {
  output: unknown;
}

export type ToolGuardrailBehavior =
  | { type: 'allow' }
  | { type: 'reject_content'; message: string };

export interface ToolGuardrailFunctionOutput {
  behavior: ToolGuardrailBehavior;
}

export interface ToolInputGuardrail {
  name: string;
  guardrailFunction: (data: ToolInputGuardrailData) => Promise<ToolGuardrailFunctionOutput>;
  execute: (data: ToolInputGuardrailData) => Promise<ToolGuardrailFunctionOutput>;
}

export interface ToolOutputGuardrail {
  name: string;
  guardrailFunction: (data: ToolOutputGuardrailData) => Promise<ToolGuardrailFunctionOutput>;
  execute: (data: ToolOutputGuardrailData) => Promise<ToolGuardrailFunctionOutput>;
}

function allowToolGuardrail(): ToolGuardrailFunctionOutput {
  return {
    behavior: { type: 'allow' },
  };
}

function rejectToolGuardrail(reason: string): ToolGuardrailFunctionOutput {
  return {
    behavior: { type: 'reject_content', message: reason },
  };
}

function parseToolArguments(rawArguments: unknown): Record<string, unknown> {
  if (typeof rawArguments !== 'string' || rawArguments.length === 0) {
    return {};
  }

  try {
    const parsed = JSON.parse(rawArguments) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    return {};
  }
}

function resolveToolName(context: ToolGuardrailContext | undefined): string {
  const value = context?.tool_name ?? context?.toolName;
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  return 'unknown_tool';
}

function resolveToolArguments(context: ToolGuardrailContext | undefined): unknown {
  return context?.tool_arguments ?? context?.toolArguments;
}

/**
 * Create an OpenAI Agents-compatible input guardrail backed by `veto.guard()`.
 *
 * The returned object is intentionally plain (`name` + `guardrailFunction`) with
 * an `execute` alias, so it can be adapted to TypeScript ports of the
 * OpenAI Agents protocol.
 */
export function createVetoInputGuardrail<
  TContext = unknown,
  TAgent = unknown,
  TResponseInputItem = unknown,
>(
  veto: Veto,
  name?: string,
): InputGuardrail<TContext, TAgent, TResponseInputItem> {
  const guardrailFunction: InputGuardrail<TContext, TAgent, TResponseInputItem>['guardrailFunction'] =
    async (_ctx, _agent, input) => {
      const result = await veto.guard('agent_input', { input });
      if (result.decision === 'deny') {
        return {
          tripwireTriggered: true,
          outputInfo: {
            reason: result.reason,
          },
        };
      }

      return {
        tripwireTriggered: false,
      };
    };

  return {
    name: name ?? 'VetoInputGuardrail',
    guardrailFunction,
    execute: async ({ context, agent, input }) => guardrailFunction(context, agent, input),
  };
}

/**
 * Create an OpenAI Agents-compatible output guardrail backed by `veto.validateOutput()`.
 */
export function createVetoOutputGuardrail<
  TContext = unknown,
  TAgent = unknown,
  TOutput = unknown,
>(
  veto: Veto,
  name?: string,
): OutputGuardrail<TContext, TAgent, TOutput> {
  const guardrailFunction: OutputGuardrail<TContext, TAgent, TOutput>['guardrailFunction'] =
    async (_ctx, _agent, output) => {
      const result = veto.validateOutput('agent_output', String(output));
      if (result.decision === 'block') {
        return {
          tripwireTriggered: true,
          outputInfo: {
            reason: result.reason,
            matched_rules: result.matchedRuleIds,
          },
        };
      }

      return {
        tripwireTriggered: false,
      };
    };

  return {
    name: name ?? 'VetoOutputGuardrail',
    guardrailFunction,
    execute: async ({ context, agent, output }) => guardrailFunction(context, agent, output),
  };
}

/**
 * Create OpenAI Agents-compatible tool input/output guardrails backed by Veto.
 */
export function createVetoToolGuardrails(
  veto: Veto,
  name?: string,
): [ToolInputGuardrail, ToolOutputGuardrail] {
  const inputName = name ? `${name}Input` : 'VetoToolInputGuardrail';
  const outputName = name ? `${name}Output` : 'VetoToolOutputGuardrail';

  const inputGuardrailFunction: ToolInputGuardrail['guardrailFunction'] = async (data) => {
    const toolName = resolveToolName(data.context);
    const args = parseToolArguments(resolveToolArguments(data.context));
    const result = await veto.guard(toolName, args);

    if (result.decision === 'deny') {
      return rejectToolGuardrail(result.reason ?? 'Policy violation');
    }

    return allowToolGuardrail();
  };

  const outputGuardrailFunction: ToolOutputGuardrail['guardrailFunction'] = async (data) => {
    const toolName = resolveToolName(data.context);
    const result = veto.validateOutput(toolName, String(data.output));

    if (result.decision === 'block') {
      return rejectToolGuardrail(result.reason ?? 'Policy violation');
    }

    return allowToolGuardrail();
  };

  return [
    {
      name: inputName,
      guardrailFunction: inputGuardrailFunction,
      execute: inputGuardrailFunction,
    },
    {
      name: outputName,
      guardrailFunction: outputGuardrailFunction,
      execute: outputGuardrailFunction,
    },
  ];
}
