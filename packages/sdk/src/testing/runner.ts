/**
 * Policy unit testing framework.
 *
 * Reads YAML fixture files and evaluates each test case against the policy
 * using the deterministic replay engine (no LLM, no network).
 *
 * @module testing/runner
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
	buildReplaySnapshot,
	decideReplayCall,
	loadPolicySnapshot,
} from '../cli/replay-engine.js';
import type { ASTNode } from '../compiler/index.js';
import type { ReplayCall } from '../cli/replay-engine.js';
import type {
	VetoTestCase,
	VetoTestResult,
	VetoTestRunResult,
	VetoTestSuite,
} from './types.js';
import { colors } from '../cli/colors.js';

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/**
 * The replay engine action `block` surfaces as decision `deny`.
 * `warn` and `log` actions surface as `allow` (non-blocking).
 * Normalize the expected value from a fixture to what the engine returns.
 */
function normalizeExpectedDecision(
	expected: VetoTestCase['expect']['decision'],
): string {
	switch (expected) {
		case 'block':
		case 'deny':
			return 'deny';
		case 'warn':
		case 'log':
			return 'allow';
		default:
			return expected;
	}
}

// ---------------------------------------------------------------------------
// Fixture loading
// ---------------------------------------------------------------------------

function collectYamlFiles(dir: string): string[] {
	const results: string[] = [];
	if (!existsSync(dir)) return results;

	const entries = readdirSync(dir);
	for (const entry of entries) {
		const full = join(dir, entry);
		const stat = statSync(full);
		if (stat.isDirectory()) {
			results.push(...collectYamlFiles(full));
		} else if (entry.endsWith('.yaml') || entry.endsWith('.yml')) {
			results.push(full);
		}
	}
	return results;
}

function loadSuites(fixturesPath: string): { suites: VetoTestSuite[]; errors: string[] } {
	const suites: VetoTestSuite[] = [];
	const errors: string[] = [];

	let files: string[];
	const resolved = resolve(fixturesPath);

	if (!existsSync(resolved)) {
		errors.push(`Fixture path not found: ${resolved}`);
		return { suites, errors };
	}

	const stat = statSync(resolved);
	if (stat.isFile()) {
		files = [resolved];
	} else {
		files = collectYamlFiles(resolved);
		if (files.length === 0) {
			errors.push(`No YAML fixture files found in: ${resolved}`);
		}
	}

	for (const file of files) {
		let content: string;
		try {
			content = readFileSync(file, 'utf-8');
		} catch (err) {
			errors.push(`Failed to read fixture file ${file}: ${err instanceof Error ? err.message : String(err)}`);
			continue;
		}

		let parsed: unknown;
		try {
			parsed = parseYaml(content);
		} catch (err) {
			const yamlErr = err as { mark?: { line?: number; column?: number }; message?: string };
			const line = (yamlErr.mark?.line ?? 0) + 1;
			const col = (yamlErr.mark?.column ?? 0) + 1;
			errors.push(
				`YAML parse error in ${file} at line ${line}, column ${col}: ${yamlErr.message ?? String(err)}`,
			);
			continue;
		}

		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			errors.push(`Invalid fixture format in ${file}: expected an object with 'suite' and 'tests' keys`);
			continue;
		}

		const raw = parsed as Record<string, unknown>;
		if (typeof raw['suite'] !== 'string') {
			errors.push(`Invalid fixture in ${file}: missing or non-string 'suite' key`);
			continue;
		}

		if (!Array.isArray(raw['tests'])) {
			errors.push(`Invalid fixture in ${file}: 'tests' must be an array`);
			continue;
		}

		suites.push(raw as unknown as VetoTestSuite);
	}

	return { suites, errors };
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface RunTestsOptions {
	/** Path to fixture YAML files or directory. Defaults to ./veto/tests */
	fixturesPath?: string;
	/** Path to the policy file or directory to test against. Defaults to ./veto */
	policyPath?: string;
	/** When true, report which rule IDs have no test coverage */
	coverage?: boolean;
	/** Suppress console output */
	quiet?: boolean;
}

// ---------------------------------------------------------------------------
// Core runner
// ---------------------------------------------------------------------------

