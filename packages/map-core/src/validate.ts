import {
  MAP_ACTION_PROPOSAL_VERSION,
  MAP_APPROVAL_VERSION,
  MAP_AUTHORITY_VERSION,
  MAP_DECISION_OUTCOME_VERSION,
  MAP_POLICY_BUNDLE_VERSION,
  MAP_RECEIPT_VERSION,
  type MapActionProposal,
  type MapActor,
  type MapApproval,
  type MapArtifact,
  type MapAuthority,
  type MapDecision,
  type MapDecisionOutcome,
  type MapFixture,
  type MapPolicyBundle,
  type MapPolicyRule,
  type MapReceiptPointer,
} from "./types.js";

const RE_ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const RE_ACTION = /^[A-Za-z0-9_.:/-]{1,200}$/;
const RE_REASON = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;
const RE_SHA256 = /^sha256:[0-9a-f]{64}$/;
const RE_RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const DECISIONS = new Set<MapDecision>(["allow", "deny", "require_approval"]);

export class MapValidationError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "MapValidationError";
    this.path = path;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new MapValidationError(path, "must be an object");
  return value;
}

function requireString(value: unknown, path: string, pattern?: RegExp): string {
  if (typeof value !== "string") throw new MapValidationError(path, "must be a string");
  if (value.length === 0) throw new MapValidationError(path, "must not be empty");
  if (pattern && !pattern.test(value)) throw new MapValidationError(path, `does not match ${pattern}`);
  return value;
}

function optionalStringOrNull(value: unknown, path: string, pattern?: RegExp): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return requireString(value, path, pattern);
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new MapValidationError(path, "must be a boolean");
  return value;
}

function requireArray<T>(value: unknown, path: string, parse: (item: unknown, itemPath: string) => T): T[] {
  if (!Array.isArray(value)) throw new MapValidationError(path, "must be an array");
  return value.map((item, index) => parse(item, `${path}[${index}]`));
}

function requireRecordOrNull(value: unknown, path: string): Record<string, unknown> | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return requireRecord(value, path);
}

function requireRfc3339(value: unknown, path: string): string {
  const text = requireString(value, path);
  const match = text.match(RE_RFC3339);
  const ms = Date.parse(text);
  if (!Number.isFinite(ms) || !match) {
    throw new MapValidationError(path, "must be an RFC 3339 timestamp");
  }

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offsetText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const daysInMonth = month >= 1 && month <= 12
    ? new Date(Date.UTC(year, month, 0)).getUTCDate()
    : 0;
  const offsetParts = offsetText === "Z" ? null : offsetText.slice(1).split(":").map(Number);
  const offsetHour = offsetParts?.[0] ?? 0;
  const offsetMinute = offsetParts?.[1] ?? 0;

  if (
    month < 1
    || month > 12
    || day < 1
    || day > daysInMonth
    || hour > 23
    || minute > 59
    || second > 59
    || offsetHour > 23
    || offsetMinute > 59
  ) {
    throw new MapValidationError(path, "must be an RFC 3339 timestamp");
  }
  return text;
}

function optionalRfc3339OrNull(value: unknown, path: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return requireRfc3339(value, path);
}

function requireDecision(value: unknown, path: string): MapDecision {
  if (typeof value !== "string" || !DECISIONS.has(value as MapDecision)) {
    throw new MapValidationError(path, "must be allow, deny, or require_approval");
  }
  return value as MapDecision;
}

function validateActor(value: unknown, path: string): MapActor {
  const obj = requireRecord(value, path);
  const kind = requireString(obj.kind, `${path}.kind`);
  if (!["human", "agent", "service", "organization"].includes(kind)) {
    throw new MapValidationError(`${path}.kind`, "must be human, agent, service, or organization");
  }
  return {
    id: requireString(obj.id, `${path}.id`, RE_ID),
    kind: kind as MapActor["kind"],
  };
}

