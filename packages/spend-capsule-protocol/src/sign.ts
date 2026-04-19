import { CompactSign, compactVerify, importJWK } from "jose";
import { sha256 } from "@noble/hashes/sha2";
import type {
  CapsulePayload,
  Jwks,
  JwksKey,
  VerifyCapsuleResult,
  VerifyOptions,
} from "./types.js";
import { JWS_TYP } from "./types.js";
import { canonicalize } from "./hash.js";
import { ValidationError, validateCapsulePayload } from "./validate.js";
import { parseRfc3339Strict, Rfc3339ParseError } from "./rfc3339.js";

const DEFAULT_SKEW_SECONDS = 30;

export interface PrivateSigningKey {
  kid: string;
  jwk: JwksKey & { d: string };
}

export type CapsuleErrorCode =
  | "jws_malformed"
  | "signature_alg_not_supported"
  | "signature_typ_invalid"
  | "signature_kid_missing"
  | "signature_kid_unknown"
  | "signature_kid_mismatch"
  | "signature_invalid"
  | "jwks_key_invalid"
  | "payload_invalid_json"
  | "payload_not_canonical"
  | "capsule_payload_invalid"
  | "capsule_version_unsupported"
  | "capsule_expires_at_invalid"
  | "capsule_issued_at_invalid"
  | "capsule_expired"
  | "capsule_issued_in_future"
  | "capsule_issuer_not_authorized"
  | "capsule_entity_not_authorized";

export class CapsuleVerificationError extends Error {
  readonly code: CapsuleErrorCode;
  constructor(code: CapsuleErrorCode, message: string) {
    super(message);
    this.name = "CapsuleVerificationError";
    this.code = code;
  }
}

/**
 * RFC 7638 JWK thumbprint. For Ed25519 the required members are
 * {crv, kty, x}. We compute sha256 of the canonical JSON and base64url-encode.
 * This binds a `kid` to the actual JWK material: callers that want tamper-
 * evident key IDs can derive kid = thumbprint(jwk).
 */
export function jwkThumbprint(jwk: JwksKey): string {
  const minimal = { crv: jwk.crv, kty: jwk.kty, x: jwk.x };
  const bytes = new TextEncoder().encode(canonicalize(minimal));
  const digest = sha256(bytes);
  return base64urlEncode(digest);
}

/**
 * Verifier trust anchor. A JWKS alone says "this key signed something"; an
 * AuthorizedJwks binds each key to the issuer (and optionally the entity)
 * it is authorized to sign for. The verifier rejects capsules whose signed
 * `issuer`/`entity_id` don't match the authorization entry for the key's kid.
 */
export interface AuthorizedJwksEntry {
  kid: string;
  issuer: string;
  /** If set, the key is restricted to signing for these entity_ids. */
  entity_ids?: string[];
}

export interface AuthorizedJwks {
  keys: JwksKey[];
  /** kid → trust metadata. Every kid in `keys` SHOULD appear here. */
  authorizations: AuthorizedJwksEntry[];
}

export interface TrustAnchor {
  /** Either a raw JWKS (no issuer binding; dev/testing only) or AuthorizedJwks. */
  jwks: Jwks | AuthorizedJwks;
  /**
   * If true (default), verifier refuses to accept keys without an
   * AuthorizedJwksEntry. Set false to explicitly opt into the legacy
   * "any trusted key can sign for any issuer" posture. Not recommended
   * for production.
   */
  requireIssuerBinding?: boolean;
}

function isAuthorized(jwks: Jwks | AuthorizedJwks): jwks is AuthorizedJwks {
  return Array.isArray((jwks as AuthorizedJwks).authorizations);
}

export async function signCapsule(
  payload: CapsulePayload,
  key: PrivateSigningKey,
): Promise<string> {
  // Refuse to sign anything that wouldn't verify. This catches bugs on the
  // issuing side before bad capsules hit the wire.
  validateCapsulePayload(payload);

  // Bind kid to JWK material. If the caller supplied a separate `kid` that
  // doesn't match an embedded `jwk.kid`, refuse — silent relabel has caused
  // real rotation-audit drift.
  if (key.jwk.kid !== undefined && key.jwk.kid !== key.kid) {
    throw new Error(
      `PrivateSigningKey.kid ("${key.kid}") must equal PrivateSigningKey.jwk.kid ("${key.jwk.kid}")`,
    );
  }

  const cryptoKey = await importJWK(key.jwk, "EdDSA");
  const body = new TextEncoder().encode(canonicalize(payload));
  return await new CompactSign(body)
    .setProtectedHeader({ alg: "EdDSA", typ: JWS_TYP, kid: key.kid })
    .sign(cryptoKey);
}

