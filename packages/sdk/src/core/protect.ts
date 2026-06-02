import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { Rule, OutputRule } from '../rules/types.js';
import { normalizePolicyPackName, resolveBuiltInPolicyPackPath } from '../rules/policy-packs.js';
import type { LogLevel, StreamLogMode, ValidationContext } from '../types/config.js';
import type { BudgetConfig, ToolCostMap } from './budget.js';
import { collectHeuristicPacksForToolNames } from './tool-pack-heuristics.js';
import { Veto, type VetoMode } from './veto.js';
import type { IdentityPolicyConfig } from '../identity/spiffe.js';

export type ProtectMode = VetoMode;

export interface ProtectOptions {
  // Policy source (pick one, auto-detected if omitted)
  configDir?: string;
  pack?: string;
  rules?: Rule[];
  apiKey?: string;
  endpoint?: string;

  // Behavior
  mode?: ProtectMode;
  logLevel?: LogLevel;
  stream?: boolean;
  streamMode?: StreamLogMode;
  /**
   * UNSAFE: if Veto initialization fails, continue with no active policies.
   * Defaults to fail-closed so tools are not accidentally run unprotected.
   */
  allowAllOnInitError?: boolean;

  // Tracking
  sessionId?: string;
  agentId?: string;
  userId?: string;
  role?: string;
  policy?: {
    identity?: IdentityPolicyConfig;
  };
  identity?: IdentityPolicyConfig;

  // Callbacks
  onApprovalRequired?: (context: ValidationContext, approvalId: string) => void | Promise<void>;
  onInitError?: (error: Error) => void;

  // Logging
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void };

  // Budget
  budget?: BudgetConfig;
  costs?: ToolCostMap;
}

type ProtectInitSource =
  | 'rules'
  | 'apiKey'
  | 'endpoint'
  | 'configDir'
  | 'local'
  | 'pack'
  | 'heuristic'
  | 'safe-defaults'
  | 'allow-all';

interface InlineRulesData {
  rules: Rule[];
  outputRules: OutputRule[];
  packs: string[];
}

interface ProtectInitDecision {
  source: ProtectInitSource;
  inlineRules?: InlineRulesData;
}

interface DefaultInstanceState {
  instance: Veto;
  source: ProtectInitSource;
  cwd: string;
}

let _defaultInstance: DefaultInstanceState | null = null;
const _instanceCache = new Map<string, Veto>();
const _referenceIds = new WeakMap<object, string>();
let _nextReferenceId = 0;

function getReferenceId(value: object | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const existing = _referenceIds.get(value);
  if (existing) {
    return existing;
  }

  const id = `ref_${_nextReferenceId++}`;
  _referenceIds.set(value, id);
  return id;
}

function canReuseDefaultInstance(state: DefaultInstanceState | null): state is DefaultInstanceState {
  return state !== null
    && state.source === 'local'
    && state.cwd === process.cwd();
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`);

  return `{${entries.join(',')}}`;
}

function toToolsArray<T extends { name: string }>(input: T | T[]): T[] {
  return Array.isArray(input) ? input : [input];
}

function collectHeuristicPacks<T extends { name: string }>(tools: readonly T[]): string[] {
  return collectHeuristicPacksForToolNames(tools.map((tool) => tool.name));
}

function hasYamlRuleFile(dir: string): boolean {
  if (!existsSync(dir)) {
    return false;
  }

  try {
    for (const entry of readdirSync(dir)) {
      const path = resolve(dir, entry);
      let stat;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      if (stat.isDirectory() && hasYamlRuleFile(path)) {
        return true;
      }
      if (stat.isFile() && (entry.endsWith('.yaml') || entry.endsWith('.yml'))) {
        return true;
      }
    }
  } catch {
    return false;
  }

  return false;
}

function hasLocalPolicyProject(): boolean {
  try {
    const vetoDir = resolve(process.cwd(), 'veto');
    return existsSync(resolve(vetoDir, 'veto.config.yaml'))
      || hasYamlRuleFile(resolve(vetoDir, 'rules'));
  } catch {
    return false;
  }
}

function readPolicyPack(packName: string): { rules: Rule[]; outputRules: OutputRule[]; normalizedPack: string } {
  const normalizedPack = normalizePolicyPackName(packName);
  const path = resolveBuiltInPolicyPackPath(normalizedPack);
  const raw = readFileSync(path, 'utf-8');
  const parsed = parseYaml(raw);

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Policy pack "${normalizedPack}" is not a YAML object`);
  }

  const parsedRecord = parsed as Record<string, unknown>;
  const rules = Array.isArray(parsedRecord.rules)
    ? parsedRecord.rules as Rule[]
    : [];

  const outputRulesRaw = parsedRecord.output_rules;
  const outputRules = Array.isArray(outputRulesRaw)
    ? outputRulesRaw as OutputRule[]
    : [];

  return {
    rules,
    outputRules,
    normalizedPack,
  };
}