function validateActionProposal(input: unknown, path: string): MapActionProposal {
  const obj = requireRecord(input, path);
  return {
    version: MAP_ACTION_PROPOSAL_VERSION,
    proposal_id: requireString(obj.proposal_id, `${path}.proposal_id`, RE_ID),
    action: requireString(obj.action, `${path}.action`, RE_ACTION),
    arguments: obj.arguments ?? {},
    actor: validateActor(obj.actor, `${path}.actor`),
    subject: obj.subject === undefined ? undefined : obj.subject === null ? null : validateActor(obj.subject, `${path}.subject`),
    audience: requireArray(obj.audience, `${path}.audience`, (item, itemPath) => requireString(item, itemPath, RE_ID)),
    created_at: requireRfc3339(obj.created_at, `${path}.created_at`),
    expires_at: optionalRfc3339OrNull(obj.expires_at, `${path}.expires_at`),
    nonce: requireString(obj.nonce, `${path}.nonce`, RE_ID),
  };
}

function validateAuthority(input: unknown, path: string): MapAuthority {
  const obj = requireRecord(input, path);
  return {
    version: MAP_AUTHORITY_VERSION,
    authority_id: requireString(obj.authority_id, `${path}.authority_id`, RE_ID),
    issuer: validateActor(obj.issuer, `${path}.issuer`),
    subject: validateActor(obj.subject, `${path}.subject`),
    delegator: obj.delegator === undefined ? undefined : obj.delegator === null ? null : validateActor(obj.delegator, `${path}.delegator`),
    audience: requireArray(obj.audience, `${path}.audience`, (item, itemPath) => requireString(item, itemPath, RE_ID)),
    actions: requireArray(obj.actions, `${path}.actions`, (item, itemPath) => requireString(item, itemPath, RE_ACTION)),
    scope: requireRecord(obj.scope, `${path}.scope`),
    limits: requireRecordOrNull(obj.limits, `${path}.limits`),
    conditions: requireRecordOrNull(obj.conditions, `${path}.conditions`),
    valid_from: requireRfc3339(obj.valid_from, `${path}.valid_from`),
    valid_until: optionalRfc3339OrNull(obj.valid_until, `${path}.valid_until`),
    evidence: requireRecordOrNull(obj.evidence, `${path}.evidence`),
    receipt_required: requireBoolean(obj.receipt_required, `${path}.receipt_required`),
  };
}

function validatePolicyRule(input: unknown, path: string): MapPolicyRule {
  const obj = requireRecord(input, path);
  return {
    rule_id: requireString(obj.rule_id, `${path}.rule_id`, RE_ID),
    action: requireString(obj.action, `${path}.action`, RE_ACTION),
    effect: requireDecision(obj.effect, `${path}.effect`),
    reason_code: requireString(obj.reason_code, `${path}.reason_code`, RE_REASON),
    conditions: requireRecordOrNull(obj.conditions, `${path}.conditions`),
    limits: requireRecordOrNull(obj.limits, `${path}.limits`),
  };
}

function validatePolicyBundle(input: unknown, path: string): MapPolicyBundle {
  const obj = requireRecord(input, path);
  return {
    version: MAP_POLICY_BUNDLE_VERSION,
    bundle_id: requireString(obj.bundle_id, `${path}.bundle_id`, RE_ID),
    issuer: validateActor(obj.issuer, `${path}.issuer`),
    audience: requireArray(obj.audience, `${path}.audience`, (item, itemPath) => requireString(item, itemPath, RE_ID)),
    valid_from: requireRfc3339(obj.valid_from, `${path}.valid_from`),
    valid_until: optionalRfc3339OrNull(obj.valid_until, `${path}.valid_until`),
    authorities: requireArray(obj.authorities, `${path}.authorities`, validateAuthority),
    rules: requireArray(obj.rules, `${path}.rules`, validatePolicyRule),
    default_decision: requireDecision(obj.default_decision, `${path}.default_decision`),
    receipt_required: requireBoolean(obj.receipt_required, `${path}.receipt_required`),
  };
}

