import type { Veto } from '../../core/veto.js';
import {
  executeGuardedRuntimeToolCall,
  guardRuntimeToolCall,
  parseJsonObject,
  type GuardedRuntimeExecutionOptions,
  type RuntimeGuardDecision,
  type RuntimeGuardOptions,
} from '../shared.js';

export interface AutoGenFunctionCall {
  name: string;
  arguments?: unknown;
  args?: unknown;
  id?: string;
  [key: string]: unknown;
}

export type AutoGenToolFunction<TResult = unknown, TContext = unknown> = (
  args: Record<string, unknown>,
  context?: TContext,
) => TResult | Promise<TResult>;

export interface AutoGenTool<TResult = unknown, TContext = unknown> {
  name: string;
  description?: string;
  parameters?: unknown;
  func?: AutoGenToolFunction<TResult, TContext>;
  execute?: AutoGenToolFunction<TResult, TContext>;
  run?: AutoGenToolFunction<TResult, TContext>;
  [key: string]: unknown;
}

export type VetoAutoGenToolOptions<TResult = unknown> = GuardedRuntimeExecutionOptions<TResult>;

export { VetoRuntimeAdapterError } from '../shared.js';
export type {
  GuardedRuntimeExecutionOptions,
  RuntimeGuardDecision,
  RuntimeGuardOptions,
} from '../shared.js';

const AUTO_GEN_FUNCTION_KEYS = ['func', 'execute', 'run'] as const;

function resolveAutoGenArgs(call: AutoGenFunctionCall): Record<string, unknown> {
  return parseJsonObject(call.arguments ?? call.args);
}

export async function guardAutoGenToolCall(
  veto: Veto,
  call: AutoGenFunctionCall,
  options?: RuntimeGuardOptions,
): Promise<RuntimeGuardDecision> {
  return await guardRuntimeToolCall(veto, {
    id: call.id,
    name: call.name,
    arguments: resolveAutoGenArgs(call),
  }, options);
}

export function wrapAutoGenFunction<TResult, TContext = unknown>(
  veto: Veto,
  name: string,
  fn: AutoGenToolFunction<TResult, TContext>,
  options?: VetoAutoGenToolOptions<TResult>,
): AutoGenToolFunction<TResult, TContext> {
  return async (args, context) => await executeGuardedRuntimeToolCall(
    veto,
    { name, arguments: parseJsonObject(args) },
    async (guardedArgs) => await fn(guardedArgs, context),
    options,
  );
}

export function wrapAutoGenTool<
  TResult,
  TContext,
  TTool extends AutoGenTool<TResult, TContext>,
>(
  veto: Veto,
  tool: TTool,
  options?: VetoAutoGenToolOptions<TResult>,
): TTool {
  const wrapped = { ...tool } as TTool;
  const writable = wrapped as Record<string, unknown>;

  for (const key of AUTO_GEN_FUNCTION_KEYS) {
    const fn = tool[key] as unknown;
    if (typeof fn === 'function') {
      writable[key] = wrapAutoGenFunction(
        veto,
        tool.name,
        fn as AutoGenToolFunction<TResult, TContext>,
        options,
      );
    }
  }

  return wrapped;
}

export function wrapAutoGenTools<TTool extends AutoGenTool>(
  veto: Veto,
  tools: TTool[],
  options?: VetoAutoGenToolOptions,
): TTool[];
export function wrapAutoGenTools<TTools extends Record<string, AutoGenTool>>(
  veto: Veto,
  tools: TTools,
  options?: VetoAutoGenToolOptions,
): TTools;
export function wrapAutoGenTools(
  veto: Veto,
  tools: AutoGenTool[] | Record<string, AutoGenTool>,
  options?: VetoAutoGenToolOptions,
): AutoGenTool[] | Record<string, AutoGenTool> {
  if (Array.isArray(tools)) {
    return tools.map((tool) => wrapAutoGenTool(veto, tool, options));
  }

  const wrapped: Record<string, AutoGenTool> = {};
  for (const [key, tool] of Object.entries(tools)) {
    wrapped[key] = wrapAutoGenTool(veto, tool.name ? tool : { ...tool, name: key }, options);
  }
  return wrapped;
}
