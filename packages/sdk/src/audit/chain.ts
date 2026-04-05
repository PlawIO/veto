/**
 * Cryptographic audit chain for append-only tamper detection.
 *
 * Each record's hash is computed over the previous hash + the record's
 * deterministic JSON serialization, forming a hash chain. Any mutation
 * to a historical record invalidates all subsequent hashes.
 *
 * @module audit/chain
 */

import { createHash } from 'node:crypto';

/**
 * Deterministic JSON serialization with sorted object keys.
 * Required for stable hashes across V8 versions and key insertion orders.
 */
function sortedStringify(obj: unknown, seen = new WeakSet<object>()): string {
	if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
	if (seen.has(obj)) return '"[Circular]"';
	seen.add(obj);
	if (Array.isArray(obj)) return '[' + obj.map((v) => sortedStringify(v, seen)).join(',') + ']';
	const keys = Object.keys(obj as Record<string, unknown>).sort();
	return '{' + keys.map((k) =>
		JSON.stringify(k) + ':' + sortedStringify((obj as Record<string, unknown>)[k], seen),
	).join(',') + '}';
}

export function computeChainHash(prevHash: string, record: unknown): string {
	const payload = prevHash + sortedStringify(record);
	return createHash('sha256').update(payload).digest('hex');
}

/** Genesis hash — used as prevHash for the very first record */
export const GENESIS_HASH = '';
