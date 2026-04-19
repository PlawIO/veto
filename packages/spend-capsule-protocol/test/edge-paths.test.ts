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

  it("crypto: unknown chain passes address through unchanged", () => {
    const n = normalizeBeneficiary({
      type: "crypto",
      chain: "some-new-chain",
      address: "custom-address-format",
    });
    expect(n).toEqual({
      type: "crypto",
      chain: "some-new-chain",
      address: "custom-address-format",
    });
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

  it("rejects when payload has an invalid expires_at datetime", async () => {
    const key = await buildTestSigningKey();
    const jws = await signCapsule(
      fixedCapsule({ expires_at: "not-a-date" }),
      key,
    );
    await expect(
      verifyCapsule(jws, await jwksFromKey(), { now: REFERENCE_NOW }),
    ).rejects.toMatchObject({ code: "capsule_expires_at_invalid" });
  });

  it("rejects when payload has an invalid issued_at datetime", async () => {
    const key = await buildTestSigningKey();
    const jws = await signCapsule(
      fixedCapsule({ issued_at: "also-not-a-date" }),
      key,
    );
    await expect(
      verifyCapsule(jws, await jwksFromKey(), { now: REFERENCE_NOW }),
    ).rejects.toMatchObject({ code: "capsule_issued_at_invalid" });
  });

  it("rejects unsupported capsule version", async () => {
    const key = await buildTestSigningKey();
    const jws = await signCapsule(
      // Cast because our types say veto.capsule/1 literal — we emulate a future
      // version escaping past the wire boundary.
      { ...fixedCapsule(), version: "veto.capsule/99" as never },
      key,
    );
    await expect(
      verifyCapsule(jws, await jwksFromKey(), { now: REFERENCE_NOW }),
    ).rejects.toMatchObject({ code: "capsule_version_unsupported" });
  });
});