function base64urlDecodeToBytes(s: string): Uint8Array {
  const padded = s + "=".repeat((4 - (s.length % 4)) % 4);
  const normalized = padded.replace(/-/g, "+").replace(/_/g, "/");
  try {
    if (typeof atob === "function") {
      const bin = atob(normalized);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    return new Uint8Array(Buffer.from(normalized, "base64"));
  } catch {
    throw new CapsuleVerificationError("jws_malformed", "invalid base64url segment");
  }
}

function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  const b64 = typeof btoa === "function" ? btoa(binary) : Buffer.from(bytes).toString("base64");
  return b64.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function decodeUtf8(bytes: Uint8Array): string {
  // TextDecoder("utf-8", {fatal: true}) rejects malformed UTF-8 instead of
  // silently substituting U+FFFD. Cross-language parity with Python's strict
  // json.loads(bytes.decode("utf-8")).
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new CapsuleVerificationError("jws_malformed", "JWS segment is not valid UTF-8");
  }
}

function parseProtectedHeader(jws: string): {
  alg?: unknown;
  typ?: unknown;
  kid?: unknown;
} {
  const firstDot = jws.indexOf(".");
  if (firstDot < 0) {
    throw new CapsuleVerificationError("jws_malformed", "JWS has no header segment");
  }
  const headerB64 = jws.slice(0, firstDot);
  const headerBytes = base64urlDecodeToBytes(headerB64);
  const headerJson = decodeUtf8(headerBytes);
  try {
    return JSON.parse(headerJson);
  } catch {
    throw new CapsuleVerificationError("jws_malformed", "JWS header is not valid JSON");
  }
}

function secondsBetween(aMs: number, bMs: number): number {
  return (aMs - bMs) / 1000;
}

