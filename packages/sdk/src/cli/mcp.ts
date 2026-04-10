import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { HeadlessResult } from './headless.js';

const DEFAULT_CONFIG_PATH = 'veto/mcp.config.yaml';
const DEFAULT_CONNECT_CONFIG_PATH = 'mcp.json';
const DEFAULT_CONNECT_SERVER_NAME = 'veto';
const DEFAULT_CLOUD_MCP_URL = 'https://api.veto.so/v1/mcp/default';
const DEFAULT_POLICY_SERVER_URL = 'http://localhost:3001';
const DEFAULT_LISTEN_HOST = '127.0.0.1';
const DEFAULT_LISTEN_PORT = 8799;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_HTTP_BODY_BYTES = 1_048_576;
const MAX_STDIO_BUFFER_BYTES = 1_048_576;
const MAX_PENDING_STDIO_REQUESTS = 1_000;

type McpTransport = 'mcp-sse' | 'mcp-stdio';
type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: string | number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface McpToolCallParams {
  name: string;
  arguments?: Record<string, unknown>;
}

interface GatewayDecisionEvent {
  type: 'decision';
  upstream: string;
  toolName: string;
  decision: 'allow' | 'deny' | 'require_approval';
  reason?: string;
  latencyMs: number;
  timestamp: string;
  requestId?: string;
  transport: McpTransport;
}

interface PolicyValidationResult {
  decision: 'allow' | 'deny' | 'require_approval';
  reason?: string;
  latencyMs: number;
}

interface McpUpstreamConfig {
  name: string;
  transport: McpTransport;
  url?: string;
  command?: string;
  args?: string[];
  headers?: Record<string, string>;
  timeoutMs: number;
}

export interface McpConfig {
  listen: {
    host: string;
    port: number;
  };
  policy: {
    serverUrl: string;
    apiKey: string;
  };
  upstreams: McpUpstreamConfig[];
  logging: {
    level: LogLevel;
  };
}

export interface McpServeOptions {
  configPath?: string;
  listen?: string;
  upstream?: string;
  transport?: string;
  apiKey?: string;
  policyServer?: string;
  timeoutMs?: number;
  asJson?: boolean;
}

export interface McpDoctorOptions {
  configPath?: string;
}

export interface McpConnectOptions {
  outputPath?: string;
  configPath?: string;
  serverName?: string;
  cloud?: boolean;
}

export interface McpInitOptions {
  outputPath?: string;
}

export interface McpDoctorReport {
  configPath: string;
  configValid: boolean;
  policyServer: {
    ok: boolean;
    url: string;
    status?: number;
    message: string;
    latencyMs?: number;
  };
  upstreams: Array<{
    name: string;
    transport: McpTransport;
    ok: boolean;
    message: string;
    latencyMs?: number;
    status?: number;
  }>;
}

interface ResolvedMcpConfig {
  path: string;
  config: McpConfig;
}

interface McpClientServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  serverUrl?: string;
  headers?: Record<string, string>;
}

interface McpClientConfigDocument {
  mcpServers?: Record<string, McpClientServerConfig>;
  [key: string]: unknown;
}

function ok<T>(data: T): HeadlessResult<T> {
  return { ok: true, data };
}

function fail<T>(code: string, message: string, details?: unknown): HeadlessResult<T> {
  return {
    ok: false,
    error: {
      code,
      message,
      details,
    },
  };
}

function inferTransportFromUpstream(value: string): McpTransport {
  const normalized = value.trim().toLowerCase();
  if (normalized.startsWith('mcp://') || normalized.startsWith('mcp+sse://') || normalized.startsWith('http://') || normalized.startsWith('https://')) {
    return 'mcp-sse';
  }
  if (normalized.startsWith('stdio://')) {
    return 'mcp-stdio';
  }
  return 'mcp-sse';
}

function parseTransportFlag(value: string | undefined): McpTransport | undefined {
  if (!value) {
    return undefined;
  }

  if (value === 'mcp-sse' || value === 'mcp-stdio') {
    return value;
  }

  throw new Error(`Invalid --transport value '${value}'. Expected mcp-sse or mcp-stdio.`);
}

function resolveMcpUpstreamHttpUrl(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid upstream URL '${rawUrl}'`);
  }

  if (parsed.protocol === 'mcp:' || parsed.protocol === 'mcp+sse:') {
    parsed = new URL(parsed.toString().replace(/^mcp(\+sse)?:\/\//i, 'http://'));
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `Unsupported upstream URL protocol '${parsed.protocol}'. Expected mcp://, mcp+sse://, http://, or https://`,
    );
  }

  if (!parsed.hostname) {
    throw new Error(`Upstream URL '${rawUrl}' is missing a hostname`);
  }

  return parsed.toString();
}

