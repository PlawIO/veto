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

// Default-ignorable code points that are invisible to humans but change hash
// input. This set covers:
//   - ZWSP/ZWNJ/ZWJ/ZWNBSP          (U+200B–U+200D, U+FEFF)
//   - BOM variants and interlinear annotation marks
//   - Bidirectional formatting and isolate controls
//     (U+061C, U+200E, U+200F, U+202A–U+202E, U+2066–U+2069)
//   - Mongolian vowel separator      (U+180E)
//   - Variation selectors            (U+FE00–U+FE0F, U+E0100–U+E01EF)
//   - Tag characters                 (U+E0000–U+E007F)
//   - Soft hyphen                    (U+00AD)
// Without bidi-control stripping, "ACME\u202EinvoiceCORP\u202C" and
// "ACMEinvoiceCORP" hash differently even though they render identically.
// Intentional: we WANT to strip combining/formatting code points as a set.
// eslint-disable-next-line no-misleading-character-class
const DEFAULT_IGNORABLE_RE = /[\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF\uFE00-\uFE0F]|[\u{E0000}-\u{E007F}]|[\u{E0100}-\u{E01EF}]/gu;

function normalizeName(raw: string): string {
  return raw
    .normalize("NFC")
    .replace(DEFAULT_IGNORABLE_RE, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

// ABA routing number checksum (weighted 3/7/1 mod 10 = 0). Rejects typos that
// pass the digit-count check.
function isValidAbaRouting(routing: string): boolean {
  if (!/^[0-9]{9}$/.test(routing)) return false;
  const w = [3, 7, 1, 3, 7, 1, 3, 7, 1];
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += parseInt(routing[i]!, 10) * w[i]!;
  return sum % 10 === 0;
}

function normalizeBankUs(name: string, routing: string, accountLast4: string): {
  type: "bank_us";
  name: string;
  routing: string;
  account_last4: string;
} {
  // Cleanup: remove whitespace and hyphens/dots only. Deliberately do NOT
  // strip arbitrary non-digits — an input like "routing: 12345" should fail
  // loudly rather than collapse into "12345" (which then fails the 9-digit
  // check anyway, but now with a clear error).
  const cleanedRouting = routing.replace(/[\s.-]/g, "");
  if (!/^[0-9]{9}$/.test(cleanedRouting)) {
    throw new Error(
      `invalid US routing number: must be exactly 9 digits after trimming whitespace/dashes; got "${routing}"`,
    );
  }
  if (!isValidAbaRouting(cleanedRouting)) {
    throw new Error(
      `invalid US routing number: ABA checksum failed for "${cleanedRouting}"`,
    );
  }
  const cleanedLast4 = accountLast4.replace(/[\s-]/g, "");
  if (!/^[0-9]{4}$/.test(cleanedLast4)) {
    throw new Error(
      `invalid account_last4: must be exactly 4 digits; got "${accountLast4}"`,
    );
  }
  return {
    type: "bank_us",
    name: normalizeName(name),
    routing: cleanedRouting,
    account_last4: cleanedLast4,
  };
}

// IBAN mod-97 check (ISO 13616). Country-specific length is enforced by the
// country length table; we validate the universally-applicable checksum here.
function isValidIbanChecksum(iban: string): boolean {
  if (!/^[A-Z0-9]{5,34}$/.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0);
    const digit = code >= 65 ? code - 55 : code - 48;
    if (digit < 0 || digit > 35) return false;
    remainder = (remainder * (digit > 9 ? 100 : 10) + digit) % 97;
  }
  return remainder === 1;
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
  if (input.iban) {
    const cleaned = input.iban.replace(/\s+/g, "").toUpperCase();
    if (!isValidIbanChecksum(cleaned)) {
      throw new Error(`invalid IBAN: checksum failed for "${input.iban}"`);
    }
    result.iban = cleaned;
  }
  if (input.swift_bic) {
    const cleaned = input.swift_bic.replace(/\s+/g, "").toUpperCase();
    if (!/^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(cleaned)) {
      throw new Error(`invalid SWIFT/BIC: "${input.swift_bic}"`);
    }
    result.swift_bic = cleaned;
  }
  if (input.country_iso) {
    const cleaned = input.country_iso.toUpperCase();
    if (!/^[A-Z]{2}$/.test(cleaned)) {
      throw new Error(`invalid ISO 3166-1 alpha-2 country code: "${input.country_iso}"`);
    }
    result.country_iso = cleaned;
  }
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

// Closed-world chain registry. A typo in `chain` MUST fail closed; silently
// passing the raw address through for an unknown chain would make two
// visually-identical beneficiaries hash differently without any warning.
type ChainKind = "evm" | "solana";
const CHAIN_REGISTRY: Record<string, { canonical: string; kind: ChainKind }> = {
  eth: { canonical: "eth", kind: "evm" },
  ethereum: { canonical: "eth", kind: "evm" },
  base: { canonical: "base", kind: "evm" },
  arb: { canonical: "arb", kind: "evm" },
  arbitrum: { canonical: "arb", kind: "evm" },
  optimism: { canonical: "optimism", kind: "evm" },
  op: { canonical: "optimism", kind: "evm" },
  polygon: { canonical: "polygon", kind: "evm" },
  matic: { canonical: "polygon", kind: "evm" },
  sol: { canonical: "sol", kind: "solana" },
  solana: { canonical: "sol", kind: "solana" },
};

function normalizeCrypto(chain: string, address: string): {
  type: "crypto";
  chain: string;
  address: string;
} {
  const key = chain.toLowerCase().trim();
  const entry = CHAIN_REGISTRY[key];
  if (!entry) {
    throw new Error(
      `unsupported crypto chain: "${chain}". Known chains: ${Object.keys(CHAIN_REGISTRY).join(", ")}`,
    );
  }
  const normalizedAddress =
    entry.kind === "evm" ? toEip55(address) : normalizeSolanaAddress(address);
  return {
    type: "crypto",
    chain: entry.canonical,
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
