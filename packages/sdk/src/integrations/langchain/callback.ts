/**
 * LangChain callback handler for Veto logging and observability.
 *
 * Callbacks are observational — they fire after tool start/end/error
 * and cannot block execution. Use this alongside middleware for
 * audit logging, metrics, or tracing.
 *
 * @example
 * ```ts
 * import { createVetoCallbackHandler } from 'veto-sdk/integrations/langchain';
 *
 * const handler = createVetoCallbackHandler({
 *   onToolStart: (name, input) => console.log(`Tool started: ${name}`),
 *   onToolEnd: (name, output) => console.log(`Tool finished: ${name}`),
 *   onToolError: (name, error) => console.error(`Tool failed: ${name}`, error),
 * });
 *
 * const result = await agent.invoke(
 *   { messages: [{ role: 'user', content: 'Hello' }] },
 *   { callbacks: [handler] },
 * );
 * ```
 */
export interface VetoCallbackOptions {
  onToolStart?: (toolName: string, input: string) => void | Promise<void>;
  onToolEnd?: (toolName: string, output: string) => void | Promise<void>;
  onToolError?: (toolName: string, error: Error) => void | Promise<void>;
}

export function createVetoCallbackHandler(options: VetoCallbackOptions): Record<string, any> {
  const toolNames = new Map<string, string>();

  return {
    name: 'VetoCallbackHandler',

    async handleToolStart(
      tool: { id?: string[]; name?: string },
      input: string,
      runId?: string,
    ): Promise<void> {
      const name = tool.name ?? tool.id?.[tool.id.length - 1] ?? 'unknown';
      if (runId) toolNames.set(runId, name);
      if (options.onToolStart) await options.onToolStart(name, input);
    },

    async handleToolEnd(output: string, runId?: string): Promise<void> {
      const name = runId ? (toolNames.get(runId) ?? '') : '';
      if (runId) toolNames.delete(runId);
      if (options.onToolEnd) await options.onToolEnd(name, output);
    },

    async handleToolError(err: Error, runId?: string): Promise<void> {
      const name = runId ? (toolNames.get(runId) ?? '') : '';
      if (runId) toolNames.delete(runId);
      if (options.onToolError) await options.onToolError(name, err);
    },
  };
}
