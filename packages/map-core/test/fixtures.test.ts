import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MAP_ACTION_PROPOSAL_VERSION,
  MAP_APPROVAL_VERSION,
  MAP_DECISION_OUTCOME_VERSION,
  MAP_POLICY_BUNDLE_VERSION,
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

  it("omits undefined object members like JSON serialization", () => {
    const proposal = validateMapArtifact({
      version: MAP_ACTION_PROPOSAL_VERSION,
      proposal_id: "proposal_without_optionals",
      action: "payments.refund",
      arguments: {},
      actor: { id: "agent_refunds", kind: "agent" },
      audience: ["finance"],
      created_at: "2026-06-04T12:00:00Z",
      nonce: "nonce_without_optionals",
    });

    expect(canonicalize({ a: 1, omitted: undefined, b: null })).toBe('{"a":1,"b":null}');
    expect(() => computeCommitment(proposal)).not.toThrow();
  });

  it("rejects undefined array entries", () => {
    expect(() => canonicalize([1, undefined])).toThrow(/\$\[1\]/);
  });

  it("rejects malformed nested authority versions", () => {
    expect(() => validateMapArtifact({
      version: MAP_POLICY_BUNDLE_VERSION,
      bundle_id: "bundle_bad_authority_version",
      issuer: { id: "issuer", kind: "organization" },
      audience: ["finance"],
      valid_from: "2026-06-04T12:00:00Z",
      authorities: [
        {
          version: "map.authority/999",
          authority_id: "authority_bad_version",
          issuer: { id: "issuer", kind: "organization" },
          subject: { id: "agent", kind: "agent" },
          audience: ["finance"],
          actions: ["payments.refund"],
          scope: {},
          limits: null,
          conditions: null,
          valid_from: "2026-06-04T12:00:00Z",
          receipt_required: true,
        },
      ],
      rules: [],
      default_decision: "deny",
      receipt_required: true,
    })).toThrow(/authorities\[0\]\.version/);
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

describe("dependency-zone guards", () => {
  it("rejects relative Python core imports of CLI and proxy modules", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "veto-map-core-zones-"));
    try {
      mkdirSync(join(tempRoot, "packages/sdk-python/veto/core"), { recursive: true });
      mkdirSync(join(tempRoot, "packages/sdk/src/core"), { recursive: true });
      mkdirSync(join(tempRoot, "packages/cli"), { recursive: true });
      mkdirSync(join(tempRoot, "packages/receipt-protocol"), { recursive: true });
      mkdirSync(join(tempRoot, "packages/map-core/src"), { recursive: true });
      mkdirSync(join(tempRoot, "packages/spend-capsule-protocol"), { recursive: true });

      writeFileSync(join(tempRoot, "packages/sdk-python/veto/core/bad.py"), "from .cli import main\nfrom ..proxy.server import app\n");
      writeFileSync(join(tempRoot, "packages/sdk-python/pyproject.toml"), "[project]\ndependencies = [\"aiohttp\", \"jcs\", \"jsonschema\", \"pydantic\", \"pyyaml\", \"sse-starlette\"]\n");
      writeFileSync(join(tempRoot, "packages/sdk/package.json"), JSON.stringify({ dependencies: { ajv: "*", picocolors: "*", "veto-receipt-protocol": "*", yaml: "*" } }));
      writeFileSync(join(tempRoot, "packages/cli/package.json"), JSON.stringify({ dependencies: { "@opentui/core": "*", ink: "*", picocolors: "*", react: "*", "veto-sdk": "*" } }));
      writeFileSync(join(tempRoot, "packages/receipt-protocol/package.json"), JSON.stringify({ dependencies: { "@noble/hashes": "*", canonicalize: "*" } }));
      writeFileSync(join(tempRoot, "packages/map-core/package.json"), JSON.stringify({ dependencies: {} }));
      writeFileSync(join(tempRoot, "packages/spend-capsule-protocol/package.json"), JSON.stringify({ dependencies: { "@noble/ed25519": "*", "@noble/hashes": "*", "@scure/base": "*", canonicalize: "*", jose: "*", "veto-receipt-protocol": "*" } }));

      expect(() => execFileSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "../../../scripts/check-dependency-zones.mjs")], {
        cwd: tempRoot,
        stdio: "pipe",
      })).toThrow(/python-core-no-cli-proxy-imports/);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
