// Hand-rolled validators for the two protocol payloads. We deliberately do not
// pull in `ajv` here to keep the package under the <10KB gzipped target — the
// validator surface is narrow enough that bespoke code is small, auditable,
// and avoids a schema-compiler footprint.
//
// Wire format is locked at veto.capsule/1 / veto.receipt/1. Any addition to
// the schema bumps the version string and adds a new validator.

import type { CapsulePayload, ReceiptPayload } from "./types.js";
import { parseRfc3339Strict, Rfc3339ParseError } from "./rfc3339.js";

const RE_CAPSULE_ID = /^cap_[0-9a-z]{24}$/;
const RE_WORKFLOW_ID = /^wf_[0-9a-z]{24}$/;
const RE_RECEIPT_ID = /^rcp_[0-9a-z]{24}$/;
const RE_SHA256_HEX = /^[0-9a-f]{64}$/;
const RE_SHA256_PREFIXED = /^sha256:[0-9a-f]{64}$/;
const RE_CURRENCY = /^[A-Z]{3,10}$/;
const RE_AMOUNT = /^\d+(\.\d{1,18})?$/;

const CAPSULE_REQUIRED = [
  "version",
  "capsule_id",
  "issuer",
  "entity_id",
  "agent_id",
  "rail_allowlist",
  "counterparty_hash",
  "amount_ceiling",
  "invoice_hash",
  "workflow_id",
  "policy_sha256",
  "issued_at",
  "expires_at",
  "nonce",
] as const;

const CAPSULE_ALLOWED = new Set<string>([
  ...CAPSULE_REQUIRED,
  "session_id",
  "memo_template",
  "approval_ref",
  "dual_control_ref",
  "max_uses",
]);

const AMOUNT_CEILING_ALLOWED = new Set<string>(["currency", "amount"]);
const RECEIPT_AMOUNT_ALLOWED = new Set<string>(["currency", "amount"]);

const ALLOWED_RAILS = new Set([
  "ach",
  "wire",
  "international_wire",
  "book",
  "usdc.eth",
  "usdc.sol",
  "usdc.base",
  "usdc.arb",
]);

export class ValidationError extends Error {
  readonly path: string;
  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "ValidationError";
    this.path = path;
  }
}

function requireString(
  value: unknown,
  path: string,
  pattern?: RegExp,
  maxLen?: number,
  minLen?: number,
): string {
  if (typeof value !== "string") {
    throw new ValidationError(path, `must be a string, got ${typeof value}`);
  }
  if (minLen !== undefined && value.length < minLen) {
    throw new ValidationError(path, `must be at least ${minLen} characters`);
  }
  if (pattern && !pattern.test(value)) {
    throw new ValidationError(path, `does not match required format ${pattern}`);
  }
  if (maxLen !== undefined && value.length > maxLen) {
    throw new ValidationError(path, `exceeds max length ${maxLen}`);
  }
  return value;
}

function requireStringOrNull(value: unknown, path: string, minLen?: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new ValidationError(path, `must be a string or null`);
  }
  if (minLen !== undefined && value.length < minLen) {
    throw new ValidationError(path, `must be at least ${minLen} characters`);
  }
  return value;
}

function requireRfc3339(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw new ValidationError(path, `must be a string, got ${typeof value}`);
  }
  try {
    parseRfc3339Strict(value);
  } catch (err) {
    if (err instanceof Rfc3339ParseError) {
      throw new ValidationError(path, err.message);
    }
    throw err;
  }
  return value;
}

/**
 * Validate an issuer URL. Must be https:// with no userinfo, query, or
 * fragment. An issuer is a trust identifier, not a dereferenceable link —
 * extra URL machinery just invites confusion attacks.
 */
