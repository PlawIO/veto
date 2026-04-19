import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { canonicalize, sha256Prefixed } from "./hash.js";
import {
  type ChainVerifyResult,
  GENESIS_PREV_RECEIPT_HASH,
  type ReceiptPayload,
  RECEIPT_VERSION,
} from "./types.js";

export const GENESIS_MERKLE_ROOT: string = sha256Prefixed("veto.merkle.genesis/1");

export const MERKLE_BLOCK_SIZE = 1024;

export type ReceiptDraft = Omit<ReceiptPayload, "version" | "prev_receipt_hash" | "merkle_root">;

export function hashReceipt(receipt: ReceiptPayload): string {
  return sha256Prefixed(canonicalize(receipt));
}

function stripPrefix(h: string): Uint8Array {
  const hex = h.startsWith("sha256:") ? h.slice(7) : h;
  return hexToBytes(hex);
}

function concatSha256(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return sha256(out);
}

export function computeMerkleRoot(leaves: string[]): string {
  if (leaves.length === 0) return GENESIS_MERKLE_ROOT;
  let level = leaves.map(stripPrefix);
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = i + 1 < level.length ? level[i + 1]! : left;
      next.push(concatSha256(left, right));
    }
    level = next;
  }
  return `sha256:${bytesToHex(level[0]!)}`;
}

export function combineAnchors(prev: string, next: string): string {
  return `sha256:${bytesToHex(concatSha256(stripPrefix(prev), stripPrefix(next)))}`;
}

export interface BuildReceiptInput {
  draft: ReceiptDraft;
  prev: ReceiptPayload | null;
  merkleRoot?: string;
}

export function buildReceipt(input: BuildReceiptInput): ReceiptPayload {
  const prevHash = input.prev ? hashReceipt(input.prev) : GENESIS_PREV_RECEIPT_HASH;
  const merkleRoot = input.merkleRoot ?? input.prev?.merkle_root ?? GENESIS_MERKLE_ROOT;
  return {
    version: RECEIPT_VERSION,
    ...input.draft,
    prev_receipt_hash: prevHash,
    merkle_root: merkleRoot,
  };
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

export function anchorBlock(
  entityId: string,
  startIndex: number,
  receipts: ReceiptPayload[],
  prevAnchor: MerkleAnchor | null,
  now: Date = new Date(),
): MerkleAnchor {
  const blockRoot = computeMerkleRoot(receipts.map(hashReceipt));
  const rollingRoot = prevAnchor
    ? combineAnchors(prevAnchor.rolling_root, blockRoot)
    : blockRoot;
  return {
    entity_id: entityId,
    chain_index_start: startIndex,
    chain_index_end: startIndex + receipts.length - 1,
    block_root: blockRoot,
    rolling_root: rollingRoot,
    issued_at: now.toISOString(),
  };
}
