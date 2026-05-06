import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import type { HeadlessResult } from './headless.js';
import { runMcpInitCommand } from './mcp.js';

const DEFAULT_SERVER_NAME = 'veto';
const DEFAULT_MCP_CONFIG_RELATIVE = 'veto/mcp.config.yaml';
const DEFAULT_CLOUD_MCP_URL = 'https://api.veto.so/v1/mcp/default';
const CURSOR_CONFIG_RELATIVE = '.cursor/mcp.json';
const CODEX_CONFIG_RELATIVE = '.codex/config.toml';
const CLAUDE_HOOK_RELATIVE = '.claude/hooks/veto-hook.mjs';
const CLAUDE_SETTINGS_RELATIVE = '.claude/settings.json';
const CLAUDE_HOOK_COMMAND = '$CLAUDE_PROJECT_DIR/.claude/hooks/veto-hook.mjs';

const CLAUDE_HOOK_CONTENT = `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

async function readStdin() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  return input;
}

function respond(permissionDecision, permissionDecisionReason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision,
      permissionDecisionReason,
    },
  }) + '\\n');
  process.exit(0);
}

function unsafeFailOpenEnabled() {
  return process.env.VETO_HOOK_FAIL_OPEN === '1';
}

function allowNotConfigured(reason) {
  process.stderr.write('[veto-hook] ' + reason + '\\n');
  respond('allow', reason);
}

function failClosed(reason) {
  if (unsafeFailOpenEnabled()) {
    const unsafeReason = reason + ' VETO_HOOK_FAIL_OPEN=1 is set; allowing call unsafely.';
    process.stderr.write('[veto-hook] ' + unsafeReason + '\\n');
    respond('allow', unsafeReason);
    return;
  }

  process.stderr.write('[veto-hook] ' + reason + '\\n');
  respond('deny', reason);
}

function asRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value;
}

function formatReason(data) {
  const parts = [];
  if (typeof data.reason === 'string' && data.reason.length > 0) {
    parts.push(data.reason);
  }
  if (typeof data.ruleId === 'string' && data.ruleId.length > 0) {
    parts.push('(policy:' + data.ruleId + ')');
  }
  return parts.length > 0 ? parts.join(' ') : undefined;
}

async function main() {
  const projectDir = resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());
  const configPath = resolve(projectDir, 'veto', 'veto.config.yaml');
  if (!existsSync(configPath)) {
    allowNotConfigured('Veto is not initialized in this project; run npx veto init to enable enforcement.');
    return;
  }

  let envelope;
  try {
    const input = await readStdin();
    envelope = JSON.parse(input || '{}');
  } catch {
    failClosed('Claude Code hook payload was not valid JSON; denying call because Veto is configured.');
    return;
  }

  const toolName = typeof envelope.tool_name === 'string' ? envelope.tool_name : '';
  if (!toolName) {
    failClosed('Claude Code hook payload did not include tool_name; denying call because Veto is configured.');
    return;
  }

  const timeoutValue = Number.parseInt(process.env.VETO_HOOK_TIMEOUT_MS || '5000', 10);
  const timeout = Number.isInteger(timeoutValue) && timeoutValue > 0 ? timeoutValue : 5000;
  const vetoCli = process.env.VETO_CLI || 'veto';
  const guard = spawnSync(vetoCli, [
    'guard',
    'check',
    '--tool',
    toolName,
    '--args',
    JSON.stringify(asRecord(envelope.tool_input)),
    '--directory',
    projectDir,
    '--mode',
    'local',
    '--json',
  ], {
    encoding: 'utf-8',
    timeout,
    maxBuffer: 1024 * 1024,
  });

  if (guard.error) {
    failClosed('Veto guard check failed to start: ' + guard.error.message + '; denying call.');
    return;
  }

  const stdout = (guard.stdout || '').trim();
  const lastLine = stdout.split(/\\r?\\n/).filter(Boolean).at(-1);
  if (!lastLine) {
    const stderr = (guard.stderr || '').trim();
    failClosed('Veto guard check produced no JSON output' + (stderr ? ': ' + stderr : '') + '; denying call.');
    return;
  }

  let result;
  try {
    result = JSON.parse(lastLine);
  } catch {
    failClosed('Veto guard check returned invalid JSON; denying call.');
    return;
  }

  if (!result.ok) {
    const message = result.error && typeof result.error.message === 'string'
      ? result.error.message
      : 'Veto guard check failed';
    failClosed(message + '; denying call.');
    return;
  }

  const data = asRecord(result.data);
  const decision = data.decision;
  const reason = formatReason(data);

  if (decision === 'deny') {
    respond('deny', reason || 'Blocked by Veto policy');
    return;
  }

  if (decision === 'require_approval') {
    respond('ask', reason || 'Veto policy requires approval');
    return;
  }

  respond('allow', reason || 'Allowed by Veto policy');
}

void main();
`;

