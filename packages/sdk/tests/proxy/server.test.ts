/**
 * End-to-end proxy governance tests.
 *
 * Spins up a mock "upstream" OpenAI-like SSE server and the veto proxy,
 * then verifies blocked tool calls produce a synthetic BLOCKED response
 * and allowed tool calls are forwarded unmodified.
 */
import http from 'node:http';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, afterAll } from 'vitest';
import { startProxyServer } from '../../src/proxy/server.js';

const TMP = '/tmp/veto-proxy-e2e-' + Date.now();

function setupVetoDir(): string {
  const configDir = join(TMP, 'veto');
  const rulesDir = join(configDir, 'rules');
  mkdirSync(rulesDir, { recursive: true });

  writeFileSync(
    join(configDir, 'veto.config.yaml'),
    [
      'version: "1.0"',
      'mode: "strict"',
      'validation:',
      '  mode: "local"',
      'logging:',
      '  level: "silent"',
      'rules:',
      '  directory: "./rules"',
    ].join('\n'),
    'utf-8',
  );

  writeFileSync(
    join(rulesDir, 'rules.yaml'),
    [
      'version: "1.0"',
      'name: test',
      'rules:',
      '  - id: block-delete',
      '    name: Block delete',
      '    enabled: true',
      '    severity: high',
      '    action: block',
      '    tools: [delete_file]',
    ].join('\n'),
    'utf-8',
  );

  return configDir;
}

/** Build an SSE stream that contains a single tool call chunk + finish */
function buildToolCallSSE(toolName: string, args: string): string {
  const delta1 = JSON.stringify({
    choices: [{
      delta: {
        tool_calls: [{ index: 0, id: 'tc_1', function: { name: toolName, arguments: '' } }],
      },
      finish_reason: null,
    }],
  });
  const delta2 = JSON.stringify({
    choices: [{
      delta: {
        tool_calls: [{ index: 0, function: { arguments: args } }],
      },
      finish_reason: null,
    }],
  });
  const finish = JSON.stringify({
    choices: [{ delta: {}, finish_reason: 'tool_calls' }],
  });
  return `data: ${delta1}\n\ndata: ${delta2}\n\ndata: ${finish}\n\ndata: [DONE]\n\n`;
}

/** Build an SSE stream with plain content (no tool calls) */
function buildContentSSE(text: string): string {
  const chunk = JSON.stringify({
    choices: [{ delta: { content: text }, finish_reason: null }],
  });
  const done = JSON.stringify({
    choices: [{ delta: {}, finish_reason: 'stop' }],
  });
  return `data: ${chunk}\n\ndata: ${done}\n\ndata: [DONE]\n\n`;
}

