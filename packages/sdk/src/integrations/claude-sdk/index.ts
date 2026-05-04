import type { Veto } from '../../core/veto.js';
import type { ToolCall, ToolDefinition } from '../../types/tool.js';
import type { AnthropicTool, AnthropicToolUse } from '../../providers/types.js';
import { fromAnthropicToolUse, toAnthropic, toAnthropicTools } from '../../providers/adapters.js';
import {
  guardRuntimeToolCall,
  type RuntimeGuardDecision,
  type RuntimeGuardOptions,
} from '../shared.js';

export type ClaudeTool = AnthropicTool;
export type ClaudeToolUseBlock = AnthropicToolUse;
export type ClaudeToolHandler<TResult = unknown> = (
  input: Record<string, unknown>,
  toolUse: ClaudeToolUseBlock,
) => TResult | Promise<TResult>;

export interface ClaudeToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: unknown;
  is_error?: boolean;
}

export interface VetoClaudeToolRunnerOptions extends RuntimeGuardOptions {
  onBlocked?: (
    decision: RuntimeGuardDecision,
    toolUse: ClaudeToolUseBlock,
  ) => ClaudeToolResultBlock | Promise<ClaudeToolResultBlock>;
}

export { VetoRuntimeAdapterError } from '../shared.js';
export type { RuntimeGuardDecision, RuntimeGuardOptions } from '../shared.js';

export function toClaudeTool(tool: ToolDefinition): ClaudeTool {
  return toAnthropic(tool);
}

export function toClaudeTools(tools: readonly ToolDefinition[]): ClaudeTool[] {
  return toAnthropicTools(tools);
}

export function fromClaudeToolUse(toolUse: ClaudeToolUseBlock): ToolCall {
  return fromAnthropicToolUse(toolUse);
}

export async function guardClaudeToolUse(
  veto: Veto,
  toolUse: ClaudeToolUseBlock,
  options?: RuntimeGuardOptions,
): Promise<RuntimeGuardDecision> {
  const call = fromAnthropicToolUse(toolUse);
  return await guardRuntimeToolCall(veto, {
    id: call.id,
    name: call.name,
    arguments: call.arguments,
  }, options);
}

export function createVetoClaudeToolRunner(
  veto: Veto,
  handlers: Record<string, ClaudeToolHandler>,
  options?: VetoClaudeToolRunnerOptions,
): (toolUse: ClaudeToolUseBlock) => Promise<ClaudeToolResultBlock> {
  return async (toolUse) => {
    const decision = await guardClaudeToolUse(veto, toolUse, options);
    if (!decision.allowed) {
      if (options?.onBlocked) {
        return await options.onBlocked(decision, toolUse);
      }
      return {
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: decision.reason ?? 'Tool call blocked by Veto',
        is_error: true,
      };
    }

    const handler = handlers[toolUse.name];
    if (!handler) {
      return {
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: `No handler registered for Claude tool ${toolUse.name}`,
        is_error: true,
      };
    }

    const content = await handler(toolUse.input, toolUse);
    return {
      type: 'tool_result',
      tool_use_id: toolUse.id,
      content,
    };
  };
}
