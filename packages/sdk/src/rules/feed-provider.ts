/**
 * Feed provider utilities for the local evaluator.
 *
 * The evaluator itself is sync and accepts any object implementing the
 * FeedProvider interface declared in `./types.ts`. This module ships an
 * in-memory reference provider suitable for tests, the CLI, and SDK
 * consumers who manage refreshes externally.
 *
 * @module rules/feed-provider
 */

import type {
  FeedConditionValue,
  FeedProvider,
  FeedSnapshot,
  PipelineConditionValue,
} from './types.js';

/**
 * Trivial in-memory provider. Caller `put()`s snapshots; evaluator `get()`s them.
 *
 * Not thread-safe. Not persistent. Intended for tests and single-process
 * SDK usage. Platform code should provide its own Redis/KV-backed
 * implementation.
 */
export class InMemoryFeedProvider implements FeedProvider {
  private readonly store = new Map<string, FeedSnapshot>();

  put(feedId: string, snapshot: FeedSnapshot): void {
    this.store.set(feedId, snapshot);
  }

  get(feedId: string, _version?: string): FeedSnapshot | undefined {
    return this.store.get(feedId);
  }

  clear(): void {
    this.store.clear();
  }

  size(): number {
    return this.store.size;
  }
}

/**
 * Resolve a FeedRef / PipelineRef to an array comparand suitable for
 * set-membership operators.
 *
 * Returns `{ resolved: unknown[] }` on hit, `{ fallback: "fail_open" | "fail_closed" }`
 * on miss/stale. Caller decides enforcement semantics per the ref's
 * `fallback` field.
 */
export function resolveFeedRef(
  ref: FeedConditionValue | PipelineConditionValue,
  provider: FeedProvider | undefined,
  now_ms: number = Date.now(),
): { resolved: unknown[] } | { fallback: 'fail_open' | 'fail_closed' } {
  const fallbackRoute = (): { fallback: 'fail_open' | 'fail_closed' } => ({
    fallback: ref.fallback === 'fail_closed' ? 'fail_closed' : 'fail_open',
  });

  if (provider === undefined) return fallbackRoute();

  const id = ref.kind === 'feed' ? ref.feed_id : ref.pipeline_id;
  const snapshot = provider.get(id, ref.version);

  if (snapshot === undefined) return fallbackRoute();

  // Defensive: a non-finite clock (NaN/Infinity) would make the staleness
  // check meaningless and could let a stale snapshot through silently.
  if (!Number.isFinite(now_ms) || !Number.isFinite(snapshot.refreshed_at_ms)) {
    return ref.fallback === 'last_known_good'
      ? { resolved: snapshot.data }
      : fallbackRoute();
  }

  const age_sec = Math.max(0, Math.floor((now_ms - snapshot.refreshed_at_ms) / 1000));
  const stale = age_sec > ref.max_staleness_sec;

  // last_known_good explicitly opts into stale snapshots.
  if (stale && ref.fallback !== 'last_known_good') return fallbackRoute();

  return { resolved: snapshot.data };
}