function parseListenAddress(rawValue: string | undefined): { host: string; port: number } {
  if (!rawValue || rawValue.trim().length === 0) {
    return {
      host: DEFAULT_LISTEN_HOST,
      port: DEFAULT_LISTEN_PORT,
    };
  }

  const trimmed = rawValue.trim();
  const hasColon = trimmed.includes(':');

  if (!hasColon) {
    const port = Number.parseInt(trimmed, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`Invalid --listen value '${rawValue}'. Expected <host:port> or <port>.`);
    }
    return {
      host: DEFAULT_LISTEN_HOST,
      port,
    };
  }

  const lastColon = trimmed.lastIndexOf(':');
  const host = trimmed.slice(0, lastColon).trim() || DEFAULT_LISTEN_HOST;
  const portText = trimmed.slice(lastColon + 1).trim();
  const port = Number.parseInt(portText, 10);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid --listen value '${rawValue}'. Expected <host:port> with valid port.`);
  }

  return {
    host,
    port,
  };
}

function normalizeConfigPath(pathValue: string | undefined): string {
  return resolve(pathValue ?? DEFAULT_CONFIG_PATH);
}

function normalizeConnectConfigPath(pathValue: string | undefined): string {
  return resolve(pathValue ?? DEFAULT_CONNECT_CONFIG_PATH);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Invalid ${name}: expected non-empty string`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error('Invalid upstream.args: expected string[]');
  }

  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') {
      throw new Error('Invalid upstream.args: expected string[]');
    }
    out.push(entry);
  }
  return out;
}

function optionalHeaders(value: unknown): Record<string, string> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid upstream.headers: expected record<string, string>');
  }

  const out: Record<string, string> = {};
  for (const [key, headerValue] of Object.entries(value)) {
    if (typeof headerValue !== 'string') {
      throw new Error('Invalid upstream.headers: expected record<string, string>');
    }
    out[key] = headerValue;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

function createEnvInterpolation(name: string): string {
  return `\${env:${name}}`;
}

function optionalPositiveNumber(value: unknown, fallback: number, fieldName: string): number {
  if (value === undefined || value === null) {
    return fallback;
  }

  const parsed = typeof value === 'number'
    ? value
    : Number.parseInt(String(value), 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${fieldName}: expected positive integer`);
  }

  return Math.floor(parsed);
}

function parseTransport(value: unknown): McpTransport {
  if (value === 'mcp-sse' || value === 'mcp-stdio') {
    return value;
  }

  throw new Error("Invalid upstream.transport: expected 'mcp-sse' or 'mcp-stdio'");
}

function parseConfigDocument(document: unknown): McpConfig {
  const root = asRecord(document);
  const listen = asRecord(root.listen);
  const policy = asRecord(root.policy);
  const logging = asRecord(root.logging);

  const host = optionalString(listen.host) ?? DEFAULT_LISTEN_HOST;
  const port = optionalPositiveNumber(listen.port, DEFAULT_LISTEN_PORT, 'listen.port');

  const policyServerUrl = optionalString(policy.serverUrl) ?? DEFAULT_POLICY_SERVER_URL;
  const policyApiKey = optionalString(policy.apiKey);
  if (!policyApiKey) {
    throw new Error('Invalid policy.apiKey: expected non-empty string');
  }

  const upstreamsRaw = root.upstreams;
  if (!Array.isArray(upstreamsRaw) || upstreamsRaw.length === 0) {
    throw new Error('Invalid upstreams: expected non-empty array');
  }

  const upstreams: McpUpstreamConfig[] = upstreamsRaw.map((entry, index) => {
    const upstream = asRecord(entry);
    const name = requireString(upstream.name, `upstreams[${index}].name`);
    const transport = parseTransport(upstream.transport);
    const url = optionalString(upstream.url);
    const command = optionalString(upstream.command);
    const args = optionalStringArray(upstream.args);
    const headers = optionalHeaders(upstream.headers);
    const timeoutMs = optionalPositiveNumber(upstream.timeoutMs, DEFAULT_TIMEOUT_MS, `upstreams[${index}].timeoutMs`);

    if (transport === 'mcp-sse' && !url) {
      throw new Error(`Invalid upstream '${name}': mcp-sse transport requires url`);
    }

    if (transport === 'mcp-stdio' && !command) {
      throw new Error(`Invalid upstream '${name}': mcp-stdio transport requires command`);
    }

    if (transport === 'mcp-sse' && url) {
      resolveMcpUpstreamHttpUrl(url);
    }

    return {
      name,
      transport,
      url,
      command,
      args,
      headers,
      timeoutMs,
    };
  });

  const loggingLevel = (() => {
    const level = optionalString(logging.level);
    if (!level) {
      return 'info' as LogLevel;
    }

    if (level === 'trace' || level === 'debug' || level === 'info' || level === 'warn' || level === 'error' || level === 'fatal') {
      return level;
    }

    throw new Error(`Invalid logging.level '${level}'`);
  })();

  return {
    listen: {
      host,
      port,
    },
    policy: {
      serverUrl: policyServerUrl.replace(/\/$/, ''),
      apiKey: policyApiKey,
    },
    upstreams,
    logging: {
      level: loggingLevel,
    },
  };
}

function loadConfigFromPath(configPath: string): McpConfig {
  if (!existsSync(configPath)) {
    throw new Error(`MCP config not found: ${configPath}`);
  }

  const content = readFileSync(configPath, 'utf-8');
  const parsed = parseYaml(content) as unknown;
  return parseConfigDocument(parsed);
}

function loadMcpClientConfigDocument(configPath: string): McpClientConfigDocument {
  if (!existsSync(configPath)) {
    return {};
  }

  const content = readFileSync(configPath, 'utf-8').trim();
  if (content.length === 0) {
    return {};
  }

  const parsed = JSON.parse(content) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid MCP client config at ${configPath}: expected top-level object`);
  }

  const document = parsed as Record<string, unknown>;
  const servers = document.mcpServers;
  if (servers !== undefined && (!servers || typeof servers !== 'object' || Array.isArray(servers))) {
    throw new Error(`Invalid MCP client config at ${configPath}: mcpServers must be an object`);
  }

  return document as McpClientConfigDocument;
}