function loadInlineRulesFromPacks(packNames: readonly string[]): InlineRulesData {
  const normalizedPacks: string[] = [];
  const rules: Rule[] = [];
  const outputRules: OutputRule[] = [];

  for (const packName of packNames) {
    const pack = readPolicyPack(packName);
    normalizedPacks.push(pack.normalizedPack);
    rules.push(...pack.rules);
    outputRules.push(...pack.outputRules);
  }

  return {
    packs: [...new Set(normalizedPacks)].sort((a, b) => a.localeCompare(b)),
    rules,
    outputRules,
  };
}

function buildInitDecision<T extends { name: string }>(
  tools: readonly T[],
  options: ProtectOptions
): ProtectInitDecision {
  if (options.rules) {
    return {
      source: 'rules',
      inlineRules: {
        packs: [],
        rules: options.rules,
        outputRules: [],
      },
    };
  }

  if (options.apiKey) {
    return { source: 'apiKey' };
  }

  if (options.endpoint) {
    return { source: 'endpoint' };
  }

  if (options.configDir) {
    return { source: 'configDir' };
  }

  if (options.pack) {
    return {
      source: 'pack',
      inlineRules: loadInlineRulesFromPacks([options.pack]),
    };
  }

  if (hasLocalPolicyProject()) {
    return { source: 'local' };
  }

  const heuristicPacks = collectHeuristicPacks(tools);
  if (heuristicPacks.length > 0) {
    return {
      source: 'heuristic',
      inlineRules: loadInlineRulesFromPacks(heuristicPacks),
    };
  }

  return {
    source: 'safe-defaults',
    inlineRules: loadInlineRulesFromPacks(['@veto/safe-defaults']),
  };
}

function resolveProtectLogLevel(options: ProtectOptions): LogLevel | undefined {
  return options.stream ? 'stream' : options.logLevel;
}

function resolveProtectMode(options: ProtectOptions, decision: ProtectInitDecision): ProtectMode | undefined {
  if (options.mode) {
    return options.mode;
  }

  if (decision.source === 'safe-defaults') {
    return 'log';
  }

  return undefined;
}

function createCacheKey(options: ProtectOptions, decision: ProtectInitDecision): string {
  return stableSerialize({
    source: decision.source,
    configDir: options.configDir,
    pack: options.pack,
    apiKey: options.apiKey,
    endpoint: options.endpoint,
    mode: resolveProtectMode(options, decision),
    logLevel: resolveProtectLogLevel(options),
    stream: options.stream,
    streamMode: options.streamMode,
    allowAllOnInitError: options.allowAllOnInitError,
    sessionId: options.sessionId,
    agentId: options.agentId,
    userId: options.userId,
    role: options.role,
    policy: options.policy,
    identity: options.identity,
    onApprovalRequiredId: getReferenceId(options.onApprovalRequired),
    packs: decision.inlineRules?.packs ?? [],
    rulesFingerprint: decision.inlineRules
      ? stableSerialize(decision.inlineRules.rules)
      : null,
    outputRulesFingerprint: decision.inlineRules
      ? stableSerialize(decision.inlineRules.outputRules)
      : null,
    budget: options.budget,
    costs: options.costs,
  });
}

function createAllowAllInstance(options: ProtectOptions): Veto {
  return Veto.fromRules({
    rules: [],
    outputRules: [],
    mode: options.mode,
    logLevel: resolveProtectLogLevel(options),
    stream: options.stream,
    streamMode: options.streamMode,
    sessionId: options.sessionId,
    agentId: options.agentId,
    userId: options.userId,
    role: options.role,
    policy: options.policy,
    identity: options.identity,
    apiKey: options.apiKey,
    endpoint: options.endpoint,
    onApprovalRequired: options.onApprovalRequired,
    budget: options.budget,
    costs: options.costs,
  });
}

function toInitError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function reportInitError(options: ProtectOptions, error: Error, allowAll: boolean): void {
  const message = allowAll
    ? 'UNSAFE Veto initialization fallback enabled; running in allow-all mode with no active policies'
    : 'Veto initialization failed; failing closed and refusing to run tools unprotected';
  const metadata = { error: error.message };

  try {
    options.onInitError?.(error);
  } catch (callbackError) {
    void callbackError;
  }

  if (options.logger) {
    options.logger.warn(message, metadata);
    return;
  }

  if (resolveProtectLogLevel(options) !== 'silent') {
    process.stderr.write(`[veto] ${message}: ${error.message}\n`);
  }
}

