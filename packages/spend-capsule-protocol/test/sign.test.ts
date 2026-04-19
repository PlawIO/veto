import { describe, expect, it } from "vitest";
import {
  CapsuleVerificationError,
  publicJwkFromPrivate,
  signCapsule,
  verifyCapsule,
} from "../src/index.js";
import { REFERENCE_NOW, buildTestSigningKey, fixedCapsule } from "./fixtures.js";

import type { AuthorizedJwks } from "../src/index.js";

// Tests use an AuthorizedJwks bound to the fixed fixture issuer so each
// verifyCapsule call exercises the happy issuer-binding path. Passing a
// plain Jwks would now be rejected as unsafe — that's the prod-safety
// default we want.
async function jwksFromKey(): Promise<AuthorizedJwks> {
  const key = await buildTestSigningKey();
  return {
    keys: [publicJwkFromPrivate(key)],
    authorizations: [
      { kid: key.kid, issuer: "https://gateway.veto.so" },
    ],
  };
}

describe("signCapsule + verifyCapsule (happy path)", () => {
  it("round-trips a capsule", async () => {
    const key = await buildTestSigningKey();
    const payload = fixedCapsule();
    const jws = await signCapsule(payload, key);

    expect(jws.split(".").length).toBe(3);

    const { payload: out, protectedHeader } = await verifyCapsule(jws, await jwksFromKey(), {
      now: REFERENCE_NOW,
    });
    expect(out).toEqual(payload);
    expect(protectedHeader).toEqual({
      alg: "EdDSA",
      typ: "veto.capsule+jws",
      kid: "veto-gateway-test",
    });
  });

  it("produces a byte-identical JWS for the same payload + key (Ed25519 determinism)", async () => {
    const key = await buildTestSigningKey();
    const payload = fixedCapsule();
    const a = await signCapsule(payload, key);
    const b = await signCapsule(payload, key);
    expect(a).toBe(b);
  });
});

describe("verifyCapsule — REGRESSION class", () => {
  it("rejects when clock skew exceeds tolerance after expiry", async () => {
    const key = await buildTestSigningKey();
    const jws = await signCapsule(fixedCapsule(), key);
    // expiry = 2026-04-17T14:15:00Z; now = 14:16:00Z; skew default 30s → reject
    await expect(
      verifyCapsule(jws, await jwksFromKey(), {
        now: new Date("2026-04-17T14:16:00Z"),
      }),
    ).rejects.toMatchObject({ code: "capsule_expired" });
  });

  it("accepts within the 30s default skew window after expiry", async () => {
    const key = await buildTestSigningKey();
    const jws = await signCapsule(fixedCapsule(), key);
    // expiry + 20s still within 30s window
    const { payload } = await verifyCapsule(jws, await jwksFromKey(), {
      now: new Date("2026-04-17T14:15:20Z"),
    });
    expect(payload.capsule_id).toBeTruthy();
  });

  it("rejects capsules issued in the future beyond skew", async () => {
    const key = await buildTestSigningKey();
    const jws = await signCapsule(fixedCapsule(), key);
    // now = 13:59:00Z, issued_at = 14:00:00Z → 60s in the future → reject
    await expect(
      verifyCapsule(jws, await jwksFromKey(), {
        now: new Date("2026-04-17T13:59:00Z"),
      }),
    ).rejects.toMatchObject({ code: "capsule_issued_in_future" });
  });

  it("rejects when the kid is unknown to the JWKS", async () => {
    const key = await buildTestSigningKey("unknown-kid");
    const jws = await signCapsule(fixedCapsule(), key);
    // JWKS has kid=veto-gateway-test; capsule signed with unknown-kid
    await expect(
      verifyCapsule(jws, await jwksFromKey(), { now: REFERENCE_NOW }),
    ).rejects.toMatchObject({ code: "signature_kid_unknown" });
  });

  it("rejects when the signature is tampered", async () => {
    const key = await buildTestSigningKey();
    const jws = await signCapsule(fixedCapsule(), key);
    // Flip the very last character of the signature segment
    const parts = jws.split(".");
    const last = parts[2]!;
    const flipped = last[0] === "A" ? "B" + last.slice(1) : "A" + last.slice(1);
    parts[2] = flipped;
    const tampered = parts.join(".");
    await expect(
      verifyCapsule(tampered, await jwksFromKey(), { now: REFERENCE_NOW }),
    ).rejects.toMatchObject({ code: "signature_invalid" });
  });

  it("rejects when the payload is tampered (different JCS canonical form)", async () => {
    const key = await buildTestSigningKey();
    const jws = await signCapsule(fixedCapsule(), key);
    // Replace the payload with a modified amount
    const parts = jws.split(".");
    const body = JSON.stringify({
      ...fixedCapsule(),
      amount_ceiling: { currency: "USD", amount: "99999.00" },
    });
    const b64 = Buffer.from(body)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    parts[1] = b64;
    const tampered = parts.join(".");
    await expect(
      verifyCapsule(tampered, await jwksFromKey(), { now: REFERENCE_NOW }),
    ).rejects.toMatchObject({ code: "signature_invalid" });
  });

  it("throws a typed CapsuleVerificationError with stable codes", async () => {
    const key = await buildTestSigningKey("some-other-kid");
    const jws = await signCapsule(fixedCapsule(), key);
    try {
      await verifyCapsule(jws, await jwksFromKey(), { now: REFERENCE_NOW });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CapsuleVerificationError);
      expect((err as CapsuleVerificationError).code).toBe("signature_kid_unknown");
    }
  });
});

describe("verifyCapsule — header validation", () => {
  it("rejects when JWS is not three segments", async () => {
    await expect(
      verifyCapsule("not.a.valid.jws", await jwksFromKey()),
    ).rejects.toBeInstanceOf(CapsuleVerificationError);
  });
});
