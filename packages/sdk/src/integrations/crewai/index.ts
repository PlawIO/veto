import type { Veto } from '../../core/veto.js';
import {
  executeGuardedRuntimeToolCall,
  guardRuntimeToolCall,
  parseJsonObject,
  type GuardedRuntimeExecutionOptions,
  type RuntimeGuardDecision,
  type RuntimeGuardOptions,
} from '../shared.js';

export interface CrewAIToolCall {
  name: string;
  input?: unknown;
  args?: unknown;
  arguments?: unknown;
  id?: string;
  [key: string]: unknown;
}

export type CrewAIToolFunction<TResult = unknown, TContext = unknown> = (
  args: Record<string, unknown>,
  context?: TContext,
) => TResult | Promise<TResult>;

export interface CrewAITool<TResult = unknown, TContext = unknown> {
  name: string;
  description?: string;
  argsSchema?: unknown;
  func?: CrewAIToolFunction<TResult, TContext>;
  run?: CrewAIToolFunction<TResult, TContext>;
  execute?: CrewAIToolFunction<TResult, TContext>;
  [key: string]: unknown;
}

export type VetoCrewAIToolOptions<TResult = unknown> = GuardedRuntimeExecutionOptions<TResult>;

export { VetoRuntimeAdapterError } from '../shared.js';
export type {
  GuardedRuntimeExecutionOptions,
  RuntimeGuardDecision,
  RuntimeGuardOptions,
} from '../shared.js';

const CREW_AI_FUNCTION_KEYS = ['func', 'run', 'execute'] as const;

function resolveCrewAIArgs(call: CrewAIToolCall): Record<string, unknown> {
  return parseJsonObject(call.input ?? call.args ?? call.arguments);
}

export async function guardCrewAIToolCall(
  veto: Veto,
  call: CrewAIToolCall,
  options?: RuntimeGuardOptions,
): Promise<RuntimeGuardDecision> {
  return await guardRuntimeToolCall(veto, {
    id: call.id,
    name: call.name,
    arguments: resolveCrewAIArgs(call),
  }, options);
}

export function wrapCrewAIFunction<TResult, TContext = unknown>(
  veto: Veto,
  name: string,
  fn: CrewAIToolFunction<TResult, TContext>,
  options?: VetoCrewAIToolOptions<TResult>,
): CrewAIToolFunction<TResult, TContext> {
  return async (args, context) => await executeGuardedRuntimeToolCall(
    veto,
    { name, arguments: parseJsonObject(args) },
    async (guardedArgs) => await fn(guardedArgs, context),
    options,
  );
}

export function wrapCrewAITool<
  TResult,
  TContext,
  TTool extends CrewAITool<TResult, TContext>,
>(
  veto: Veto,
  tool: TTool,
  options?: VetoCrewAIToolOptions<TResult>,
): TTool {
  const wrapped = { ...tool } as TTool;
  const writable = wrapped as Record<string, unknown>;

  for (const key of CREW_AI_FUNCTION_KEYS) {
    const fn = tool[key] as unknown;
    if (typeof fn === 'function') {
      writable[key] = wrapCrewAIFunction(
        veto,
        tool.name,
        fn as CrewAIToolFunction<TResult, TContext>,
        options,
      );
    }
  }

  return wrapped;
}

export function wrapCrewAITools<TTool extends CrewAITool>(
  veto: Veto,
  tools: TTool[],
  options?: VetoCrewAIToolOptions,
): TTool[];
export function wrapCrewAITools<TTools extends Record<string, CrewAITool>>(
  veto: Veto,
  tools: TTools,
  options?: VetoCrewAIToolOptions,
): TTools;
export function wrapCrewAITools(
  veto: Veto,
  tools: CrewAITool[] | Record<string, CrewAITool>,
  options?: VetoCrewAIToolOptions,
): CrewAITool[] | Record<string, CrewAITool> {
  if (Array.isArray(tools)) {
    return tools.map((tool) => wrapCrewAITool(veto, tool, options));
  }

  const wrapped: Record<string, CrewAITool> = {};
  for (const [key, tool] of Object.entries(tools)) {
    wrapped[key] = wrapCrewAITool(veto, tool.name ? tool : { ...tool, name: key }, options);
  }
  return wrapped;
}