function shouldEmitAutoApplyMessage(logLevel: LogLevel | undefined): boolean {
  return logLevel !== 'silent';
}

function emitAutoAppliedPackMessage<T extends { name: string }>(
  tools: readonly T[],
  decision: ProtectInitDecision,
  logLevel: LogLevel | undefined
): void {
  if (!shouldEmitAutoApplyMessage(logLevel)) {
    return;
  }

  if (decision.source !== 'heuristic' || !decision.inlineRules || decision.inlineRules.packs.length === 0) {
    return;
  }

  process.stderr.write(
    `[veto] Auto-applied policy packs: ${decision.inlineRules.packs.join(', ')}\n`
  );
  process.stderr.write(
    `[veto] ${decision.inlineRules.rules.length} rules active for ${tools.length} tools. Run 'npx veto test' for details.\n`
  );
}

async function initializeVeto<T extends { name: string }>(tools: readonly T[], options: ProtectOptions): Promise<{
  instance: Veto;
  cacheKey: string;
  decision: ProtectInitDecision;
  fromCache: boolean;
}> {
  const decision = buildInitDecision(tools, options);
  const cacheKey = createCacheKey(options, decision);

  const cached = _instanceCache.get(cacheKey);
  if (cached) {
    return { instance: cached, cacheKey, decision, fromCache: true };
  }

  let instance: Veto;

  try {
    switch (decision.source) {
      case 'rules':
      case 'pack':
      case 'heuristic':
      case 'safe-defaults':
      case 'allow-all': {
        const inlineRules = decision.inlineRules ?? { rules: [], outputRules: [] as OutputRule[], packs: [] };
        instance = Veto.fromRules({
          rules: inlineRules.rules,
          outputRules: inlineRules.outputRules,
          mode: resolveProtectMode(options, decision),
          logLevel: resolveProtectLogLevel(options),
          stream: options.stream,
          streamMode: options.streamMode,
          sessionId: options.sessionId,
          agentId: options.agentId,
          userId: options.userId,
          role: options.role,
          policy: options.policy,
          identity: options.identity,
          apiKey: options.apiKey,
          endpoint: options.endpoint,
          onApprovalRequired: options.onApprovalRequired,
          budget: options.budget,
          costs: options.costs,
        });
        break;
      }
      case 'apiKey':
      case 'endpoint':
      case 'configDir':
      case 'local': {
        instance = await Veto.init({
          configDir: options.configDir,
          mode: options.mode,
          logLevel: resolveProtectLogLevel(options),
          streamMode: options.streamMode,
          sessionId: options.sessionId,
          agentId: options.agentId,
          userId: options.userId,
          role: options.role,
          policy: options.policy,
          identity: options.identity,
          apiKey: options.apiKey,
          endpoint: options.endpoint,
          onApprovalRequired: options.onApprovalRequired,
        });
        break;
      }
      default: {
        instance = createAllowAllInstance(options);
      }
    }
  } catch (error) {
    const initError = toInitError(error);
    reportInitError(options, initError, options.allowAllOnInitError === true);
    if (options.allowAllOnInitError !== true) {
      throw initError;
    }
    instance = createAllowAllInstance(options);
  }

  _instanceCache.set(cacheKey, instance);

  return { instance, cacheKey, decision, fromCache: false };
}

export async function protect<T extends { name: string }>(
  tools: T[],
  options?: ProtectOptions
): Promise<T[]>;
export async function protect<T extends { name: string }>(
  tool: T,
  options?: ProtectOptions
): Promise<T>;
export async function protect<T extends { name: string }>(
  input: T | T[],
  options?: ProtectOptions
): Promise<T | T[]> {
  if (options === undefined && canReuseDefaultInstance(_defaultInstance)) {
    return Array.isArray(input)
      ? _defaultInstance.instance.wrap(input)
      : _defaultInstance.instance.wrapTool(input);
  }

  const normalizedOptions = options ?? {};
  const tools = toToolsArray(input);
  const { instance, decision, fromCache } = await initializeVeto(tools, normalizedOptions);

  if (!fromCache) {
    emitAutoAppliedPackMessage(tools, decision, normalizedOptions.logLevel);
  }

  if (options === undefined) {
    _defaultInstance = {
      instance,
      source: decision.source,
      cwd: process.cwd(),
    };
  }

  return Array.isArray(input)
    ? instance.wrap(input)
    : instance.wrapTool(input);
}

export function __resetProtectCacheForTests(): void {
  _defaultInstance = null;
  _instanceCache.clear();
}
