/**
 * veto intercept — HTTP proxy for OpenAI and Anthropic streaming APIs.
 *
 * Intercepts tool calls in streaming responses (SSE format) and validates
 * them against Veto policies before forwarding to the client.
 *
 * Architecture — full buffering:
 *   1. Non-tool-call responses → passthrough chunks as they arrive
 *   2. Tool-call responses → buffer all chunks until stream signals completion
 *   3. Validate assembled tool call → allow (flush buffer) or block (synthetic error)
 *   4. Buffer overflow (> maxBufferBytes) → flush + passthrough, skip validation
 *
 * @module proxy/server
 */

import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import type { ProxyConfig } from './types.js';
import {
  finalizeToolCall,
  mergeToolCallDeltas,
  parseSSELine,
  synthBlockedEvent,
  type PendingToolCall,
} from './interceptor.js';
import {
  finalizeAnthropicToolUse,
  mergeAnthropicToolUseDelta,
  parseAnthropicSSELines,
  synthAnthropicBlockedEvent,
  type AnthropicPendingToolUse,
} from './anthropic-interceptor.js';
import { Veto } from '../core/veto.js';

const MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024; // 10 MB

function resolveFormat(config: ProxyConfig): 'openai' | 'anthropic' {
  const fmt = config.format ?? 'auto';
  if (fmt === 'openai' || fmt === 'anthropic') return fmt;
  return config.target.includes('anthropic') ? 'anthropic' : 'openai';
}

/**
 * Handle one proxied request.
 */
async function handleRequest(
  clientReq: http.IncomingMessage,
  clientRes: http.ServerResponse,
  config: ProxyConfig,
  veto: Veto,
): Promise<void> {
  const target = new URL(config.target);
  const reqUrl = clientReq.url ?? '/';
  const format = resolveFormat(config);

  const isInterceptTarget =
    format === 'anthropic'
      ? reqUrl.includes('/v1/messages')
      : reqUrl.includes('/chat/completions');

  // Forward request headers, replacing host
  const headers: Record<string, string | string[] | undefined> = {
    ...clientReq.headers,
    host: target.host,
  };
  // Remove transfer-encoding since we may buffer the body
  delete headers['content-length'];

  // Collect request body with size limit
  const bodyChunks: Buffer[] = [];
  let bodySize = 0;
  let bodyLimitExceeded = false;
  for await (const chunk of clientReq) {
    const buf = chunk as Buffer;
    bodySize += buf.length;
    if (bodySize > MAX_REQUEST_BODY_BYTES) {
      bodyLimitExceeded = true;
      clientReq.destroy();
      break;
    }
    bodyChunks.push(buf);
  }
  if (bodyLimitExceeded) {
    clientRes.writeHead(413, { 'Content-Type': 'text/plain' });
    clientRes.end('Request body too large');
    return;
  }
  const body = Buffer.concat(bodyChunks);

  let parsedBody: Record<string, unknown> | null = null;
  if (isInterceptTarget) {
    try {
      parsedBody = JSON.parse(body.toString('utf-8')) as Record<string, unknown>;
    } catch {
      // Not valid JSON — treat as non-streaming passthrough
    }
  }

  const isStream = parsedBody?.['stream'] === true;

  const upstreamOptions: https.RequestOptions = {
    hostname: target.hostname,
    port: target.port || (target.protocol === 'https:' ? 443 : 80),
    path: reqUrl,
    method: clientReq.method,
    headers: {
      ...headers,
      'content-length': body.length.toString(),
    },
  };

  const upstreamLib = target.protocol === 'https:' ? https : http;

  await new Promise<void>((resolve, reject) => {
    const upstreamReq = upstreamLib.request(upstreamOptions, (upstreamRes) => {
      if (!isInterceptTarget) {
        clientRes.writeHead(upstreamRes.statusCode ?? 200, upstreamRes.headers);
        upstreamRes.pipe(clientRes);
        upstreamRes.on('end', resolve);
        upstreamRes.on('error', reject);
        return;
      }

      if (format === 'anthropic') {
        if (isStream) {
          clientRes.writeHead(upstreamRes.statusCode ?? 200, upstreamRes.headers);
          interceptAnthropicSSEStream(upstreamRes, clientRes, config, veto).then(resolve).catch(reject);
        } else {
          interceptAnthropicNonStreamResponse(upstreamRes, clientRes, veto).then(resolve).catch(reject);
        }
      } else {
        if (isStream) {
          clientRes.writeHead(upstreamRes.statusCode ?? 200, upstreamRes.headers);
          interceptSSEStream(upstreamRes, clientRes, config, veto).then(resolve).catch(reject);
        } else {
          interceptNonStreamResponse(upstreamRes, clientRes, veto).then(resolve).catch(reject);
        }
      }
    });

    upstreamReq.on('error', (err) => {
      console.error('[veto intercept] Upstream connection error:', err.message);
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, { 'Content-Type': 'text/plain' });
        clientRes.end('Bad Gateway');
      }
      reject(err);
    });

    upstreamReq.write(body);
    upstreamReq.end();
  });
}

