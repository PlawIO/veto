import { describe, expect, it } from "vitest";
import {
  CapsuleVerificationError,
  hashBeneficiary,
  normalizeBeneficiary,
  publicJwkFromPrivate,
  signCapsule,
  verifyCapsule,
} from "../src/index.js";
import { REFERENCE_NOW, buildTestSigningKey, fixedCapsule } from "./fixtures.js";

async function jwksFromKey() {
  const key = await buildTestSigningKey();
  return { keys: [publicJwkFromPrivate(key)] };
}

describe("hash.ts — beneficiary normalization edge paths", () => {
  it("bank_intl: uppercases IBAN/BIC, strips whitespace, uppercases country", () => {
    const n = normalizeBeneficiary({
      type: "bank_intl",
      name: "  Acme Europe GmbH  ",
      iban: " DE89 3704 0044 0532 0130 00 ",
      swift_bic: "cobadeff",
      country_iso: "de",
    });
    expect(n).toEqual({
      type: "bank_intl",
      name: "acme europe gmbh",
      iban: "DE89370400440532013000",
      swift_bic: "COBADEFF",
      country_iso: "DE",
    });
  });

  it("bank_intl: hashes identically regardless of optional field whitespace", () => {
    const a = hashBeneficiary({
      type: "bank_intl",
      name: "Acme Europe GmbH",
      iban: "DE89370400440532013000",
    });
    const b = hashBeneficiary({
      type: "bank_intl",
      name: "  ACME europe   gmbh ",
      iban: " de89 3704 0044 0532 0130 00 ",
    });
    expect(a).toBe(b);
  });

  it("crypto: unknown chain fails closed (no silent pass-through)", () => {
    // Typos and unsupported chains MUST throw — otherwise two
    // visually-identical beneficiaries could hash differently just because
    // the caller typed "etherium" instead of "ethereum".
    expect(() =>
      normalizeBeneficiary({
        type: "crypto",
        chain: "some-new-chain",
        address: "custom-address-format",
      }),
    ).toThrow(/unsupported crypto chain/);
  });

  it("crypto EVM: rejects malformed address length", () => {
    expect(() =>
      hashBeneficiary({
        type: "crypto",
        chain: "ethereum",
        address: "0xdeadbeef",
      }),
    ).toThrow(/invalid EVM/);
  });
});

