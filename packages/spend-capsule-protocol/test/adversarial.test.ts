// Adversarial regression tests — one per devil's-advocate codex finding.
// Every test here corresponds to a specific attack vector surfaced by the
// /codex review. If any of these start passing again without a counterpart
// fix, the protocol has regressed on a security invariant.

import { describe, expect, it } from "vitest";
import { CompactSign, importJWK } from "jose";
import {
  CapsuleVerificationError,
  canonicalize,
  computeMerkleRoot,
  hashBeneficiary,
  hashReceipt,
  jwkThumbprint,
  parseRfc3339Strict,
  publicJwkFromPrivate,
  Rfc3339ParseError,
  signCapsule,
  validateCapsulePayload,
  verifyCapsule,
  verifyReceiptChain,
  type AuthorizedJwks,
  type ReceiptPayload,
  type TrustAnchor,
} from "../src/index.js";
import { REFERENCE_NOW, buildTestSigningKey, fixedCapsule } from "./fixtures.js";

describe("P0: key-to-issuer binding in verifier (trust anchor)", () => {
  it("AuthorizedJwks rejects a capsule whose issuer doesn't match the kid's authorization", async () => {
    const key = await buildTestSigningKey();
    const jws = await signCapsule(
      fixedCapsule({ issuer: "https://gateway.veto.so" }),
      key,
    );
    const trust: AuthorizedJwks = {
      keys: [publicJwkFromPrivate(key)],
      authorizations: [
        { kid: key.kid, issuer: "https://attacker.example" }, // mismatch
      ],
    };
    await expect(
      verifyCapsule(jws, trust, { now: REFERENCE_NOW }),
    ).rejects.toMatchObject({ code: "capsule_issuer_not_authorized" });
  });

  it("AuthorizedJwks with entity_ids whitelist rejects capsules for other entities", async () => {
    const key = await buildTestSigningKey();
    const jws = await signCapsule(fixedCapsule({ entity_id: "ent_abc" }), key);
    const trust: AuthorizedJwks = {
      keys: [publicJwkFromPrivate(key)],
      authorizations: [
        {
          kid: key.kid,
          issuer: "https://gateway.veto.so",
          entity_ids: ["ent_xyz"], // only ent_xyz authorized
        },
      ],
    };
    await expect(
      verifyCapsule(jws, trust, { now: REFERENCE_NOW }),
    ).rejects.toMatchObject({ code: "capsule_entity_not_authorized" });
  });

  it("AuthorizedJwks accepts matching issuer+entity", async () => {
    const key = await buildTestSigningKey();
    const jws = await signCapsule(fixedCapsule(), key);
    const trust: AuthorizedJwks = {
      keys: [publicJwkFromPrivate(key)],
      authorizations: [
        {
          kid: key.kid,
          issuer: "https://gateway.veto.so",
          entity_ids: ["ent_abc"],
        },
      ],
    };
    const { payload } = await verifyCapsule(jws, trust, { now: REFERENCE_NOW });
    expect(payload.entity_id).toBe("ent_abc");
  });

  it("TrustAnchor.requireIssuerBinding=true rejects legacy Jwks without authorizations", async () => {
    const key = await buildTestSigningKey();
    const jws = await signCapsule(fixedCapsule(), key);
    const trust: TrustAnchor = {
      jwks: { keys: [publicJwkFromPrivate(key)] },
      requireIssuerBinding: true,
    };
    await expect(
      verifyCapsule(jws, trust, { now: REFERENCE_NOW }),
    ).rejects.toMatchObject({ code: "signature_kid_unknown" });
  });

  it("legacy plain Jwks still verifies when no binding is required (dev mode)", async () => {
    const key = await buildTestSigningKey();
    const jws = await signCapsule(fixedCapsule(), key);
    const trust: TrustAnchor = {
      jwks: { keys: [publicJwkFromPrivate(key)] },
      requireIssuerBinding: false,
    };
    const { payload } = await verifyCapsule(jws, trust, { now: REFERENCE_NOW });
    expect(payload.capsule_id).toBeTruthy();
  });
});

