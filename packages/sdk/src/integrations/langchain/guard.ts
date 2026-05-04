import type { Veto } from '../../core/veto.js';
import {
  asRecord,
  guardRuntimeToolCall,
  type RuntimeGuardDecision,
  type RuntimeGuardOptions,
} from '../shared.js';

export interface LangChainGuardToolCall {
  name: string;
  args?: Record<string, unknown>;
  id?: string;
  type?: string;
}

export async function guardLangChainToolCall(
  veto: Veto,
  toolCall: LangChainGuardToolCall,
  options?: RuntimeGuardOptions,
): Promise<RuntimeGuardDecision> {
  return await guardRuntimeToolCall(veto, {
    id: toolCall.id,
    name: toolCall.name,
    arguments: asRecord(toolCall.args),
  }, options);
}
