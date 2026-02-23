import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { Rule, OutputRule } from '../rules/types.js';
import { normalizePolicyPackName, resolveBuiltInPolicyPackPath } from '../rules/policy-packs.js';
import type { LogLevel, ValidationContext } from '../types/config.js';
import type { BudgetConfig, ToolCostMap } from './budget.js';
import { Veto, type VetoMode } from './veto.js';

export type ProtectMode = VetoMode | 'shadow';

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

  // Tracking
  sessionId?: string;
  agentId?: string;
  userId?: string;
  role?: string;

  // Callbacks
  onApprovalRequired?: (context: ValidationContext, approvalId: string) => void | Promise<void>;

  // Budget
  budget?: BudgetConfig;
  costs?: ToolCostMap;
}

interface ToolPackHeuristic {
  patterns: readonly string[];
  pack: string;
}

const TOOL_PACK_HEURISTICS: readonly ToolPackHeuristic[] = [
  {
    patterns: ['transfer', 'payment', 'balance', 'withdraw', 'deposit', 'invoice'],
    pack: '@veto/financial',
  },
  {
    patterns: ['navigate', 'click', 'goto', 'browse', 'scroll', 'type_text'],
    pack: '@veto/browser-automation',
  },
  {
    patterns: ['query', 'sql', 'database', 'select', 'insert', 'table'],
    pack: '@veto/data-access',
  },
  {
    patterns: ['exec', 'shell', 'command', 'terminal', 'bash', 'run_code'],
    pack: '@veto/coding-agent',
  },
];

type ProtectInitSource =
  | 'rules'
  | 'apiKey'
  | 'endpoint'
  | 'configDir'
  | 'local'
  | 'pack'
  | 'heuristic'
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

let _defaultInstance: Veto | null = null;
const _instanceCache = new Map<string, Veto>();

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

function normalizeProtectMode(mode: ProtectMode | undefined): VetoMode | undefined {
  if (mode === 'shadow') {
    // TODO: PLW-94 true shadow mode behavior.
    return 'log';
  }

  return mode;
}

function toToolsArray<T extends { name: string }>(input: T | T[]): T[] {
  return Array.isArray(input) ? input : [input];
}

function collectHeuristicPacks<T extends { name: string }>(tools: readonly T[]): string[] {
  const packs = new Set<string>();

  for (const tool of tools) {
    const name = tool.name.toLowerCase();

    for (const heuristic of TOOL_PACK_HEURISTICS) {
      if (heuristic.patterns.some((pattern) => name.includes(pattern))) {
        packs.add(heuristic.pack);
      }
    }
  }

  return [...packs].sort((a, b) => a.localeCompare(b));
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

  if (existsSync(resolve(process.cwd(), 'veto'))) {
    return { source: 'local' };
  }

  if (options.pack) {
    return {
      source: 'pack',
      inlineRules: loadInlineRulesFromPacks([options.pack]),
    };
  }

  const heuristicPacks = collectHeuristicPacks(tools);
  if (heuristicPacks.length > 0) {
    return {
      source: 'heuristic',
      inlineRules: loadInlineRulesFromPacks(heuristicPacks),
    };
  }

  return {
    source: 'allow-all',
    inlineRules: {
      packs: [],
      rules: [],
      outputRules: [],
    },
  };
}

function createCacheKey(options: ProtectOptions, decision: ProtectInitDecision): string {
  return stableSerialize({
    source: decision.source,
    configDir: options.configDir,
    pack: options.pack,
    apiKey: options.apiKey,
    endpoint: options.endpoint,
    mode: normalizeProtectMode(options.mode),
    logLevel: options.logLevel,
    sessionId: options.sessionId,
    agentId: options.agentId,
    userId: options.userId,
    role: options.role,
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
    mode: normalizeProtectMode(options.mode),
    logLevel: options.logLevel,
    sessionId: options.sessionId,
    agentId: options.agentId,
    userId: options.userId,
    role: options.role,
    apiKey: options.apiKey,
    endpoint: options.endpoint,
    onApprovalRequired: options.onApprovalRequired,
    budget: options.budget,
    costs: options.costs,
  });
}

async function initializeVeto<T extends { name: string }>(tools: readonly T[], options: ProtectOptions): Promise<{
  instance: Veto;
  cacheKey: string;
}> {
  const decision = buildInitDecision(tools, options);
  const cacheKey = createCacheKey(options, decision);

  const cached = _instanceCache.get(cacheKey);
  if (cached) {
    return { instance: cached, cacheKey };
  }

  let instance: Veto;

  try {
    switch (decision.source) {
      case 'rules':
      case 'pack':
      case 'heuristic':
      case 'allow-all': {
        const inlineRules = decision.inlineRules ?? { rules: [], outputRules: [] as OutputRule[], packs: [] };
        instance = Veto.fromRules({
          rules: inlineRules.rules,
          outputRules: inlineRules.outputRules,
          mode: normalizeProtectMode(options.mode),
          logLevel: options.logLevel,
          sessionId: options.sessionId,
          agentId: options.agentId,
          userId: options.userId,
          role: options.role,
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
          mode: normalizeProtectMode(options.mode),
          logLevel: options.logLevel,
          sessionId: options.sessionId,
          agentId: options.agentId,
          userId: options.userId,
          role: options.role,
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
  } catch {
    instance = createAllowAllInstance(options);
  }

  _instanceCache.set(cacheKey, instance);

  return { instance, cacheKey };
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
  if (options === undefined && _defaultInstance) {
    return Array.isArray(input)
      ? _defaultInstance.wrap(input)
      : _defaultInstance.wrapTool(input);
  }

  const normalizedOptions = options ?? {};
  const tools = toToolsArray(input);
  const { instance } = await initializeVeto(tools, normalizedOptions);

  if (options === undefined) {
    _defaultInstance = instance;
  }

  return Array.isArray(input)
    ? instance.wrap(input)
    : instance.wrapTool(input);
}

export function __resetProtectCacheForTests(): void {
  _defaultInstance = null;
  _instanceCache.clear();
}