function writeMcpClientConfigDocument(configPath: string, document: McpClientConfigDocument): void {
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(document, null, 2) + '\n', 'utf-8');
}

function createLocalMcpClientServerConfig(configPath: string): McpClientServerConfig {
  return {
    command: 'veto',
    args: ['mcp', 'serve', '--config', configPath],
    env: {
      VETO_API_KEY: createEnvInterpolation('VETO_API_KEY'),
    },
  };
}

function createCloudMcpClientServerConfig(): McpClientServerConfig {
  return {
    url: DEFAULT_CLOUD_MCP_URL,
    serverUrl: DEFAULT_CLOUD_MCP_URL,
    headers: {
      'X-Veto-API-Key': createEnvInterpolation('VETO_API_KEY'),
    },
  };
}

function parseQuickStdioCommand(upstreamValue: string): { command: string; args: string[] } {
  const withoutPrefix = upstreamValue.replace(/^stdio:\/\//, '').trim();
  if (!withoutPrefix) {
    throw new Error("Invalid --upstream for mcp-stdio. Expected 'stdio://<command> [args]'.");
  }

  const segments = withoutPrefix.split(' ').map((part) => part.trim()).filter(Boolean);
  const command = segments[0];
  if (!command) {
    throw new Error("Invalid --upstream for mcp-stdio. Expected 'stdio://<command> [args]'.");
  }

  return {
    command,
    args: segments.slice(1),
  };
}

function buildConfigFromServeOptions(options: McpServeOptions): ResolvedMcpConfig {
  const path = normalizeConfigPath(options.configPath);
  const explicitTransport = parseTransportFlag(options.transport);
  const explicitApiKey = options.apiKey?.trim();
  const envApiKey = process.env.VETO_API_KEY?.trim();
  const policyApiKey = explicitApiKey || envApiKey;

  if (existsSync(path)) {
    const loaded = loadConfigFromPath(path);

    if (options.listen) {
      loaded.listen = parseListenAddress(options.listen);
    }

    if (options.policyServer) {
      loaded.policy.serverUrl = options.policyServer.trim().replace(/\/$/, '');
    }

    if (policyApiKey) {
      loaded.policy.apiKey = policyApiKey;
    }

    if (options.timeoutMs && options.timeoutMs > 0) {
      loaded.upstreams = loaded.upstreams.map((upstream) => ({
        ...upstream,
        timeoutMs: options.timeoutMs!,
      }));
    }

    return {
      path,
      config: loaded,
    };
  }

  if (!options.upstream) {
    throw new Error(`No MCP config found at ${path}. Provide --upstream and --api-key, or run 'veto mcp init'.`);
  }

  if (!policyApiKey) {
    throw new Error("Missing policy API key. Provide --api-key or set VETO_API_KEY.");
  }

  const transport = explicitTransport ?? inferTransportFromUpstream(options.upstream);
  const timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const listen = parseListenAddress(options.listen);

  const upstream: McpUpstreamConfig = {
    name: 'default',
    transport,
    timeoutMs,
  };

  if (transport === 'mcp-sse') {
    resolveMcpUpstreamHttpUrl(options.upstream);
    upstream.url = options.upstream;
  } else {
    const parsedStdio = parseQuickStdioCommand(options.upstream);
    upstream.command = parsedStdio.command;
    upstream.args = parsedStdio.args;
  }

  return {
    path,
    config: {
      listen,
      policy: {
        serverUrl: (options.policyServer ?? process.env.VETO_POLICY_SERVER_URL ?? DEFAULT_POLICY_SERVER_URL).trim().replace(/\/$/, ''),
        apiKey: policyApiKey,
      },
      upstreams: [upstream],
      logging: {
        level: 'info',
      },
    },
  };
}

class PolicyClient {
  constructor(
    private serverUrl: string,
    private apiKey: string,
  ) {}

  async validate(toolName: string, args: Record<string, unknown>): Promise<PolicyValidationResult> {
    const startedAt = Date.now();

    try {
      const response = await fetch(`${this.serverUrl}/v1/validate`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-veto-api-key': this.apiKey,
        },
        body: JSON.stringify({
          toolName,
          arguments: args,
        }),
      });

      if (!response.ok) {
        return {
          decision: 'deny',
          reason: `Policy server returned ${response.status}`,
          latencyMs: Date.now() - startedAt,
        };
      }

      const body = await response.json() as {
        decision: 'allow' | 'deny' | 'require_approval';
        reason?: string;
      };

      return {
        decision: body.decision,
        reason: body.reason,
        latencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      return {
        decision: 'deny',
        reason: `Policy server unreachable: ${error instanceof Error ? error.message : String(error)}`,
        latencyMs: Date.now() - startedAt,
      };
    }
  }
}