function validateApproval(input: unknown, path: string): MapApproval {
  const obj = requireRecord(input, path);
  const decision = requireString(obj.decision, `${path}.decision`);
  if (!["approved", "denied"].includes(decision)) {
    throw new MapValidationError(`${path}.decision`, "must be approved or denied");
  }
  return {
    version: MAP_APPROVAL_VERSION,
    approval_id: requireString(obj.approval_id, `${path}.approval_id`, RE_ID),
    proposal_id: requireString(obj.proposal_id, `${path}.proposal_id`, RE_ID),
    action_commitment: requireString(obj.action_commitment, `${path}.action_commitment`, RE_SHA256),
    approver: validateActor(obj.approver, `${path}.approver`),
    decision: decision as MapApproval["decision"],
    reason_code: optionalStringOrNull(obj.reason_code, `${path}.reason_code`, RE_REASON),
    created_at: requireRfc3339(obj.created_at, `${path}.created_at`),
    expires_at: requireRfc3339(obj.expires_at, `${path}.expires_at`),
    nonce: requireString(obj.nonce, `${path}.nonce`, RE_ID),
  };
}

function validateDecisionOutcome(input: unknown, path: string): MapDecisionOutcome {
  const obj = requireRecord(input, path);
  return {
    version: MAP_DECISION_OUTCOME_VERSION,
    outcome_id: requireString(obj.outcome_id, `${path}.outcome_id`, RE_ID),
    proposal_id: requireString(obj.proposal_id, `${path}.proposal_id`, RE_ID),
    action_commitment: requireString(obj.action_commitment, `${path}.action_commitment`, RE_SHA256),
    policy_bundle_id: optionalStringOrNull(obj.policy_bundle_id, `${path}.policy_bundle_id`, RE_ID),
    decision: requireDecision(obj.decision, `${path}.decision`),
    reason_code: requireString(obj.reason_code, `${path}.reason_code`, RE_REASON),
    reason_detail: optionalStringOrNull(obj.reason_detail, `${path}.reason_detail`),
    approval_id: optionalStringOrNull(obj.approval_id, `${path}.approval_id`, RE_ID),
    receipt_required: requireBoolean(obj.receipt_required, `${path}.receipt_required`),
    evaluated_at: requireRfc3339(obj.evaluated_at, `${path}.evaluated_at`),
  };
}

function validateReceiptPointer(input: unknown, path: string): MapReceiptPointer {
  const obj = requireRecord(input, path);
  return {
    version: MAP_RECEIPT_VERSION,
    receipt_id: requireString(obj.receipt_id, `${path}.receipt_id`, RE_ID),
    receipt_hash: requireString(obj.receipt_hash, `${path}.receipt_hash`, RE_SHA256),
    outcome_id: requireString(obj.outcome_id, `${path}.outcome_id`, RE_ID),
    decision_id: optionalStringOrNull(obj.decision_id, `${path}.decision_id`, RE_ID),
  };
}

export function validateMapArtifact(input: unknown, path = "$"): MapArtifact {
  const obj = requireRecord(input, path);
  switch (obj.version) {
    case MAP_ACTION_PROPOSAL_VERSION:
      return validateActionProposal(input, path);
    case MAP_AUTHORITY_VERSION:
      return validateAuthority(input, path);
    case MAP_POLICY_BUNDLE_VERSION:
      return validatePolicyBundle(input, path);
    case MAP_APPROVAL_VERSION:
      return validateApproval(input, path);
    case MAP_DECISION_OUTCOME_VERSION:
      return validateDecisionOutcome(input, path);
    case MAP_RECEIPT_VERSION:
      return validateReceiptPointer(input, path);
    default:
      throw new MapValidationError(`${path}.version`, `unsupported MAP artifact version: ${String(obj.version)}`);
  }
}

export function validateMapFixture(input: unknown): MapFixture {
  const obj = requireRecord(input, "$");
  return {
    name: requireString(obj.name, "$.name", RE_ID),
    description: requireString(obj.description, "$.description"),
    artifacts: requireArray(obj.artifacts, "$.artifacts", validateMapArtifact),
    expected_decision: requireDecision(obj.expected_decision, "$.expected_decision"),
    expected_reason_code: requireString(obj.expected_reason_code, "$.expected_reason_code", RE_REASON),
  };
}
