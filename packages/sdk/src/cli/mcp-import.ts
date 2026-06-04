import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { HeadlessResult } from './headless.js';

const DEFAULT_SERVER_NAME = 'veto';
const DEFAULT_GATEWAY_CONFIG_RELATIVE = 'veto/mcp.config.yaml';
const CURSOR_CONFIG_RELATIVE = '.cursor/mcp.json';
const CODEX_CONFIG_RELATIVE = '.codex/config.toml';
const CLAUDE_DESKTOP_CONFIG_RELATIVE = 'Library/Application Support/Claude/claude_desktop_config.json';
const GENERIC_MCP_CONFIG_RELATIVE = 'mcp.json';
const DEFAULT_TIMEOUT_MS = 30_000;

type ClientKind = 'cursor' | 'codex' | 'claude-desktop' | 'generic';
type McpTransport = 'mcp-sse' | 'mcp-stdio';

interface ClientServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  serverUrl?: string;
  headers?: Record<string, string>;
  [key: string]: unknown;
}

interface UpstreamConfig {
  name: string;
  transport: McpTransport;
  url?: string;
  command?: string;
  args?: string[];
  headers?: Record<string, string>;
  timeoutMs: number;
}

interface GatewayConfigDocument {
  listen?: {
    host?: string;
    port?: number;
  };
  policy?: {
    serverUrl?: string;
    apiKey?: string;
  };
  upstreams?: UpstreamConfig[];
  logging?: {
    level?: string;
  };
}

interface DetectedClient {
  kind: ClientKind;
  path: string;
}

interface ImportedClientResult {
  kind: ClientKind;
  path: string;
  backupPath?: string;
  importedServers: string[];
  skippedServers: string[];
  updated: boolean;
  restored?: boolean;
}

export interface McpImportOptions {
  directory?: string;
  inputPath?: string;
  configPath?: string;
  serverName?: string;
  dryRun?: boolean;
  restore?: boolean;
}

export interface McpImportResult {
  projectDir: string;
  gatewayConfigPath: string;
  gatewayConfigUpdated: boolean;
  clients: ImportedClientResult[];
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function toSlash(value: string): string {
  return value.split(sep).join('/');
}

function ensureDotSlash(value: string): string {
  const normalized = toSlash(value);
  if (normalized.startsWith('.') || normalized.startsWith('/')) {
    return normalized;
  }
  return `./${normalized}`;
}

function resolveProjectDir(directory: string | undefined): string {
  return resolve(directory ?? process.cwd());
}

function resolveProjectPath(projectDir: string, pathValue: string | undefined, defaultRelative: string): string {
  if (pathValue && isAbsolute(pathValue)) return resolve(pathValue);
  return resolve(projectDir, pathValue ?? defaultRelative);
}

function gatewayReference(projectDir: string, configPath: string, explicitPath: string | undefined): string {
  if (explicitPath) {
    return isAbsolute(explicitPath) ? toSlash(resolve(explicitPath)) : ensureDotSlash(explicitPath);
  }
  const relative = toSlash(configPath.startsWith(projectDir)
    ? configPath.slice(projectDir.length + 1)
    : configPath);
  return ensureDotSlash(relative);
}

function createProxyServerConfig(configReference: string): ClientServerConfig {
  return {
    command: 'veto-mcp-proxy',
    args: ['--config', configReference],
    env: {
      VETO_API_KEY: '${env:VETO_API_KEY}',
    },
  };
}

function serverLooksLikeVeto(name: string, server: ClientServerConfig): boolean {
  const haystack = [
    name,
    server.command,
    server.url,
    server.serverUrl,
    ...(Array.isArray(server.args) ? server.args : []),
  ]
    .filter((part): part is string => typeof part === 'string')
    .join(' ')
    .toLowerCase();
  return /\bveto\b|veto-mcp-proxy|api\.veto\.so/.test(haystack);
}

function readJsonObject(path: string): Record<string, unknown> {
  const content = readFileSync(path, 'utf-8').trim();
  if (!content) return {};
  const parsed = JSON.parse(content) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`Invalid JSON config at ${path}: expected top-level object`);
  }
  return parsed;
}

function writeJsonObject(path: string, document: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(document, null, 2) + '\n', 'utf-8');
}

function asStringArray(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') out.push(entry);
  }
  return out;
}

