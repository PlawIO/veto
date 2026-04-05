import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runTests } from '../../src/testing/runner.js';

const TMP = join(__dirname, '__run_tests_tmp__');

function writeFixture(name: string, content: string): string {
	const path = join(TMP, name);
	writeFileSync(path, content, 'utf-8');
	return path;
}

beforeAll(() => {
	mkdirSync(TMP, { recursive: true });
});

afterAll(() => {
	rmSync(TMP, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Policy YAML used across tests
// ---------------------------------------------------------------------------

const POLICY_YAML = `
version: "1.0"
name: test-policy
rules:
  - id: block-transfers
    name: Block large transfers
    enabled: true
    severity: high
    action: block
    tools:
      - transfer_funds
    conditions:
      - field: arguments.amount
        operator: greater_than
        value: 10000
  - id: prod-approval
    name: Production approval
    enabled: true
    severity: high
    action: require_approval
    tools:
      - deploy
    conditions:
      - field: arguments.env
        operator: equals
        value: prod
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runTests — passing test', () => {
	it('returns passed=true when expected decision matches actual', async () => {
		const policyFile = writeFixture('policy-pass.yaml', POLICY_YAML);
		const fixtureContent = `
suite: financial tests
tests:
  - id: allow-small-transfer
    description: small transfers are allowed
    tool: transfer_funds
    arguments:
      amount: 500
    expect:
      decision: allow
`;
		const fixtureFile = writeFixture('pass-fixture.yaml', fixtureContent);

		const result = await runTests({
			fixturesPath: fixtureFile,
			policyPath: policyFile,
			quiet: true,
		});

		expect(result.total).toBe(1);
		expect(result.passed).toBe(1);
		expect(result.failed).toBe(0);
		expect(result.results[0].passed).toBe(true);
	});

	it('maps block decision correctly (block action → deny decision)', async () => {
		const policyFile = writeFixture('policy-block.yaml', POLICY_YAML);
		const fixtureContent = `
suite: block tests
tests:
  - id: block-large-transfer
    tool: transfer_funds
    arguments:
      amount: 50000
    expect:
      decision: block
      rule_id: block-transfers
`;
		const fixtureFile = writeFixture('block-fixture.yaml', fixtureContent);

		const result = await runTests({
			fixturesPath: fixtureFile,
			policyPath: policyFile,
			quiet: true,
		});

		expect(result.total).toBe(1);
		expect(result.passed).toBe(1);
	});
});

describe('runTests — failing test', () => {
	it('returns passed=false when expected decision does not match actual', async () => {
		const policyFile = writeFixture('policy-fail.yaml', POLICY_YAML);
		const fixtureContent = `
suite: fail suite
tests:
  - id: wrong-expectation
    tool: transfer_funds
    arguments:
      amount: 500
    expect:
      decision: deny
`;
		const fixtureFile = writeFixture('fail-fixture.yaml', fixtureContent);

		const result = await runTests({
			fixturesPath: fixtureFile,
			policyPath: policyFile,
			quiet: true,
		});

		expect(result.total).toBe(1);
		expect(result.passed).toBe(0);
		expect(result.failed).toBe(1);
		expect(result.results[0].passed).toBe(false);
		expect(result.results[0].error).toMatch(/expected decision/);
	});

	it('returns passed=false when rule_id does not match', async () => {
		const policyFile = writeFixture('policy-ruleid.yaml', POLICY_YAML);
		const fixtureContent = `
suite: rule-id tests
tests:
  - id: wrong-rule-id
    tool: transfer_funds
    arguments:
      amount: 50000
    expect:
      decision: deny
      rule_id: wrong-rule-id
`;
		const fixtureFile = writeFixture('ruleid-fixture.yaml', fixtureContent);

		const result = await runTests({
			fixturesPath: fixtureFile,
			policyPath: policyFile,
			quiet: true,
		});

		expect(result.total).toBe(1);
		expect(result.failed).toBe(1);
		expect(result.results[0].passed).toBe(false);
		expect(result.results[0].error).toMatch(/rule_id/);
	});
});

describe('runTests — YAML parse error', () => {
	it('reports clean error for invalid YAML and does not throw', async () => {
		const policyFile = writeFixture('policy-yaml-err.yaml', POLICY_YAML);
		const badYaml = `
suite: bad fixture
tests:
  - id: broken
    tool: [unclosed bracket
    arguments: {bad: yaml: here
    expect:
      decision: allow
`;
		const fixtureFile = writeFixture('bad-fixture.yaml', badYaml);

		const result = await runTests({
			fixturesPath: fixtureFile,
			policyPath: policyFile,
			quiet: true,
		});

		// Should not throw, should report load error
		expect(result.loadErrors.length).toBeGreaterThan(0);
		expect(result.loadErrors[0]).toMatch(/YAML parse error/);
		expect(result.total).toBe(0);
	});
});

describe('runTests — coverage flag', () => {
	it('returns results with rule_id tracking for coverage gap detection', async () => {
		const policyFile = writeFixture('policy-coverage.yaml', POLICY_YAML);
		// Only tests for block-transfers rule, not prod-approval
		const fixtureContent = `
suite: coverage suite
tests:
  - id: block-check
    tool: transfer_funds
    arguments:
      amount: 50000
    expect:
      decision: deny
      rule_id: block-transfers
`;
		const fixtureFile = writeFixture('coverage-fixture.yaml', fixtureContent);

		const result = await runTests({
			fixturesPath: fixtureFile,
			policyPath: policyFile,
			coverage: true,
			quiet: true,
		});

		const testedRuleIds = new Set(
			result.results
				.filter((r) => r.expected.rule_id !== undefined)
				.map((r) => r.expected.rule_id),
		);

		// block-transfers is tested, prod-approval is not
		expect(testedRuleIds.has('block-transfers')).toBe(true);
		expect(testedRuleIds.has('prod-approval')).toBe(false);
	});
});

describe('runTests — fixture path errors', () => {
	it('reports error when fixture path does not exist', async () => {
		const policyFile = writeFixture('policy-missing.yaml', POLICY_YAML);

		const result = await runTests({
			fixturesPath: join(TMP, 'nonexistent-dir'),
			policyPath: policyFile,
			quiet: true,
		});

		expect(result.loadErrors.length).toBeGreaterThan(0);
		expect(result.loadErrors[0]).toMatch(/not found/i);
	});
});
