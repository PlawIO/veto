// Hand-rolled validators for the two protocol payloads. We deliberately do not
// pull in `ajv` here to keep the package under the <10KB gzipped target — the
// validator surface is narrow enough that bespoke code is small, auditable,
// and avoids a schema-compiler footprint.
//
// Wire format is locked at veto.capsule/1 / veto.receipt/1. Any addition to
// the schema bumps the version string and adds a new validator.

import type { CapsulePayload, ReceiptPayload } from "./types.js";

const RE_CAPSULE_ID = /^cap_[0-9a-z]{24}$/;
const RE_WORKFLOW_ID = /^wf_[0-9a-z]{24}$/;
const RE_RECEIPT_ID = /^rcp_[0-9a-z]{24}$/;
const RE_SHA256_HEX = /^[0-9a-f]{64}$/;
const RE_SHA256_PREFIXED = /^sha256:[0-9a-f]{64}$/;
const RE_CURRENCY = /^[A-Z]{3,10}$/;
const RE_AMOUNT = /^\d+(\.\d{1,18})?$/;
// RFC 3339 date-time with explicit offset (Z or ±HH:MM). Rejects naive local
// strings like "2026-04-17T14:00:00" that have caused timezone drift bugs.
const RE_RFC3339 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

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

function requireString(value: unknown, path: string, pattern?: RegExp, maxLen?: number): string {
  if (typeof value !== "string") {
    throw new ValidationError(path, `must be a string, got ${typeof value}`);
  }
  if (pattern && !pattern.test(value)) {
    throw new ValidationError(path, `does not match required format ${pattern}`);
  }
  if (maxLen !== undefined && value.length > maxLen) {
    throw new ValidationError(path, `exceeds max length ${maxLen}`);
  }
  return value;
}

function requireStringOrNull(value: unknown, path: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new ValidationError(path, `must be a string or null`);
  }
  return value;
}

function requireRfc3339(value: unknown, path: string): string {
  const s = requireString(value, path);
  if (!RE_RFC3339.test(s)) {
    throw new ValidationError(
      path,
      `must be RFC 3339 with explicit offset (e.g., "...Z" or "...+00:00"); naive local strings rejected`,
    );
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

  // additionalProperties: false — match JSON Schema's strict mode.
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
  requireString(obj.issuer, "$.issuer");
  try {
    new URL(obj.issuer as string);
  } catch {
    throw new ValidationError("$.issuer", "must be a valid URI");
  }
  requireString(obj.entity_id, "$.entity_id");
  requireString(obj.agent_id, "$.agent_id");
  if (obj.session_id !== undefined) requireString(obj.session_id, "$.session_id");

  if (!Array.isArray(obj.rail_allowlist) || obj.rail_allowlist.length < 1) {
    throw new ValidationError("$.rail_allowlist", "must be a non-empty array");
  }
  for (let i = 0; i < obj.rail_allowlist.length; i++) {
    const rail = obj.rail_allowlist[i];
    if (typeof rail !== "string" || !ALLOWED_RAILS.has(rail)) {
      throw new ValidationError(`$.rail_allowlist[${i}]`, `invalid rail: ${String(rail)}`);
    }
  }

  requireString(obj.counterparty_hash, "$.counterparty_hash", RE_SHA256_PREFIXED);

  if (!obj.amount_ceiling || typeof obj.amount_ceiling !== "object") {
    throw new ValidationError("$.amount_ceiling", "must be an object");
  }
  const ac = obj.amount_ceiling as Record<string, unknown>;
  requireString(ac.currency, "$.amount_ceiling.currency", RE_CURRENCY);
  requireString(ac.amount, "$.amount_ceiling.amount", RE_AMOUNT);

  if (obj.memo_template !== undefined) {
    requireString(obj.memo_template, "$.memo_template", undefined, 140);
  }
  requireString(obj.invoice_hash, "$.invoice_hash", RE_SHA256_PREFIXED);
  requireString(obj.workflow_id, "$.workflow_id", RE_WORKFLOW_ID);
  requireString(obj.policy_sha256, "$.policy_sha256", RE_SHA256_HEX);
  if ("approval_ref" in obj) requireStringOrNull(obj.approval_ref, "$.approval_ref");
  if ("dual_control_ref" in obj) requireStringOrNull(obj.dual_control_ref, "$.dual_control_ref");

  requireRfc3339(obj.issued_at, "$.issued_at");
  requireRfc3339(obj.expires_at, "$.expires_at");

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
  requireString(obj.entity_id, "$.entity_id");
  requireString(obj.agent_id, "$.agent_id");
  requireString(obj.tool, "$.tool");
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

  return obj as unknown as ReceiptPayload;
}
