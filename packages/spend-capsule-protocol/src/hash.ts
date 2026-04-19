import canonicalizeModule from "canonicalize";
import { sha256 } from "@noble/hashes/sha2";
import { keccak_256 } from "@noble/hashes/sha3";
import { base58 } from "@scure/base";
import { bytesToHex } from "@noble/hashes/utils";
import type { Beneficiary } from "./types.js";

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

// Strip zero-width joiners / BOMs etc. that are invisible to humans but
// change hash input. Applied on top of NFC normalization for belt-and-
// suspenders uniqueness of beneficiary names.
function normalizeName(raw: string): string {
  return raw
    .normalize("NFC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeBankUs(name: string, routing: string, accountLast4: string): {
  type: "bank_us";
  name: string;
  routing: string;
  account_last4: string;
} {
  return {
    type: "bank_us",
    name: normalizeName(name),
    routing: routing.replace(/\D/g, ""),
    account_last4: accountLast4.slice(-4),
  };
}

function normalizeBankIntl(input: {
  name: string;
  iban?: string;
  swift_bic?: string;
  country_iso?: string;
}): {
  type: "bank_intl";
  name: string;
  iban?: string;
  swift_bic?: string;
  country_iso?: string;
} {
  const result: {
    type: "bank_intl";
    name: string;
    iban?: string;
    swift_bic?: string;
    country_iso?: string;
  } = {
    type: "bank_intl",
    name: normalizeName(input.name),
  };
  if (input.iban) result.iban = input.iban.replace(/\s+/g, "").toUpperCase();
  if (input.swift_bic) result.swift_bic = input.swift_bic.replace(/\s+/g, "").toUpperCase();
  if (input.country_iso) result.country_iso = input.country_iso.toUpperCase();
  return result;
}

function toEip55(address: string): string {
  const lower = address.toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{40}$/.test(lower)) {
    throw new Error(`invalid EVM address: ${address}`);
  }
  const hashHex = bytesToHex(keccak_256(lower));
  let out = "";
  for (let i = 0; i < lower.length; i++) {
    const c = lower[i]!;
    if (/[0-9]/.test(c)) {
      out += c;
      continue;
    }
    out += parseInt(hashHex[i]!, 16) >= 8 ? c.toUpperCase() : c;
  }
  return `0x${out}`;
}

// Solana addresses are base58-encoded 32-byte Ed25519 public keys (or derived
// program addresses). Proper validation decodes and checks byte length —
// regex-only validation lets random 32-44 char base58 strings through.
function normalizeSolanaAddress(address: string): string {
  let decoded: Uint8Array;
  try {
    decoded = base58.decode(address);
  } catch (err) {
    throw new Error(`invalid Solana (base58) address: ${address}: ${(err as Error).message}`);
  }
  if (decoded.length !== 32) {
    throw new Error(
      `invalid Solana address: decoded to ${decoded.length} bytes, expected 32`,
    );
  }
  return address;
}

const EVM_CHAINS = new Set(["eth", "ethereum", "base", "arbitrum", "arb", "optimism", "polygon"]);

function normalizeCrypto(chain: string, address: string): {
  type: "crypto";
  chain: string;
  address: string;
} {
  const normalizedChain = chain.toLowerCase();
  let normalizedAddress: string;
  if (EVM_CHAINS.has(normalizedChain)) {
    normalizedAddress = toEip55(address);
  } else if (normalizedChain === "solana" || normalizedChain === "sol") {
    normalizedAddress = normalizeSolanaAddress(address);
  } else {
    normalizedAddress = address;
  }
  return {
    type: "crypto",
    chain: normalizedChain,
    address: normalizedAddress,
  };
}

export function normalizeBeneficiary(b: Beneficiary): object {
  switch (b.type) {
    case "bank_us":
      return normalizeBankUs(b.name, b.routing, b.account_last4);
    case "bank_intl":
      return normalizeBankIntl(b);
    case "crypto":
      return normalizeCrypto(b.chain, b.address);
  }
}

export function hashBeneficiary(b: Beneficiary): string {
  return hashCanonical(normalizeBeneficiary(b));
}
