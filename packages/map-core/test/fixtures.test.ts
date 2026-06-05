import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MAP_ACTION_PROPOSAL_VERSION,
  MAP_APPROVAL_VERSION,
  MAP_DECISION_OUTCOME_VERSION,
  canonicalize,
  computeCommitment,
  validateMapArtifact,
  validateMapFixture,
  type MapActionProposal,
  type MapApproval,
  type MapDecisionOutcome,
} from "../src/index.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

function loadFixture(file: string): unknown {
  return JSON.parse(readFileSync(join(fixturesDir, file), "utf8"));
}

function proposalsById(artifacts: ReturnType<typeof validateMapFixture>["artifacts"]): Map<string, MapActionProposal> {
  const proposals = new Map<string, MapActionProposal>();
  for (const artifact of artifacts) {
    if (artifact.version === MAP_ACTION_PROPOSAL_VERSION) {
      proposals.set(artifact.proposal_id, artifact);
    }
  }
  return proposals;
}

describe("MAP-Core conformance fixtures", () => {
  const fixtureFiles = readdirSync(fixturesDir)
    .filter((file) => file.endsWith(".json"))
    .sort();

  it.each(fixtureFiles)("validates %s", (file) => {
    const fixture = validateMapFixture(loadFixture(file));
    const proposals = proposalsById(fixture.artifacts);
    const outcomes = fixture.artifacts.filter(
      (artifact): artifact is MapDecisionOutcome => artifact.version === MAP_DECISION_OUTCOME_VERSION,
    );
    const approvals = fixture.artifacts.filter(
      (artifact): artifact is MapApproval => artifact.version === MAP_APPROVAL_VERSION,
    );

    expect(outcomes.at(-1)).toMatchObject({
      decision: fixture.expected_decision,
      reason_code: fixture.expected_reason_code,
    });

    for (const outcome of outcomes) {
      const proposal = proposals.get(outcome.proposal_id);
      expect(proposal, `${file}: missing proposal ${outcome.proposal_id}`).toBeDefined();
      expect(outcome.action_commitment).toBe(computeCommitment(proposal));
    }

    for (const approval of approvals) {
      const proposal = proposals.get(approval.proposal_id);
      expect(proposal, `${file}: missing approval proposal ${approval.proposal_id}`).toBeDefined();
      expect(approval.action_commitment).toBe(computeCommitment(proposal));
    }
  });

  it("rejects malformed artifacts", () => {
    expect(() => validateMapArtifact({
      version: "map.decision_outcome/0.1",
      outcome_id: "outcome_bad",
      proposal_id: "proposal_bad",
      action_commitment: "not-a-hash",
      decision: "allow",
      reason_code: "allowed",
      receipt_required: true,
      evaluated_at: "2026-06-04T12:00:00Z",
    })).toThrow(/action_commitment/);
  });

  it("uses deterministic bytewise key ordering for commitments", () => {
    expect(canonicalize({ b: 1, a: 2, aa: 3 })).toBe('{"a":2,"aa":3,"b":1}');
  });

  it.each([
    "2026-06-04T12:00:00",
    "2026-06-04T12:00",
    "2026-02-31T12:00:00Z",
  ])("rejects invalid timestamp %s", (evaluatedAt) => {
    expect(() => validateMapArtifact({
      version: "map.decision_outcome/0.1",
      outcome_id: "outcome_bad_timestamp",
      proposal_id: "proposal_bad",
      action_commitment: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
      decision: "allow",
      reason_code: "allowed",
      receipt_required: true,
      evaluated_at: evaluatedAt,
    })).toThrow(/evaluated_at/);
  });

  it("models approval replay as a commitment mismatch", () => {
    const fixture = validateMapFixture(loadFixture("approval-replay-denied.json"));
    const approval = fixture.artifacts.find(
      (artifact): artifact is MapApproval => artifact.version === MAP_APPROVAL_VERSION,
    );
    const outcome = fixture.artifacts.find(
      (artifact): artifact is MapDecisionOutcome => artifact.version === MAP_DECISION_OUTCOME_VERSION,
    );

    expect(approval?.action_commitment).toBeDefined();
    expect(outcome?.action_commitment).toBeDefined();
    expect(approval?.action_commitment).not.toBe(outcome?.action_commitment);
    expect(outcome).toMatchObject({
      decision: "deny",
      reason_code: "approval_commitment_mismatch",
      approval_id: approval?.approval_id,
    });
  });
});
