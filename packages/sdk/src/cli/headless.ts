import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { Veto } from '../core/veto.js';
import {
  checkGenerationConnectivity,
  generatePolicyFromPrompt,
  validateGeneratedYaml,
} from './repl-generate.js';
import { createReplSessionContext } from './repl-context.js';
import { evaluateToolCallHybrid } from './repl.js';

const DEFAULT_CLOUD_BASE_URL = 'https://api.runveto.com';
const DEVICE_POLL_INTERVAL_SECONDS = 5;
const DEVICE_POLL_TIMEOUT_SECONDS = 300;

export type StudioTheme = 'veto' | 'claude' | 'high-contrast';

export interface HeadlessResult<T> {
  ok: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

interface CloudSession {
  baseUrl: string;
  accessToken?: string;
  refreshToken?: string;
  accessTokenExpiresAt?: string;
  organizationId?: string;
  projectId?: string;
  user?: {
    id?: string;
    email?: string;
    name?: string;
  };
}

interface CloudApiResponse {
  ok: boolean;
  status: number;
  body: unknown;
}

interface PolicyGenerateCommandOptions {
  projectDir: string;
  tool: string;
  prompt: string;
  modeHint?: 'auto' | 'deterministic' | 'llm';
  target: 'local' | 'cloud';
  savePath?: string;
  demoTemplate?: boolean;
}

interface PolicyApplyCommandOptions {
  projectDir: string;
  filePath: string;
  target: 'local' | 'cloud';
  projectId?: string;
}

interface GuardCheckCommandOptions {
  projectDir: string;
  tool: string;
  argsJson?: string;
  contextJson?: string;
  mode: 'local' | 'cloud' | 'kernel' | 'custom';
}

interface DoctorCommandOptions {
  projectDir: string;
}

interface CloudLoginCommandOptions {
  baseUrl?: string;
}

interface CloudContextCommandOptions {
  baseUrl?: string;
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

export function printHeadlessResult<T>(result: HeadlessResult<T>, asJson: boolean): void {
  if (asJson) {
    console.log(JSON.stringify(result));
    return;
  }

  if (result.ok) {
    if (result.data === undefined) {
      console.log('ok');
      return;
    }

    if (typeof result.data === 'string') {
      console.log(result.data);
      return;
    }

    console.log(JSON.stringify(result.data, null, 2));
    return;
  }

  console.error(`Error (${result.error?.code ?? 'unknown'}): ${result.error?.message ?? 'Unknown error'}`);
  if (result.error?.details !== undefined) {
    console.error(JSON.stringify(result.error.details, null, 2));
  }
}

function getCloudSessionPath(): string {
  return resolve(homedir(), '.veto', 'cloud-session.json');
}

function loadCloudSession(): CloudSession | null {
  const sessionPath = getCloudSessionPath();
  if (!existsSync(sessionPath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(sessionPath, 'utf-8')) as CloudSession;
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }

    return {
      baseUrl: typeof parsed.baseUrl === 'string' ? parsed.baseUrl : DEFAULT_CLOUD_BASE_URL,
      accessToken: typeof parsed.accessToken === 'string' ? parsed.accessToken : undefined,
      refreshToken: typeof parsed.refreshToken === 'string' ? parsed.refreshToken : undefined,
      accessTokenExpiresAt: typeof parsed.accessTokenExpiresAt === 'string'
        ? parsed.accessTokenExpiresAt
        : undefined,
      organizationId: typeof parsed.organizationId === 'string' ? parsed.organizationId : undefined,
      projectId: typeof parsed.projectId === 'string' ? parsed.projectId : undefined,
      user: parsed.user,
    };
  } catch {
    return null;
  }
}

function persistCloudSession(session: CloudSession): void {
  const sessionPath = getCloudSessionPath();
  mkdirSync(resolve(sessionPath, '..'), { recursive: true });
  writeFileSync(sessionPath, JSON.stringify(session, null, 2), 'utf-8');
}

function clearCloudSession(): void {
  const sessionPath = getCloudSessionPath();
  if (existsSync(sessionPath)) {
    rmSync(sessionPath, { force: true });
  }
}

function normalizeBaseUrl(baseUrl: string | undefined): string {
  const resolved = (baseUrl ?? DEFAULT_CLOUD_BASE_URL).trim();
  return resolved.replace(/\/$/, '');
}

function resolveCloudBaseUrl(explicitBaseUrl?: string): string {
  const fromEnv = process.env.VETO_API_URL?.trim();
  const session = loadCloudSession();

  return normalizeBaseUrl(
    explicitBaseUrl
      ?? fromEnv
      ?? session?.baseUrl
      ?? DEFAULT_CLOUD_BASE_URL
  );
}

function resolveCloudAuthHeaders(): HeadlessResult<Record<string, string>> {
  const apiKey = process.env.VETO_API_KEY?.trim();
  if (apiKey) {
    return ok({
      'X-Veto-API-Key': apiKey,
    });
  }

  const session = loadCloudSession();
  if (session?.accessToken) {
    return ok({
      Authorization: `Bearer ${session.accessToken}`,
    });
  }

  return fail(
    'cloud_auth_missing',
    'No cloud credentials found. Set VETO_API_KEY or run `veto cloud login`.'
  );
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const raw = await response.text();
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

async function callCloudApi(options: {
  baseUrl: string;
  path: string;
  method: 'GET' | 'POST';
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
}): Promise<CloudApiResponse> {
  const url = `${options.baseUrl}${options.path}`;

  const headers: Record<string, string> = {
    ...(options.headers ?? {}),
  };

  let requestBody: string | undefined;
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    requestBody = JSON.stringify(options.body);
  }

  const response = await fetch(url, {
    method: options.method,
    headers,
    body: requestBody,
  });

  return {
    ok: response.ok,
    status: response.status,
    body: await parseResponseBody(response),
  };
}

function parseJsonObject(value: string, label: string): HeadlessResult<Record<string, unknown>> {
  const trimmed = value.trim();
  if (!trimmed) {
    return ok({});
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return fail('invalid_json_object', `${label} must be a JSON object.`);
    }

    return ok(parsed as Record<string, unknown>);
  } catch (error) {
    return fail(
      'invalid_json',
      `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function readStdinText(): Promise<string | undefined> {
  if (process.stdin.isTTY) {
    return undefined;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin as AsyncIterable<Buffer | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf-8'));
  }

  const text = Buffer.concat(chunks).toString('utf-8').trim();
  return text.length > 0 ? text : undefined;
}

function toRuleFileName(toolName: string): string {
  const value = toolName.toLowerCase();
  let slug = '';
  let previousWasDash = false;

  for (const character of value) {
    const isAlphaNumeric =
      (character >= 'a' && character <= 'z') ||
      (character >= '0' && character <= '9');

    if (isAlphaNumeric) {
      slug += character;
      previousWasDash = false;
      continue;
    }

    if (!previousWasDash) {
      slug += '-';
      previousWasDash = true;
    }
  }

  while (slug.startsWith('-')) {
    slug = slug.slice(1);
  }

  while (slug.endsWith('-')) {
    slug = slug.slice(0, -1);
  }

  return `${slug || 'policy'}.generated.yaml`;
}

function getRuleCount(value: unknown): number {
  if (!value || typeof value !== 'object') {
    return 0;
  }

  const candidate = (value as { rules?: unknown }).rules;
  return Array.isArray(candidate) ? candidate.length : 0;
}

export async function runPolicyGenerateCommand(
  options: PolicyGenerateCommandOptions
): Promise<HeadlessResult<{
  target: 'local' | 'cloud';
  toolName: string;
  prompt: string;
  yaml: string;
  ruleCount: number;
  mode?: string;
  warnings: string[];
  savedTo?: string;
}>> {
  const projectDir = resolve(options.projectDir);

  if (options.target === 'local') {
    try {
      const context = await createReplSessionContext(projectDir);
      const generated = await generatePolicyFromPrompt({
        prompt: options.prompt,
        projectDir,
        rulesDirectory: context.rulesDir,
        tools: context.discoveredTools,
        existingRules: context.allRules,
        allowTemplateFallback: options.demoTemplate,
      });

      const parsed = validateGeneratedYaml(generated.yaml);
      const warnings = [...generated.warnings];

      if (!context.discoveredTools.find((tool) => tool.name === options.tool)) {
        warnings.push(
          `Tool '${options.tool}' is not currently discovered in workspace scan. Generation may be generic.`
        );
      }

      let savedTo: string | undefined;
      if (options.savePath) {
        savedTo = resolve(projectDir, options.savePath);
        mkdirSync(resolve(savedTo, '..'), { recursive: true });
        writeFileSync(savedTo, generated.yaml, 'utf-8');
      }

      return ok({
        target: 'local',
        toolName: options.tool,
        prompt: options.prompt,
        yaml: generated.yaml,
        ruleCount: getRuleCount(parsed),
        mode: generated.mode,
        warnings,
        savedTo,
      });
    } catch (error) {
      return fail(
        'policy_generate_failed',
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  const auth = resolveCloudAuthHeaders();
  if (!auth.ok) {
    return fail(
      auth.error?.code ?? 'cloud_auth_missing',
      auth.error?.message ?? 'Missing cloud authentication credentials.',
      auth.error?.details
    );
  }

  const baseUrl = resolveCloudBaseUrl();
  const response = await callCloudApi({
    baseUrl,
    path: '/v1/policies/generate',
    method: 'POST',
    headers: auth.data,
    body: {
      toolName: options.tool,
      prompt: options.prompt,
      modeHint: options.modeHint,
    },
  });

  if (!response.ok) {
    return fail('cloud_policy_generate_failed', `Cloud generation failed with status ${response.status}.`, response.body);
  }

  const body = response.body as {
    yaml?: unknown;
    draft?: {
      mode?: unknown;
    };
  } | null;

  if (!body || typeof body.yaml !== 'string') {
    return fail('cloud_policy_generate_invalid_response', 'Cloud generation response is missing YAML.', response.body);
  }

  let ruleCount = 0;
  try {
    const parsed = validateGeneratedYaml(body.yaml);
    ruleCount = getRuleCount(parsed);
  } catch {
    ruleCount = 0;
  }

  let savedTo: string | undefined;
  if (options.savePath) {
    savedTo = resolve(projectDir, options.savePath);
    mkdirSync(resolve(savedTo, '..'), { recursive: true });
    writeFileSync(savedTo, body.yaml, 'utf-8');
  }

  return ok({
    target: 'cloud',
    toolName: options.tool,
    prompt: options.prompt,
    yaml: body.yaml,
    ruleCount,
    mode: typeof body.draft?.mode === 'string' ? body.draft.mode : undefined,
    warnings: [],
    savedTo,
  });
}

export async function runPolicyApplyCommand(
  options: PolicyApplyCommandOptions
): Promise<HeadlessResult<{
  target: 'local' | 'cloud';
  sourceFile: string;
  appliedFile?: string;
  draftId?: string;
  ruleCount: number;
}>> {
  const projectDir = resolve(options.projectDir);
  const sourceFile = resolve(projectDir, options.filePath);

  if (!existsSync(sourceFile)) {
    return fail('policy_file_missing', `Policy file not found: ${sourceFile}`);
  }

  const yaml = readFileSync(sourceFile, 'utf-8');
  let parsedPolicy: Record<string, unknown>;

  try {
    parsedPolicy = validateGeneratedYaml(yaml);
  } catch (error) {
    return fail('policy_file_invalid', error instanceof Error ? error.message : String(error));
  }

  const rules = Array.isArray(parsedPolicy.rules) ? parsedPolicy.rules : [];

  if (options.target === 'local') {
    const rulesDir = resolve(projectDir, 'veto', 'rules');
    const targetFile = resolve(rulesDir, basename(sourceFile));

    if (targetFile !== sourceFile) {
      mkdirSync(rulesDir, { recursive: true });
      writeFileSync(targetFile, yaml, 'utf-8');
    }

    return ok({
      target: 'local',
      sourceFile,
      appliedFile: targetFile,
      ruleCount: rules.length,
    });
  }

  const auth = resolveCloudAuthHeaders();
  if (!auth.ok) {
    return fail(
      auth.error?.code ?? 'cloud_auth_missing',
      auth.error?.message ?? 'Missing cloud authentication credentials.',
      auth.error?.details
    );
  }

  const baseUrl = resolveCloudBaseUrl();
  const draftName = basename(sourceFile, extname(sourceFile));

  const response = await callCloudApi({
    baseUrl,
    path: '/v1/policy-drafts',
    method: 'POST',
    headers: auth.data,
    body: {
      name: draftName,
      description: `Applied from CLI file ${basename(sourceFile)}`,
      rules,
      status: 'draft',
      projectId: options.projectId,
    },
  });

  if (!response.ok) {
    return fail('cloud_policy_apply_failed', `Cloud apply failed with status ${response.status}.`, response.body);
  }

  const body = response.body as {
    data?: {
      id?: unknown;
    };
  } | null;

  const draftId = typeof body?.data?.id === 'string' ? body.data.id : undefined;

  return ok({
    target: 'cloud',
    sourceFile,
    draftId,
    ruleCount: rules.length,
  });
}

function readValidationModeFromConfig(projectDir: string): 'local' | 'cloud' | 'kernel' | 'custom' | undefined {
  const configPath = resolve(projectDir, 'veto', 'veto.config.yaml');
  if (!existsSync(configPath)) {
    return undefined;
  }

  try {
    const parsed = parseYaml(readFileSync(configPath, 'utf-8')) as {
      validation?: {
        mode?: unknown;
      };
    } | null;

    const mode = parsed?.validation?.mode;
    if (mode === 'local' || mode === 'cloud' || mode === 'kernel' || mode === 'custom') {
      return mode;
    }

    return undefined;
  } catch {
    return undefined;
  }
}

function coerceGuardContext(context: Record<string, unknown>): {
  sessionId?: string;
  agentId?: string;
  userId?: string;
  role?: string;
} {
  return {
    sessionId: typeof context.sessionId === 'string' ? context.sessionId : undefined,
    agentId: typeof context.agentId === 'string' ? context.agentId : undefined,
    userId: typeof context.userId === 'string' ? context.userId : undefined,
    role: typeof context.role === 'string' ? context.role : undefined,
  };
}

export async function runGuardCheckCommand(
  options: GuardCheckCommandOptions
): Promise<HeadlessResult<{
  mode: 'local' | 'cloud' | 'kernel' | 'custom';
  toolName: string;
  decision: 'allow' | 'deny' | 'require_approval';
  reason?: string;
  ruleId?: string;
  severity?: string;
}>> {
  const projectDir = resolve(options.projectDir);

  const inputArgsRaw = options.argsJson ?? await readStdinText() ?? '{}';
  const argsParsed = parseJsonObject(inputArgsRaw, 'Tool args');
  if (!argsParsed.ok) {
    return fail(
      argsParsed.error?.code ?? 'invalid_json',
      argsParsed.error?.message ?? 'Tool args is invalid JSON.',
      argsParsed.error?.details
    );
  }

  const contextParsed = parseJsonObject(options.contextJson ?? '{}', 'Context');
  if (!contextParsed.ok) {
    return fail(
      contextParsed.error?.code ?? 'invalid_json',
      contextParsed.error?.message ?? 'Context is invalid JSON.',
      contextParsed.error?.details
    );
  }

  const argsObject = argsParsed.data ?? {};
  const contextObject = contextParsed.data ?? {};

  if (options.mode === 'local') {
    try {
      const context = await createReplSessionContext(projectDir);
      const result = await evaluateToolCallHybrid(context, options.tool, argsObject);

      return ok({
        mode: 'local',
        toolName: options.tool,
        decision: result.decision,
        reason: result.reason,
        ruleId: result.matchedRule?.id,
        severity: result.matchedRule?.severity,
      });
    } catch (error) {
      return fail('guard_local_failed', error instanceof Error ? error.message : String(error));
    }
  }

  if (options.mode === 'cloud' && !process.env.VETO_API_KEY?.trim()) {
    return fail('guard_cloud_missing_api_key', 'Cloud guard mode requires VETO_API_KEY.');
  }

  if (options.mode === 'kernel' || options.mode === 'custom') {
    const configuredMode = readValidationModeFromConfig(projectDir);
    if (configuredMode !== options.mode) {
      return fail(
        'guard_mode_mismatch',
        `Requested mode '${options.mode}' but veto.config.yaml is '${configuredMode ?? 'unset'}'.`,
        {
          configuredMode,
          requestedMode: options.mode,
        }
      );
    }
  }

  try {
    const veto = await Veto.init({
      configDir: resolve(projectDir, 'veto'),
      ...(options.mode === 'cloud'
        ? {
            apiKey: process.env.VETO_API_KEY?.trim(),
            endpoint: process.env.VETO_API_URL?.trim(),
          }
        : {}),
    });

    const result = await veto.guard(
      options.tool,
      argsObject,
      coerceGuardContext(contextObject)
    );

    return ok({
      mode: options.mode,
      toolName: options.tool,
      decision: result.decision,
      reason: result.reason,
      ruleId: result.ruleId,
      severity: result.severity,
    });
  } catch (error) {
    return fail('guard_check_failed', error instanceof Error ? error.message : String(error));
  }
}

export async function runDoctorCommand(
  options: DoctorCommandOptions
): Promise<HeadlessResult<{
  projectDir: string;
  runtime: 'node' | 'bun';
  configPresent: boolean;
  generation: {
    connected: boolean;
    mode?: string;
    reason?: string;
  };
  renderers: {
    inkAvailable: boolean;
    opentuiAvailable: boolean;
    opentuiRuntimeReady: boolean;
  };
  cloud: {
    apiKeyPresent: boolean;
    sessionPresent: boolean;
    baseUrl: string;
  };
}>> {
  const projectDir = resolve(options.projectDir);
  const runtime = process.versions?.bun ? 'bun' : 'node';
  const configPath = resolve(projectDir, 'veto', 'veto.config.yaml');

  let inkAvailable = false;
  let opentuiAvailable = false;

  try {
    await import('ink');
    inkAvailable = true;
  } catch {
    inkAvailable = false;
  }

  try {
    await import('@opentui/core');
    opentuiAvailable = true;
  } catch {
    opentuiAvailable = false;
  }

  const generation = await checkGenerationConnectivity({ projectDir });
  const session = loadCloudSession();

  return ok({
    projectDir,
    runtime,
    configPresent: existsSync(configPath),
    generation: {
      connected: generation.connected,
      mode: generation.mode,
      reason: generation.reason,
    },
    renderers: {
      inkAvailable,
      opentuiAvailable,
      opentuiRuntimeReady: runtime === 'bun' && opentuiAvailable,
    },
    cloud: {
      apiKeyPresent: Boolean(process.env.VETO_API_KEY?.trim()),
      sessionPresent: Boolean(session?.accessToken),
      baseUrl: resolveCloudBaseUrl(),
    },
  });
}

export async function runCloudLoginCommand(
  options: CloudLoginCommandOptions
): Promise<HeadlessResult<{
  baseUrl: string;
  userCode: string;
  verificationUri: string;
  authorized: boolean;
}>> {
  const baseUrl = resolveCloudBaseUrl(options.baseUrl);
  const startResponse = await callCloudApi({
    baseUrl,
    path: '/v1/cli/device/start',
    method: 'POST',
    body: {
      clientName: 'veto-cli',
    },
  });

  if (!startResponse.ok) {
    return fail(
      'cloud_login_start_failed',
      `Device login start failed with status ${startResponse.status}.`,
      startResponse.body
    );
  }

  const startBody = startResponse.body as {
    deviceCode?: unknown;
    device_code?: unknown;
    userCode?: unknown;
    user_code?: unknown;
    verificationUri?: unknown;
    verification_uri?: unknown;
    intervalSeconds?: unknown;
    interval?: unknown;
    expiresInSeconds?: unknown;
    expires_in?: unknown;
  } | null;

  const deviceCode = typeof startBody?.deviceCode === 'string'
    ? startBody.deviceCode
    : typeof startBody?.device_code === 'string'
      ? startBody.device_code
      : undefined;
  const userCode = typeof startBody?.userCode === 'string'
    ? startBody.userCode
    : typeof startBody?.user_code === 'string'
      ? startBody.user_code
      : undefined;
  const verificationUri = typeof startBody?.verificationUri === 'string'
    ? startBody.verificationUri
    : typeof startBody?.verification_uri === 'string'
      ? startBody.verification_uri
      : undefined;

  if (!deviceCode || !userCode || !verificationUri) {
    return fail('cloud_login_invalid_start_response', 'Device login start response is missing required fields.', startResponse.body);
  }

  const intervalSeconds = Number(
    startBody?.intervalSeconds
      ?? startBody?.interval
      ?? DEVICE_POLL_INTERVAL_SECONDS
  );
  const timeoutSeconds = Number(
    startBody?.expiresInSeconds
      ?? startBody?.expires_in
      ?? DEVICE_POLL_TIMEOUT_SECONDS
  );

  console.log(`Open: ${verificationUri}`);
  console.log(`Code: ${userCode}`);
  console.log('Waiting for approval...');

  const startedAt = Date.now();

  while ((Date.now() - startedAt) < timeoutSeconds * 1000) {
    await new Promise((resolveTimeout) => {
      setTimeout(resolveTimeout, Math.max(1, intervalSeconds) * 1000);
    });

    const pollResponse = await callCloudApi({
      baseUrl,
      path: '/v1/cli/device/poll',
      method: 'POST',
      body: {
        deviceCode,
      },
    });

    if (pollResponse.status === 202) {
      continue;
    }

    if (!pollResponse.ok) {
      return fail(
        'cloud_login_poll_failed',
        `Device login polling failed with status ${pollResponse.status}.`,
        pollResponse.body
      );
    }

    const pollBody = pollResponse.body as {
      accessToken?: unknown;
      access_token?: unknown;
      refreshToken?: unknown;
      refresh_token?: unknown;
      expiresAt?: unknown;
      expires_at?: unknown;
      organizationId?: unknown;
      organization_id?: unknown;
      projectId?: unknown;
      project_id?: unknown;
      user?: {
        id?: unknown;
        email?: unknown;
        name?: unknown;
      };
    } | null;

    const accessToken = typeof pollBody?.accessToken === 'string'
      ? pollBody.accessToken
      : typeof pollBody?.access_token === 'string'
        ? pollBody.access_token
        : undefined;

    if (!accessToken) {
      continue;
    }

    const refreshToken = typeof pollBody?.refreshToken === 'string'
      ? pollBody.refreshToken
      : typeof pollBody?.refresh_token === 'string'
        ? pollBody.refresh_token
        : undefined;

    const session: CloudSession = {
      baseUrl,
      accessToken,
      refreshToken,
      accessTokenExpiresAt: typeof pollBody?.expiresAt === 'string'
        ? pollBody.expiresAt
        : typeof pollBody?.expires_at === 'string'
          ? pollBody.expires_at
          : undefined,
      organizationId: typeof pollBody?.organizationId === 'string'
        ? pollBody.organizationId
        : typeof pollBody?.organization_id === 'string'
          ? pollBody.organization_id
          : undefined,
      projectId: typeof pollBody?.projectId === 'string'
        ? pollBody.projectId
        : typeof pollBody?.project_id === 'string'
          ? pollBody.project_id
          : undefined,
      user: {
        id: typeof pollBody?.user?.id === 'string' ? pollBody.user.id : undefined,
        email: typeof pollBody?.user?.email === 'string' ? pollBody.user.email : undefined,
        name: typeof pollBody?.user?.name === 'string' ? pollBody.user.name : undefined,
      },
    };

    persistCloudSession(session);

    return ok({
      baseUrl,
      userCode,
      verificationUri,
      authorized: true,
    });
  }

  return fail('cloud_login_timeout', 'Device login timed out before authorization completed.');
}

export async function runCloudWhoamiCommand(
  options: CloudContextCommandOptions
): Promise<HeadlessResult<{
  baseUrl: string;
  context: unknown;
}>> {
  const session = loadCloudSession();
  if (!session?.accessToken) {
    return fail('cloud_session_missing', 'No cloud session found. Run `veto cloud login` first.');
  }

  const baseUrl = resolveCloudBaseUrl(options.baseUrl ?? session.baseUrl);

  const response = await callCloudApi({
    baseUrl,
    path: '/v1/cli/context',
    method: 'GET',
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
    },
  });

  if (!response.ok) {
    return fail('cloud_whoami_failed', `Cloud context failed with status ${response.status}.`, response.body);
  }

  return ok({
    baseUrl,
    context: response.body,
  });
}

export function runCloudOrgUseCommand(
  organizationId: string
): HeadlessResult<{
  organizationId: string;
}> {
  const session = loadCloudSession();
  if (!session) {
    return fail('cloud_session_missing', 'No cloud session found. Run `veto cloud login` first.');
  }

  const updated: CloudSession = {
    ...session,
    organizationId,
  };
  persistCloudSession(updated);

  return ok({ organizationId });
}

export function runCloudProjectUseCommand(
  projectId: string
): HeadlessResult<{
  projectId: string;
}> {
  const session = loadCloudSession();
  if (!session) {
    return fail('cloud_session_missing', 'No cloud session found. Run `veto cloud login` first.');
  }

  const updated: CloudSession = {
    ...session,
    projectId,
  };
  persistCloudSession(updated);

  return ok({ projectId });
}

export function runCloudLogoutCommand(): HeadlessResult<{ cleared: boolean }> {
  clearCloudSession();
  return ok({ cleared: true });
}

export async function parseGuardArgsJson(explicitArgs: string | undefined): Promise<HeadlessResult<string>> {
  if (explicitArgs && explicitArgs.trim().length > 0) {
    return ok(explicitArgs);
  }

  const stdinText = await readStdinText();
  if (stdinText) {
    return ok(stdinText);
  }

  return ok('{}');
}

export function resolvePolicySavePath(projectDir: string, toolName: string, explicitPath?: string): string {
  if (explicitPath && explicitPath.trim().length > 0) {
    return resolve(projectDir, explicitPath);
  }

  return resolve(projectDir, 'veto', 'rules', toRuleFileName(toolName));
}