export type InstallTarget = 'claude-code' | 'cursor' | 'codex';
export type FileStatus = 'created' | 'updated' | 'unchanged' | 'skipped_existing';

export interface InstallOptions {
  target: string;
  directory?: string;
  outputPath?: string;
  configPath?: string;
  serverName?: string;
  cloud?: boolean;
  force?: boolean;
}

interface BaseInstallResult {
  target: InstallTarget;
  projectDir: string;
  messages: string[];
}

export interface ClaudeCodeInstallResult extends BaseInstallResult {
  target: 'claude-code';
  hookPath: string;
  settingsPath: string;
  hookStatus: FileStatus;
  settingsCreated: boolean;
  settingsUpdated: boolean;
  uninstallHint: string;
}

export interface CursorInstallResult extends BaseInstallResult {
  target: 'cursor';
  path: string;
  serverName: string;
  serverCreated: boolean;
  updated: boolean;
  mode: 'local' | 'cloud';
  endpoint: string;
  gatewayConfigPath?: string;
  gatewayConfigReference?: string;
  gatewayConfigCreated?: boolean;
}

export interface CodexInstallResult extends BaseInstallResult {
  target: 'codex';
  path: string;
  serverName: string;
  serverCreated: boolean;
  updated: boolean;
  gatewayConfigPath: string;
  gatewayConfigReference: string;
  gatewayConfigCreated: boolean;
  trustHint: string;
}

export type InstallCommandResult = ClaudeCodeInstallResult | CursorInstallResult | CodexInstallResult;

interface CursorMcpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  serverUrl?: string;
  headers?: Record<string, string>;
}

interface GatewayConfigResolution {
  path: string;
  reference: string;
}

interface ClaudeSettingsMergeResult {
  created: boolean;
  updated: boolean;
}

interface TomlSectionRange {
  start: number;
  end: number;
}

function ok<T>(data: T): HeadlessResult<T> {
  return {
    ok: true,
    data,
  };
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

function resolveProjectPath(projectDir: string, explicitPath: string | undefined, defaultRelative: string): string {
  if (explicitPath && isAbsolute(explicitPath)) {
    return resolve(explicitPath);
  }
  return resolve(projectDir, explicitPath ?? defaultRelative);
}

function resolveGatewayConfig(projectDir: string, explicitPath: string | undefined): GatewayConfigResolution {
  const path = resolveProjectPath(projectDir, explicitPath, DEFAULT_MCP_CONFIG_RELATIVE);
  const reference = explicitPath
    ? (isAbsolute(explicitPath) ? toSlash(resolve(explicitPath)) : ensureDotSlash(explicitPath))
    : `./${DEFAULT_MCP_CONFIG_RELATIVE}`;

  return {
    path,
    reference,
  };
}

function resolveServerName(serverName: string | undefined): string {
  const resolved = (serverName ?? DEFAULT_SERVER_NAME).trim();
  if (!resolved) {
    throw new Error('--server-name must be a non-empty string');
  }
  return resolved;
}

function readJsonObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) {
    return {};
  }

  const content = readFileSync(path, 'utf-8').trim();
  if (!content) {
    return {};
  }

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

function createEnvInterpolation(name: string): string {
  return `\${env:${name}}`;
}

function createProxyMcpServerConfig(configReference: string): CursorMcpServerConfig {
  return {
    command: 'veto-mcp-proxy',
    args: ['--config', configReference],
    env: {
      VETO_API_KEY: createEnvInterpolation('VETO_API_KEY'),
    },
  };
}

function createCloudMcpServerConfig(): CursorMcpServerConfig {
  return {
    url: DEFAULT_CLOUD_MCP_URL,
    serverUrl: DEFAULT_CLOUD_MCP_URL,
    headers: {
      'X-Veto-API-Key': createEnvInterpolation('VETO_API_KEY'),
    },
  };
}

