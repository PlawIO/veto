import type { Veto } from '../../core/veto.js';
import {
  asRecord,
  executeGuardedRuntimeToolCall,
  guardRuntimeToolCall,
  type GuardedRuntimeExecutionOptions,
  type RuntimeGuardDecision,
  type RuntimeGuardOptions,
} from '../shared.js';

export interface MastraTool<
  TArgs = unknown,
  TResult = unknown,
  TContext = unknown,
> {
  id?: string;
  name?: string;
  description?: string;
  inputSchema?: unknown;
  execute: (args: TArgs, context?: TContext) => TResult | Promise<TResult>;
  [key: string]: unknown;
}

export type MastraToolRef = string | { id?: string; name?: string };
export type VetoMastraToolOptions<TResult = unknown> = GuardedRuntimeExecutionOptions<TResult>;

export { VetoRuntimeAdapterError } from '../shared.js';
export type {
  GuardedRuntimeExecutionOptions,
  RuntimeGuardDecision,
  RuntimeGuardOptions,
} from '../shared.js';

function resolveMastraToolName(tool: MastraToolRef): string {
  if (typeof tool === 'string' && tool.length > 0) return tool;
  if (typeof tool === 'object') {
    if (typeof tool.name === 'string' && tool.name.length > 0) return tool.name;
    if (typeof tool.id === 'string' && tool.id.length > 0) return tool.id;
  }
  throw new Error('Mastra tool must include a name or id');
}

export async function guardMastraToolCall(
  veto: Veto,
  tool: MastraToolRef,
  args: unknown,
  options?: RuntimeGuardOptions,
): Promise<RuntimeGuardDecision> {
  return await guardRuntimeToolCall(veto, {
    name: resolveMastraToolName(tool),
    arguments: asRecord(args),
  }, options);
}

export function wrapMastraTool<
  TArgs,
  TResult,
  TContext,
  TTool extends MastraTool<TArgs, TResult, TContext>,
>(
  veto: Veto,
  tool: TTool,
  options?: VetoMastraToolOptions<TResult>,
): TTool {
  const toolName = resolveMastraToolName(tool);
  const originalExecute = tool.execute;
  const wrapped = Object.create(Object.getPrototypeOf(tool)) as TTool;
  Object.assign(wrapped, tool);
  wrapped.execute = (async (args: TArgs, context?: TContext): Promise<TResult> => {
    return await executeGuardedRuntimeToolCall(
      veto,
      { name: toolName, arguments: asRecord(args) },
      async (guardedArgs) => await originalExecute.call(tool, guardedArgs as TArgs, context),
      options,
    );
  }) as TTool['execute'];
  return wrapped;
}

export function wrapMastraTools<TTool extends MastraTool>(
  veto: Veto,
  tools: TTool[],
  options?: VetoMastraToolOptions,
): TTool[];
export function wrapMastraTools<TTools extends Record<string, MastraTool>>(
  veto: Veto,
  tools: TTools,
  options?: VetoMastraToolOptions,
): TTools;
export function wrapMastraTools(
  veto: Veto,
  tools: MastraTool[] | Record<string, MastraTool>,
  options?: VetoMastraToolOptions,
): MastraTool[] | Record<string, MastraTool> {
  if (Array.isArray(tools)) {
    return tools.map((tool) => wrapMastraTool(veto, tool, options));
  }

  const wrapped: Record<string, MastraTool> = {};
  for (const [key, tool] of Object.entries(tools)) {
    const namedTool = tool.name || tool.id ? tool : { ...tool, name: key };
    wrapped[key] = wrapMastraTool(veto, namedTool, options);
  }
  return wrapped;
}
