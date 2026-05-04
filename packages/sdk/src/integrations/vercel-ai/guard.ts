import type { Veto } from '../../core/veto.js';
import {
  guardRuntimeToolCall,
  parseJsonObject,
  type RuntimeGuardDecision,
  type RuntimeGuardOptions,
} from '../shared.js';

export interface VercelAIToolCallPart {
  type?: string;
  toolCallId?: string;
  toolName: string;
  args?: unknown;
  input?: unknown;
  [key: string]: unknown;
}

export async function guardVercelAIToolCall(
  veto: Veto,
  part: VercelAIToolCallPart,
  options?: RuntimeGuardOptions,
): Promise<RuntimeGuardDecision> {
  return await guardRuntimeToolCall(veto, {
    id: part.toolCallId,
    name: part.toolName,
    arguments: parseJsonObject(part.args ?? part.input),
  }, options);
}
