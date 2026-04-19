import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { canonicalize, sha256Prefixed } from "./hash.js";
import {
  type ChainVerifyResult,
  GENESIS_PREV_RECEIPT_HASH,
  type ReceiptPayload,
  RECEIPT_VERSION,
} from "./types.js";
import { ValidationError, validateReceiptPayload } from "./validate.js";

// Domain-separation tags prevent cross-context collisions. Without these, a
// 32-byte value that happens to equal a leaf hash could be reinterpreted as
// an internal node digest (or vice versa) and alter the root. See
// https://en.wikipedia.org/wiki/Merkle_tree#Second_preimage_attack.
const DOMAIN_LEAF = 0x00;
const DOMAIN_NODE = 0x01;
const DOMAIN_ANCHOR = 0x02;

export const MERKLE_BLOCK_SIZE = 1024;

// Genesis merkle root has its own domain context so no real receipt root can
// equal it structurally.
export const GENESIS_MERKLE_ROOT: string = (() => {
  const seed = new TextEncoder().encode("veto.merkle.genesis/1");
  const tagged = new Uint8Array(seed.length + 1);
  tagged[0] = DOMAIN_ANCHOR;
  tagged.set(seed, 1);
  return sha256Prefixed(tagged);
})();

export type ReceiptDraft = Omit<ReceiptPayload, "version" | "prev_receipt_hash" | "merkle_root">;

export function hashReceipt(receipt: ReceiptPayload): string {
  return sha256Prefixed(canonicalize(receipt));
}

function stripPrefix(h: string): Uint8Array {
  if (!h.startsWith("sha256:")) {
    throw new Error(`digest must be sha256:<hex>, got ${h.slice(0, 16)}...`);
  }
  const hex = h.slice(7);
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error(`digest must be exactly 64 lowercase hex chars; got length ${hex.length}`);
  }
  return hexToBytes(hex);
}

function taggedHash(domain: number, ...parts: Uint8Array[]): Uint8Array {
  const total = 1 + parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  buf[0] = domain;
  let off = 1;
  for (const p of parts) {
    buf.set(p, off);
    off += p.length;
  }
  return sha256(buf);
}

export function computeMerkleRoot(leaves: string[]): string {
  if (leaves.length === 0) return GENESIS_MERKLE_ROOT;
  // Leaves are already sha256(canonical(receipt)); re-hash each under the
  // leaf domain so internal nodes and leaves cannot collide.
  let level = leaves.map((l) => taggedHash(DOMAIN_LEAF, stripPrefix(l)));
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = i + 1 < level.length ? level[i + 1]! : left;
      next.push(taggedHash(DOMAIN_NODE, left, right));
    }
    level = next;
  }
  return `sha256:${bytesToHex(level[0]!)}`;
}

/**
 * Combine a previous rolling anchor with a newly-built block root into a new
 * rolling anchor. Bound under the anchor domain so the value cannot be
 * reinterpreted as a leaf or internal node.
 */
export function combineAnchors(prev: string, next: string): string {
  return `sha256:${bytesToHex(
    taggedHash(DOMAIN_ANCHOR, stripPrefix(prev), stripPrefix(next)),
  )}`;
}

export interface BuildReceiptInput {
  draft: ReceiptDraft;
  prev: ReceiptPayload | null;
  merkleRoot?: string;
}

export function buildReceipt(input: BuildReceiptInput): ReceiptPayload {
  const prevHash = input.prev ? hashReceipt(input.prev) : GENESIS_PREV_RECEIPT_HASH;
  const merkleRoot = input.merkleRoot ?? input.prev?.merkle_root ?? GENESIS_MERKLE_ROOT;
  const built: ReceiptPayload = {
    version: RECEIPT_VERSION,
    ...input.draft,
    prev_receipt_hash: prevHash,
    merkle_root: merkleRoot,
  };
  // Schema-validate on build so bad drafts fail loudly at the right layer.
  try {
    validateReceiptPayload(built);
  } catch (err) {
    if (err instanceof ValidationError) {
      throw new Error(`buildReceipt produced invalid receipt: ${err.message}`);
    }
    throw err;
  }
  return built;
}

export function verifyReceiptChain(receipts: ReceiptPayload[]): ChainVerifyResult {
  if (receipts.length === 0) return { ok: true };

  for (let i = 0; i < receipts.length; i++) {
    const r = receipts[i]!;
    if (r.version !== RECEIPT_VERSION) {
      return {
        ok: false,
        breakAt: i,
        reason: `receipt[${i}] has unsupported version ${r.version}`,
      };
    }
    const expectedPrev = i === 0 ? GENESIS_PREV_RECEIPT_HASH : hashReceipt(receipts[i - 1]!);
    if (r.prev_receipt_hash !== expectedPrev) {
      return {
        ok: false,
        breakAt: i,
        reason:
          i === 0
            ? `receipt[0] prev_receipt_hash must be the genesis hash`
            : `receipt[${i}] prev_receipt_hash does not match sha256 of receipt[${i - 1}]`,
      };
    }
  }
  return { ok: true };
}

export interface MerkleAnchor {
  entity_id: string;
  chain_index_start: number;
  chain_index_end: number;
  block_root: string;
  rolling_root: string;
  issued_at: string;
}

/**
 * Compute a rolling merkle anchor for a block of receipts. Binds
 * `entity_id`, the chain index range, and `issued_at` into the rolling root
 * so a forged `block_root` with the same bytes but a different label chain
 * cannot be spliced in.
 */
export function anchorBlock(
  entityId: string,
  startIndex: number,
  receipts: ReceiptPayload[],
  prevAnchor: MerkleAnchor | null,
  now: Date = new Date(),
): MerkleAnchor {
  if (receipts.length === 0) {
    throw new Error("anchorBlock requires at least one receipt");
  }
  if (!Number.isInteger(startIndex) || startIndex < 0) {
    throw new Error("anchorBlock startIndex must be a non-negative integer");
  }
  const blockRoot = computeMerkleRoot(receipts.map(hashReceipt));
  const issuedAt = now.toISOString();
  const endIndex = startIndex + receipts.length - 1;

  // Bind anchor identity into the rolling root. Without this, two chains with
  // identical block_roots but different entity_ids would produce identical
  // anchors.
  const boundInput = canonicalize({
    entity_id: entityId,
    chain_index_start: startIndex,
    chain_index_end: endIndex,
    block_root: blockRoot,
    issued_at: issuedAt,
  });
  const blockBound = sha256Prefixed(boundInput);

  const prevSeed = prevAnchor?.rolling_root ?? GENESIS_MERKLE_ROOT;
  const rollingRoot = combineAnchors(prevSeed, blockBound);

  return {
    entity_id: entityId,
    chain_index_start: startIndex,
    chain_index_end: endIndex,
    block_root: blockRoot,
    rolling_root: rollingRoot,
    issued_at: issuedAt,
  };
}