/**
 * Intercept a non-streaming chat completion response.
 * Buffer the full response, extract tool calls, validate, then forward or block.
 */
async function interceptNonStreamResponse(
  upstream: http.IncomingMessage,
  clientRes: http.ServerResponse,
  veto: Veto,
): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of upstream) {
    chunks.push(chunk as Buffer);
  }
  const responseBody = Buffer.concat(chunks).toString('utf-8');

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(responseBody) as Record<string, unknown>;
  } catch {
    // Not JSON — forward as-is
    clientRes.writeHead(upstream.statusCode ?? 200, upstream.headers);
    clientRes.end(responseBody);
    return;
  }

  const choices = Array.isArray(parsed['choices']) ? parsed['choices'] : [];
  let blocked = false;
  let blockReason = 'Tool call blocked by veto policy';

  for (const choice of choices) {
    if (typeof choice !== 'object' || choice === null) continue;
    const c = choice as Record<string, unknown>;
    const message = c['message'] as Record<string, unknown> | undefined;
    if (!message || !Array.isArray(message['tool_calls'])) continue;

    for (const tc of message['tool_calls'] as Record<string, unknown>[]) {
      const fn = tc['function'] as Record<string, unknown> | undefined;
      if (!fn || typeof fn['name'] !== 'string') continue;

      let args: Record<string, unknown> = {};
      if (typeof fn['arguments'] === 'string') {
        try {
          const p = JSON.parse(fn['arguments'] as string);
          if (p && typeof p === 'object' && !Array.isArray(p)) args = p as Record<string, unknown>;
        } catch {
           
          console.warn(`[veto intercept] Malformed tool arguments for '${fn['name']}', validating with empty args`);
        }
      }

      try {
        const result = await veto.guard(fn['name'] as string, args);
        if (result.decision !== 'allow') {
          blocked = true;
          blockReason = result.reason ?? `Tool call '${fn['name']}' blocked`;
          break;
        }
      } catch (err) {
        console.error('[veto intercept] Unexpected guard error:', err instanceof Error ? err.message : String(err));
        blocked = true;
        blockReason = 'Tool call validation failed';
        break;
      }
    }
    if (blocked) break;
  }

  if (blocked) {
    const blockedResponse = {
      ...parsed,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: `[BLOCKED by veto] ${blockReason}` },
          finish_reason: 'stop',
        },
      ],
    };
    const body = JSON.stringify(blockedResponse);
    const headers = { ...upstream.headers };
    headers['content-length'] = Buffer.byteLength(body).toString();
    clientRes.writeHead(200, headers);
    clientRes.end(body);
  } else {
    clientRes.writeHead(upstream.statusCode ?? 200, upstream.headers);
    clientRes.end(responseBody);
  }
}

