/**
 * In-process sliding window rate limit store.
 *
 * Stores call timestamps per key. Checks are synchronous — safe in Node.js
 * single-threaded event loop (no race conditions on Map reads/writes).
 *
 * Limitations: process-local only. Resets on restart. For multi-process
 * deployments, use cloud mode with stateful counters.
 */
const store = new Map<string, number[]>();

let sweepInterval: ReturnType<typeof setInterval> | null = null;
let maxWindowMs = 0;

/**
 * Check if a call is allowed, and record it if so.
 * Returns true if allowed, false if rate limited.
 */
export function checkAndRecord(key: string, maxCalls: number, windowMs: number): boolean {
  const now = Date.now();
  const prev = store.get(key) ?? [];
  const valid = prev.filter(t => now - t < windowMs);
  if (valid.length >= maxCalls) return false;
  valid.push(now);
  store.set(key, valid);

  // Track the largest window for sweep purposes
  if (windowMs > maxWindowMs) maxWindowMs = windowMs;
  ensureSweep();
  return true;
}

/** Remove keys whose newest timestamp is older than the largest configured window. */
function sweep(): void {
  if (store.size === 0) return;
  const now = Date.now();
  const cutoff = maxWindowMs || 60_000;
  for (const [key, timestamps] of store) {
    if (timestamps.length === 0 || now - timestamps[timestamps.length - 1] >= cutoff) {
      store.delete(key);
    }
  }
}

function ensureSweep(): void {
  if (sweepInterval !== null) return;
  sweepInterval = setInterval(sweep, 60_000);
  if (typeof sweepInterval === 'object' && sweepInterval !== null && 'unref' in sweepInterval) {
    (sweepInterval as NodeJS.Timeout).unref();
  }
}

/** Clear all rate limit state (used in tests) */
export function clearStore(): void {
  store.clear();
  if (sweepInterval !== null) {
    clearInterval(sweepInterval);
    sweepInterval = null;
  }
  maxWindowMs = 0;
}
