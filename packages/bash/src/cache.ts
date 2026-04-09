import { createHash, scryptSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CacheKeyInput, CachedDecision, DecisionCacheLike } from './types.js';

interface CacheEntry {
  expiresAt: number;
  value: CachedDecision;
}

interface CacheStore {
  entries: Record<string, CacheEntry>;
}

const API_KEY_NAMESPACE_SALT = 'veto-bash-cache-namespace:v1';
const apiKeyNamespaceCache = new Map<string, string>();

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`);

  return `{${entries.join(',')}}`;
}

function normalizeStore(raw: unknown): CacheStore {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { entries: {} };
  }

  const entries = (raw as { entries?: unknown }).entries;
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
    return { entries: {} };
  }

  const normalized: Record<string, CacheEntry> = {};

  for (const [key, value] of Object.entries(entries)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      continue;
    }

    const expiresAt = (value as { expiresAt?: unknown }).expiresAt;
    const cachedValue = (value as { value?: unknown }).value;

    if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
      continue;
    }

    if (!cachedValue || typeof cachedValue !== 'object' || Array.isArray(cachedValue)) {
      continue;
    }

    const decision = (cachedValue as { decision?: unknown }).decision;
    if (decision !== 'allow' && decision !== 'deny') {
      continue;
    }

    normalized[key] = {
      expiresAt,
      value: cachedValue as CachedDecision,
    };
  }

  return { entries: normalized };
}

export function defaultCachePath(): string {
  return join(homedir(), '.veto', 'cache', 'veto-bash-decisions.json');
}

export function hashCacheInput(input: CacheKeyInput): string {
  return createHash('sha256').update(stableStringify(input)).digest('hex');
}

export function deriveApiKeyNamespace(apiKey: string | undefined): string | undefined {
  if (!apiKey) {
    return undefined;
  }

  const cached = apiKeyNamespaceCache.get(apiKey);
  if (cached) {
    return cached;
  }

  const derived = scryptSync(apiKey, API_KEY_NAMESPACE_SALT, 32).toString('hex');
  apiKeyNamespaceCache.set(apiKey, derived);
  return derived;
}

export class PersistentDecisionCache implements DecisionCacheLike {
  constructor(
    private readonly filePath: string = defaultCachePath(),
    private readonly now: () => number = () => Date.now()
  ) {}

  get(key: CacheKeyInput): CachedDecision | null {
    const store = this.readStore();
    const changed = this.pruneExpired(store);
    const entry = store.entries[hashCacheInput(key)];

    if (changed) {
      this.writeStore(store);
    }

    return entry?.value ?? null;
  }

  set(key: CacheKeyInput, value: CachedDecision, ttlSeconds: number): void {
    if (ttlSeconds <= 0) {
      return;
    }

    const store = this.readStore();
    this.pruneExpired(store);
    store.entries[hashCacheInput(key)] = {
      expiresAt: this.now() + ttlSeconds * 1000,
      value,
    };
    this.writeStore(store);
  }

  private readStore(): CacheStore {
    if (!existsSync(this.filePath)) {
      return { entries: {} };
    }

    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf-8')) as unknown;
      return normalizeStore(parsed);
    } catch {
      return { entries: {} };
    }
  }

  private writeStore(store: CacheStore): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(store, null, 2), 'utf-8');
  }

  private pruneExpired(store: CacheStore): boolean {
    const currentTime = this.now();
    let changed = false;

    for (const [key, entry] of Object.entries(store.entries)) {
      if (entry.expiresAt <= currentTime) {
        delete store.entries[key];
        changed = true;
      }
    }

    return changed;
  }
}