class UpstreamRuntime {
  private sseClients = new Set<ServerResponse>();
  private sessionCounter = 0;
  private stdioProcess: ChildProcessWithoutNullStreams | null = null;
  private stdioBuffer = '';
  private pendingStdio = new Map<string | number, {
    resolve: (response: JsonRpcResponse) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(
    private upstream: McpUpstreamConfig,
    private policyClient: PolicyClient,
  ) {}

  async start(): Promise<void> {
    if (this.upstream.transport === 'mcp-stdio') {
      this.startStdioProcess();
    }
  }

  async shutdown(): Promise<void> {
    for (const client of this.sseClients) {
      client.end();
    }
    this.sseClients.clear();

    if (this.stdioProcess) {
      this.stdioProcess.kill('SIGTERM');
      this.stdioProcess = null;
    }

    for (const [id, pending] of this.pendingStdio) {
      clearTimeout(pending.timer);
      pending.resolve({
        jsonrpc: '2.0',
        id,
        error: {
          code: -32603,
          message: `Stdio request ${String(id)} canceled during shutdown`,
        },
      });
    }
    this.pendingStdio.clear();
  }

  attachSseClient(res: ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });

    this.sseClients.add(res);

    const sessionNotification = JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/session',
      params: {
        sessionId: String(++this.sessionCounter),
      },
    });
    res.write(`data: ${sessionNotification}\n\n`);

    res.on('close', () => {
      this.sseClients.delete(res);
    });
  }

  async handleMessage(message: JsonRpcRequest): Promise<JsonRpcResponse> {
    if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return {
        jsonrpc: '2.0',
        id: message?.id,
        error: {
          code: -32600,
          message: 'Invalid JSON-RPC request',
        },
      };
    }

    if (message.method === 'tools/call') {
      const params = (message.params ?? {}) as unknown as McpToolCallParams;
      const toolName = typeof params.name === 'string' ? params.name.trim() : '';
      if (!toolName) {
        return {
          jsonrpc: '2.0',
          id: message.id,
          error: {
            code: -32602,
            message: 'Invalid tools/call request: params.name must be a non-empty string',
          },
        };
      }

      const result = await this.policyClient.validate(toolName, asRecord(params.arguments));
      this.emitDecision({
        type: 'decision',
        upstream: this.upstream.name,
        toolName,
        decision: result.decision,
        reason: result.reason,
        latencyMs: result.latencyMs,
        timestamp: new Date().toISOString(),
        requestId: message.id !== undefined ? String(message.id) : undefined,
        transport: this.upstream.transport,
      });

      if (result.decision === 'deny') {
        return {
          jsonrpc: '2.0',
          id: message.id,
          error: {
            code: -32001,
            message: `Tool call denied: ${result.reason ?? 'policy violation'}`,
          },
        };
      }

      if (result.decision === 'require_approval') {
        return {
          jsonrpc: '2.0',
          id: message.id,
          error: {
            code: -32002,
            message: `Tool call requires approval: ${result.reason ?? 'pending review'}`,
          },
        };
      }
    }

    if (this.upstream.transport === 'mcp-sse') {
      return this.forwardViaHttp(message);
    }

    return this.forwardViaStdio(message);
  }

  private async forwardViaHttp(message: JsonRpcRequest): Promise<JsonRpcResponse> {
    const upstreamUrl = this.upstream.url;
    if (!upstreamUrl) {
      return {
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32603,
          message: 'Missing upstream url',
        },
      };
    }

    let targetUrl: string;
    try {
      targetUrl = resolveMcpUpstreamHttpUrl(upstreamUrl);
    } catch (error) {
      return {
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : 'Invalid upstream URL',
        },
      };
    }

    try {
      const response = await fetch(targetUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(this.upstream.headers ?? {}),
        },
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(this.upstream.timeoutMs),
      });

      if (!response.ok) {
        return {
          jsonrpc: '2.0',
          id: message.id,
          error: {
            code: -32603,
            message: `Upstream returned ${response.status}`,
          },
        };
      }

      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.includes('text/event-stream')) {
        return this.consumeSseResponse(response, message.id);
      }

      return await response.json() as JsonRpcResponse;
    } catch (error) {
      return {
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32603,
          message: `Upstream request failed: ${error instanceof Error ? error.message : String(error)}`,
        },
      };
    }
  }

  private async consumeSseResponse(response: Response, requestId?: string | number): Promise<JsonRpcResponse> {
    const body = response.body;
    if (!body) {
      return {
        jsonrpc: '2.0',
        id: requestId,
        error: {
          code: -32603,
          message: 'Empty upstream SSE stream',
        },
      };
    }

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let matched: JsonRpcResponse | null = null;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) {
            continue;
          }

          const payload = line.slice(6).trim();
          if (!payload) {
            continue;
          }

          this.broadcast(payload);

          try {
            const parsed = JSON.parse(payload) as JsonRpcResponse;
            if (parsed.id === requestId) {
              matched = parsed;
            }
          } catch {
            continue;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    return matched ?? {
      jsonrpc: '2.0',
      id: requestId,
      error: {
        code: -32603,
        message: 'No response in SSE stream',
      },
    };
  }

  private async forwardViaStdio(message: JsonRpcRequest): Promise<JsonRpcResponse> {
    if (!this.stdioProcess?.stdin?.writable) {
      return {
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32603,
          message: 'Stdio process not running',
        },
      };
    }

    if (message.id === undefined) {
      try {
        await this.writeToStdio(`${JSON.stringify(message)}\n`);
      } catch (error) {
        return {
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: `Failed to write to stdio upstream: ${error instanceof Error ? error.message : String(error)}`,
          },
        };
      }

      return {
        jsonrpc: '2.0',
        result: null,
      };
    }

    if (this.pendingStdio.size >= MAX_PENDING_STDIO_REQUESTS) {
      return {
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32603,
          message: `Too many pending stdio requests (max ${MAX_PENDING_STDIO_REQUESTS})`,
        },
      };
    }

    const id = message.id;
    return await new Promise((resolveResponse) => {
      const timer = setTimeout(() => {
        this.pendingStdio.delete(id);
        resolveResponse({
          jsonrpc: '2.0',
          id,
          error: {
            code: -32603,
            message: 'Upstream timeout',
          },
        });
      }, this.upstream.timeoutMs);

      this.pendingStdio.set(id, {
        resolve: resolveResponse,
        timer,
      });

      this.writeToStdio(`${JSON.stringify(message)}\n`).catch((error) => {
        const pending = this.pendingStdio.get(id);
        if (!pending) {
          return;
        }
        clearTimeout(pending.timer);
        this.pendingStdio.delete(id);
        resolveResponse({
          jsonrpc: '2.0',
          id,
          error: {
            code: -32603,
            message: `Failed to write to stdio upstream: ${error instanceof Error ? error.message : String(error)}`,
          },
        });
      });
    });
  }

  private writeToStdio(payload: string): Promise<void> {
    const stdin = this.stdioProcess?.stdin;
    if (!stdin || !stdin.writable) {
      return Promise.reject(new Error('Stdio process not running'));
    }

    return new Promise((resolveWrite, rejectWrite) => {
      const onError = (error: Error) => {
        stdin.off('error', onError);
        rejectWrite(error);
      };

      stdin.once('error', onError);
      stdin.write(payload, (error?: Error | null) => {
        stdin.off('error', onError);
        if (error) {
          rejectWrite(error);
          return;
        }
        resolveWrite();
      });
    });
  }

  private failPendingStdioRequests(message: string): void {
    for (const [id, pending] of this.pendingStdio) {
      clearTimeout(pending.timer);
      pending.resolve({
        jsonrpc: '2.0',
        id,
        error: {
          code: -32603,
          message,
        },
      });
    }
    this.pendingStdio.clear();
  }

  private startStdioProcess(): void {
    const command = this.upstream.command;
    if (!command) {
      throw new Error(`mcp-stdio upstream '${this.upstream.name}' is missing command`);
    }

    const child = spawn(command, this.upstream.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });

    this.stdioProcess = child;

    child.stdout.on('data', (chunk: Buffer) => {
      if (this.stdioBuffer.length + chunk.length > MAX_STDIO_BUFFER_BYTES) {
        this.stdioBuffer = '';
        this.failPendingStdioRequests(
          `Stdio buffer exceeded ${MAX_STDIO_BUFFER_BYTES} bytes for upstream '${this.upstream.name}'`,
        );
        return;
      }

      this.stdioBuffer += chunk.toString('utf-8');
      const lines = this.stdioBuffer.split('\n');
      this.stdioBuffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }

        this.broadcast(trimmed);

        let parsed: JsonRpcResponse;
        try {
          parsed = JSON.parse(trimmed) as JsonRpcResponse;
        } catch {
          continue;
        }

        if (parsed.id === undefined) {
          continue;
        }

        const pending = this.pendingStdio.get(parsed.id);
        if (!pending) {
          continue;
        }

        clearTimeout(pending.timer);
        this.pendingStdio.delete(parsed.id);
        pending.resolve(parsed);
      }
    });

    child.on('error', (error) => {
      const message = `Stdio process error for upstream '${this.upstream.name}': ${error.message}`;
      this.failPendingStdioRequests(message);
    });

    child.on('exit', (code) => {
      const message = `Stdio process exited for upstream '${this.upstream.name}' with code ${String(code)}`;
      this.failPendingStdioRequests(message);
      this.stdioProcess = null;
    });
  }

  private emitDecision(event: GatewayDecisionEvent): void {
    this.broadcast(JSON.stringify(event));
  }

  private broadcast(payload: string): void {
    for (const client of this.sseClients) {
      client.write(`data: ${payload}\n\n`);
    }
  }
}