function initializeGatewayConfig(configPath: string): boolean {
  const result = runMcpInitCommand({ outputPath: configPath });
  if (!result.ok) {
    throw new Error(result.error?.message ?? 'Failed to initialize MCP gateway config');
  }
  return result.data?.created ?? false;
}

function runCursorInstall(options: InstallOptions): CursorInstallResult {
  const projectDir = resolveProjectDir(options.directory);
  const path = resolveProjectPath(projectDir, options.outputPath, CURSOR_CONFIG_RELATIVE);
  const serverName = resolveServerName(options.serverName);
  const existingDocument = readJsonObject(path);
  const rawServers = existingDocument.mcpServers;

  if (rawServers !== undefined && !isRecord(rawServers)) {
    throw new Error(`Invalid Cursor MCP config at ${path}: mcpServers must be an object`);
  }

  let gatewayConfig: GatewayConfigResolution | undefined;
  let gatewayConfigCreated: boolean | undefined;
  let nextServerConfig: CursorMcpServerConfig;
  let endpoint: string;

  if (options.cloud) {
    nextServerConfig = createCloudMcpServerConfig();
    endpoint = DEFAULT_CLOUD_MCP_URL;
  } else {
    gatewayConfig = resolveGatewayConfig(projectDir, options.configPath);
    gatewayConfigCreated = initializeGatewayConfig(gatewayConfig.path);
    nextServerConfig = createProxyMcpServerConfig(gatewayConfig.reference);
    endpoint = gatewayConfig.reference;
  }

  const servers: Record<string, unknown> = { ...(isRecord(rawServers) ? rawServers : {}) };
  const existing = servers[serverName];
  const serverCreated = existing === undefined;
  const updated = JSON.stringify(existing ?? null) !== JSON.stringify(nextServerConfig);

  if (serverCreated || updated) {
    servers[serverName] = nextServerConfig;
    existingDocument.mcpServers = servers;
    writeJsonObject(path, existingDocument);
  }

  const mode = options.cloud ? 'cloud' : 'local';
  const messages = options.cloud
    ? [
        `Cursor MCP config ${serverCreated || updated ? 'updated' : 'already current'}: ${path}`,
        `Server '${serverName}' uses Veto Cloud: ${DEFAULT_CLOUD_MCP_URL}`,
        'Set VETO_API_KEY in your environment and reload Cursor.',
      ]
    : [
        `Cursor MCP config ${serverCreated || updated ? 'updated' : 'already current'}: ${path}`,
        `Server '${serverName}' runs veto-mcp-proxy --config ${gatewayConfig!.reference}`,
        `Gateway config ${gatewayConfigCreated ? 'created' : 'reused'}: ${gatewayConfig!.path}`,
        'Set VETO_API_KEY in your environment and reload Cursor.',
      ];

  return {
    target: 'cursor',
    projectDir,
    path,
    serverName,
    serverCreated,
    updated,
    mode,
    endpoint,
    gatewayConfigPath: gatewayConfig?.path,
    gatewayConfigReference: gatewayConfig?.reference,
    gatewayConfigCreated,
    messages,
  };
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlStringArray(values: string[]): string {
  return `[${values.map((value) => tomlString(value)).join(', ')}]`;
}

function tomlKeySegment(value: string): string {
  if (/^[A-Za-z0-9_-]+$/.test(value)) {
    return value;
  }
  return tomlString(value);
}

function createCodexMcpServerSection(serverName: string, configReference: string): string {
  const sectionName = `mcp_servers.${tomlKeySegment(serverName)}`;
  return [
    `[${sectionName}]`,
    'command = "veto-mcp-proxy"',
    `args = ${tomlStringArray(['--config', configReference])}`,
    'enabled = true',
    `env_vars = ${tomlStringArray(['VETO_API_KEY'])}`,
  ].join('\n');
}

function parseTomlSectionName(line: string): string | null {
  const match = /^\s*\[([^\]]+)]\s*$/.exec(line);
  return match?.[1]?.trim() ?? null;
}

function parseTomlServerName(sectionName: string): string | null {
  if (!sectionName.startsWith('mcp_servers.')) {
    return null;
  }

  const rawName = sectionName.slice('mcp_servers.'.length).trim();
  if (rawName.startsWith('"') && rawName.endsWith('"')) {
    try {
      return JSON.parse(rawName) as string;
    } catch {
      return rawName;
    }
  }

  return rawName;
}

