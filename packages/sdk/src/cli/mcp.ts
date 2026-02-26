import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { HeadlessResult } from './headless.js';

const DEFAULT_CONFIG_PATH = 'veto/mcp.config.yaml';
const DEFAULT_POLICY_SERVER_URL = 'http://localhost:3001';
const DEFAULT_LISTEN_HOST = '127.0.0.1';
const DEFAULT_LISTEN_PORT = 8799;
const DEFAULT_TIMEOUT_MS = 30_000;

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
    parsed.protocol = 'http:';
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
    reject: (error: Error) => void;
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
      pending.reject(new Error(`Stdio request ${String(id)} canceled during shutdown`));
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
      if (params.name) {
        const result = await this.policyClient.validate(params.name, params.arguments ?? {});
        this.emitDecision({
          type: 'decision',
          upstream: this.upstream.name,
          toolName: params.name,
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

  private forwardViaStdio(message: JsonRpcRequest): Promise<JsonRpcResponse> {
    if (!this.stdioProcess?.stdin?.writable) {
      return Promise.resolve({
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32603,
          message: 'Stdio process not running',
        },
      });
    }

    if (message.id === undefined) {
      this.stdioProcess.stdin.write(`${JSON.stringify(message)}\n`);
      return Promise.resolve({
        jsonrpc: '2.0',
        result: null,
      });
    }

    return new Promise((resolveResponse, rejectResponse) => {
      const id = message.id!;
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
        reject: rejectResponse,
        timer,
      });

      this.stdioProcess!.stdin.write(`${JSON.stringify(message)}\n`);
    });
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
      this.stdioBuffer += chunk.toString();
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
    });

    child.on('exit', (code) => {
      const message = `Stdio process exited for upstream '${this.upstream.name}' with code ${String(code)}`;
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
      this.writeJson(res, 400, {
        jsonrpc: '2.0',
        error: {
          code: -32700,
          message: `Invalid JSON body: ${error instanceof Error ? error.message : String(error)}`,
        },
      });
      return;
    }

    const message = payload as JsonRpcRequest;
    const response = await runtime.handleMessage(message);
    this.writeJson(res, 200, response);
  }

  private async readBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    await new Promise<void>((resolveRead, rejectRead) => {
      req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      req.on('end', () => resolveRead());
      req.on('error', rejectRead);
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