class McpGatewayServer {
  private server: HttpServer | null = null;
  private runtimes = new Map<string, UpstreamRuntime>();
  private policyClient: PolicyClient;

  constructor(private config: McpConfig) {
    this.policyClient = new PolicyClient(config.policy.serverUrl, config.policy.apiKey);
    for (const upstream of config.upstreams) {
      this.runtimes.set(upstream.name, new UpstreamRuntime(upstream, this.policyClient));
    }
  }

  async start(): Promise<void> {
    for (const runtime of this.runtimes.values()) {
      await runtime.start();
    }

    this.server = createServer(async (req, res) => {
      await this.handleHttpRequest(req, res);
    });

    await new Promise<void>((resolveStart, rejectStart) => {
      this.server!.once('error', rejectStart);
      this.server!.listen(this.config.listen.port, this.config.listen.host, () => {
        this.server!.off('error', rejectStart);
        resolveStart();
      });
    });
  }

  async stop(): Promise<void> {
    for (const runtime of this.runtimes.values()) {
      await runtime.shutdown();
    }

    if (!this.server) {
      return;
    }

    await new Promise<void>((resolveClose) => {
      this.server!.close(() => resolveClose());
    });

    this.server = null;
  }

  getAddress(): { host: string; port: number } | null {
    if (!this.server) {
      return null;
    }

    const address = this.server.address();
    if (!address || typeof address === 'string') {
      return null;
    }

    return {
      host: address.address,
      port: address.port,
    };
  }