/**
 * Read the upstream SSE stream, buffer tool-call chunks, validate, then
 * either flush the buffer or send a synthetic error.
 */
async function interceptSSEStream(
  upstream: http.IncomingMessage,
  clientRes: http.ServerResponse,
  config: ProxyConfig,
  veto: Veto,
): Promise<void> {
  const maxBufferBytes = config.maxBufferBytes;

  // Decoder for SSE text
  let partial = '';
  const pendingToolCalls = new Map<number, PendingToolCall>();
  let bufferedLines: string[] = [];
  let bufferedBytes = 0;
  let mode: 'passthrough' | 'buffer' | 'overflow' | 'blocked' = 'passthrough';
  let bufferOverflowed = false;

  const flushBuffer = () => {
    for (const line of bufferedLines) {
      clientRes.write(line + '\n');
    }
    bufferedLines = [];
    bufferedBytes = 0;
  };

  for await (const rawChunk of upstream) {
    const chunk = (rawChunk as Buffer).toString('utf-8');
    partial += chunk;

    // SSE lines are separated by \n (or \r\n)
    const lines = partial.split('\n');
    partial = lines.pop() ?? '';

    for (const rawLine of lines) {
      const line = rawLine.replace(/\r$/, '');
      const parsed = parseSSELine(line);

      if (mode === 'blocked') {
        continue;
      }

      if (parsed.done) {
        if (mode === 'buffer') {
          // Stream ended during buffering without finishing tool calls — flush
          flushBuffer();
        }
        clientRes.write('data: [DONE]\n\n');
        continue;
      }

      if (mode === 'overflow') {
        // Buffer overflowed — just passthrough
        clientRes.write(line + '\n');
        continue;
      }

      if (mode === 'passthrough') {
        if (parsed.hasToolCalls) {
          // Switch to buffer mode
          mode = 'buffer';
        } else {
          clientRes.write(line + '\n');
          continue;
        }
      }

      // Buffer mode: accumulate
      if (parsed.data) {
        mergeToolCallDeltas(pendingToolCalls, parsed.data);
      }

      const lineBytes = Buffer.byteLength(line, 'utf-8');
      bufferedBytes += lineBytes;
      bufferedLines.push(line);

      if (bufferedBytes > maxBufferBytes) {
        // Overflow: flush everything and passthrough rest
        bufferOverflowed = true;
        mode = 'overflow';
        flushBuffer();
         
        console.warn('[veto intercept] Buffer limit exceeded — flushing without validation');
        continue;
      }

      if (parsed.finishReasonToolCalls) {
        // Validate assembled tool calls
        let blocked = false;
        let blockReason = 'Tool call blocked by veto policy';

        for (const [, tc] of pendingToolCalls) {
          const finalized = finalizeToolCall(tc);
          try {
            const result = await veto.guard(finalized.name, finalized.arguments);
            if (result.decision !== 'allow') {
              blocked = true;
              blockReason = result.reason ?? `Tool call '${finalized.name}' blocked`;
              break;
            }
          } catch (err) {
            console.error('[veto intercept] Unexpected guard error:', err instanceof Error ? err.message : String(err));
            blocked = true;
            blockReason = 'Tool call validation failed';
            break;
          }
        }

        if (blocked) {
          // Clear buffered chunks — send synthetic block event
          bufferedLines = [];
          clientRes.write(synthBlockedEvent(blockReason));
          mode = 'blocked';
        } else {
          flushBuffer();
          mode = 'passthrough';
        }

        pendingToolCalls.clear();
      }
    }
  }

  // Flush any remaining partial line (shouldn't happen with well-formed SSE)
  if (partial.trim() && mode !== 'blocked') {
    clientRes.write(partial + '\n');
  }

  if (mode === 'buffer' && !bufferOverflowed) {
    // Stream ended mid-buffer (connection closed?) — flush what we have
    flushBuffer();
  }

  clientRes.end();
}

