/**
 * SSE stream interceptor for OpenAI chat completions.
 *
 * Buffers streaming chunks, assembles tool call arguments, validates
 * the assembled tool call against Veto policies, then either flushes
 * the buffer or sends a synthetic error event.
 *
 * @module proxy/interceptor
 */

/**
 * A partially assembled tool call from SSE deltas.
 */
export interface PendingToolCall {
  index: number;
  id: string;
  name: string;
  argumentsRaw: string;
}

/**
 * Result of processing one SSE line.
 */
export interface SSELineResult {
  /** Raw line to forward (for passthrough mode) */
  line: string;
  /** Parsed JSON data if this is a data line */
  data?: Record<string, unknown> | null;
  /** True if this line is `data: [DONE]` */
  done?: boolean;
  /** True if this line contains a tool_calls delta */
  hasToolCalls?: boolean;
  /** True if finish_reason === "tool_calls" */
  finishReasonToolCalls?: boolean;
}

/** Parse a single SSE line. Returns null for non-data/comment lines. */
export function parseSSELine(line: string): SSELineResult {
  if (line === 'data: [DONE]') return { line, done: true };
  if (!line.startsWith('data: ')) return { line };

  const jsonStr = line.slice(6);
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(jsonStr) as Record<string, unknown>;
  } catch {
    return { line };
  }

  const choices = Array.isArray(data['choices']) ? data['choices'] : [];
  let hasToolCalls = false;
  let finishReasonToolCalls = false;

  for (const choice of choices) {
    if (typeof choice !== 'object' || choice === null) continue;
    const c = choice as Record<string, unknown>;
    if (c['finish_reason'] === 'tool_calls') finishReasonToolCalls = true;
    const delta = c['delta'] as Record<string, unknown> | undefined;
    if (delta && Array.isArray(delta['tool_calls']) && (delta['tool_calls'] as unknown[]).length > 0) {
      hasToolCalls = true;
    }
  }

  return { line, data, hasToolCalls, finishReasonToolCalls };
}

/**
 * Merge tool call deltas from one SSE chunk into the pending map.
 * OpenAI streams arguments across multiple chunks.
 */
export function mergeToolCallDeltas(
  pending: Map<number, PendingToolCall>,
  data: Record<string, unknown>,
): void {
  const choices = Array.isArray(data['choices']) ? data['choices'] : [];
  for (const choice of choices) {
    if (typeof choice !== 'object' || choice === null) continue;
    const c = choice as Record<string, unknown>;
    const delta = c['delta'] as Record<string, unknown> | undefined;
    if (!delta || !Array.isArray(delta['tool_calls'])) continue;

    for (const tc of delta['tool_calls'] as Record<string, unknown>[]) {
      const idx = typeof tc['index'] === 'number' ? tc['index'] : 0;
      if (!pending.has(idx)) {
        pending.set(idx, {
          index: idx,
          id: typeof tc['id'] === 'string' ? tc['id'] : '',
          name: typeof (tc['function'] as Record<string, unknown> | undefined)?.['name'] === 'string'
            ? (tc['function'] as Record<string, unknown>)['name'] as string
            : '',
          argumentsRaw: '',
        });
      }
      const existing = pending.get(idx)!;
      const fn = tc['function'] as Record<string, unknown> | undefined;
      if (fn && typeof fn['name'] === 'string' && fn['name'] && !existing.name) {
        existing.name = fn['name'] as string;
      }
      if (fn && typeof fn['arguments'] === 'string') {
        existing.argumentsRaw += fn['arguments'] as string;
      }
    }
  }
}

/**
 * Parse assembled argument strings into objects.
 * Returns the tool call with a best-effort parsed arguments object.
 */
export function finalizeToolCall(tc: PendingToolCall): {
  name: string;
  id: string;
  arguments: Record<string, unknown>;
} {
  let args: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(tc.argumentsRaw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      args = parsed as Record<string, unknown>;
    }
  } catch {
     
    console.warn(`[veto intercept] Malformed tool arguments for '${tc.name}', validating with empty args`);
  }
  return { name: tc.name, id: tc.id, arguments: args };
}

/**
 * Synthesize a blocked response as a valid SSE event.
 * Sends a finish_reason: "stop" chunk with an error message in the content.
 */
export function synthBlockedEvent(reason: string, requestId?: string): string {
  const chunk = {
    id: requestId ?? 'veto-blocked',
    object: 'chat.completion.chunk',
    choices: [
      {
        index: 0,
        delta: { role: 'assistant', content: `[BLOCKED by veto] ${reason}` },
        finish_reason: 'stop',
      },
    ],
  };
  return `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`;
}