function findTomlServerSection(lines: string[], serverName: string): TomlSectionRange | null {
  for (let index = 0; index < lines.length; index++) {
    const sectionName = parseTomlSectionName(lines[index] ?? '');
    if (sectionName === null || parseTomlServerName(sectionName) !== serverName) {
      continue;
    }

    let end = lines.length;
    for (let next = index + 1; next < lines.length; next++) {
      if (/^\s*\[/.test(lines[next] ?? '')) {
        end = next;
        break;
      }
    }

    return {
      start: index,
      end,
    };
  }

  return null;
}

function upsertTomlServerSection(content: string, serverName: string, section: string): { content: string; serverCreated: boolean } {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  if (content.length === 0) {
    return {
      content: section + '\n',
      serverCreated: true,
    };
  }

  if (lines.at(-1) === '') {
    lines.pop();
  }

  const existing = findTomlServerSection(lines, serverName);
  const sectionLines = section.split('\n');

  if (existing) {
    lines.splice(existing.start, existing.end - existing.start, ...sectionLines);
  } else {
    if (lines.length > 0 && lines.at(-1)?.trim() !== '') {
      lines.push('');
    }
    lines.push(...sectionLines);
  }

  while (lines.length > 0 && lines.at(-1)?.trim() === '') {
    lines.pop();
  }

  return {
    content: lines.join('\n') + '\n',
    serverCreated: existing === null,
  };
}

function readTextFileIfExists(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf-8') : '';
}

function runCodexInstall(options: InstallOptions): CodexInstallResult {
  if (options.cloud) {
    throw new Error('veto install codex does not support --cloud yet; use the local veto-mcp-proxy config.');
  }

  const projectDir = resolveProjectDir(options.directory);
  const path = resolveProjectPath(projectDir, options.outputPath, CODEX_CONFIG_RELATIVE);
  const serverName = resolveServerName(options.serverName);
  const gatewayConfig = resolveGatewayConfig(projectDir, options.configPath);
  const gatewayConfigCreated = initializeGatewayConfig(gatewayConfig.path);
  const currentContent = readTextFileIfExists(path);
  const section = createCodexMcpServerSection(serverName, gatewayConfig.reference);
  const merged = upsertTomlServerSection(currentContent, serverName, section);
  const updated = currentContent !== merged.content;

  if (updated) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, merged.content, 'utf-8');
  }

  const trustHint = 'Project-local Codex MCP config only loads after the project is trusted.';

  return {
    target: 'codex',
    projectDir,
    path,
    serverName,
    serverCreated: merged.serverCreated,
    updated,
    gatewayConfigPath: gatewayConfig.path,
    gatewayConfigReference: gatewayConfig.reference,
    gatewayConfigCreated,
    trustHint,
    messages: [
      `Codex MCP config ${updated ? 'updated' : 'already current'}: ${path}`,
      `Server '${serverName}' runs veto-mcp-proxy --config ${gatewayConfig.reference}`,
      `Gateway config ${gatewayConfigCreated ? 'created' : 'reused'}: ${gatewayConfig.path}`,
      trustHint,
    ],
  };
}

function writeHookFile(path: string, force: boolean | undefined): FileStatus {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, CLAUDE_HOOK_CONTENT, 'utf-8');
    chmodSync(path, 0o755);
    return 'created';
  }

  const existing = readFileSync(path, 'utf-8');
  if (existing === CLAUDE_HOOK_CONTENT) {
    chmodSync(path, 0o755);
    return 'unchanged';
  }

  if (force) {
    writeFileSync(path, CLAUDE_HOOK_CONTENT, 'utf-8');
    chmodSync(path, 0o755);
    return 'updated';
  }

  return 'skipped_existing';
}