function headersFrom(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') out[key] = entry;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function upstreamFromServer(name: string, server: ClientServerConfig): UpstreamConfig | null {
  const url = typeof server.url === 'string'
    ? server.url
    : typeof server.serverUrl === 'string'
      ? server.serverUrl
      : undefined;
  if (url) {
    return {
      name,
      transport: 'mcp-sse',
      url,
      headers: headersFrom(server.headers),
      timeoutMs: DEFAULT_TIMEOUT_MS,
    };
  }
  if (typeof server.command === 'string' && server.command.trim().length > 0) {
    return {
      name,
      transport: 'mcp-stdio',
      command: server.command.trim(),
      args: asStringArray(server.args),
      timeoutMs: DEFAULT_TIMEOUT_MS,
    };
  }
  return null;
}

function backupPathFor(path: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${path}.veto-backup-${stamp}`;
}

function backupFile(path: string, dryRun: boolean): string {
  const backupPath = backupPathFor(path);
  if (!dryRun) {
    writeFileSync(backupPath, readFileSync(path, 'utf-8'), 'utf-8');
  }
  return backupPath;
}

function findLatestBackup(path: string): string | null {
  const dir = dirname(path);
  if (!existsSync(dir)) return null;
  const prefix = `${path.split('/').pop()}.veto-backup-`;
  const backups = readdirSync(dir)
    .filter((entry) => entry.startsWith(prefix))
    .map((entry) => join(dir, entry))
    .sort();
  return backups.at(-1) ?? null;
}

function restoreClient(client: DetectedClient, dryRun: boolean): ImportedClientResult {
  const backupPath = findLatestBackup(client.path);
  if (!backupPath) {
    throw new Error(`No Veto backup found for ${client.path}`);
  }
  if (!dryRun) {
    renameSync(backupPath, client.path);
  }
  return {
    kind: client.kind,
    path: client.path,
    backupPath,
    importedServers: [],
    skippedServers: [],
    updated: !dryRun,
    restored: true,
  };
}

function parseMcpServers(document: Record<string, unknown>, path: string): Record<string, ClientServerConfig> {
  const rawServers = document.mcpServers;
  if (!isRecord(rawServers)) {
    throw new Error(`Invalid MCP JSON config at ${path}: mcpServers must be an object`);
  }
  const servers: Record<string, ClientServerConfig> = {};
  for (const [name, server] of Object.entries(rawServers)) {
    if (isRecord(server)) servers[name] = server as ClientServerConfig;
  }
  return servers;
}

function importJsonClient(
  client: DetectedClient,
  proxyConfig: ClientServerConfig,
  serverName: string,
  dryRun: boolean,
): { result: ImportedClientResult; upstreams: UpstreamConfig[] } {
  const document = readJsonObject(client.path);
  const servers = parseMcpServers(document, client.path);
  const upstreams: UpstreamConfig[] = [];
  const importedServers: string[] = [];
  const skippedServers: string[] = [];

  for (const [name, server] of Object.entries(servers)) {
    if (serverLooksLikeVeto(name, server)) {
      skippedServers.push(name);
      continue;
    }
    const upstream = upstreamFromServer(name, server);
    if (upstream) {
      upstreams.push(upstream);
      importedServers.push(name);
    } else {
      skippedServers.push(name);
    }
  }

  const nextDocument: Record<string, unknown> = {
    ...document,
    mcpServers: {
      [serverName]: proxyConfig,
    },
  };
  const updated = JSON.stringify(document) !== JSON.stringify(nextDocument);
  const backupPath = updated ? backupFile(client.path, dryRun) : undefined;
  if (updated && !dryRun) {
    writeJsonObject(client.path, nextDocument);
  }

  return {
    upstreams,
    result: {
      kind: client.kind,
      path: client.path,
      backupPath,
      importedServers,
      skippedServers,
      updated,
    },
  };
}

interface TomlServerSection {
  name: string;
  start: number;
  end: number;
  fields: Record<string, unknown>;
}

function parseTomlSectionName(line: string): string | null {
  const match = /^\s*\[([^\]]+)]\s*$/.exec(line);
  return match?.[1]?.trim() ?? null;
}

function parseTomlServerName(sectionName: string): string | null {
  if (!sectionName.startsWith('mcp_servers.')) return null;
  const raw = sectionName.slice('mcp_servers.'.length).trim();
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try {
      return JSON.parse(raw) as string;
    } catch {
      return raw.slice(1, -1);
    }
  }
  return raw;
}

function parseTomlValue(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return undefined;
    }
  }
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  return undefined;
}

function parseTomlServers(content: string): TomlServerSection[] {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const sections: TomlServerSection[] = [];
  for (let index = 0; index < lines.length; index++) {
    const sectionName = parseTomlSectionName(lines[index] ?? '');
    const serverName = sectionName ? parseTomlServerName(sectionName) : null;
    if (!serverName) continue;
    let end = lines.length;
    for (let next = index + 1; next < lines.length; next++) {
      if (/^\s*\[/.test(lines[next] ?? '')) {
        end = next;
        break;
      }
    }
    const fields: Record<string, unknown> = {};
    for (let row = index + 1; row < end; row++) {
      const match = /^\s*([A-Za-z0-9_.-]+)\s*=\s*(.*?)\s*$/.exec(lines[row] ?? '');
      if (!match) continue;
      fields[match[1]!] = parseTomlValue(match[2]!);
    }
    sections.push({
      name: serverName,
      start: index,
      end,
      fields,
    });
  }
  return sections;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlStringArray(values: string[]): string {
  return `[${values.map((value) => tomlString(value)).join(', ')}]`;
}

function tomlKeySegment(value: string): string {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : tomlString(value);
}

function createCodexProxySection(serverName: string, configReference: string): string {
  return [
    `[mcp_servers.${tomlKeySegment(serverName)}]`,
    'command = "veto-mcp-proxy"',
    `args = ${tomlStringArray(['--config', configReference])}`,
    'enabled = true',
    `env_vars = ${tomlStringArray(['VETO_API_KEY'])}`,
  ].join('\n');
}

function removeTomlSections(content: string, sections: TomlServerSection[]): string {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  for (const section of [...sections].sort((a, b) => b.start - a.start)) {
    lines.splice(section.start, section.end - section.start);
  }
  while (lines.length > 0 && lines.at(-1)?.trim() === '') lines.pop();
  return lines.join('\n');
}

function importCodexClient(
  client: DetectedClient,
  serverName: string,
  configReference: string,
  dryRun: boolean,
): { result: ImportedClientResult; upstreams: UpstreamConfig[] } {
  const content = readFileSync(client.path, 'utf-8');
  const sections = parseTomlServers(content);
  const upstreams: UpstreamConfig[] = [];
  const importedServers: string[] = [];
  const skippedServers: string[] = [];
  const removableSections: TomlServerSection[] = [];

  for (const section of sections) {
    const server = section.fields as ClientServerConfig;
    if (serverLooksLikeVeto(section.name, server)) {
      skippedServers.push(section.name);
      removableSections.push(section);
      continue;
    }
    const upstream = upstreamFromServer(section.name, server);
    if (upstream) {
      upstreams.push(upstream);
      importedServers.push(section.name);
      removableSections.push(section);
    } else {
      skippedServers.push(section.name);
    }
  }

  const base = removeTomlSections(content, removableSections).trimEnd();
  const nextContent = `${base ? `${base}\n\n` : ''}${createCodexProxySection(serverName, configReference)}\n`;
  const updated = content !== nextContent;
  const backupPath = updated ? backupFile(client.path, dryRun) : undefined;
  if (updated && !dryRun) {
    mkdirSync(dirname(client.path), { recursive: true });
    writeFileSync(client.path, nextContent, 'utf-8');
  }

  return {
    upstreams,
    result: {
      kind: client.kind,
      path: client.path,
      backupPath,
      importedServers,
      skippedServers,
      updated,
    },
  };
}

function readGatewayConfig(path: string): GatewayConfigDocument {
  if (!existsSync(path)) {
    return {
      listen: {
        host: '127.0.0.1',
        port: 8799,
      },
      policy: {
        serverUrl: 'http://localhost:3001',
        apiKey: '${env:VETO_API_KEY}',
      },
      upstreams: [],
      logging: {
        level: 'info',
      },
    };
  }
  const parsed = parseYaml(readFileSync(path, 'utf-8')) as unknown;
  return isRecord(parsed) ? parsed as GatewayConfigDocument : {};
}

function upstreamKey(upstream: UpstreamConfig): string {
  return upstream.transport === 'mcp-sse'
    ? `${upstream.name}:url:${upstream.url ?? ''}`
    : `${upstream.name}:cmd:${upstream.command ?? ''}:${(upstream.args ?? []).join('\0')}`;
}

function mergeGatewayConfig(path: string, upstreams: UpstreamConfig[], dryRun: boolean): boolean {
  const existing = readGatewayConfig(path);
  const currentUpstreams = Array.isArray(existing.upstreams) ? existing.upstreams : [];
  const seen = new Set(currentUpstreams.map(upstreamKey));
  const merged = [...currentUpstreams];

  for (const upstream of upstreams) {
    const key = upstreamKey(upstream);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(upstream);
  }

  const next: GatewayConfigDocument = {
    listen: existing.listen ?? { host: '127.0.0.1', port: 8799 },
    policy: existing.policy ?? { serverUrl: 'http://localhost:3001', apiKey: '${env:VETO_API_KEY}' },
    upstreams: merged,
    logging: existing.logging ?? { level: 'info' },
  };
  const currentText = existsSync(path) ? readFileSync(path, 'utf-8') : '';
  const nextText = stringifyYaml(next, { lineWidth: 0 }).trimEnd() + '\n';
  const updated = currentText !== nextText;
  if (updated && !dryRun) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, nextText, 'utf-8');
  }
  return updated;
}

function detectKindFromPath(path: string): ClientKind {
  const normalized = toSlash(path);
  if (normalized.endsWith('/.cursor/mcp.json')) return 'cursor';
  if (normalized.endsWith('/.codex/config.toml')) return 'codex';
  if (normalized.endsWith('/claude_desktop_config.json')) return 'claude-desktop';
  return 'generic';
}

function detectClients(projectDir: string, inputPath: string | undefined): DetectedClient[] {
  if (inputPath) {
    const path = resolveProjectPath(projectDir, inputPath, inputPath);
    if (!existsSync(path)) throw new Error(`MCP config not found: ${path}`);
    return [{ kind: detectKindFromPath(path), path }];
  }

  const candidates: DetectedClient[] = [
    { kind: 'cursor', path: resolve(projectDir, CURSOR_CONFIG_RELATIVE) },
    { kind: 'codex', path: resolve(projectDir, CODEX_CONFIG_RELATIVE) },
    { kind: 'generic', path: resolve(projectDir, GENERIC_MCP_CONFIG_RELATIVE) },
    { kind: 'cursor', path: resolve(homedir(), CURSOR_CONFIG_RELATIVE) },
    { kind: 'codex', path: resolve(homedir(), CODEX_CONFIG_RELATIVE) },
    { kind: 'claude-desktop', path: resolve(homedir(), CLAUDE_DESKTOP_CONFIG_RELATIVE) },
  ];

  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (!existsSync(candidate.path) || seen.has(candidate.path)) return false;
    seen.add(candidate.path);
    return true;
  });
}

export function runMcpImportCommand(options: McpImportOptions = {}): HeadlessResult<McpImportResult> {
  try {
    const projectDir = resolveProjectDir(options.directory);
    const gatewayConfigPath = resolveProjectPath(projectDir, options.configPath, DEFAULT_GATEWAY_CONFIG_RELATIVE);
    const configReference = gatewayReference(projectDir, gatewayConfigPath, options.configPath);
    const serverName = (options.serverName ?? DEFAULT_SERVER_NAME).trim() || DEFAULT_SERVER_NAME;
    const clients = detectClients(projectDir, options.inputPath);
    if (clients.length === 0) {
      return fail('mcp_import_no_configs', 'No MCP client configs found to import.');
    }

    if (options.restore) {
      const restored = clients.map((client) => restoreClient(client, options.dryRun ?? false));
      return ok({
        projectDir,
        gatewayConfigPath,
        gatewayConfigUpdated: false,
        clients: restored,
      });
    }

    const proxyConfig = createProxyServerConfig(configReference);
    const allUpstreams: UpstreamConfig[] = [];
    const results: ImportedClientResult[] = [];

    for (const client of clients) {
      const imported = client.kind === 'codex'
        ? importCodexClient(client, serverName, configReference, options.dryRun ?? false)
        : importJsonClient(client, proxyConfig, serverName, options.dryRun ?? false);
      allUpstreams.push(...imported.upstreams);
      results.push(imported.result);
    }

    const gatewayConfigUpdated = mergeGatewayConfig(gatewayConfigPath, allUpstreams, options.dryRun ?? false);
    return ok({
      projectDir,
      gatewayConfigPath,
      gatewayConfigUpdated,
      clients: results,
    });
  } catch (error) {
    return fail('mcp_import_failed', 'Failed to import MCP config.', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}
