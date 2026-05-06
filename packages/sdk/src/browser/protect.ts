import { Veto } from './veto.js';
import type { OutputRule, Rule } from '../rules/types.js';
import type { ProtectOptions } from '../core/protect.js';
export type { ProtectMode, ProtectOptions } from '../core/protect.js';

type ProtectInitSource = 'rules' | 'apiKey' | 'allow-all';

interface ProtectInitDecision {
  source: ProtectInitSource;
  rules: Rule[];
  outputRules: OutputRule[];
}

let _defaultInstance: Veto | null = null;
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

function buildInitDecision<T extends { name: string }>(
  _tools: readonly T[],
  options: ProtectOptions
): ProtectInitDecision {
  if (options.rules) {
    return {
      source: 'rules',
      rules: options.rules,
      outputRules: [],
    };
  }

  if (options.apiKey) {
    return {
      source: 'apiKey',
      rules: [],
      outputRules: [],
    };
  }

  return {
    source: 'allow-all',
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
    mode: options.mode,
    logLevel: options.logLevel,
    allowAllOnInitError: options.allowAllOnInitError,
    sessionId: options.sessionId,
    agentId: options.agentId,
    userId: options.userId,
    role: options.role,
    onApprovalRequiredId: getReferenceId(options.onApprovalRequired),
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
    mode: options.mode,
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

  if (options.logLevel !== 'silent') {
    console.warn(`[veto] ${message}: ${error.message}`);
  }
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
        mode: options.mode,
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
  } catch (error) {
    const initError = toInitError(error);
    reportInitError(options, initError, options.allowAllOnInitError === true);
    if (options.allowAllOnInitError !== true) {
      throw initError;
    }
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