/**
 * Intercept a non-streaming Anthropic Messages response.
 * Tool calls are content blocks with type "tool_use", where input is an object (not stringified).
 */
async function interceptAnthropicNonStreamResponse(
  upstream: http.IncomingMessage,
  clientRes: http.ServerResponse,
  veto: Veto,
): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of upstream) {
    chunks.push(chunk as Buffer);
  }
  const responseBody = Buffer.concat(chunks).toString('utf-8');

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(responseBody) as Record<string, unknown>;
  } catch {
    clientRes.writeHead(upstream.statusCode ?? 200, upstream.headers);
    clientRes.end(responseBody);
    return;
  }

  const content = Array.isArray(parsed['content']) ? parsed['content'] : [];
  let blocked = false;
  let blockReason = 'Tool call blocked by veto policy';

  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b['type'] !== 'tool_use') continue;

    const name = typeof b['name'] === 'string' ? b['name'] : '';
    let args: Record<string, unknown> = {};
    if (b['input'] && typeof b['input'] === 'object' && !Array.isArray(b['input'])) {
      args = b['input'] as Record<string, unknown>;
    }

    try {
      const result = await veto.guard(name, args);
      if (result.decision !== 'allow') {
        blocked = true;
        blockReason = result.reason ?? `Tool call '${name}' blocked`;
        break;
      }
    } catch (err) {
      console.error('[veto intercept] Unexpected guard error:', err instanceof Error ? err.message : String(err));
      blocked = true;
      blockReason = 'Tool call validation failed';
      break;
    }
  }

  if (blocked) {
    const blockedResponse = {
      ...parsed,
      content: [{ type: 'text', text: `[BLOCKED by veto] ${blockReason}` }],
      stop_reason: 'end_turn',
    };
    const body = JSON.stringify(blockedResponse);
    const headers = { ...upstream.headers };
    headers['content-length'] = Buffer.byteLength(body).toString();
    clientRes.writeHead(200, headers);
    clientRes.end(body);
  } else {
    clientRes.writeHead(upstream.statusCode ?? 200, upstream.headers);
    clientRes.end(responseBody);
  }
}

/**
 * Intercept an Anthropic SSE stream.
 *
 * Anthropic events come as `event: <type>\ndata: <json>\n\n` pairs.
 * Tool calls span content_block_start → content_block_delta(s) → content_block_stop.
 * We buffer from the first tool_use block start until message_stop, then validate.
 */