function requireIssuer(value: unknown, path: string): string {
  const s = requireString(value, path, undefined, 2048, 1);
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    throw new ValidationError(path, "must be a valid URL");
  }
  if (url.protocol !== "https:") {
    throw new ValidationError(path, `must use https:// scheme; got ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new ValidationError(path, "must not contain userinfo (user:pass@)");
  }
  if (url.search) {
    throw new ValidationError(path, "must not contain a query string");
  }
  if (url.hash) {
    throw new ValidationError(path, "must not contain a fragment");
  }
  return s;
}

/**
 * Validate a Spend Capsule payload against veto.capsule/1. Throws
 * ValidationError on the first defect. Callers in sign/verify wrap this in
 * CapsuleVerificationError.
 */
export function validateCapsulePayload(input: unknown): CapsulePayload {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ValidationError("$", "must be a JSON object");
  }
  const obj = input as Record<string, unknown>;

  for (const key of Object.keys(obj)) {
    if (!CAPSULE_ALLOWED.has(key)) {
      throw new ValidationError(`$.${key}`, "additional properties are not allowed");
    }
  }
  for (const field of CAPSULE_REQUIRED) {
    if (!(field in obj)) {
      throw new ValidationError(`$.${field}`, "required field is missing");
    }
  }

  if (obj.version !== "veto.capsule/1") {
    throw new ValidationError("$.version", 'must be the literal "veto.capsule/1"');
  }
  requireString(obj.capsule_id, "$.capsule_id", RE_CAPSULE_ID);
  requireIssuer(obj.issuer, "$.issuer");
  requireString(obj.entity_id, "$.entity_id", undefined, 128, 1);
  requireString(obj.agent_id, "$.agent_id", undefined, 128, 1);
  if (obj.session_id !== undefined) requireString(obj.session_id, "$.session_id", undefined, 128, 1);

  if (!Array.isArray(obj.rail_allowlist) || obj.rail_allowlist.length < 1) {
    throw new ValidationError("$.rail_allowlist", "must be a non-empty array");
  }
  const seenRails = new Set<string>();
  for (let i = 0; i < obj.rail_allowlist.length; i++) {
    const rail = obj.rail_allowlist[i];
    if (typeof rail !== "string" || !ALLOWED_RAILS.has(rail)) {
      throw new ValidationError(`$.rail_allowlist[${i}]`, `invalid rail: ${String(rail)}`);
    }
    if (seenRails.has(rail)) {
      throw new ValidationError(`$.rail_allowlist[${i}]`, `duplicate rail: ${rail}`);
    }
    seenRails.add(rail);
  }

  requireString(obj.counterparty_hash, "$.counterparty_hash", RE_SHA256_PREFIXED);

  if (!obj.amount_ceiling || typeof obj.amount_ceiling !== "object" || Array.isArray(obj.amount_ceiling)) {
    throw new ValidationError("$.amount_ceiling", "must be an object");
  }
  const ac = obj.amount_ceiling as Record<string, unknown>;
  for (const key of Object.keys(ac)) {
    if (!AMOUNT_CEILING_ALLOWED.has(key)) {
      throw new ValidationError(`$.amount_ceiling.${key}`, "additional properties are not allowed");
    }
  }
  if (!("currency" in ac)) {
    throw new ValidationError("$.amount_ceiling.currency", "required field is missing");
  }
  if (!("amount" in ac)) {
    throw new ValidationError("$.amount_ceiling.amount", "required field is missing");
  }
  requireString(ac.currency, "$.amount_ceiling.currency", RE_CURRENCY);
  requireString(ac.amount, "$.amount_ceiling.amount", RE_AMOUNT);

  if (obj.memo_template !== undefined) {
    requireString(obj.memo_template, "$.memo_template", undefined, 140);
  }
  requireString(obj.invoice_hash, "$.invoice_hash", RE_SHA256_PREFIXED);
  requireString(obj.workflow_id, "$.workflow_id", RE_WORKFLOW_ID);
  requireString(obj.policy_sha256, "$.policy_sha256", RE_SHA256_HEX);
  if ("approval_ref" in obj) requireStringOrNull(obj.approval_ref, "$.approval_ref", 1);
  if ("dual_control_ref" in obj) requireStringOrNull(obj.dual_control_ref, "$.dual_control_ref", 1);

  requireRfc3339(obj.issued_at, "$.issued_at");
  requireRfc3339(obj.expires_at, "$.expires_at");

  // expires_at must be strictly after issued_at. A capsule that's born
  // expired is always a bug.
  const issuedMs = parseRfc3339Strict(obj.issued_at as string).epochMs;
  const expiresMs = parseRfc3339Strict(obj.expires_at as string).epochMs;
  if (expiresMs <= issuedMs) {
    throw new ValidationError("$.expires_at", "must be strictly after issued_at");
  }

  if (obj.max_uses !== undefined) {
    if (typeof obj.max_uses !== "number" || !Number.isInteger(obj.max_uses) || obj.max_uses < 1) {
      throw new ValidationError(
        "$.max_uses",
        "must be a positive integer (>= 1); null/0 are not allowed",
      );
    }
  }
  const nonce = requireString(obj.nonce, "$.nonce");
  if (nonce.length < 16) {
    throw new ValidationError("$.nonce", "must be at least 16 characters");
  }

  return obj as unknown as CapsulePayload;
}

const RECEIPT_REQUIRED = [
  "version",
  "receipt_id",
  "entity_id",
  "agent_id",
  "tool",
  "decision",
  "issued_at",
  "args_hash",
  "result_hash",
  "policy_hash",
  "prev_receipt_hash",
  "merkle_root",
] as const;

const RECEIPT_ALLOWED = new Set<string>([
  ...RECEIPT_REQUIRED,
  "session_id",
  "workflow_id",
  "capsule_id",
  "reason_code",
  "reason_detail",
  "approval_hash",
  "policy_pack_id",
  "counterparty_hash",
  "rail",
  "amount",
]);

const ALLOWED_DECISIONS = new Set(["allow", "deny", "require_approval"]);
const RE_REASON_CODE = /^[a-z][a-z0-9_]{0,63}$/;

export function validateReceiptPayload(input: unknown): ReceiptPayload {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ValidationError("$", "must be a JSON object");
  }
  const obj = input as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!RECEIPT_ALLOWED.has(key)) {
      throw new ValidationError(`$.${key}`, "additional properties are not allowed");
    }
  }
  for (const field of RECEIPT_REQUIRED) {
    if (!(field in obj)) {
      throw new ValidationError(`$.${field}`, "required field is missing");
    }
  }
  if (obj.version !== "veto.receipt/1") {
    throw new ValidationError("$.version", 'must be the literal "veto.receipt/1"');
  }
  requireString(obj.receipt_id, "$.receipt_id", RE_RECEIPT_ID);
  requireString(obj.entity_id, "$.entity_id", undefined, 128, 1);
  requireString(obj.agent_id, "$.agent_id", undefined, 128, 1);
  requireString(obj.tool, "$.tool", /^[a-z][a-z0-9_.:-]{0,127}$/);

  if (typeof obj.decision !== "string" || !ALLOWED_DECISIONS.has(obj.decision)) {
    throw new ValidationError("$.decision", `invalid decision: ${String(obj.decision)}`);
  }
  requireRfc3339(obj.issued_at, "$.issued_at");
  requireString(obj.args_hash, "$.args_hash", RE_SHA256_PREFIXED);
  if (obj.result_hash !== null) {
    requireString(obj.result_hash, "$.result_hash", RE_SHA256_PREFIXED);
  }
  requireString(obj.policy_hash, "$.policy_hash", RE_SHA256_HEX);
  requireString(obj.prev_receipt_hash, "$.prev_receipt_hash", RE_SHA256_PREFIXED);
  requireString(obj.merkle_root, "$.merkle_root", RE_SHA256_PREFIXED);

  // Optional fields — fully validate when present.
  if ("session_id" in obj && obj.session_id !== undefined) {
    requireString(obj.session_id, "$.session_id", undefined, 128, 1);
  }
  if ("workflow_id" in obj && obj.workflow_id !== undefined) {
    requireString(obj.workflow_id, "$.workflow_id", RE_WORKFLOW_ID);
  }
  if ("capsule_id" in obj && obj.capsule_id !== null && obj.capsule_id !== undefined) {
    requireString(obj.capsule_id, "$.capsule_id", RE_CAPSULE_ID);
  }
  if ("reason_code" in obj && obj.reason_code !== undefined) {
    requireString(obj.reason_code, "$.reason_code", RE_REASON_CODE);
  }
  if ("reason_detail" in obj && obj.reason_detail !== undefined) {
    requireString(obj.reason_detail, "$.reason_detail", undefined, 1024);
  }
  if ("approval_hash" in obj && obj.approval_hash !== null && obj.approval_hash !== undefined) {
    requireString(obj.approval_hash, "$.approval_hash", RE_SHA256_PREFIXED);
  }
  if ("policy_pack_id" in obj && obj.policy_pack_id !== undefined) {
    requireString(obj.policy_pack_id, "$.policy_pack_id", /^[a-z][a-z0-9_]{0,63}$/);
  }
  if ("counterparty_hash" in obj && obj.counterparty_hash !== null && obj.counterparty_hash !== undefined) {
    requireString(obj.counterparty_hash, "$.counterparty_hash", RE_SHA256_PREFIXED);
  }
  if ("rail" in obj && obj.rail !== null && obj.rail !== undefined) {
    if (typeof obj.rail !== "string" || !ALLOWED_RAILS.has(obj.rail)) {
      throw new ValidationError("$.rail", `invalid rail: ${String(obj.rail)}`);
    }
  }
  if ("amount" in obj && obj.amount !== null && obj.amount !== undefined) {
    if (typeof obj.amount !== "object" || Array.isArray(obj.amount)) {
      throw new ValidationError("$.amount", "must be an object");
    }
    const am = obj.amount as Record<string, unknown>;
    for (const key of Object.keys(am)) {
      if (!RECEIPT_AMOUNT_ALLOWED.has(key)) {
        throw new ValidationError(`$.amount.${key}`, "additional properties are not allowed");
      }
    }
    if (!("currency" in am)) {
      throw new ValidationError("$.amount.currency", "required field is missing");
    }
    if (!("amount" in am)) {
      throw new ValidationError("$.amount.amount", "required field is missing");
    }
    requireString(am.currency, "$.amount.currency", RE_CURRENCY);
    requireString(am.amount, "$.amount.amount", RE_AMOUNT);
  }

  return obj as unknown as ReceiptPayload;
}
