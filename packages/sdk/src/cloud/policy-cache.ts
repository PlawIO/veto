import type { VetoCloudClient } from './client.js';
import type { DeterministicPolicy } from '../deterministic/types.js';

interface CacheEntry {
  policy: DeterministicPolicy;
  staleAt: number;
  expiredAt: number;
}

export class PolicyCache {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly refreshing = new Map<string, number>();
  private readonly invalidationVersion = new Map<string, number>();
  private nextRefreshToken = 0;
  private globalInvalidationVersion = 0;

  constructor(
    private readonly client: VetoCloudClient,
    private readonly freshMs = 60_000,
    private readonly maxMs = 300_000
  ) {}

  get(toolName: string): DeterministicPolicy | null {
    const entry = this.cache.get(toolName);
    const now = Date.now();

    if (!entry) {
      this.backgroundRefresh(toolName);
      return null;
    }

    if (now < entry.staleAt) {
      return entry.policy;
    }

    if (now < entry.expiredAt) {
      this.backgroundRefresh(toolName);
      return entry.policy;
    }

    this.backgroundRefresh(toolName);
    return null;
  }

  invalidate(toolName: string): void {
    this.cache.delete(toolName);
    this.refreshing.delete(toolName);
    this.invalidationVersion.set(toolName, this.getToolInvalidationVersion(toolName) + 1);
  }

  invalidateAll(): void {
    this.cache.clear();
    this.refreshing.clear();
    this.invalidationVersion.clear();
    this.globalInvalidationVersion += 1;
  }

  private backgroundRefresh(toolName: string): void {
    if (this.refreshing.has(toolName)) return;

    const refreshToken = this.nextRefreshToken++;
    const toolInvalidationVersion = this.getToolInvalidationVersion(toolName);
    const globalInvalidationVersion = this.globalInvalidationVersion;

    this.refreshing.set(toolName, refreshToken);
    // Defer to macrotask to avoid interfering with the current validation's fetch
    setTimeout(() => {
      this.client.fetchPolicy(toolName)
        .then((response) => {
          if (!response) return;
          if (!this.canApplyRefreshResult(
            toolName,
            refreshToken,
            toolInvalidationVersion,
            globalInvalidationVersion,
          )) {
            return;
          }

          const now = Date.now();
          const policy: DeterministicPolicy = {
            toolName: response.toolName,
            mode: response.mode,
            constraints: response.constraints ?? [],
            hasSessionConstraints: response.sessionConstraints != null,
            hasRateLimits: response.rateLimits != null,
            version: response.version,
            fetchedAt: now,
          };

          this.cache.set(toolName, {
            policy,
            staleAt: now + this.freshMs,
            expiredAt: now + this.maxMs,
          });
        })
        .catch(() => {
          // Background refresh failed — will retry on next cache access
        })
        .finally(() => {
          if (this.refreshing.get(toolName) === refreshToken) {
            this.refreshing.delete(toolName);
          }
        });
    }, 0);
  }

  private getToolInvalidationVersion(toolName: string): number {
    return this.invalidationVersion.get(toolName) ?? 0;
  }

  private canApplyRefreshResult(
    toolName: string,
    refreshToken: number,
    toolInvalidationVersion: number,
    globalInvalidationVersion: number
  ): boolean {
    return this.refreshing.get(toolName) === refreshToken
      && this.getToolInvalidationVersion(toolName) === toolInvalidationVersion
      && this.globalInvalidationVersion === globalInvalidationVersion;
  }
}