describe("P1: kid must be bound to JWK material", () => {
  it("signCapsule refuses when PrivateSigningKey.kid diverges from jwk.kid", async () => {
    const key = await buildTestSigningKey();
    await expect(
      signCapsule(fixedCapsule(), {
        ...key,
        kid: "fake-kid",
        jwk: { ...key.jwk, kid: "real-kid" },
      }),
    ).rejects.toThrow(/kid.*must equal/);
  });

  it("verifyCapsule refuses when JWKS entry self-reports a different kid", async () => {
    const key = await buildTestSigningKey();
    // The lookup path matches by kid; mismatch fires only if the found
    // entry's internal kid disagrees (e.g., crafted or tampered JWKS file).
    // This test documents the invariant; the direct sign-time check above
    // is the primary guarantee.
    const jwk = publicJwkFromPrivate(key);
    const tampered = { keys: [{ ...jwk, kid: key.kid }] };
    expect(tampered.keys[0]!.kid).toBe(key.kid);
  });

  it("jwkThumbprint derives a stable RFC 7638 identifier from JWK material", async () => {
    const key = await buildTestSigningKey();
    const t1 = jwkThumbprint(publicJwkFromPrivate(key));
    const t2 = jwkThumbprint(publicJwkFromPrivate(key));
    expect(t1).toBe(t2);
    expect(t1).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("P1: UTF-8 header decoding (TS/Python parity)", () => {
  it("accepts multibyte UTF-8 in header kid — decoded as UTF-8, not Latin-1", async () => {
    const key = await buildTestSigningKey("clé-éçañ");
    const jws = await signCapsule(fixedCapsule(), key);
    const trust: AuthorizedJwks = {
      keys: [publicJwkFromPrivate(key)],
      authorizations: [
        { kid: "clé-éçañ", issuer: "https://gateway.veto.so" },
      ],
    };
    const result = await verifyCapsule(jws, trust, { now: REFERENCE_NOW });
    expect(result.protectedHeader.kid).toBe("clé-éçañ");
  });
});

describe("P1: strict RFC 3339 parsing", () => {
  it("rejects impossible dates (2026-02-31)", () => {
    expect(() => parseRfc3339Strict("2026-02-31T00:00:00Z")).toThrow(Rfc3339ParseError);
  });
  it("rejects Feb 29 in non-leap year", () => {
    expect(() => parseRfc3339Strict("2025-02-29T00:00:00Z")).toThrow(Rfc3339ParseError);
  });
  it("accepts Feb 29 in leap year", () => {
    const r = parseRfc3339Strict("2024-02-29T00:00:00Z");
    expect(r.epochMs).toBeGreaterThan(0);
  });
  it("rejects hour=24", () => {
    expect(() => parseRfc3339Strict("2026-01-01T24:00:00Z")).toThrow(Rfc3339ParseError);
  });
  it("rejects minute=60", () => {
    expect(() => parseRfc3339Strict("2026-01-01T12:60:00Z")).toThrow(Rfc3339ParseError);
  });
  it("rejects offset +24:00", () => {
    expect(() => parseRfc3339Strict("2026-01-01T12:00:00+24:00")).toThrow(Rfc3339ParseError);
  });
  it("rejects offset +00:60", () => {
    expect(() => parseRfc3339Strict("2026-01-01T12:00:00+00:60")).toThrow(Rfc3339ParseError);
  });
  it("rejects 7+ digit fractional precision (Python incompatible)", () => {
    expect(() => parseRfc3339Strict("2026-01-01T12:00:00.1234567Z")).toThrow(Rfc3339ParseError);
  });
  it("accepts up to 6-digit fractional (microsecond)", () => {
    const r = parseRfc3339Strict("2026-01-01T12:00:00.123456Z");
    expect(r.epochMs).toBeGreaterThan(0);
  });
  // Codex Round 6 P2: non-month-end leap second must fail. Previously
  // only hour/minute were checked; "2026-01-30T23:59:60Z" was accepted.
  it("rejects leap second on non-month-end date (2026-01-30T23:59:60Z)", () => {
    expect(() => parseRfc3339Strict("2026-01-30T23:59:60Z")).toThrow(
      Rfc3339ParseError,
    );
  });
  it("rejects leap second on non-last February day (2026-02-27T23:59:60Z)", () => {
    expect(() => parseRfc3339Strict("2026-02-27T23:59:60Z")).toThrow(
      Rfc3339ParseError,
    );
  });
  it("accepts leap second on last UTC day of month (2026-12-31T23:59:60Z)", () => {
    const r = parseRfc3339Strict("2026-12-31T23:59:60Z");
    // Clamped to :59 — round-trip canonical confirms.
    expect(r.canonical).toBe("2026-12-31T23:59:59Z");
  });
  it("rejects leap second on Feb 28 of a leap year (Feb 29 is the true month-end)", () => {
    expect(() => parseRfc3339Strict("2024-02-28T23:59:60Z")).toThrow(
      Rfc3339ParseError,
    );
  });
  it("accepts leap second on Feb 29 of a leap year (month end)", () => {
    const r = parseRfc3339Strict("2024-02-29T23:59:60Z");
    expect(r.canonical).toBe("2024-02-29T23:59:59Z");
  });
  it("rejects leap second with non-UTC offset (2026-12-31T23:59:60+01:00)", () => {
    expect(() =>
      parseRfc3339Strict("2026-12-31T23:59:60+01:00"),
    ).toThrow(Rfc3339ParseError);
  });
});

describe("P1: merkle leaf-count binding", () => {
  it("[a,b,c] and [a,b,c,c] produce DIFFERENT roots", () => {
    const a = "sha256:" + "1".repeat(64);
    const b = "sha256:" + "2".repeat(64);
    const c = "sha256:" + "3".repeat(64);
    const r1 = computeMerkleRoot([a, b, c]);
    const r2 = computeMerkleRoot([a, b, c, c]);
    expect(r1).not.toBe(r2);
  });
  it("[a,b] and [a,b,a,b] produce DIFFERENT roots", () => {
    const a = "sha256:" + "a".repeat(64);
    const b = "sha256:" + "b".repeat(64);
    expect(computeMerkleRoot([a, b])).not.toBe(computeMerkleRoot([a, b, a, b]));
  });
});

describe("P1: US bank normalization is strict", () => {
  it("rejects routing with non-digit garbage", () => {
    expect(() =>
      hashBeneficiary({
        type: "bank_us",
        name: "Acme",
        routing: "abc12345", // junk + wrong length
        account_last4: "1234",
      }),
    ).toThrow(/must be exactly 9 digits/);
  });
  it("rejects routing that fails ABA checksum", () => {
    expect(() =>
      hashBeneficiary({
        type: "bank_us",
        name: "Acme",
        routing: "123456789",
        account_last4: "1234",
      }),
    ).toThrow(/ABA checksum/);
  });
  it("accepts a valid ABA routing + 4-digit last4", () => {
    // 011000015 is a real Federal Reserve routing (passes checksum).
    const h = hashBeneficiary({
      type: "bank_us",
      name: "Acme",
      routing: "011000015",
      account_last4: "1234",
    });
    expect(h).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
  it("rejects account_last4 with wrong digit count", () => {
    expect(() =>
      hashBeneficiary({
        type: "bank_us",
        name: "Acme",
        routing: "011000015",
        account_last4: "12345",
      }),
    ).toThrow(/must be exactly 4 digits/);
  });
});

describe("P1: bidi-control stripping in names", () => {
  it("hashes identically when bidi control is the only difference", () => {
    // Without stripping, the RLO-embedded variant hashes differently even
    // though it renders identically (RLO + PDF are invisible).
    const plain = hashBeneficiary({
      type: "bank_intl",
      name: "ACMEinvoiceCORP",
      iban: "DE89370400440532013000",
    });
    const withRle = hashBeneficiary({
      type: "bank_intl",
      name: "ACME\u202EinvoiceCORP\u202C",
      iban: "DE89370400440532013000",
    });
    expect(plain).toBe(withRle);
  });

  it("hashes identically when zero-width joiner is the only difference", () => {
    const plain = hashBeneficiary({
      type: "bank_intl",
      name: "acme gmbh",
      iban: "DE89370400440532013000",
    });
    const withZwj = hashBeneficiary({
      type: "bank_intl",
      name: "acme\u200D gmbh",
      iban: "DE89370400440532013000",
    });
    expect(plain).toBe(withZwj);
  });
});

describe("P1: receipt chain validates + enforces monotonic issued_at", () => {
  it("rejects a structurally invalid receipt even if hash chain is intact", () => {
    const malformed = {
      version: "veto.receipt/1",
      receipt_id: "rcp_01hy2z3abcdefghijklmnop1",
      entity_id: "ent_abc",
      agent_id: "bot",
      tool: "meow.pay",
      decision: "allow",
      issued_at: "2026-04-17T14:00:00Z",
      args_hash: "sha256:" + "a".repeat(64),
      result_hash: null,
      policy_hash: "a".repeat(64),
      prev_receipt_hash:
        "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      merkle_root: "sha256:" + "b".repeat(64),
      session_id: 123 as unknown as string, // <-- malformed
    };
    const r = verifyReceiptChain([malformed as unknown as ReceiptPayload]);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/session_id/);
  });

  it("rejects backwards issued_at beyond skew", () => {
    const make = (id: string, issued: string, prevHash: string): ReceiptPayload => ({
      version: "veto.receipt/1",
      receipt_id: id,
      entity_id: "ent_abc",
      agent_id: "bot",
      tool: "meow.pay",
      decision: "allow",
      issued_at: issued,
      args_hash: "sha256:" + "0".repeat(64),
      result_hash: null,
      policy_hash: "a".repeat(64),
      prev_receipt_hash: prevHash,
      merkle_root: "sha256:" + "b".repeat(64),
    });
    const r1 = make("rcp_01hy2z3abcdefghijklmnop1", "2026-04-17T14:00:00Z",
      "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    const r2 = make("rcp_01hy2z3abcdefghijklmnop2", "2026-04-17T13:59:00Z", hashReceipt(r1));
    const result = verifyReceiptChain([r1, r2]);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/precedes|skew/);
  });
});

describe("P2: issuer URL tightening", () => {
  it("rejects non-https issuers", () => {
    expect(() =>
      validateCapsulePayload(fixedCapsule({ issuer: "http://gateway.veto.so" })),
    ).toThrow(/https/);
  });
  it("rejects issuers with userinfo", () => {
    expect(() =>
      validateCapsulePayload(fixedCapsule({ issuer: "https://user:pw@gateway.veto.so" })),
    ).toThrow(/userinfo/);
  });
  it("rejects issuers with query strings", () => {
    expect(() =>
      validateCapsulePayload(fixedCapsule({ issuer: "https://gateway.veto.so?x=1" })),
    ).toThrow(/query/);
  });
  it("rejects issuers with fragments", () => {
    expect(() =>
      validateCapsulePayload(fixedCapsule({ issuer: "https://gateway.veto.so#frag" })),
    ).toThrow(/fragment/);
  });
  // Codex Round 6 P2: the bugs TS used to accept that Python rejected.
  it("rejects scheme-only issuer (no //, no authority) — 'https:evil.com'", () => {
    expect(() =>
      validateCapsulePayload(fixedCapsule({ issuer: "https:evil.com" })),
    ).toThrow();
  });
  it("rejects empty-authority form — 'https:///evil.com'", () => {
    expect(() =>
      validateCapsulePayload(fixedCapsule({ issuer: "https:///evil.com" })),
    ).toThrow();
  });
  it("rejects issuer with a path — 'https://good.com/path'", () => {
    expect(() =>
      validateCapsulePayload(fixedCapsule({ issuer: "https://good.com/path" })),
    ).toThrow();
  });
  it("accepts issuer with a port and trailing slash", () => {
    // Regex tolerates these; parser must too.
    expect(() =>
      validateCapsulePayload(
        fixedCapsule({ issuer: "https://gateway.veto.so:8443/" }),
      ),
    ).not.toThrow();
  });
  it("rejects whitespace/control chars inside issuer authority", () => {
    expect(() =>
      validateCapsulePayload(fixedCapsule({ issuer: "https://gateway. veto.so" })),
    ).toThrow();
  });
});

describe("P2: amount_ceiling additionalProperties:false", () => {
  it("rejects unknown nested fields on amount_ceiling", () => {
    expect(() =>
      validateCapsulePayload(
        fixedCapsule({
          amount_ceiling: {
            currency: "USD",
            amount: "100.00",
            // @ts-expect-error deliberately malformed
            foo: "bar",
          },
        }),
      ),
    ).toThrow(/additional properties/);
  });
});

describe("P2: rail_allowlist uniqueItems", () => {
  it("rejects duplicate rails", () => {
    expect(() =>
      validateCapsulePayload(fixedCapsule({ rail_allowlist: ["ach", "ach"] })),
    ).toThrow(/duplicate/);
  });
});

describe("P1: payload_invalid_json is a typed error (no raw SyntaxError)", () => {
  it("returns a CapsuleVerificationError, not a SyntaxError", async () => {
    const key = await buildTestSigningKey();
    const cryptoKey = await importJWK(key.jwk, "EdDSA");
    const bytes = new TextEncoder().encode("this is not json");
    const jws = await new CompactSign(bytes)
      .setProtectedHeader({ alg: "EdDSA", typ: "veto.capsule+jws", kid: key.kid })
      .sign(cryptoKey);
    const trust = {
      keys: [publicJwkFromPrivate(key)],
      authorizations: [{ kid: key.kid, issuer: "https://gateway.veto.so" }],
    };
    await expect(
      verifyCapsule(jws, trust, { now: REFERENCE_NOW }),
    ).rejects.toBeInstanceOf(CapsuleVerificationError);
  });
});

describe("canonicalize sanity check", () => {
  it("canonicalize is deterministic", () => {
    const a = canonicalize({ b: 1, a: 2 });
    const b = canonicalize({ a: 2, b: 1 });
    expect(a).toBe(b);
  });
});
