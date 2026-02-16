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

    const toolCalls: Array<{ name: string; args: Record<string, unknown>; id?: string }> =
      lastMessage?.tool_calls ?? [];

    if (toolCalls.length === 0) {
      return toolNode.invoke(state);
    }

    // Validate ALL tool calls before deciding
    const denied: Array<{ callId: string; reason: string }> = [];
    const deniedIds = new Set<string>();

    for (const tc of toolCalls) {
      const callId = tc.id ?? generateToolCallId();

      const result = await veto.validateToolCall({
        id: callId,
        name: tc.name,
        arguments: tc.args ?? {},
      });

      if (!result.allowed) {
        const reason = result.validationResult?.reason ?? 'Policy violation';
        denied.push({ callId, reason });
        deniedIds.add(callId);
        if (onDeny) await onDeny(tc.name, tc.args, reason);
      } else {
        if (onAllow) await onAllow(tc.name, tc.args);
      }
    }

    if (denied.length === 0) {
      return toolNode.invoke(state);
    }

    // Build denial messages
    let ToolMessage: any;
    try {
      const mod = await import('@langchain/core/messages');
      ToolMessage = mod.ToolMessage;
    } catch {
      ToolMessage = null;
    }

    const denialMessages = denied.map(d =>
      ToolMessage
        ? new ToolMessage({ content: `Tool call denied by Veto: ${d.reason}`, tool_call_id: d.callId })
        : { content: `Tool call denied by Veto: ${d.reason}`, tool_call_id: d.callId },
    );

    // If ALL calls denied, return denials only
    if (denied.length === toolCalls.length) {
      return { messages: denialMessages };
    }

    // Partial denial — execute allowed calls, merge with denial messages
    const allowedCalls = toolCalls.filter((tc: any) => !deniedIds.has(tc.id ?? ''));
    const modifiedMessages = [...state.messages];
    const lastMsg = modifiedMessages[modifiedMessages.length - 1];
    modifiedMessages[modifiedMessages.length - 1] = { ...lastMsg, tool_calls: allowedCalls };

    const allowedResult = await toolNode.invoke({ ...state, messages: modifiedMessages });
    return {
      messages: [...denialMessages, ...(allowedResult?.messages ?? [])],
    };
  };
}