describe("sign.ts — header + payload error paths", () => {
  it("rejects alg that is not EdDSA", async () => {
    // Hand-craft a JWS with HS256 header
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "veto.capsule+jws", kid: "x" }))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const body = Buffer.from(JSON.stringify(fixedCapsule()))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const jws = `${header}.${body}.AAAA`;
    await expect(
      verifyCapsule(jws, await jwksFromKey(), { now: REFERENCE_NOW }),
    ).rejects.toMatchObject({ code: "signature_alg_not_supported" });
  });

  it("rejects unexpected typ", async () => {
    const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT", kid: "x" }))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const body = Buffer.from(JSON.stringify(fixedCapsule()))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const jws = `${header}.${body}.AAAA`;
    await expect(
      verifyCapsule(jws, await jwksFromKey(), { now: REFERENCE_NOW }),
    ).rejects.toMatchObject({ code: "signature_typ_invalid" });
  });

  it("rejects missing kid", async () => {
    const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "veto.capsule+jws" }))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const body = Buffer.from(JSON.stringify(fixedCapsule()))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const jws = `${header}.${body}.AAAA`;
    await expect(
      verifyCapsule(jws, await jwksFromKey(), { now: REFERENCE_NOW }),
    ).rejects.toMatchObject({ code: "signature_kid_missing" });
  });

  it("rejects malformed JWS header (not JSON)", async () => {
    const jws = "not-base64-json.body.sig";
    await expect(
      verifyCapsule(jws, await jwksFromKey(), { now: REFERENCE_NOW }),
    ).rejects.toBeInstanceOf(CapsuleVerificationError);
  });

  it("signCapsule rejects naive expires_at (no offset) at issuance time", async () => {
    const key = await buildTestSigningKey();
    await expect(
      signCapsule(fixedCapsule({ expires_at: "2026-04-17T14:15:00" }), key),
    ).rejects.toThrow(/RFC 3339 with explicit offset|expires_at/);
  });

  it("signCapsule rejects naive issued_at (no offset) at issuance time", async () => {
    const key = await buildTestSigningKey();
    await expect(
      signCapsule(fixedCapsule({ issued_at: "2026-04-17T14:00:00" }), key),
    ).rejects.toThrow(/RFC 3339 with explicit offset|issued_at/);
  });

  it("signCapsule rejects unsupported capsule version at issuance time", async () => {
    const key = await buildTestSigningKey();
    await expect(
      signCapsule(
        { ...fixedCapsule(), version: "veto.capsule/99" as never },
        key,
      ),
    ).rejects.toThrow(/veto\.capsule\/1/);
  });

  it("verifyCapsule rejects a capsule signed with a bad expires_at (hand-crafted bypass)", async () => {
    // Simulate the wire path: a peer that bypasses our signer creates a JWS
    // with a bad expires_at. Build it via raw JWS primitives so the schema
    // validator in signCapsule doesn't short-circuit.
    const key = await buildTestSigningKey();
    const badPayload = { ...fixedCapsule(), expires_at: "not-a-date" };
    const { CompactSign, importJWK } = await import("jose");
    const { canonicalize } = await import("../src/index.js");
    const cryptoKey = await importJWK(key.jwk, "EdDSA");
    // Use canonical bytes so the "payload_not_canonical" guard doesn't fire first.
    const bytes = new TextEncoder().encode(canonicalize(badPayload));
    const jws = await new CompactSign(bytes)
      .setProtectedHeader({ alg: "EdDSA", typ: "veto.capsule+jws", kid: key.kid })
      .sign(cryptoKey);
    await expect(
      verifyCapsule(jws, await jwksFromKey(), { now: REFERENCE_NOW }),
    ).rejects.toMatchObject({ code: "capsule_payload_invalid" });
  });

  it("verifyCapsule rejects additional properties (schema validation on verify)", async () => {
    const key = await buildTestSigningKey();
    const { CompactSign, importJWK } = await import("jose");
    const { canonicalize } = await import("../src/index.js");
    const cryptoKey = await importJWK(key.jwk, "EdDSA");
    const payload = { ...fixedCapsule(), extra_field: "should_be_rejected" };
    const bytes = new TextEncoder().encode(canonicalize(payload));
    const jws = await new CompactSign(bytes)
      .setProtectedHeader({ alg: "EdDSA", typ: "veto.capsule+jws", kid: key.kid })
      .sign(cryptoKey);
    await expect(
      verifyCapsule(jws, await jwksFromKey(), { now: REFERENCE_NOW }),
    ).rejects.toMatchObject({ code: "capsule_payload_invalid" });
  });

  it("verifyCapsule rejects non-canonical payload even when signature is valid", async () => {
    const key = await buildTestSigningKey();
    const { CompactSign, importJWK } = await import("jose");
    const { canonicalize } = await import("../src/index.js");
    const cryptoKey = await importJWK(key.jwk, "EdDSA");
    // Handcraft a guaranteed non-canonical form: JCS requires keys in
    // lexicographic order. Prepend an extra space after the opening brace
    // so the bytes can never equal any canonical encoding.
    const canonicalBytes = new TextEncoder().encode(canonicalize(fixedCapsule()));
    const nonCanonicalBytes = new Uint8Array(canonicalBytes.length + 1);
    nonCanonicalBytes[0] = 0x7b; // '{'
    nonCanonicalBytes[1] = 0x20; // extra space
    nonCanonicalBytes.set(canonicalBytes.slice(1), 2);
    const jws = await new CompactSign(nonCanonicalBytes)
      .setProtectedHeader({ alg: "EdDSA", typ: "veto.capsule+jws", kid: key.kid })
      .sign(cryptoKey);
    await expect(
      verifyCapsule(jws, await jwksFromKey(), { now: REFERENCE_NOW }),
    ).rejects.toMatchObject({ code: "payload_not_canonical" });
  });

  it("verifyCapsule rejects max_uses = 0", async () => {
    const key = await buildTestSigningKey();
    await expect(
      signCapsule({ ...fixedCapsule(), max_uses: 0 } as never, key),
    ).rejects.toThrow(/max_uses/);
  });
});
