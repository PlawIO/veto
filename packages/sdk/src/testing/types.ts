/**
 * Types for the policy unit testing framework.
 *
 * @module testing/types
 */

export interface VetoTestCase {
	id: string;
	description?: string;
	tool: string;
	arguments: Record<string, unknown>;
	context?: Record<string, unknown>;
	expect: {
		decision: 'allow' | 'deny' | 'block' | 'warn' | 'log' | 'require_approval';
		rule_id?: string;
	};
}

export interface VetoTestSuite {
	suite: string;
	tests: VetoTestCase[];
}

export interface VetoTestResult {
	testId: string;
	suite: string;
	passed: boolean;
	expected: VetoTestCase['expect'];
	actual: { decision: string; rule_id?: string };
	error?: string;
}

export interface VetoTestRunResult {
	total: number;
	passed: number;
	failed: number;
	results: VetoTestResult[];
	loadErrors?: string[];
}
