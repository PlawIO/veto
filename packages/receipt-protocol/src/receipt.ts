import { randomBytes } from "node:crypto";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { canonicalize, sha256Prefixed } from "./hash.js";
import {
  type ChainVerifyResult,
  type DecisionReceiptDraft,
  type DecisionReceiptPayload,
  GENESIS_PREVIOUS_RECEIPT_HASH,
  type ReceiptSummary,
  RECEIPT_VERSION,
} from "./types.js";
import { parseRfc3339Strict } from "./rfc3339.js";
import { ValidationError, validateDecisionReceiptPayload } from "./validate.js";

const DOMAIN_LEAF = 0x00;
const DOMAIN_NODE = 0x01;
const DOMAIN_ANCHOR = 0x02;
const DOMAIN_ROOT = 0x03;

export const MERKLE_BLOCK_SIZE = 1024;

export const GENESIS_MERKLE_ROOT: string = (() => {
  const seed = new TextEncoder().encode("veto.merkle.genesis/1");
  const tagged = new Uint8Array(seed.length + 1);
  tagged[0] = DOMAIN_ANCHOR;
  tagged.set(seed, 1);
  return sha256Prefixed(tagged);
})();

export interface BuildDecisionReceiptInput {
  draft: DecisionReceiptDraft;
  previous: DecisionReceiptPayload | null;
  merkleRoot?: string;
}

export interface ChainVerifyOptions {
  timestampSkewSeconds?: number;
}

export function createReceiptId(): string {
  return `rcp_${randomBytes(12).toString("hex")}`;
}

export function hashDecisionReceipt(receipt: DecisionReceiptPayload): string {
  return sha256Prefixed(canonicalize(receipt));
}

export function summarizeReceipt(receipt: DecisionReceiptPayload): ReceiptSummary {
  return {
    receipt_id: receipt.receipt_id,
    receipt_hash: hashDecisionReceipt(receipt),
    previous_receipt_hash: receipt.previous_receipt_hash,
    merkle_root: receipt.merkle_root,
  };
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
  for (const part of parts) {
    buf.set(part, off);
    off += part.length;
  }
  return sha256(buf);
}

function u64Bytes(n: number): Uint8Array {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error(`u64Bytes requires a non-negative safe integer; got ${n}`);
  }
  const out = new Uint8Array(8);
  for (let i = 7; i >= 0; i--) {
    out[i] = n & 0xff;
    n = Math.floor(n / 256);
  }
  return out;
}

export function computeMerkleRoot(leaves: string[]): string {
  if (leaves.length === 0) return GENESIS_MERKLE_ROOT;
  let level = leaves.map((leaf) => taggedHash(DOMAIN_LEAF, stripPrefix(leaf)));
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = i + 1 < level.length ? level[i + 1]! : left;
      next.push(taggedHash(DOMAIN_NODE, left, right));
    }
    level = next;
  }
  return `sha256:${bytesToHex(taggedHash(DOMAIN_ROOT, u64Bytes(leaves.length), level[0]!))}`;
}

export function buildDecisionReceipt(input: BuildDecisionReceiptInput): DecisionReceiptPayload {
  const previousReceiptHash = input.previous
    ? hashDecisionReceipt(input.previous)
    : GENESIS_PREVIOUS_RECEIPT_HASH;
  const receipt: DecisionReceiptPayload = {
    version: RECEIPT_VERSION,
    ...input.draft,
    previous_receipt_hash: previousReceiptHash,
    merkle_root: input.merkleRoot ?? input.previous?.merkle_root ?? GENESIS_MERKLE_ROOT,
  };
  try {
    validateDecisionReceiptPayload(receipt);
  } catch (err) {
    if (err instanceof ValidationError) {
      throw new Error(`buildDecisionReceipt produced invalid receipt: ${err.message}`);
    }
    throw err;
  }
  return receipt;
}

export function verifyDecisionReceiptChain(
  receipts: DecisionReceiptPayload[],
  options: ChainVerifyOptions = {},
): ChainVerifyResult {
  if (receipts.length === 0) return { ok: true };
  const skewMs = (options.timestampSkewSeconds ?? 5) * 1000;
  let prevIssuedMs = -Infinity;
  let prevRoot: string | null = null;

  for (let i = 0; i < receipts.length; i++) {
    const receipt = receipts[i]!;
    try {
      validateDecisionReceiptPayload(receipt);
    } catch (err) {
      const msg = err instanceof ValidationError ? err.message : String(err);
      return { ok: false, breakAt: i, reason: `receipt[${i}] invalid: ${msg}` };
    }
    if (receipt.version !== RECEIPT_VERSION) {
      return {
        ok: false,
        breakAt: i,
        reason: `receipt[${i}] has unsupported version ${receipt.version}`,
      };
    }

    const expectedPrevious =
      i === 0 ? GENESIS_PREVIOUS_RECEIPT_HASH : hashDecisionReceipt(receipts[i - 1]!);
    if (receipt.previous_receipt_hash !== expectedPrevious) {
      return {
        ok: false,
        breakAt: i,
        reason:
          i === 0
            ? "receipt[0] previous_receipt_hash must be the genesis hash"
            : `receipt[${i}] previous_receipt_hash does not match sha256 of receipt[${i - 1}]`,
      };
    }

    const issuedMs = parseRfc3339Strict(receipt.timestamp).epochMs;
    if (issuedMs + skewMs < prevIssuedMs) {
      return {
        ok: false,
        breakAt: i,
        reason: `receipt[${i}] timestamp ${receipt.timestamp} precedes receipt[${i - 1}].timestamp beyond tolerated skew`,
      };
    }
    prevIssuedMs = Math.max(prevIssuedMs, issuedMs);

    if (prevRoot !== null && receipt.merkle_root !== prevRoot) {
      const atBoundary = i % MERKLE_BLOCK_SIZE === 0;
      if (!atBoundary) {
        return {
          ok: false,
          breakAt: i,
          reason: `receipt[${i}] merkle_root changed mid-block (position ${i % MERKLE_BLOCK_SIZE})`,
        };
      }
    }
    prevRoot = receipt.merkle_root;
  }
  return { ok: true };
}

export function formatReceiptNdjson(receipts: DecisionReceiptPayload[]): string {
  return receipts.map((receipt) => canonicalize(receipt)).join("\n") + (receipts.length > 0 ? "\n" : "");
}

export function parseReceiptNdjson(input: string): DecisionReceiptPayload[] {
  const receipts: DecisionReceiptPayload[] = [];
  const lines = input.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      throw new Error(`line ${i + 1}: invalid JSON: ${(err as Error).message}`);
    }
    receipts.push(validateDecisionReceiptPayload(parsed));
  }
  return receipts;
}