async function interceptAnthropicSSEStream(
  upstream: http.IncomingMessage,
  clientRes: http.ServerResponse,
  config: ProxyConfig,
  veto: Veto,
): Promise<void> {
  const maxBufferBytes = config.maxBufferBytes;

  let partial = '';
  const pendingToolUses = new Map<number, AnthropicPendingToolUse>();
  let bufferedChunks: string[] = [];
  let bufferedBytes = 0;
  let mode: 'passthrough' | 'buffer' | 'overflow' = 'passthrough';
  let bufferOverflowed = false;
  // Track which content block indexes are tool_use blocks
  const toolUseIndexes = new Set<number>();

  // Accumulate event: + data: line pairs
  let eventLineBuf: string[] = [];

  const flushBuffer = () => {
    for (const chunk of bufferedChunks) {
      clientRes.write(chunk);
    }
    bufferedChunks = [];
    bufferedBytes = 0;
  };

  for await (const rawChunk of upstream) {
    const chunk = (rawChunk as Buffer).toString('utf-8');
    partial += chunk;

    const lines = partial.split('\n');
    partial = lines.pop() ?? '';

    for (const rawLine of lines) {
      const line = rawLine.replace(/\r$/, '');

      // Accumulate event: + data: pairs; empty line signals end of an SSE event
      if (line !== '') {
        eventLineBuf.push(line);
        continue;
      }

      // Empty line = end of SSE event
      if (eventLineBuf.length === 0) {
        if (mode === 'passthrough') clientRes.write('\n');
        continue;
      }

      const sseBlock = eventLineBuf.join('\n') + '\n\n';
      const parsed = parseAnthropicSSELines(eventLineBuf);
      eventLineBuf = [];

      // Track tool_use block indexes
      if (parsed.eventType === 'content_block_start' && parsed.data) {
        const block = parsed.data['content_block'] as Record<string, unknown> | undefined;
        if (block && block['type'] === 'tool_use') {
          const idx = typeof parsed.data['index'] === 'number' ? parsed.data['index'] : 0;
          toolUseIndexes.add(idx);
        }
      }

      // Determine if this event relates to a tool_use block
      const isToolUseEvent = parsed.hasToolUse
        || (parsed.toolUseStop && parsed.data && toolUseIndexes.has(
          typeof parsed.data['index'] === 'number' ? parsed.data['index'] : -1,
        ));

      if (mode === 'overflow') {
        clientRes.write(sseBlock);
        continue;
      }

      if (mode === 'passthrough') {
        if (isToolUseEvent) {
          mode = 'buffer';
        } else if (parsed.messageStop) {
          clientRes.write(sseBlock);
          continue;
        } else {
          clientRes.write(sseBlock);
          continue;
        }
      }

      // Buffer mode
      if (parsed.data && parsed.eventType) {
        mergeAnthropicToolUseDelta(pendingToolUses, parsed.data, parsed.eventType);
      }

      const blockBytes = Buffer.byteLength(sseBlock, 'utf-8');
      bufferedBytes += blockBytes;
      bufferedChunks.push(sseBlock);

      if (bufferedBytes > maxBufferBytes) {
        bufferOverflowed = true;
        mode = 'overflow';
        flushBuffer();
        console.warn('[veto intercept] Buffer limit exceeded — flushing without validation');
        continue;
      }

      if (parsed.messageStop) {
        // Validate all assembled tool uses
        let blocked = false;
        let blockReason = 'Tool call blocked by veto policy';

        for (const [, tc] of pendingToolUses) {
          const finalized = finalizeAnthropicToolUse(tc);
          try {
            const result = await veto.guard(finalized.name, finalized.arguments);
            if (result.decision !== 'allow') {
              blocked = true;
              blockReason = result.reason ?? `Tool call '${finalized.name}' blocked`;
              break;
            }
          } catch (err) {
            console.error('[veto intercept] Unexpected guard error:', err instanceof Error ? err.message : String(err));
            blocked = true;
            blockReason = 'Tool call validation failed';
            break;
          }
        }

        if (blocked) {
          bufferedChunks = [];
          clientRes.write(synthAnthropicBlockedEvent(blockReason));
        } else {
          flushBuffer();
        }

        mode = 'passthrough';
        pendingToolUses.clear();
        toolUseIndexes.clear();
      }
    }
  }

  // Flush remaining partial event lines
  if (partial.trim()) {
    clientRes.write(partial + '\n');
  }

  if (mode === 'buffer' && !bufferOverflowed) {
    flushBuffer();
  }

  clientRes.end();
}

/**
 * Start the veto intercept proxy server.
 * Returns a cleanup function that stops the server and destroys the Veto instance.
 */
export async function startProxyServer(config: ProxyConfig): Promise<() => Promise<void>> {
  const veto = await Veto.init({ configDir: config.configDir });

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      handleRequest(req, res, config, veto).catch((err) => {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          const detail = err instanceof Error ? err.message : String(err);
          console.error('[veto intercept] Internal proxy error:', detail);
          res.end('Internal proxy error');
        }
      });
    });

    server.on('error', reject);
    server.listen(config.port, '127.0.0.1', () => {
      resolve(async () => {
        await new Promise<void>((r, e) => server.close((err) => (err ? e(err) : r())));
        veto.dispose();
      });
    });
  });
}
