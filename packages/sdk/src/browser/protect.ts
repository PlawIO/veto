import { Veto } from './veto.js';
import type { OutputRule, Rule } from '../rules/types.js';
import type { ProtectMode, ProtectOptions } from '../core/protect.js';
import type { VetoMode } from './types.js';
export type { ProtectMode, ProtectOptions } from '../core/protect.js';

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

type ProtectInitSource = 'rules' | 'apiKey' | 'allow-all';

interface ProtectInitDecision {
  source: ProtectInitSource;
  packs: string[];
  rules: Rule[];
  outputRules: OutputRule[];
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

function buildInitDecision<T extends { name: string }>(
  tools: readonly T[],
  options: ProtectOptions
): ProtectInitDecision {
  if (options.rules) {
    return {
      source: 'rules',
      packs: [],
      rules: options.rules,
      outputRules: [],
    };
  }

  if (options.apiKey) {
    return {
      source: 'apiKey',
      packs: [],
      rules: [],
      outputRules: [],
    };
  }

  return {
    source: 'allow-all',
    packs: collectHeuristicPacks(tools),
    rules: [],
    outputRules: [],
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
    packs: decision.packs,
    rulesFingerprint: stableSerialize(decision.rules),
    outputRulesFingerprint: stableSerialize(decision.outputRules),
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

async function initializeVeto<T extends { name: string }>(tools: readonly T[], options: ProtectOptions): Promise<Veto> {
  const decision = buildInitDecision(tools, options);
  const cacheKey = createCacheKey(options, decision);

  const cached = _instanceCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  let instance: Veto;

  try {
    if (decision.source === 'apiKey') {
      instance = await Veto.fromCloud({
        apiKey: options.apiKey!,
        endpoint: options.endpoint,
      });
    } else {
      instance = Veto.fromRules({
        rules: decision.rules,
        outputRules: decision.outputRules,
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
  } catch {
    instance = createAllowAllInstance(options);
  }

  _instanceCache.set(cacheKey, instance);

  return instance;
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
  const instance = await initializeVeto(tools, normalizedOptions);

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
