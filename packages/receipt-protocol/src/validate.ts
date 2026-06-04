import type { DecisionReceiptPayload } from "./types.js";
import { parseRfc3339Strict, Rfc3339ParseError } from "./rfc3339.js";

const RE_RECEIPT_ID = /^rcp_[0-9a-z]{24}$/;
const RE_SHA256_PREFIXED = /^sha256:[0-9a-f]{64}$/;
const RE_ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const RE_TOOL_NAME = /^[A-Za-z0-9_.:/-]{1,200}$/;
const RE_REASON_CODE = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;
const ALLOWED_DECISIONS = new Set([
  "allow",
  "deny",
  "require_approval",
  "approval_approved",
  "approval_denied",
]);

const REQUIRED = [
  "version",
  "receipt_id",
  "organization_id",
  "project_id",
  "decision_id",
  "tool_name",
  "policy_version",
  "policy_hash",
  "decision",
  "redacted_arguments",
  "argument_hash",
  "result_hash",
  "approval_hash",
  "previous_receipt_hash",
  "merkle_root",
  "timestamp",
] as const;

const ALLOWED = new Set<string>([
  ...REQUIRED,
  "approval_id",
  "session_id",
  "agent_id",
  "client_id",
  "connection_id",
  "upstream_id",
  "tool_schema_hash",
  "policy_id",
  "reason_code",
  "reason_detail",
  "trace_id",
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
  if (maxLen !== undefined && value.length > maxLen) {
    throw new ValidationError(path, `exceeds max length ${maxLen}`);
  }
  if (pattern && !pattern.test(value)) {
    throw new ValidationError(path, `does not match required format ${pattern}`);
  }
  return value;
}

function requireStringOrNull(
  value: unknown,
  path: string,
  pattern?: RegExp,
  maxLen?: number,
  minLen?: number,
): string | null {
  if (value === null || value === undefined) return null;
  return requireString(value, path, pattern, maxLen, minLen);
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

export function requireSha256(value: unknown, path: string): string {
  return requireString(value, path, RE_SHA256_PREFIXED);
}

export function validateDecisionReceiptPayload(input: unknown): DecisionReceiptPayload {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ValidationError("$", "must be a JSON object");
  }
  const obj = input as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!ALLOWED.has(key)) {
      throw new ValidationError(`$.${key}`, "additional properties are not allowed");
    }
  }
  for (const field of REQUIRED) {
    if (!(field in obj)) {
      throw new ValidationError(`$.${field}`, "required field is missing");
    }
  }

  if (obj.version !== "veto.receipt/1") {
    throw new ValidationError("$.version", 'must be the literal "veto.receipt/1"');
  }
  requireString(obj.receipt_id, "$.receipt_id", RE_RECEIPT_ID);
  requireString(obj.organization_id, "$.organization_id", RE_ID);
  requireStringOrNull(obj.project_id, "$.project_id", RE_ID);
  requireString(obj.decision_id, "$.decision_id", RE_ID);
  if ("approval_id" in obj) requireStringOrNull(obj.approval_id, "$.approval_id", RE_ID);
  if ("session_id" in obj) requireStringOrNull(obj.session_id, "$.session_id", RE_ID);
  if ("agent_id" in obj) requireStringOrNull(obj.agent_id, "$.agent_id", RE_ID);
  if ("client_id" in obj) requireStringOrNull(obj.client_id, "$.client_id", RE_ID);
  if ("connection_id" in obj) requireStringOrNull(obj.connection_id, "$.connection_id", undefined, 256, 1);
  if ("upstream_id" in obj) requireStringOrNull(obj.upstream_id, "$.upstream_id", RE_ID);
  requireString(obj.tool_name, "$.tool_name", RE_TOOL_NAME);
  if ("tool_schema_hash" in obj) requireStringOrNull(obj.tool_schema_hash, "$.tool_schema_hash", RE_SHA256_PREFIXED);
  if ("policy_id" in obj) requireStringOrNull(obj.policy_id, "$.policy_id", RE_ID);
  requireString(obj.policy_version, "$.policy_version", undefined, 128, 1);
  requireSha256(obj.policy_hash, "$.policy_hash");

  if (typeof obj.decision !== "string" || !ALLOWED_DECISIONS.has(obj.decision)) {
    throw new ValidationError("$.decision", `invalid decision: ${String(obj.decision)}`);
  }
  if ("reason_code" in obj) requireStringOrNull(obj.reason_code, "$.reason_code", RE_REASON_CODE);
  if ("reason_detail" in obj) requireStringOrNull(obj.reason_detail, "$.reason_detail", undefined, 2048);

  requireSha256(obj.argument_hash, "$.argument_hash");
  requireStringOrNull(obj.result_hash, "$.result_hash", RE_SHA256_PREFIXED);
  requireStringOrNull(obj.approval_hash, "$.approval_hash", RE_SHA256_PREFIXED);
  requireSha256(obj.previous_receipt_hash, "$.previous_receipt_hash");
  requireSha256(obj.merkle_root, "$.merkle_root");
  requireRfc3339(obj.timestamp, "$.timestamp");
  if ("trace_id" in obj) requireStringOrNull(obj.trace_id, "$.trace_id", undefined, 256, 1);

  return obj as unknown as DecisionReceiptPayload;
}
