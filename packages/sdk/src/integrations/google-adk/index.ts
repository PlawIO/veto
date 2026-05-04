import type { Veto } from '../../core/veto.js';
import type { ToolCall, ToolDefinition } from '../../types/tool.js';
import type { GoogleFunctionCall, GoogleFunctionDeclaration, GoogleTool } from '../../providers/types.js';
import {
  fromGoogleFunctionCall,
  toGoogleFunctionDeclaration,
  toGoogleTool,
} from '../../providers/adapters.js';
import {
  asRecord,
  guardRuntimeToolCall,
  type RuntimeGuardDecision,
  type RuntimeGuardOptions,
} from '../shared.js';

export type GoogleADKFunctionDeclaration = GoogleFunctionDeclaration;
export type GoogleADKTool = GoogleTool;

export interface GoogleADKFunctionCall {
  name: string;
  args?: Record<string, unknown>;
  id?: string;
  [key: string]: unknown;
}

export type GoogleADKFunctionHandler<TResult = unknown> = (
  args: Record<string, unknown>,
  functionCall: GoogleADKFunctionCall,
) => TResult | Promise<TResult>;

export interface GoogleADKFunctionResponse {
  name: string;
  response: unknown;
  id?: string;
  error?: boolean;
}

export interface VetoGoogleADKFunctionRunnerOptions extends RuntimeGuardOptions {
  onBlocked?: (
    decision: RuntimeGuardDecision,
    functionCall: GoogleADKFunctionCall,
  ) => GoogleADKFunctionResponse | Promise<GoogleADKFunctionResponse>;
}

export { VetoRuntimeAdapterError } from '../shared.js';
export type { RuntimeGuardDecision, RuntimeGuardOptions } from '../shared.js';

export function toGoogleADKFunctionDeclaration(
  tool: ToolDefinition,
): GoogleADKFunctionDeclaration {
  return toGoogleFunctionDeclaration(tool);
}

export function toGoogleADKFunctionDeclarations(
  tools: readonly ToolDefinition[],
): GoogleADKFunctionDeclaration[] {
  return tools.map(toGoogleFunctionDeclaration);
}

export function toGoogleADKTool(tools: readonly ToolDefinition[]): GoogleADKTool {
  return toGoogleTool(tools);
}

export function fromGoogleADKFunctionCall(functionCall: GoogleADKFunctionCall): ToolCall {
  const call = fromGoogleFunctionCall({
    name: functionCall.name,
    args: asRecord(functionCall.args),
  } satisfies GoogleFunctionCall);
  return functionCall.id ? { ...call, id: functionCall.id } : call;
}

export async function guardGoogleADKFunctionCall(
  veto: Veto,
  functionCall: GoogleADKFunctionCall,
  options?: RuntimeGuardOptions,
): Promise<RuntimeGuardDecision> {
  const call = fromGoogleADKFunctionCall(functionCall);
  return await guardRuntimeToolCall(veto, {
    id: call.id,
    name: call.name,
    arguments: call.arguments,
  }, options);
}

export function createVetoGoogleADKFunctionRunner(
  veto: Veto,
  handlers: Record<string, GoogleADKFunctionHandler>,
  options?: VetoGoogleADKFunctionRunnerOptions,
): (functionCall: GoogleADKFunctionCall) => Promise<GoogleADKFunctionResponse> {
  return async (functionCall) => {
    const args = asRecord(functionCall.args);
    const decision = await guardGoogleADKFunctionCall(veto, functionCall, options);
    if (!decision.allowed) {
      if (options?.onBlocked) {
        return await options.onBlocked(decision, functionCall);
      }
      return {
        name: functionCall.name,
        id: functionCall.id,
        response: decision.reason ?? 'Tool call blocked by Veto',
        error: true,
      };
    }

    const handler = handlers[functionCall.name];
    if (!handler) {
      return {
        name: functionCall.name,
        id: functionCall.id,
        response: `No handler registered for Google ADK function ${functionCall.name}`,
        error: true,
      };
    }

    return {
      name: functionCall.name,
      id: functionCall.id,
      response: await handler(args, functionCall),
    };
  };
}
