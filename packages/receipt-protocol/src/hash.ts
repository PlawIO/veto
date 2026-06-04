import canonicalizeModule from "canonicalize";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";

const canonicalizeLib = canonicalizeModule as unknown as (
  value: unknown,
) => string | undefined;

export function canonicalize(value: unknown): string {
  const result = canonicalizeLib(value);
  if (result === undefined) {
    throw new Error("canonicalize returned undefined; value contains no canonical form");
  }
  return result;
}

export function sha256Hex(input: string | Uint8Array): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  return bytesToHex(sha256(bytes));
}

export function sha256Prefixed(input: string | Uint8Array): string {
  return `sha256:${sha256Hex(input)}`;
}

export function hashCanonical(value: unknown): string {
  return sha256Prefixed(canonicalize(value));
}
