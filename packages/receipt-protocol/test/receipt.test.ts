import { describe, expect, it } from "vitest";
import {
  buildDecisionReceipt,
  createReceiptId,
  formatReceiptNdjson,
  hashCanonical,
  hashDecisionReceipt,
  parseRfc3339Strict,
  parseReceiptNdjson,
  validateDecisionReceiptPayload,
  ValidationError,
  verifyDecisionReceiptChain,
  type DecisionReceiptDraft,
} from "../src/index.js";

function draft(overrides: Partial<DecisionReceiptDraft> = {}): DecisionReceiptDraft {
  return {
    receipt_id: createReceiptId(),
    organization_id: "org_test",
    project_id: "proj_test",
    decision_id: `dec_${Math.random().toString(16).slice(2, 14)}`,
    approval_id: null,
    session_id: null,
    agent_id: "agent_test",
    client_id: "client_test",
    connection_id: null,
    upstream_id: null,
    tool_name: "filesystem.write",
    tool_schema_hash: null,
    policy_id: "pol_test",
    policy_version: "1",
    policy_hash: hashCanonical({ policy: "deny-risky-write" }),
    decision: "allow",
    reason_code: "allowed",
    reason_detail: "matched allow rule",
    redacted_arguments: { path: "/tmp/example", body: "[redacted]" },
    argument_hash: hashCanonical({ path: "/tmp/example", body: "secret" }),
    result_hash: hashCanonical({ ok: true }),
    approval_hash: null,
    timestamp: "2026-06-02T12:00:00Z",
    trace_id: null,
    ...overrides,
  };
}

describe("decision receipt protocol", () => {
  it("hashes canonical payloads independent of object key insertion order", () => {
    const first = buildDecisionReceipt({ draft: draft(), previous: null });
    const reordered = JSON.parse(JSON.stringify(first));
    const second = {
      tool_name: reordered.tool_name,
      version: reordered.version,
      receipt_id: reordered.receipt_id,
      organization_id: reordered.organization_id,
      project_id: reordered.project_id,
      decision_id: reordered.decision_id,
      approval_id: reordered.approval_id,
      session_id: reordered.session_id,
      agent_id: reordered.agent_id,
      client_id: reordered.client_id,
      connection_id: reordered.connection_id,
      upstream_id: reordered.upstream_id,
      tool_schema_hash: reordered.tool_schema_hash,
      policy_id: reordered.policy_id,
      policy_version: reordered.policy_version,
      policy_hash: reordered.policy_hash,
      decision: reordered.decision,
      reason_code: reordered.reason_code,
      reason_detail: reordered.reason_detail,
      redacted_arguments: reordered.redacted_arguments,
      argument_hash: reordered.argument_hash,
      result_hash: reordered.result_hash,
      approval_hash: reordered.approval_hash,
      previous_receipt_hash: reordered.previous_receipt_hash,
      merkle_root: reordered.merkle_root,
      timestamp: reordered.timestamp,
      trace_id: reordered.trace_id,
    };

    expect(hashDecisionReceipt(second)).toEqual(hashDecisionReceipt(first));
  });

  it("verifies a linked chain and detects tampering", () => {
    const first = buildDecisionReceipt({ draft: draft(), previous: null });
    const second = buildDecisionReceipt({
      draft: draft({
        decision_id: "dec_followup",
        receipt_id: createReceiptId(),
        timestamp: "2026-06-02T12:00:01Z",
      }),
      previous: first,
    });
    const third = buildDecisionReceipt({
      draft: draft({
        decision_id: "dec_after_tamper",
        receipt_id: createReceiptId(),
        timestamp: "2026-06-02T12:00:02Z",
      }),
      previous: second,
    });

    expect(verifyDecisionReceiptChain([first, second, third])).toEqual({ ok: true });
    expect(
      verifyDecisionReceiptChain([
        first,
        { ...second, reason_detail: "tampered after export" },
        third,
      ]).ok,
    ).toBe(false);
  });

  it("allows nullable result hashes for deny/approval outcomes and approval hashes", () => {
    const receipt = buildDecisionReceipt({
      draft: draft({
        decision: "require_approval",
        result_hash: null,
        approval_hash: hashCanonical({ approval_id: "appr_test", status: "pending" }),
      }),
      previous: null,
    });

    expect(receipt.result_hash).toBeNull();
    expect(receipt.approval_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(verifyDecisionReceiptChain([receipt])).toEqual({ ok: true });
  });

  it("rejects undefined for required nullable hash fields", () => {
    const receipt = buildDecisionReceipt({ draft: draft(), previous: null });

    expect(() =>
      validateDecisionReceiptPayload({
        ...receipt,
        result_hash: undefined,
      }),
    ).toThrow(ValidationError);
  });

  it("preserves RFC 3339 years below 100 when computing canonical UTC time", () => {
    const parsed = parseRfc3339Strict("0099-12-31T23:59:59.123Z");

    expect(parsed.canonical).toBe("0099-12-31T23:59:59.123Z");
    expect(new Date(parsed.epochMs).getUTCFullYear()).toBe(99);
  });

  it("round-trips canonical NDJSON exports", () => {
    const first = buildDecisionReceipt({ draft: draft(), previous: null });
    const second = buildDecisionReceipt({
      draft: draft({
        decision_id: "dec_export",
        receipt_id: createReceiptId(),
        timestamp: "2026-06-02T12:00:02Z",
      }),
      previous: first,
    });

    const ndjson = formatReceiptNdjson([first, second]);
    const parsed = parseReceiptNdjson(ndjson);
    expect(parsed).toEqual([first, second]);
    expect(verifyDecisionReceiptChain(parsed)).toEqual({ ok: true });
  });
});