/** Start a minimal mock upstream server. Returns its URL and a stop fn. */
function startMockUpstream(sseBody: string): Promise<{ url: string; stop: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(sseBody);
      res.end();
    });

    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${port}`,
        stop: () => new Promise<void>((r, e) => server.close((err) => (err ? e(err) : r()))),
      });
    });
  });
}

/** Find an available port for testing. */
function getFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const tmp = http.createServer();
    tmp.listen(0, '127.0.0.1', () => {
      const { port } = tmp.address() as { port: number };
      tmp.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

/** Make a streaming chat completion request through the proxy. Returns response body as string. */
function requestThroughProxy(proxyPort: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: 'gpt-4', stream: true, messages: [] });
    const options: http.RequestOptions = {
      hostname: '127.0.0.1',
      port: proxyPort,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    };

    const req = http.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk as Buffer));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      res.on('error', reject);
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

describe('veto intercept proxy — end-to-end', () => {
  afterAll(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  it('blocked tool call receives synthetic BLOCKED response', async () => {
    const configDir = setupVetoDir();
    const upstream = await startMockUpstream(buildToolCallSSE('delete_file', '{"path":"/etc/hosts"}'));
    const freePort = await getFreePort();

    const stopProxy = await startProxyServer({
      port: freePort,
      target: upstream.url,
      maxBufferBytes: 1024 * 1024,
      configDir,
      format: 'openai',
    });

    try {
      const response = await requestThroughProxy(freePort);
      expect(response).toContain('[BLOCKED by veto]');
      expect(response).toContain('data: ');
      expect(response).toContain('[DONE]');
    } finally {
      await stopProxy();
      await upstream.stop();
    }
  });

  it('allowed tool call is forwarded to client', async () => {
    const configDir = setupVetoDir();
    const sseBody = buildToolCallSSE('read_file', '{"path":"/tmp/file"}');
    const upstream = await startMockUpstream(sseBody);
    const freePort = await getFreePort();

    const stopProxy = await startProxyServer({
      port: freePort,
      target: upstream.url,
      maxBufferBytes: 1024 * 1024,
      configDir,
      format: 'openai',
    });

    try {
      const response = await requestThroughProxy(freePort);
      expect(response).not.toContain('[BLOCKED by veto]');
      expect(response).toContain('read_file');
    } finally {
      await stopProxy();
      await upstream.stop();
    }
  });

  it('non-tool-call content streams through unmodified', async () => {
    const configDir = setupVetoDir();
    const upstream = await startMockUpstream(buildContentSSE('Hello, world!'));
    const freePort = await getFreePort();

    const stopProxy = await startProxyServer({
      port: freePort,
      target: upstream.url,
      maxBufferBytes: 1024 * 1024,
      configDir,
      format: 'openai',
    });

    try {
      const response = await requestThroughProxy(freePort);
      expect(response).toContain('Hello, world!');
      expect(response).not.toContain('[BLOCKED by veto]');
    } finally {
      await stopProxy();
      await upstream.stop();
    }
  });

  it('returns 502 when upstream is unreachable', async () => {
    const configDir = setupVetoDir();
    const freePort = await getFreePort();

    // Point at a port nothing is listening on
    const deadPort = await getFreePort();
    const stopProxy = await startProxyServer({
      port: freePort,
      target: `http://127.0.0.1:${deadPort}`,
      maxBufferBytes: 1024 * 1024,
      configDir,
      format: 'openai',
    });

    try {
      const { statusCode, body } = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
        const reqBody = JSON.stringify({ model: 'gpt-4', stream: true, messages: [] });
        const req = http.request({
          hostname: '127.0.0.1', port: freePort,
          path: '/v1/chat/completions', method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(reqBody) },
        }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c as Buffer));
          res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
          res.on('error', reject);
        });
        req.on('error', reject);
        req.write(reqBody);
        req.end();
      });

      expect(statusCode).toBe(502);
      expect(body).toContain('Bad Gateway');
    } finally {
      await stopProxy();
    }
  });

  it('returns 413 or resets connection when request body exceeds limit', async () => {
    const configDir = setupVetoDir();
    const upstream = await startMockUpstream(buildContentSSE('should not reach'));
    const freePort = await getFreePort();

    const stopProxy = await startProxyServer({
      port: freePort,
      target: upstream.url,
      maxBufferBytes: 1024 * 1024,
      configDir,
      format: 'openai',
    });

    try {
      // Use a stream that generates oversized data chunk by chunk
      const result = await new Promise<{ statusCode: number; body: string } | { error: string }>((resolve) => {
        const req = http.request({
          hostname: '127.0.0.1', port: freePort,
          path: '/v1/chat/completions', method: 'POST',
          headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
        }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c as Buffer));
          res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
        });
        req.on('error', (err) => resolve({ error: err.message }));

        // Write 11 chunks of 1MB each, using drain events for backpressure
        const chunk = Buffer.alloc(1024 * 1024, 0x78); // 1MB of 'x'
        let written = 0;
        const writeNext = () => {
          while (written < 11) {
            written++;
            const ok = req.write(chunk);
            if (!ok) {
              req.once('drain', writeNext);
              return;
            }
          }
          req.end();
        };
        writeNext();
      });

      // Server destroys the stream and sends 413, or connection is reset
      if ('statusCode' in result) {
        expect(result.statusCode).toBe(413);
        expect(result.body).toContain('too large');
      } else {
        // Connection was reset — server rejected the oversized body
        expect(result.error).toBeTruthy();
      }
    } finally {
      await stopProxy();
      await upstream.stop();
    }
  }, 30000);

  it('non-streaming chat completion with blocked tool call returns blocked response', async () => {
    const configDir = setupVetoDir();

    // Mock upstream that returns a non-streaming response with a tool call
    const nonStreamUpstream = await new Promise<{ url: string; stop: () => Promise<void> }>((resolve, reject) => {
      const server = http.createServer((_req, res) => {
        const responseBody = JSON.stringify({
          id: 'chatcmpl-123',
          object: 'chat.completion',
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              tool_calls: [{
                id: 'call_1',
                type: 'function',
                function: { name: 'delete_file', arguments: '{"path":"/etc/hosts"}' },
              }],
            },
            finish_reason: 'tool_calls',
          }],
        });
        res.writeHead(200, {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(responseBody),
        });
        res.end(responseBody);
      });
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as { port: number };
        resolve({
          url: `http://127.0.0.1:${port}`,
          stop: () => new Promise<void>((r, e) => server.close((err) => (err ? e(err) : r()))),
        });
      });
    });

    const freePort = await getFreePort();
    const stopProxy = await startProxyServer({
      port: freePort,
      target: nonStreamUpstream.url,
      maxBufferBytes: 1024 * 1024,
      configDir,
      format: 'openai',
    });

    try {
      // Non-streaming request (stream: false or absent)
      const { body } = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
        const reqBody = JSON.stringify({ model: 'gpt-4', stream: false, messages: [] });
        const req = http.request({
          hostname: '127.0.0.1', port: freePort,
          path: '/v1/chat/completions', method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(reqBody) },
        }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c as Buffer));
          res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
          res.on('error', reject);
        });
        req.on('error', reject);
        req.write(reqBody);
        req.end();
      });

      expect(body).toContain('[BLOCKED by veto]');
      const parsed = JSON.parse(body) as Record<string, unknown>;
      expect(parsed['choices']).toBeDefined();
    } finally {
      await stopProxy();
      await nonStreamUpstream.stop();
    }
  });

  it('cleanup function stops server and disposes veto instance', async () => {
    const configDir = setupVetoDir();
    const upstream = await startMockUpstream(buildContentSSE('test'));
    const freePort = await getFreePort();

    const stopProxy = await startProxyServer({
      port: freePort,
      target: upstream.url,
      maxBufferBytes: 1024 * 1024,
      configDir,
      format: 'openai',
    });

    // Server is running — verify a request works
    const response = await requestThroughProxy(freePort);
    expect(response).toContain('test');

    // Stop the proxy
    await stopProxy();
    await upstream.stop();

    // After stop, connections should be refused
    await expect(
      new Promise<string>((resolve, reject) => {
        const req = http.request({ hostname: '127.0.0.1', port: freePort, path: '/', method: 'GET' }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c as Buffer));
          res.on('end', () => resolve(Buffer.concat(chunks).toString()));
        });
        req.on('error', reject);
        req.end();
      })
    ).rejects.toThrow();
  });
});
