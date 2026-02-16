import type { Veto } from '../../core/veto.js';
import { generateToolCallId } from '../../utils/id.js';

export interface VetoToolNodeOptions {
  /** Called when a tool call is allowed. */
  onAllow?: (toolName: string, args: Record<string, unknown>) => void | Promise<void>;
  /** Called when a tool call is denied. */
  onDeny?: (toolName: string, args: Record<string, unknown>, reason: string) => void | Promise<void>;
}

/**
 * Create a LangGraph-compatible node function that validates tool calls
 * through Veto before delegating to a real ToolNode.
 *
 * This is for users building raw LangGraph graphs who want per-node
 * validation without using `createAgent` + middleware.
 *
 * @example
 * ```ts
 * import { StateGraph, MessagesAnnotation, START, END } from '@langchain/langgraph';
 * import { ToolNode, toolsCondition } from '@langchain/langgraph/prebuilt';
 * import { Veto } from 'veto-sdk';
 * import { createVetoToolNode } from 'veto-sdk/integrations/langchain';
 *
 * const veto = await Veto.init();
 * const toolNode = new ToolNode([searchTool, emailTool]);
 * const vetoToolNode = createVetoToolNode(veto, toolNode);
 *
 * const graph = new StateGraph(MessagesAnnotation)
 *   .addNode('agent', callModel)
 *   .addNode('tools', vetoToolNode)
 *   .addEdge(START, 'agent')
 *   .addConditionalEdges('agent', toolsCondition, ['tools', END])
 *   .addEdge('tools', 'agent')
 *   .compile();
 * ```
 */
export function createVetoToolNode(
  veto: Veto,
  toolNode: { invoke: (state: any) => Promise<any> },
  options?: VetoToolNodeOptions,
): (state: any) => Promise<any> {
  const onAllow = options?.onAllow;
  const onDeny = options?.onDeny;

  return async (state: { messages: any[] }) => {
    const lastMessage = state.messages[state.messages.length - 1];

    // Check if the last message has tool_calls (AIMessage from LangChain)
    const toolCalls: Array<{ name: string; args: Record<string, unknown>; id?: string }> =
      lastMessage?.tool_calls ?? [];

    if (toolCalls.length === 0) {
      return toolNode.invoke(state);
    }

    // Validate each tool call
    for (const tc of toolCalls) {
      const callId = tc.id ?? generateToolCallId();

      const result = await (veto as any).validateToolCall({
        id: callId,
        name: tc.name,
        arguments: tc.args ?? {},
      });

      if (!result.allowed) {
        const reason = result.validationResult?.reason ?? 'Policy violation';
        if (onDeny) await onDeny(tc.name, tc.args, reason);

        // Return ToolMessage(s) for denied calls
        let ToolMessage: any;
        try {
          const mod = await import('@langchain/core/messages');
          ToolMessage = mod.ToolMessage;
        } catch {
          // Fallback: return plain objects
          return {
            messages: toolCalls.map(t => ({
              content: `Tool call denied by Veto: ${reason}`,
              tool_call_id: t.id ?? callId,
            })),
          };
        }

        return {
          messages: toolCalls.map(t => new ToolMessage({
            content: `Tool call denied by Veto: ${reason}`,
            tool_call_id: t.id ?? callId,
          })),
        };
      }

      if (onAllow) await onAllow(tc.name, tc.args);
    }

    // All tool calls allowed, delegate to real ToolNode
    return toolNode.invoke(state);
  };
}
