import { describe, it, expect } from 'vitest';
import { computeChainHash, GENESIS_HASH } from '../../src/audit/chain.js';

describe('computeChainHash', () => {
	it('is deterministic — same input produces same hash', () => {
		const record = { decision: 'allow', tool_name: 'read_file', timestamp: '2024-01-01T00:00:00Z' };
		const h1 = computeChainHash(GENESIS_HASH, record);
		const h2 = computeChainHash(GENESIS_HASH, record);
		expect(h1).toBe(h2);
	});

	it('produces different hashes for different records', () => {
		const r1 = { decision: 'allow', tool_name: 'read_file' };
		const r2 = { decision: 'deny', tool_name: 'delete_file' };
		expect(computeChainHash(GENESIS_HASH, r1)).not.toBe(computeChainHash(GENESIS_HASH, r2));
	});

	it('produces different hashes for different prevHash values', () => {
		const record = { decision: 'allow', tool_name: 'read_file' };
		const h1 = computeChainHash('', record);
		const h2 = computeChainHash('deadbeef', record);
		expect(h1).not.toBe(h2);
	});

	it('key order does not affect the hash', () => {
		const r1 = { a: 1, b: 2 };
		const r2 = { b: 2, a: 1 };
		expect(computeChainHash(GENESIS_HASH, r1)).toBe(computeChainHash(GENESIS_HASH, r2));
	});

	it('chain integrity: record 1 hash chains correctly from genesis', () => {
		const record = { decision: 'allow', tool_name: 'read_file', timestamp: '2024-01-01T00:00:00Z' };
		const hash = computeChainHash(GENESIS_HASH, record);

		// Simulate verifier: recompute from genesis
		const recomputed = computeChainHash(GENESIS_HASH, record);
		expect(hash).toBe(recomputed);
	});

	it('tamper detection: modifying a field changes the hash', () => {
		const original = { decision: 'allow', tool_name: 'read_file', amount: 100 };
		const tampered = { decision: 'allow', tool_name: 'read_file', amount: 9999 };

		const h1 = computeChainHash(GENESIS_HASH, original);
		const h2 = computeChainHash(GENESIS_HASH, tampered);
		expect(h1).not.toBe(h2);
	});

	it('multi-record chain: each record links to the previous', () => {
		const records = [
			{ tool_name: 'read_file', decision: 'allow' },
			{ tool_name: 'write_file', decision: 'deny' },
			{ tool_name: 'delete_file', decision: 'allow' },
		];

		const hashes: string[] = [];
		let prev = GENESIS_HASH;
		for (const record of records) {
			const hash = computeChainHash(prev, record);
			hashes.push(hash);
			prev = hash;
		}

		// All hashes distinct
		expect(new Set(hashes).size).toBe(3);

		// Re-verify from scratch
		let verifyPrev = GENESIS_HASH;
		for (let i = 0; i < records.length; i++) {
			const expected = computeChainHash(verifyPrev, records[i]);
			expect(expected).toBe(hashes[i]);
			verifyPrev = hashes[i];
		}
	});

	it('produces a sha256 hex string of length 64', () => {
		const hash = computeChainHash(GENESIS_HASH, { x: 1 });
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
	});
});
