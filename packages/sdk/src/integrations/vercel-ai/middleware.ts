import { ToolCallDeniedError, type Veto } from '../../core/veto.js';
import { generateToolCallId } from '../../utils/id.js';

/**
 * Stream part types emitted by the Vercel AI SDK language model spec v3.
 * Declared locally to avoid a hard dependency on `ai` or `@ai-sdk/provider`.
 */
interface ToolCallStreamPart {
  type: 'tool-call';
  toolCallId: string;
  toolName: string;
  input: string;
}

interface ToolCallGeneratePart {
  type: 'tool-call';
  toolCallType: 'function';
  toolCallId: string;
  toolName: string;
  args: string;
}

interface GenerateResult {
  content: Array<ToolCallGeneratePart | { type: string }>;
  [key: string]: unknown;
}

interface StreamResult {
  stream: ReadableStream;
  [key: string]: unknown;
}

interface MiddlewareOptions {
  type: 'generate' | 'stream';
  params: Record<string, unknown>;
  model: unknown;
}

interface WrapOptions {
  doGenerate: () => Promise<GenerateResult>;
  doStream: () => Promise<StreamResult>;
  params: Record<string, unknown>;
  model: unknown;
}

/**
 * Vercel AI SDK middleware type (LanguageModelV3Middleware).
 *
 * This interface mirrors the shape expected by `wrapLanguageModel` from
 * the `ai` package. We define it here so the integration works without
 * requiring `ai` as a compile-time dependency.
 */
export interface VetoVercelMiddleware {
  specificationVersion: 'v3';
  transformParams?: (options: MiddlewareOptions) => Promise<Record<string, unknown>>;
  wrapGenerate?: (options: WrapOptions) => Promise<GenerateResult>;
  wrapStream?: (options: WrapOptions) => Promise<StreamResult>;
}

export interface CreateVetoMiddlewareOptions {
  /** Called when a tool call is allowed. */
  onAllow?: (toolName: string, args: Record<string, unknown>) => void | Promise<void>;
  /** Called when a tool call is denied. */
  onDeny?: (toolName: string, args: Record<string, unknown>, reason: string) => void | Promise<void>;
  /**
   * When true, denied tool calls in streaming mode throw instead of
   * being silently dropped from the stream. Defaults to false.
   */
  throwOnDeny?: boolean;
}

/**
 * Create a Vercel AI SDK middleware that validates every tool call through Veto.
 *
 * Works with both `generateText` and `streamText`. Intercepts tool calls
 * after the model produces them and validates each one against Veto policies
 * before the SDK executes the tool's `execute` function.
 *
 * @example
 * ```ts
 * import { wrapLanguageModel, generateText, tool } from 'ai';
 * import { openai } from '@ai-sdk/openai';
 * import { Veto } from 'veto-sdk';
 * import { createVetoMiddleware } from 'veto-sdk/integrations/vercel-ai';
 * import { z } from 'zod';
 *
 * const veto = await Veto.init();
 * const model = wrapLanguageModel({
 *   model: openai('gpt-4o'),
 *   middleware: createVetoMiddleware(veto),
 * });
 *
 * const { text } = await generateText({
 *   model,
 *   tools: {
 *     sendEmail: tool({
 *       description: 'Send an email',
 *       parameters: z.object({ to: z.string(), body: z.string() }),
 *       execute: async ({ to, body }) => ({ sent: true }),
 *     }),
 *   },
 *   maxSteps: 5,
 *   prompt: 'Send an email to alice@example.com',
 * });
 * ```
 */
export function createVetoMiddleware(
  veto: Veto,
  options?: CreateVetoMiddlewareOptions,
): VetoVercelMiddleware {
  const onAllow = options?.onAllow;
  const onDeny = options?.onDeny;
  const throwOnDeny = options?.throwOnDeny ?? false;

  async function validateToolCall(
    toolName: string,
    argsJson: string,
    toolCallId: string,
  ): Promise<{ allowed: boolean; reason?: string; finalArgs?: Record<string, unknown> }> {
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(argsJson);
    } catch {
      args = {};
    }

    const result = await (veto as any).validateToolCall({
      id: toolCallId || generateToolCallId(),
      name: toolName,
      arguments: args,
    });

    if (!result.allowed) {
      const reason = result.validationResult?.reason ?? 'Policy violation';
      if (onDeny) await onDeny(toolName, args, reason);
      return { allowed: false, reason };
    }

    if (onAllow) await onAllow(toolName, args);
    return { allowed: true, finalArgs: result.finalArguments ?? args };
  }

  return {
    specificationVersion: 'v3',

    wrapGenerate: async ({ doGenerate }) => {
      const result = await doGenerate();

      for (const part of result.content) {
        if (part.type !== 'tool-call') continue;
        const tc = part as ToolCallGeneratePart;

        const validation = await validateToolCall(tc.toolName, tc.args, tc.toolCallId);
        if (!validation.allowed) {
          throw new ToolCallDeniedError(
            tc.toolName,
            tc.toolCallId,
            { decision: 'deny', reason: validation.reason },
          );
        }

        if (validation.finalArgs) {
          tc.args = JSON.stringify(validation.finalArgs);
        }
      }

      return result;
    },

    wrapStream: async ({ doStream }) => {
      const { stream, ...rest } = await doStream();

      const toolCallBuffers = new Map<string, { toolName: string; chunks: any[] }>();

      const transform = new TransformStream({
        async transform(chunk: any, controller: TransformStreamDefaultController) {
          if (chunk.type === 'tool-input-start') {
            toolCallBuffers.set(chunk.id, { toolName: chunk.toolName, chunks: [chunk] });
            return;
          }

          if (chunk.type === 'tool-input-delta') {
            const buf = toolCallBuffers.get(chunk.id);
            if (buf) buf.chunks.push(chunk);
            return;
          }

          if (chunk.type === 'tool-call') {
            const tc = chunk as ToolCallStreamPart;
            const buffer = toolCallBuffers.get(tc.toolCallId);
            toolCallBuffers.delete(tc.toolCallId);

            const validation = await validateToolCall(tc.toolName, tc.input, tc.toolCallId);
            if (!validation.allowed) {
              if (throwOnDeny) {
                throw new ToolCallDeniedError(
                  tc.toolName,
                  tc.toolCallId,
                  { decision: 'deny', reason: validation.reason },
                );
              }
              return;
            }

            if (buffer) {
              for (const bufferedChunk of buffer.chunks) {
                controller.enqueue(bufferedChunk);
              }
            }

            if (validation.finalArgs) {
              controller.enqueue({
                ...tc,
                input: JSON.stringify(validation.finalArgs),
              });
              return;
            }
          }

          controller.enqueue(chunk);
        },
      });

      return { stream: stream.pipeThrough(transform), ...rest };
    },
  };
}