  private resolveUpstream(pathname: string): UpstreamRuntime | null {
    const clean = pathname.replace(/^\/+/, '').replace(/\/+$/, '');

    if (!clean && this.config.upstreams.length === 1) {
      return this.runtimes.get(this.config.upstreams[0].name) ?? null;
    }

    const candidates = clean.startsWith('mcp/')
      ? [clean.slice(4)]
      : [clean];

    for (const candidate of candidates) {
      if (!candidate) {
        continue;
      }
      const runtime = this.runtimes.get(candidate);
      if (runtime) {
        return runtime;
      }
    }

    return null;
  }

  private async handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const requestUrl = new URL(req.url ?? '/', 'http://localhost');

    if (requestUrl.pathname === '/health') {
      this.writeJson(res, 200, {
        status: 'ok',
        upstreams: this.config.upstreams.map((upstream) => ({
          name: upstream.name,
          transport: upstream.transport,
        })),
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const runtime = this.resolveUpstream(requestUrl.pathname);
    if (!runtime) {
      this.writeJson(res, 404, {
        error: {
          code: 'upstream_not_found',
          message: `No upstream mapped for path '${requestUrl.pathname}'.`,
        },
      });
      return;
    }

    if (method === 'GET') {
      runtime.attachSseClient(res);
      return;
    }

    if (method !== 'POST') {
      this.writeJson(res, 405, {
        error: {
          code: 'method_not_allowed',
          message: 'Only GET and POST are supported for MCP routes.',
        },
      });
      return;
    }

    let payload: unknown;
    try {
      payload = await this.readBody(req);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const tooLarge = reason.includes('Request body exceeds');

      this.writeJson(res, tooLarge ? 413 : 400, {
        jsonrpc: '2.0',
        error: {
          code: tooLarge ? -32603 : -32700,
          message: tooLarge ? reason : `Invalid JSON body: ${reason}`,
        },
      });
      return;
    }

    const message = payload as JsonRpcRequest;
    const response = await runtime.handleMessage(message);
    this.writeJson(res, 200, response);
  }

  private async readBody(req: IncomingMessage): Promise<unknown> {
    const contentLengthHeader = req.headers['content-length'];
    if (typeof contentLengthHeader === 'string') {
      const declaredLength = Number.parseInt(contentLengthHeader, 10);
      if (Number.isInteger(declaredLength) && declaredLength > MAX_HTTP_BODY_BYTES) {
        throw new Error(`Request body exceeds ${MAX_HTTP_BODY_BYTES} bytes`);
      }
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    await new Promise<void>((resolveRead, rejectRead) => {
      const onData = (chunk: string | Buffer) => {
        const normalized = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += normalized.byteLength;
        if (totalBytes > MAX_HTTP_BODY_BYTES) {
          req.off('data', onData);
          req.off('end', onEnd);
          req.off('error', onError);
          req.destroy();
          rejectRead(new Error(`Request body exceeds ${MAX_HTTP_BODY_BYTES} bytes`));
          return;
        }
        chunks.push(normalized);
      };
      const onEnd = () => resolveRead();
      const onError = (error: Error) => rejectRead(error);

      req.on('data', onData);
      req.on('end', onEnd);
      req.on('error', onError);
    });

    if (chunks.length === 0) {
      return {};
    }

    const text = Buffer.concat(chunks).toString('utf-8');
    return JSON.parse(text);
  }

  private writeJson(res: ServerResponse, status: number, body: unknown): void {
    const content = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(content).toString(),
    });
    res.end(content);
  }
}

async function probePolicyServer(config: McpConfig): Promise<McpDoctorReport['policyServer']> {
  const startedAt = Date.now();
  const url = `${config.policy.serverUrl}/health`;

  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(5_000),
    });

    return {
      ok: response.ok,
      url,
      status: response.status,
      latencyMs: Date.now() - startedAt,
      message: response.ok
        ? 'Policy server reachable'
        : `Policy server responded with ${response.status}`,
    };
  } catch (error) {
    return {
      ok: false,
      url,
      latencyMs: Date.now() - startedAt,
      message: `Policy server probe failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function probeUpstream(upstream: McpUpstreamConfig): Promise<McpDoctorReport['upstreams'][number]> {
  const startedAt = Date.now();

  if (upstream.transport === 'mcp-sse') {
    try {
      const targetUrl = resolveMcpUpstreamHttpUrl(upstream.url!);
      const response = await fetch(targetUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(upstream.headers ?? {}),
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'doctor-tools-list',
          method: 'tools/list',
          params: {},
        }),
        signal: AbortSignal.timeout(Math.min(upstream.timeoutMs, 5_000)),
      });

      return {
        name: upstream.name,
        transport: upstream.transport,
        ok: response.ok,
        status: response.status,
        latencyMs: Date.now() - startedAt,
        message: response.ok
          ? 'Upstream reachable'
          : `Upstream returned ${response.status}`,
      };
    } catch (error) {
      return {
        name: upstream.name,
        transport: upstream.transport,
        ok: false,
        latencyMs: Date.now() - startedAt,
        message: `Upstream probe failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  try {
    const child = spawn(upstream.command!, upstream.args ?? [], {
      stdio: 'ignore',
      env: process.env,
    });

    const result = await new Promise<{ ok: boolean; message: string }>((resolveProbe) => {
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        resolveProbe({ ok: true, message: 'Stdio command started successfully' });
      }, 300);

      child.once('error', (error) => {
        clearTimeout(timer);
        resolveProbe({ ok: false, message: `Failed to spawn stdio command: ${error.message}` });
      });

      child.once('exit', (code) => {
        clearTimeout(timer);
        resolveProbe({
          ok: code === 0,
          message: code === 0
            ? 'Stdio command executed successfully'
            : `Stdio command exited with code ${String(code)}`,
        });
      });
    });

    return {
      name: upstream.name,
      transport: upstream.transport,
      ok: result.ok,
      latencyMs: Date.now() - startedAt,
      message: result.message,
    };
  } catch (error) {
    return {
      name: upstream.name,
      transport: upstream.transport,
      ok: false,
      latencyMs: Date.now() - startedAt,
      message: `Stdio probe failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function runDoctorForResolvedConfig(configPath: string, config: McpConfig): Promise<McpDoctorReport> {
  const policyServer = await probePolicyServer(config);
  const upstreams = await Promise.all(config.upstreams.map((upstream) => probeUpstream(upstream)));

  return {
    configPath,
    configValid: true,
    policyServer,
    upstreams,
  };
}

export function loadMcpConfig(configPath: string): McpConfig {
  const resolved = normalizeConfigPath(configPath);
  return loadConfigFromPath(resolved);
}

export function createDefaultMcpConfigTemplate(): string {
  return stringifyYaml({
    listen: {
      host: DEFAULT_LISTEN_HOST,
      port: DEFAULT_LISTEN_PORT,
    },
    policy: {
      serverUrl: DEFAULT_POLICY_SERVER_URL,
      apiKey: 'veto_replace_me',
    },
    upstreams: [
      {
        name: 'default',
        transport: 'mcp-sse',
        url: 'http://localhost:3000/mcp',
        timeoutMs: DEFAULT_TIMEOUT_MS,
      },
    ],
    logging: {
      level: 'info',
    },
  }, {
    lineWidth: 0,
  }).trimEnd() + '\n';
}

export function runMcpInitCommand(options: McpInitOptions = {}): HeadlessResult<{ path: string; created: boolean }> {
  try {
    const path = normalizeConfigPath(options.outputPath);
    if (existsSync(path)) {
      return ok({
        path,
        created: false,
      });
    }

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, createDefaultMcpConfigTemplate(), 'utf-8');

    return ok({
      path,
      created: true,
    });
  } catch (error) {
    return fail('mcp_init_failed', 'Failed to initialize MCP config.', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

export function runMcpConnectCommand(
  options: McpConnectOptions = {},
): HeadlessResult<{
  path: string;
  serverName: string;
  created: boolean;
  updated: boolean;
  mode: 'local' | 'cloud';
  endpoint: string;
  gatewayConfigPath?: string;
}> {
  try {
    const path = normalizeConnectConfigPath(options.outputPath);
    const serverName = options.serverName?.trim() || DEFAULT_CONNECT_SERVER_NAME;

    const document = loadMcpClientConfigDocument(path);
    const servers = { ...(document.mcpServers ?? {}) };
    const existing = servers[serverName];

    let nextConfig: McpClientServerConfig;
    let endpoint: string;
    let gatewayConfigPath: string | undefined;

    if (options.cloud) {
      nextConfig = createCloudMcpClientServerConfig();
      endpoint = DEFAULT_CLOUD_MCP_URL;
    } else {
      gatewayConfigPath = normalizeConfigPath(options.configPath);
      const initResult = runMcpInitCommand({ outputPath: gatewayConfigPath });
      if (!initResult.ok) {
        throw new Error(initResult.error?.message ?? 'Failed to initialize MCP gateway config');
      }

      nextConfig = createLocalMcpClientServerConfig(gatewayConfigPath);
      endpoint = gatewayConfigPath;
    }

    const created = existing === undefined;
    const updated = JSON.stringify(existing ?? null) !== JSON.stringify(nextConfig);

    if (created || updated) {
      servers[serverName] = nextConfig;
      document.mcpServers = servers;
      writeMcpClientConfigDocument(path, document);
    }

    return ok({
      path,
      serverName,
      created,
      updated,
      mode: options.cloud ? 'cloud' : 'local',
      endpoint,
      gatewayConfigPath,
    });
  } catch (error) {
    return fail('mcp_connect_failed', 'Failed to persist MCP client config.', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function runMcpDoctorCommand(options: McpDoctorOptions = {}): Promise<HeadlessResult<McpDoctorReport>> {
  let resolved: ResolvedMcpConfig;

  try {
    const path = normalizeConfigPath(options.configPath);
    resolved = {
      path,
      config: loadConfigFromPath(path),
    };
  } catch (error) {
    return fail('mcp_config_invalid', 'MCP config is invalid.', {
      reason: error instanceof Error ? error.message : String(error),
      configPath: normalizeConfigPath(options.configPath),
    });
  }

  const report = await runDoctorForResolvedConfig(resolved.path, resolved.config);

  const healthy = report.policyServer.ok && report.upstreams.every((upstream) => upstream.ok);
  if (!healthy) {
    return fail('mcp_doctor_failed', 'One or more MCP checks failed.', report);
  }

  return ok(report);
}

function printServeStartup(configPath: string, config: McpConfig, asJson: boolean): void {
  const payload = {
    mode: 'mcp-server',
    listen: `${config.listen.host}:${config.listen.port}`,
    configPath,
    policyServer: config.policy.serverUrl,
    upstreams: config.upstreams.map((upstream) => ({
      name: upstream.name,
      transport: upstream.transport,
    })),
  };

  if (asJson) {
    console.log(JSON.stringify(ok(payload)));
    return;
  }

  console.log('Veto MCP Server');
  console.log(`Listening: ${payload.listen}`);
  console.log(`Config: ${configPath}`);
  console.log(`Policy server: ${config.policy.serverUrl}`);
  for (const upstream of config.upstreams) {
    console.log(`Upstream: ${upstream.name} (${upstream.transport})`);
  }
}

async function waitForTermination(runtime: McpGatewayServer): Promise<void> {
  await new Promise<void>((resolveWait, rejectWait) => {
    let shuttingDown = false;

    const shutdown = () => {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;

      runtime.stop()
        .then(() => resolveWait())
        .catch((error) => rejectWait(error));
    };

    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
}

function assertApiKeyFormat(apiKey: string): void {
  if (!/^veto_[A-Za-z0-9_-]{16,}$/.test(apiKey)) {
    throw new Error("policy.apiKey must match format 'veto_<token>' and include a sufficiently long token");
  }
}

export async function runMcpServeCommand(options: McpServeOptions = {}): Promise<void> {
  const resolved = buildConfigFromServeOptions(options);
  assertApiKeyFormat(resolved.config.policy.apiKey);

  const report = await runDoctorForResolvedConfig(resolved.path, resolved.config);
  const healthy = report.policyServer.ok && report.upstreams.every((upstream) => upstream.ok);
  if (!healthy) {
    if (!options.asJson) {
      console.error('MCP doctor failed before startup.');
      console.error(JSON.stringify(report, null, 2));
    }
    throw new Error('One or more MCP checks failed.');
  }

  const runtime = new McpGatewayServer(resolved.config);
  await runtime.start();
  printServeStartup(resolved.path, resolved.config, options.asJson ?? false);
  await waitForTermination(runtime);
}

export function resolveMcpConfigForTesting(options: McpServeOptions): ResolvedMcpConfig {
  return buildConfigFromServeOptions(options);
}

export function createMcpGatewayServerForTesting(config: McpConfig): Pick<McpGatewayServer, 'start' | 'stop' | 'getAddress'> {
  return new McpGatewayServer(config);
}