export async function verifyCapsule(
  jws: string,
  trust: Jwks | AuthorizedJwks | TrustAnchor,
  options: VerifyOptions = {},
): Promise<VerifyCapsuleResult> {
  const skew = options.clockSkewSeconds ?? DEFAULT_SKEW_SECONDS;
  const now = options.now ?? new Date();

  // Accept three shapes for backwards-compat:
  //   1. Plain Jwks                (legacy; no issuer binding — warn-worthy)
  //   2. AuthorizedJwks            (has authorizations[])
  //   3. TrustAnchor { jwks, ... } (full control over requireIssuerBinding)
  let anchor: TrustAnchor;
  if ("jwks" in (trust as TrustAnchor)) {
    anchor = trust as TrustAnchor;
  } else {
    anchor = { jwks: trust as Jwks | AuthorizedJwks };
  }
  const requireBinding =
    anchor.requireIssuerBinding ?? isAuthorized(anchor.jwks);

  const parts = jws.split(".");
  if (parts.length !== 3) {
    throw new CapsuleVerificationError(
      "jws_malformed",
      `JWS must have exactly 3 segments, got ${parts.length}`,
    );
  }
  const [headerB64, payloadB64] = parts;
  if (!headerB64 || !payloadB64) {
    throw new CapsuleVerificationError("jws_malformed", "JWS has empty segments");
  }

  const header = parseProtectedHeader(jws);
  if (header.alg !== "EdDSA") {
    throw new CapsuleVerificationError(
      "signature_alg_not_supported",
      `unsupported alg: ${String(header.alg)}`,
    );
  }
  if (header.typ !== JWS_TYP) {
    throw new CapsuleVerificationError(
      "signature_typ_invalid",
      `unexpected typ: ${String(header.typ)}`,
    );
  }
  if (typeof header.kid !== "string" || header.kid.length === 0) {
    throw new CapsuleVerificationError("signature_kid_missing", "missing kid in JWS header");
  }

  const keys = anchor.jwks.keys;
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    throw new CapsuleVerificationError(
      "signature_kid_unknown",
      `no JWKS key with kid=${header.kid}`,
    );
  }
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519") {
    throw new CapsuleVerificationError(
      "jwks_key_invalid",
      `JWKS key for kid=${header.kid} must be OKP/Ed25519`,
    );
  }
  if (jwk.kid !== header.kid) {
    // The key entry's self-reported kid diverges from the lookup key. Abort.
    throw new CapsuleVerificationError(
      "signature_kid_mismatch",
      `JWKS entry kid "${jwk.kid}" disagrees with header kid "${header.kid}"`,
    );
  }

  let cryptoKey: Awaited<ReturnType<typeof importJWK>>;
  try {
    cryptoKey = await importJWK(jwk, "EdDSA");
  } catch (err) {
    throw new CapsuleVerificationError(
      "jwks_key_invalid",
      `JWKS key import failed: ${(err as Error).message}`,
    );
  }

  let verified: { payload: Uint8Array };
  try {
    verified = await compactVerify(jws, cryptoKey);
  } catch {
    throw new CapsuleVerificationError(
      "signature_invalid",
      "JWS signature verification failed",
    );
  }

  // Parse payload bytes once under a typed error umbrella. Any subsequent
  // decoding/canonicalization failure is deterministically mapped.
  const signedCanonical = decodeUtf8(verified.payload);
  let parsed: unknown;
  try {
    parsed = JSON.parse(signedCanonical);
  } catch {
    throw new CapsuleVerificationError("payload_invalid_json", "payload is not JSON");
  }

  // Canonical-form enforcement. The signer commits to JCS-canonicalized bytes;
  // the verifier MUST reject a valid-signature-over-non-canonical payload so
  // there is exactly one wire encoding per semantic capsule.
  const expectedCanonical = canonicalize(parsed);
  if (expectedCanonical !== signedCanonical) {
    throw new CapsuleVerificationError(
      "payload_not_canonical",
      "capsule payload is valid JSON but not JCS-canonical",
    );
  }

  let payload: CapsulePayload;
  try {
    payload = validateCapsulePayload(parsed);
  } catch (err) {
    if (err instanceof ValidationError) {
      throw new CapsuleVerificationError(
        "capsule_payload_invalid",
        `capsule failed schema validation: ${err.message}`,
      );
    }
    throw err;
  }

  if (payload.version !== "veto.capsule/1") {
    throw new CapsuleVerificationError(
      "capsule_version_unsupported",
      `unsupported capsule version: ${payload.version}`,
    );
  }

  // ---- Trust-anchor binding ----
  // A key proven to have signed the capsule is not enough. The trust anchor
  // MUST also authorize this key to sign for the claimed (issuer, entity_id).
  // Without this check, any trusted key in an aggregated JWKS could mint a
  // capsule for an issuer it was never authorized for.
  if (isAuthorized(anchor.jwks)) {
    const auth = anchor.jwks.authorizations.find((a) => a.kid === header.kid);
    if (!auth) {
      if (requireBinding) {
        throw new CapsuleVerificationError(
          "signature_kid_unknown",
          `kid "${header.kid}" has no authorization entry in trust anchor`,
        );
      }
    } else {
      if (auth.issuer !== payload.issuer) {
        throw new CapsuleVerificationError(
          "capsule_issuer_not_authorized",
          `kid "${header.kid}" is not authorized to sign for issuer "${payload.issuer}" (expected "${auth.issuer}")`,
        );
      }
      if (auth.entity_ids && !auth.entity_ids.includes(payload.entity_id)) {
        throw new CapsuleVerificationError(
          "capsule_entity_not_authorized",
          `kid "${header.kid}" is not authorized for entity_id "${payload.entity_id}"`,
        );
      }
    }
  } else if (requireBinding) {
    throw new CapsuleVerificationError(
      "signature_kid_unknown",
      "trust anchor has no authorizations; pass AuthorizedJwks or set requireIssuerBinding=false explicitly",
    );
  }

  // ---- Temporal validation ----
  let expiresMs: number;
  let issuedMs: number;
  try {
    expiresMs = parseRfc3339Strict(payload.expires_at).epochMs;
  } catch (err) {
    const msg = err instanceof Rfc3339ParseError ? err.message : String(err);
    throw new CapsuleVerificationError("capsule_expires_at_invalid", msg);
  }
  try {
    issuedMs = parseRfc3339Strict(payload.issued_at).epochMs;
  } catch (err) {
    const msg = err instanceof Rfc3339ParseError ? err.message : String(err);
    throw new CapsuleVerificationError("capsule_issued_at_invalid", msg);
  }

  const nowMs = now.getTime();
  if (secondsBetween(nowMs, expiresMs) > skew) {
    throw new CapsuleVerificationError(
      "capsule_expired",
      `capsule expired at ${payload.expires_at}`,
    );
  }
  if (secondsBetween(issuedMs, nowMs) > skew) {
    throw new CapsuleVerificationError(
      "capsule_issued_in_future",
      `capsule issued_at ${payload.issued_at} is beyond tolerated skew`,
    );
  }

  // Validate signature segment is well-formed base64url (already consumed by
  // compactVerify, but surface a clear error if caller hand-crafted garbage).
  base64urlDecodeToBytes(parts[2]!);

  return {
    payload,
    protectedHeader: {
      alg: "EdDSA",
      typ: JWS_TYP,
      kid: header.kid,
    },
  };
}

export function publicJwkFromPrivate(key: PrivateSigningKey): JwksKey {
  return {
    kty: key.jwk.kty,
    crv: key.jwk.crv,
    kid: key.kid,
    x: key.jwk.x,
    alg: "EdDSA",
    use: "sig",
  };
}
