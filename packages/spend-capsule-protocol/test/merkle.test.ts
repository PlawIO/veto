import { describe, expect, it } from "vitest";
import {
  GENESIS_MERKLE_ROOT,
  GENESIS_PREV_RECEIPT_HASH,
  type ReceiptPayload,
  anchorBlock,
  buildReceipt,
  combineAnchors,
  computeMerkleRoot,
  hashReceipt,
  verifyReceiptChain,
} from "../src/index.js";

function draft(n: number, overrides: Partial<ReceiptPayload> = {}): Omit<
  ReceiptPayload,
  "version" | "prev_receipt_hash" | "merkle_root"
> {
  return {
    receipt_id: `rcp_01hy2z3${String(n).padStart(17, "0")}`,
    entity_id: "ent_abc",
    agent_id: "claude-code-ci-bot",
    tool: "meow.pay",
    decision: "allow",
    reason_code: "ok",
    args_hash: `sha256:${String(n).padStart(64, "a")}`,
    result_hash: `sha256:${String(n).padStart(64, "b")}`,
    policy_hash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    policy_pack_id: "ap_strict_v1",
    issued_at: `2026-04-17T14:0${n % 10}:00Z`,
    ...overrides,
  };
}

describe("buildReceipt + chain continuity", () => {
  it("genesis receipt has prev_receipt_hash = sha256(empty) per spec A5", () => {
    const r = buildReceipt({ draft: draft(0), prev: null });
    expect(r.prev_receipt_hash).toBe(GENESIS_PREV_RECEIPT_HASH);
    expect(r.merkle_root).toBe(GENESIS_MERKLE_ROOT);
    expect(r.version).toBe("veto.receipt/1");
  });

  it("next receipt's prev_receipt_hash = sha256(canonical(prev))", () => {
    const r0 = buildReceipt({ draft: draft(0), prev: null });
    const r1 = buildReceipt({ draft: draft(1), prev: r0 });
    expect(r1.prev_receipt_hash).toBe(hashReceipt(r0));
  });

  it("carries merkle_root forward if not overridden", () => {
    const r0 = buildReceipt({ draft: draft(0), prev: null, merkleRoot: "sha256:" + "c".repeat(64) });
    const r1 = buildReceipt({ draft: draft(1), prev: r0 });
    expect(r1.merkle_root).toBe(r0.merkle_root);
  });
});

describe("verifyReceiptChain", () => {
  it("returns ok=true for an intact chain", () => {
    const r0 = buildReceipt({ draft: draft(0), prev: null });
    const r1 = buildReceipt({ draft: draft(1), prev: r0 });
    const r2 = buildReceipt({ draft: draft(2), prev: r1 });
    expect(verifyReceiptChain([r0, r1, r2])).toEqual({ ok: true });
  });

  it("returns ok=true for an empty chain", () => {
    expect(verifyReceiptChain([])).toEqual({ ok: true });
  });

  it("detects tamper at the correct index", () => {
    const r0 = buildReceipt({ draft: draft(0), prev: null });
    const r1 = buildReceipt({ draft: draft(1), prev: r0 });
    const r2 = buildReceipt({ draft: draft(2), prev: r1 });
    // Tamper r1 in-place → r2's prev_receipt_hash no longer matches sha256(r1)
    const tampered: ReceiptPayload = { ...r1, reason_code: "maliciously_changed" };
    const result = verifyReceiptChain([r0, tampered, r2]);
    expect(result.ok).toBe(false);
    expect(result.breakAt).toBe(2);
  });

  it("detects a bad genesis prev_receipt_hash at index 0", () => {
    const r0 = buildReceipt({ draft: draft(0), prev: null });
    const bad: ReceiptPayload = {
      ...r0,
      prev_receipt_hash: "sha256:" + "f".repeat(64),
    };
    const result = verifyReceiptChain([bad]);
    expect(result.ok).toBe(false);
    expect(result.breakAt).toBe(0);
  });

  it("detects a chain break where a receipt was removed", () => {
    const r0 = buildReceipt({ draft: draft(0), prev: null });
    const r1 = buildReceipt({ draft: draft(1), prev: r0 });
    const r2 = buildReceipt({ draft: draft(2), prev: r1 });
    // Drop r1 → r2 now follows r0 but carries the old prev hash
    const result = verifyReceiptChain([r0, r2]);
    expect(result.ok).toBe(false);
    expect(result.breakAt).toBe(1);
  });
});

describe("computeMerkleRoot + combineAnchors", () => {
  it("is deterministic for a fixed leaf set", () => {
    const leaves = [
      "sha256:" + "1".repeat(64),
      "sha256:" + "2".repeat(64),
      "sha256:" + "3".repeat(64),
      "sha256:" + "4".repeat(64),
    ];
    const a = computeMerkleRoot(leaves);
    const b = computeMerkleRoot(leaves);
    expect(a).toBe(b);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("handles odd leaf counts by duplicating the last leaf", () => {
    const odd = [
      "sha256:" + "1".repeat(64),
      "sha256:" + "2".repeat(64),
      "sha256:" + "3".repeat(64),
    ];
    // Should not throw; should produce a stable root.
    expect(computeMerkleRoot(odd)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("empty leaf set returns genesis root", () => {
    expect(computeMerkleRoot([])).toBe(GENESIS_MERKLE_ROOT);
  });

  it("combineAnchors is associative order-dependent (chain, not tree)", () => {
    const a = combineAnchors("sha256:" + "a".repeat(64), "sha256:" + "b".repeat(64));
    const b = combineAnchors("sha256:" + "b".repeat(64), "sha256:" + "a".repeat(64));
    expect(a).not.toBe(b);
  });
});

describe("anchorBlock (rolling O(log N) merkle)", () => {
  it("builds anchors that chain via combineAnchors", () => {
    const block1 = [0, 1, 2, 3].map((n) =>
      buildReceipt({ draft: draft(n), prev: null }),
    );
    const a1 = anchorBlock("ent_abc", 0, block1, null, new Date("2026-04-17T14:10:00Z"));
    expect(a1.chain_index_start).toBe(0);
    expect(a1.chain_index_end).toBe(3);
    expect(a1.rolling_root).toBe(a1.block_root);

    const block2 = [4, 5, 6, 7].map((n) =>
      buildReceipt({ draft: draft(n), prev: null }),
    );
    const a2 = anchorBlock("ent_abc", 4, block2, a1, new Date("2026-04-17T14:11:00Z"));
    expect(a2.rolling_root).toBe(combineAnchors(a1.rolling_root, a2.block_root));
  });
});
