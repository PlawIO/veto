import { ToolCallDeniedError, type Veto } from '../../core/veto.js';
import { generateToolCallId } from '../../utils/id.js';

/**
 * Shape of a tool call as passed through LangChain's middleware system.
 * Matches the `ToolCallRequest.toolCall` object from `langchain`.
 */
interface LangChainToolCall {
  name: string;
  args: Record<string, unknown>;
  id?: string;
  type?: string;
}

export interface VetoLangChainMiddlewareOptions {
  /** Called when a tool call is allowed. */
  onAllow?: (toolName: string, args: Record<string, unknown>) => void | Promise<void>;
  /** Called when a tool call is denied. */
  onDeny?: (toolName: string, args: Record<string, unknown>, reason: string) => void | Promise<void>;
  /**
   * When true, denied tool calls throw `ToolCallDeniedError` instead of
   * returning a ToolMessage. Defaults to false (returns ToolMessage).
   */
  throwOnDeny?: boolean;
}

/**
 * Create a LangChain v1 middleware `wrapToolCall` function that validates
 * every tool call through Veto before execution.
 *
 * Compatible with `createAgent` from `langchain` (JS/TS). The returned
 * function matches the `wrapToolCall` middleware signature: it receives
 * a request and handler, validates the tool call, and either passes
 * through to the handler or returns a denied ToolMessage.
 *
 * @example
 * ```ts
 * import { createAgent } from 'langchain';
 * import { Veto } from 'veto-sdk';
 * import { createVetoLangChainMiddleware } from 'veto-sdk/integrations/langchain';
 *
 * const veto = await Veto.init();
 *
 * const agent = createAgent({
 *   model: 'openai:gpt-4o',
 *   tools: [searchTool, emailTool],
 *   middleware: [createVetoLangChainMiddleware(veto)],
 * });
 * ```
 */
export function createVetoLangChainMiddleware(
  veto: Veto,
  options?: VetoLangChainMiddlewareOptions,
): { name: string; wrapToolCall: (request: any, handler: any) => Promise<any> } {
  const onAllow = options?.onAllow;
  const onDeny = options?.onDeny;
  const throwOnDeny = options?.throwOnDeny ?? false;

  return {
    name: 'VetoGuardrail',

    wrapToolCall: async (request: { toolCall: LangChainToolCall }, handler: (req: any) => Promise<any>) => {
      const tc = request.toolCall;
      const toolName = tc.name;
      const args = tc.args ?? {};
      const callId = tc.id ?? generateToolCallId();

      const result = await (veto as any).validateToolCall({
        id: callId,
        name: toolName,
        arguments: args,
      });

      if (!result.allowed) {
        const reason = result.validationResult?.reason ?? 'Policy violation';

        if (onDeny) await onDeny(toolName, args, reason);

        if (throwOnDeny) {
          throw new ToolCallDeniedError(
            toolName,
            callId,
            result.validationResult,
          );
        }

        // Return a ToolMessage-compatible object.
        // LangChain middleware expects this shape from wrapToolCall.
        let ToolMessage: any;
        try {
          const mod = await import('@langchain/core/messages');
          ToolMessage = mod.ToolMessage;
        } catch {
          // If @langchain/core isn't available, return a plain object
          return { content: `Tool call denied by Veto: ${reason}`, tool_call_id: callId };
        }

        return new ToolMessage({
          content: `Tool call denied by Veto: ${reason}`,
          tool_call_id: callId,
        });
      }

      if (onAllow) await onAllow(toolName, args);

      // If arguments were modified, update the request
      if (result.finalArguments && result.finalArguments !== args) {
        return handler({
          ...request,
          toolCall: { ...tc, args: result.finalArguments },
        });
      }

      return handler(request);
    },
  };
}