function commandIsVetoHook(command: unknown): command is string {
  return typeof command === 'string' && /(^|[/$\\])veto-hook\.(mjs|js|py)(\s|$|"|')/.test(command);
}

function mergeClaudeSettings(settingsPath: string): ClaudeSettingsMergeResult {
  const existed = existsSync(settingsPath);
  const settings = readJsonObject(settingsPath);
  const hooksValue = settings.hooks;

  if (hooksValue !== undefined && !isRecord(hooksValue)) {
    throw new Error(`Invalid Claude settings at ${settingsPath}: hooks must be an object`);
  }

  const hooks = isRecord(hooksValue) ? hooksValue : {};
  const preToolUseValue = hooks.PreToolUse;

  if (preToolUseValue !== undefined && !Array.isArray(preToolUseValue)) {
    throw new Error(`Invalid Claude settings at ${settingsPath}: hooks.PreToolUse must be an array`);
  }

  const preToolUse = Array.isArray(preToolUseValue) ? preToolUseValue : [];
  let hasGlobalCoverage = false;
  let changed = false;

  for (const block of preToolUse) {
    if (!isRecord(block) || !Array.isArray(block.hooks)) {
      continue;
    }

    let vetoHooksInBlock = 0;
    for (const hook of block.hooks) {
      if (!isRecord(hook) || !commandIsVetoHook(hook.command)) {
        continue;
      }

      vetoHooksInBlock += 1;
      if (hook.command !== CLAUDE_HOOK_COMMAND) {
        hook.command = CLAUDE_HOOK_COMMAND;
        changed = true;
      }
      if (hook.type !== 'command') {
        hook.type = 'command';
        changed = true;
      }
    }

    if (vetoHooksInBlock > 0) {
      if (block.matcher === '') {
        hasGlobalCoverage = true;
      } else if (block.hooks.length === vetoHooksInBlock) {
        block.matcher = '';
        hasGlobalCoverage = true;
        changed = true;
      }
    }
  }

  if (!hasGlobalCoverage) {
    preToolUse.push({
      matcher: '',
      hooks: [
        {
          type: 'command',
          command: CLAUDE_HOOK_COMMAND,
          timeout_ms: 5000,
        },
      ],
    });
    changed = true;
  }

  if (!isRecord(settings.hooks)) {
    settings.hooks = hooks;
    changed = true;
  }

  if (hooks.PreToolUse !== preToolUse) {
    hooks.PreToolUse = preToolUse;
    changed = true;
  }

  if (!changed) {
    return {
      created: false,
      updated: false,
    };
  }

  writeJsonObject(settingsPath, settings);

  return {
    created: !existed,
    updated: true,
  };
}

function runClaudeCodeInstall(options: InstallOptions): ClaudeCodeInstallResult {
  if (options.cloud) {
    throw new Error('veto install claude-code only supports local project policies.');
  }

  const projectDir = resolveProjectDir(options.directory);
  const hookPath = join(projectDir, CLAUDE_HOOK_RELATIVE);
  const settingsPath = join(projectDir, CLAUDE_SETTINGS_RELATIVE);
  const hookStatus = writeHookFile(hookPath, options.force);
  const settings = mergeClaudeSettings(settingsPath);
  const uninstallHint = `Remove ${CLAUDE_HOOK_RELATIVE} and the Veto PreToolUse entry from ${CLAUDE_SETTINGS_RELATIVE}.`;
  const hookMessage = hookStatus === 'skipped_existing'
    ? `Hook exists and was not overwritten: ${hookPath} (use --force to replace it)`
    : `Hook ${hookStatus}: ${hookPath}`;

  return {
    target: 'claude-code',
    projectDir,
    hookPath,
    settingsPath,
    hookStatus,
    settingsCreated: settings.created,
    settingsUpdated: settings.updated,
    uninstallHint,
    messages: [
      hookMessage,
      `Claude settings ${settings.updated ? 'updated' : 'already current'}: ${settingsPath}`,
      'Run `npx veto init` if this project does not have local policies yet.',
      `Uninstall: ${uninstallHint}`,
    ],
  };
}

export function runInstallCommand(options: InstallOptions): HeadlessResult<InstallCommandResult> {
  try {
    if (options.target === 'claude-code') {
      return ok(runClaudeCodeInstall(options));
    }

    if (options.target === 'cursor') {
      return ok(runCursorInstall(options));
    }

    if (options.target === 'codex') {
      return ok(runCodexInstall(options));
    }

    return fail(
      'install_target_unknown',
      `Unknown install target: ${options.target}`,
      {
        targets: ['claude-code', 'cursor', 'codex'],
      }
    );
  } catch (error) {
    return fail(
      'install_failed',
      'Failed to install Veto integration.',
      {
        target: options.target,
        reason: error instanceof Error ? error.message : String(error),
      }
    );
  }
}

export function formatInstallResult(result: HeadlessResult<InstallCommandResult>): string {
  if (!result.ok) {
    const lines = [`Error (${result.error?.code ?? 'unknown'}): ${result.error?.message ?? 'Unknown error'}`];
    if (result.error?.details !== undefined) {
      lines.push(JSON.stringify(result.error.details, null, 2));
    }
    return lines.join('\n');
  }

  return result.data?.messages.join('\n') ?? 'ok';
}
