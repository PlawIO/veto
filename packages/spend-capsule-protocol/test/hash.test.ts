import { describe, expect, it } from "vitest";
import {
  GENESIS_PREV_RECEIPT_HASH,
  canonicalize,
  hashBeneficiary,
  hashCanonical,
  normalizeBeneficiary,
  sha256Hex,
  sha256Prefixed,
} from "../src/index.js";

describe("canonicalize (JCS round-trip)", () => {
  it("sorts keys deterministically regardless of insertion order", () => {
    const a = canonicalize({ b: 1, a: 2, c: { y: 1, x: 2 } });
    const b = canonicalize({ c: { x: 2, y: 1 }, a: 2, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"b":1,"c":{"x":2,"y":1}}');
  });

  it("is stable across deep nesting", () => {
    const v = { z: [3, 2, 1], a: { q: [null, { r: "s" }] } };
    expect(canonicalize(v)).toBe('{"a":{"q":[null,{"r":"s"}]},"z":[3,2,1]}');
  });
});

describe("sha256 of empty == genesis prev_receipt_hash (A5 golden vector)", () => {
  it("GENESIS_PREV_RECEIPT_HASH is exactly sha256 of the empty byte string", () => {
    expect(sha256Prefixed("")).toBe(GENESIS_PREV_RECEIPT_HASH);
    expect(sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});

describe("hashBeneficiary normalization", () => {
  it("bank_us: trims whitespace/dashes from routing, lowercases name, enforces exact 4-digit last4", () => {
    const n = normalizeBeneficiary({
      type: "bank_us",
      name: "  Acme   Supplies LLC  ",
      routing: "121-000-248",
      account_last4: "4821",
    });
    expect(n).toEqual({
      type: "bank_us",
      name: "acme supplies llc",
      routing: "121000248",
      account_last4: "4821",
    });

    const h = hashBeneficiary({
      type: "bank_us",
      name: "Acme Supplies LLC",
      routing: "121000248",
      account_last4: "4821",
    });
    expect(h).toMatch(/^sha256:[0-9a-f]{64}$/);

    // Alternate spellings/formatting hash identically (whitespace trim only).
    const h2 = hashBeneficiary({
      type: "bank_us",
      name: "  ACME supplies   llc ",
      routing: "121 000 248",
      account_last4: "4821",
    });
    expect(h2).toBe(h);
  });

  it("crypto EVM: normalizes to EIP-55 checksum", () => {
    const h = hashBeneficiary({
      type: "crypto",
      chain: "Ethereum",
      // All-lowercase input
      address: "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed",
    });
    const h2 = hashBeneficiary({
      type: "crypto",
      chain: "ethereum",
      // Same address, mixed case upper/lower (will re-checksum identically)
      address: "0x5AAEB6053F3E94C9B9A09F33669435E7EF1BEAED",
    });
    expect(h).toBe(h2);
  });

  it("crypto Solana: rejects non-base58 characters", () => {
    expect(() =>
      hashBeneficiary({
        type: "crypto",
        chain: "solana",
        address: "0xnotbase58",
      }),
    ).toThrow(/base58/);
  });

  it("hashCanonical is deterministic for the same value", () => {
    const v = { entity: "ent_abc", amount: "100.00", currency: "USD" };
    expect(hashCanonical(v)).toBe(hashCanonical({ currency: "USD", amount: "100.00", entity: "ent_abc" }));
  });
});
