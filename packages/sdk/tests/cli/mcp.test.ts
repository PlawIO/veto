import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  createMcpGatewayServerForTesting,
  createDefaultMcpConfigTemplate,
  resolveMcpConfigForTesting,
  runMcpConnectCommand,
  runMcpDoctorCommand,
  runMcpInitCommand,
} from '../../src/cli/mcp.js';
import { parseMcpProxyOptions } from '../../src/cli/mcp-proxy-bin.js';

const TMP_ROOT = `/tmp/veto-mcp-cli-test-${Date.now()}`;

async function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        resolve(0);
        return;
      }
      resolve(address.port);
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function readSsePayload(reader: ReadableStreamDefaultReader<Uint8Array>, timeoutMs = 1000): Promise<string | null> {
  const decoder = new TextDecoder();
  let buffer = '';
  const read = (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        return null;
      }
      buffer += decoder.decode(value, { stream: true });
      const match = buffer.match(/^data: (.*)$/m);
      if (match) {
        return match[1] ?? '';
      }
    }
  })();
  const timeout = new Promise<null>((resolveTimeout) => {
    setTimeout(() => resolveTimeout(null), timeoutMs);
  });
  return await Promise.race([read, timeout]);
}

describe('mcp cli commands', () => {
  afterEach(() => {
    if (existsSync(TMP_ROOT)) {
      rmSync(TMP_ROOT, { recursive: true, force: true });
    }
  });

  it('creates default mcp config file on init', () => {
    const outputPath = join(TMP_ROOT, 'veto', 'mcp.config.yaml');
    const result = runMcpInitCommand({ outputPath });

    expect(result.ok).toBe(true);
    expect(result.data?.created).toBe(true);
    expect(existsSync(outputPath)).toBe(true);

    const second = runMcpInitCommand({ outputPath });
    expect(second.ok).toBe(true);
    expect(second.data?.created).toBe(false);
  });

  it('persists a local MCP client config entry and initializes the gateway config', () => {
    const outputPath = join(TMP_ROOT, 'mcp.json');
    const gatewayConfigPath = join(TMP_ROOT, 'veto', 'mcp.config.yaml');
    const result = runMcpConnectCommand({
      outputPath,
      configPath: gatewayConfigPath,
    });

    expect(result.ok).toBe(true);
    expect(result.data?.mode).toBe('local');
    expect(result.data?.created).toBe(true);
    expect(result.data?.updated).toBe(true);
    expect(result.data?.gatewayConfigPath).toBe(gatewayConfigPath);
    expect(existsSync(outputPath)).toBe(true);
    expect(existsSync(gatewayConfigPath)).toBe(true);

    const parsed = JSON.parse(readFileSync(outputPath, 'utf-8')) as {
      mcpServers?: Record<string, {
        command?: string;
        args?: string[];
        env?: Record<string, string>;
      }>;
    };

    expect(parsed.mcpServers?.veto?.command).toBe('veto');
    expect(parsed.mcpServers?.veto?.args).toEqual(['mcp', 'serve', '--config', gatewayConfigPath]);
    expect(parsed.mcpServers?.veto?.env).toEqual({
      VETO_API_KEY: '${env:VETO_API_KEY}',
    });

    chmodSync(outputPath, 0o444);
    const second = runMcpConnectCommand({
      outputPath,
      configPath: gatewayConfigPath,
    });
    expect(second.ok).toBe(true);
    expect(second.data?.created).toBe(false);
    expect(second.data?.updated).toBe(false);
  });

  it('persists an api MCP client config entry when --cloud is enabled', () => {
    const outputPath = join(TMP_ROOT, 'mcp.json');
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, JSON.stringify({
      version: 1,
      mcpServers: {
        existing: {
          command: 'node',
          args: ['existing.js'],
        },
      },
    }, null, 2), 'utf-8');

    const result = runMcpConnectCommand({
      outputPath,
      cloud: true,
    });

    expect(result.ok).toBe(true);
    expect(result.data?.mode).toBe('api');
    expect(result.data?.endpoint).toBe('https://api.veto.so/v1/mcp/default');
    expect(result.data?.gatewayConfigPath).toBeUndefined();

    const parsed = JSON.parse(readFileSync(outputPath, 'utf-8')) as {
      version?: number;
      mcpServers?: Record<string, {
        command?: string;
        args?: string[];
        url?: string;
        serverUrl?: string;
        headers?: Record<string, string>;
      }>;
    };

    expect(parsed.version).toBe(1);
    expect(parsed.mcpServers?.existing).toEqual({
      command: 'node',
      args: ['existing.js'],
    });
    expect(parsed.mcpServers?.veto).toEqual({
      url: 'https://api.veto.so/v1/mcp/default',
      serverUrl: 'https://api.veto.so/v1/mcp/default',
      headers: {
        'X-Veto-API-Key': '${env:VETO_API_KEY}',
      },
    });

    const second = runMcpConnectCommand({
      outputPath,
      cloud: true,
    });
    expect(second.ok).toBe(true);
    expect(second.data?.created).toBe(false);
    expect(second.data?.updated).toBe(false);
  });

  it('builds quick serve config from flags when no file exists', () => {
    const resolved = resolveMcpConfigForTesting({
      configPath: join(TMP_ROOT, 'missing-config.yaml'),
      upstream: 'http://localhost:9000/mcp',
      apiKey: 'veto_test_key',
      listen: '0.0.0.0:9900',
      timeoutMs: 1234,
    });

    expect(resolved.config.listen.host).toBe('0.0.0.0');
    expect(resolved.config.listen.port).toBe(9900);
    expect(resolved.config.policy.apiKey).toBe('veto_test_key');
    expect(resolved.config.upstreams).toHaveLength(1);
    expect(resolved.config.upstreams[0]?.transport).toBe('mcp-sse');
    expect(resolved.config.upstreams[0]?.timeoutMs).toBe(1234);
  });

  it('rejects invalid explicit transport values in quick serve mode', () => {
    expect(() => resolveMcpConfigForTesting({
      configPath: join(TMP_ROOT, 'missing-config.yaml'),
      upstream: 'http://localhost:9000/mcp',
      apiKey: 'veto_test_key',
      transport: 'invalid-transport',
    })).toThrow("Invalid --transport");
  });

  it('rejects unsupported upstream protocols in quick serve mode', () => {
    expect(() => resolveMcpConfigForTesting({
      configPath: join(TMP_ROOT, 'missing-config.yaml'),
      upstream: 'mcphttp://169.254.169.254/internal',
      apiKey: 'veto_test_key',
    })).toThrow('Unsupported upstream URL protocol');
  });

  it('passes doctor checks when policy server and upstream are reachable', async () => {
    mkdirSync(TMP_ROOT, { recursive: true });

    const policyServer = createServer((req, res) => {
      if (req.url === '/health') {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }

      res.statusCode = 404;
      res.end();
    });

    const upstreamServer = createServer((req, res) => {
      if (req.method === 'POST') {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: 'doctor-tools-list',
          result: { tools: [] },
        }));
        return;
      }

      res.statusCode = 405;
      res.end();
    });

    const policyPort = await listen(policyServer);
    const upstreamPort = await listen(upstreamServer);

    const configPath = join(TMP_ROOT, 'veto', 'mcp.config.yaml');
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, `listen:\n  host: 127.0.0.1\n  port: 8899\npolicy:\n  serverUrl: http://127.0.0.1:${policyPort}\n  apiKey: veto_test_key\nupstreams:\n  - name: default\n    transport: mcp-sse\n    url: http://127.0.0.1:${upstreamPort}\n    timeoutMs: 2000\nlogging:\n  level: info\n`, 'utf-8');

    try {
      const result = await runMcpDoctorCommand({ configPath });
      expect(result.ok).toBe(true);
      expect(result.data?.policyServer.ok).toBe(true);
      expect(result.data?.upstreams[0]?.ok).toBe(true);
    } finally {
      await closeServer(policyServer);
      await closeServer(upstreamServer);
    }
  });

  it('default template is valid yaml with required sections', () => {
    const template = createDefaultMcpConfigTemplate();
    expect(template).toContain('listen:');
    expect(template).toContain('policy:');
    expect(template).toContain('upstreams:');

    const path = join(TMP_ROOT, 'template.yaml');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, template, 'utf-8');

    const raw = readFileSync(path, 'utf-8');
    expect(raw.length).toBeGreaterThan(50);
  });

  it('publishes veto-mcp-proxy bin paths in first-party CLI packages', () => {
    const sdkPackage = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf-8')) as {
      bin?: Record<string, string>;
    };
    const cliPackage = JSON.parse(readFileSync(resolve(process.cwd(), '../cli/package.json'), 'utf-8')) as {
      bin?: Record<string, string>;
    };
    const vetoPackage = JSON.parse(readFileSync(resolve(process.cwd(), '../veto/package.json'), 'utf-8')) as {
      bin?: Record<string, string>;
    };

    expect(sdkPackage.bin?.['veto-mcp-proxy']).toBe('./dist/cli/mcp-proxy-bin.js');
    expect(cliPackage.bin?.['veto-mcp-proxy']).toBe('./dist/mcp-proxy-bin.js');
    expect(vetoPackage.bin?.['veto-mcp-proxy']).toBe('./dist/mcp-proxy-bin.js');
  });

  it('parses veto-mcp-proxy options for the shared MCP serve command', () => {
    expect(parseMcpProxyOptions([
      '--config',
      './veto/mcp.config.yaml',
      '--listen',
      '127.0.0.1:9000',
      '--upstream',
      'http://localhost:3000/mcp',
      '--transport',
      'mcp-sse',
      '--api-key',
      'veto_test_key_1234567890',
      '--policy-server',
      'http://localhost:3001',
      '--timeout-ms',
      '1234',
      '--json',
    ])).toEqual({
      configPath: './veto/mcp.config.yaml',
      listen: '127.0.0.1:9000',
      upstream: 'http://localhost:3000/mcp',
      transport: 'mcp-sse',
      apiKey: 'veto_test_key_1234567890',
      policyServer: 'http://localhost:3001',
      timeoutMs: 1234,
      asJson: true,
    });

    expect(parseMcpProxyOptions(['--help'])).toBeNull();
    expect(() => parseMcpProxyOptions(['--timeout-ms', '0'])).toThrow('positive integer');
  });

  it('rejects tools/call requests without a non-empty tool name', async () => {
    const gateway = createMcpGatewayServerForTesting({
      listen: {
        host: '127.0.0.1',
        port: 0,
      },
      policy: {
        serverUrl: 'http://127.0.0.1:65534',
        apiKey: 'veto_test_key_1234567890',
      },
      upstreams: [
        {
          name: 'default',
          transport: 'mcp-sse',
          url: 'http://127.0.0.1:65534',
          timeoutMs: 1000,
        },
      ],
      logging: {
        level: 'info',
      },
    });

    await gateway.start();
    const address = gateway.getAddress();
    expect(address).not.toBeNull();

    try {
      const response = await fetch(`http://${address!.host}:${address!.port}/default`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            arguments: { amount: 100 },
          },
        }),
      });

      expect(response.status).toBe(200);
      const body = await response.json() as { error?: { code?: number; message?: string } };
      expect(body.error?.code).toBe(-32602);
      expect(body.error?.message).toContain('params.name');
    } finally {
      await gateway.stop();
    }
  });

  it('rejects oversized HTTP bodies', async () => {
    const gateway = createMcpGatewayServerForTesting({
      listen: {
        host: '127.0.0.1',
        port: 0,
      },
      policy: {
        serverUrl: 'http://127.0.0.1:65534',
        apiKey: 'veto_test_key_1234567890',
      },
      upstreams: [
        {
          name: 'default',
          transport: 'mcp-sse',
          url: 'http://127.0.0.1:65534',
          timeoutMs: 1000,
        },
      ],
      logging: {
        level: 'info',
      },
    });

    await gateway.start();
    const address = gateway.getAddress();
    expect(address).not.toBeNull();

    const oversizedPayload = 'x'.repeat(1_100_000);

    try {
      const response = await fetch(`http://${address!.host}:${address!.port}/default`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: oversizedPayload,
      });

      expect(response.status).toBe(413);
      const body = await response.json() as { error?: { message?: string } };
      expect(body.error?.message).toContain('Request body exceeds');
    } finally {
      await gateway.stop();
    }
  });

  it('denies tool calls when policy server returns malformed decisions', async () => {
    let upstreamCalls = 0;
    const policyServer = createServer((req, res) => {
      if (req.url === '/v1/validate') {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ decision: 'definitely_allow' }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    const upstreamServer = createServer((req, res) => {
      upstreamCalls += 1;
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }));
    });

    const policyPort = await listen(policyServer);
    const upstreamPort = await listen(upstreamServer);
    const gateway = createMcpGatewayServerForTesting({
      listen: { host: '127.0.0.1', port: 0 },
      policy: { serverUrl: `http://127.0.0.1:${policyPort}`, apiKey: 'veto_test_key_1234567890' },
      upstreams: [
        { name: 'default', transport: 'mcp-sse', url: `http://127.0.0.1:${upstreamPort}`, timeoutMs: 1000 },
      ],
      logging: { level: 'info' },
    });

    await gateway.start();
    const address = gateway.getAddress();
    expect(address).not.toBeNull();

    try {
      const response = await fetch(`http://${address!.host}:${address!.port}/default`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'dangerous_tool', arguments: {} },
        }),
      });
      const body = await response.json() as { error?: { code?: number; message?: string } };

      expect(body.error?.code).toBe(-32001);
      expect(body.error?.message).toContain('invalid decision payload');
      expect(upstreamCalls).toBe(0);
    } finally {
      await gateway.stop();
      await closeServer(policyServer);
      await closeServer(upstreamServer);
    }
  });

  it('does not broadcast policy decisions to unrelated SSE subscribers', async () => {
    const policyServer = createServer((req, res) => {
      if (req.url === '/v1/validate') {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ decision: 'allow' }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    const upstreamServer = createServer((req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { ok: true } }));
    });

    const policyPort = await listen(policyServer);
    const upstreamPort = await listen(upstreamServer);
    const gateway = createMcpGatewayServerForTesting({
      listen: { host: '127.0.0.1', port: 0 },
      policy: { serverUrl: `http://127.0.0.1:${policyPort}`, apiKey: 'veto_test_key_1234567890' },
      upstreams: [
        { name: 'default', transport: 'mcp-sse', url: `http://127.0.0.1:${upstreamPort}`, timeoutMs: 1000 },
      ],
      logging: { level: 'info' },
    });

    await gateway.start();
    const address = gateway.getAddress();
    expect(address).not.toBeNull();

    const sseResponse = await fetch(`http://${address!.host}:${address!.port}/default`);
    const reader = sseResponse.body?.getReader();
    expect(reader).toBeDefined();

    try {
      const session = await readSsePayload(reader!);
      expect(session).toContain('notifications/session');

      const response = await fetch(`http://${address!.host}:${address!.port}/default`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'safe_tool', arguments: {} },
        }),
      });
      expect(response.status).toBe(200);

      const leaked = await readSsePayload(reader!, 100);
      expect(leaked).toBeNull();
    } finally {
      await reader?.cancel();
      await gateway.stop();
      await closeServer(policyServer);
      await closeServer(upstreamServer);
    }
  });
});