export async function runTests(options: RunTestsOptions = {}): Promise<VetoTestRunResult> {
	const fixturesPath = options.fixturesPath ?? './veto/tests';
	const policyPath = options.policyPath ?? './veto';
	const coverage = options.coverage ?? false;
	const quiet = options.quiet ?? false;

	// Load policy
	let snapshot;
	try {
		snapshot = loadPolicySnapshot(policyPath);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (!quiet) console.error(colors.error(`Failed to load policy: ${msg}`));
		return { total: 0, passed: 0, failed: 0, results: [], loadErrors: [`Policy load error: ${msg}`] };
	}

	const replaySnapshot = buildReplaySnapshot(snapshot);
	const expressionCache = new Map<string, ASTNode>();

	// Load fixtures
	const { suites, errors: loadErrors } = loadSuites(fixturesPath);

	if (loadErrors.length > 0 && !quiet) {
		for (const err of loadErrors) {
			console.error(colors.error(`  Error: ${err}`));
		}
	}

	if (suites.length === 0) {
		if (!quiet) console.log(colors.warning('No test suites loaded.'));
		return { total: 0, passed: 0, failed: 0, results: [], loadErrors };
	}

	// Run tests
	const results: VetoTestResult[] = [];

	for (const suite of suites) {
		if (!quiet) console.log(`\n${colors.bold(suite.suite)}`);

		for (const testCase of suite.tests) {
			const call: ReplayCall = {
				index: 1,
				line: 1,
				tool: testCase.tool,
				arguments: testCase.arguments,
				timestamp: new Date().toISOString(),
				...(testCase.context ?? {}),
			};

			let result: VetoTestResult;
			try {
				const decision = decideReplayCall(replaySnapshot, call, [], expressionCache);
				const normalizedExpected = normalizeExpectedDecision(testCase.expect.decision);
				const actualDecision = decision.decision;
				const actualRuleId = decision.ruleId;

				const decisionMatch = actualDecision === normalizedExpected;
				const ruleIdMatch = testCase.expect.rule_id === undefined
					|| actualRuleId === testCase.expect.rule_id;
				const passed = decisionMatch && ruleIdMatch;

				result = {
					testId: testCase.id,
					suite: suite.suite,
					passed,
					expected: testCase.expect,
					actual: { decision: actualDecision, rule_id: actualRuleId },
				};

				if (!passed && !decisionMatch) {
					result.error = `expected decision '${testCase.expect.decision}' but got '${actualDecision}'`;
				} else if (!passed && !ruleIdMatch) {
					result.error = `expected rule_id '${testCase.expect.rule_id ?? ''}' but got '${actualRuleId ?? ''}'`;
				}
			} catch (err) {
				result = {
					testId: testCase.id,
					suite: suite.suite,
					passed: false,
					expected: testCase.expect,
					actual: { decision: 'error' },
					error: err instanceof Error ? err.message : String(err),
				};
			}

			results.push(result);

			if (!quiet) {
				const badge = result.passed
					? colors.success('  PASS')
					: colors.error('  FAIL');
				const desc = testCase.description ? ` — ${testCase.description}` : '';
				console.log(`${badge} ${colors.dim(testCase.id)}${desc}`);
				if (!result.passed && result.error) {
					console.log(`       ${colors.error(result.error)}`);
				}
			}
		}
	}

	const passed = results.filter((r) => r.passed).length;
	const failed = results.length - passed;

	if (!quiet) {
		console.log('');
		const summary = failed === 0
			? colors.success(`Tests: ${passed} passed`)
			: `Tests: ${colors.success(`${passed} passed`)}, ${colors.error(`${failed} failed`)}`;
		console.log(summary);
	}

	// Coverage report
	if (coverage && !quiet) {
		printCoverageReport(snapshot.rules, results);
	}

	return { total: results.length, passed, failed, results, loadErrors };
}

function printCoverageReport(
	rules: import('../rules/types.js').Rule[],
	results: VetoTestResult[],
): void {
	const testedRuleIds = new Set(
		results
			.filter((r) => r.expected.rule_id !== undefined)
			.map((r) => r.expected.rule_id as string),
	);

	const allRuleIds = rules
		.filter((r) => r.id !== undefined)
		.map((r) => r.id as string);

	const untested = allRuleIds.filter((id) => !testedRuleIds.has(id));

	console.log('');
	console.log(colors.bold('Coverage:'));
	console.log(`  Rules with tests:    ${testedRuleIds.size}`);
	console.log(`  Rules without tests: ${untested.length}`);

	if (untested.length > 0) {
		console.log('');
		console.log(colors.warning('  Untested rule IDs:'));
		for (const id of untested) {
			console.log(`    ${colors.dim(id)}`);
		}
	}
}
