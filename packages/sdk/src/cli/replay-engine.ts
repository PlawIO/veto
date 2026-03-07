/**
 * Shared replay engine used by both `replay` and `diff` commands.
 *
 * Pure deterministic evaluation — no LLM calls, no cloud calls, no network.
 *
 * @module cli/replay-engine
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { compile as compileExpression, evaluate, type ASTNode } from '../compiler/index.js';
import { RuleLoader } from '../rules/loader.js';
import { evaluateConditionCollections } from '../rules/condition-evaluator.js';
import type { Rule } from '../rules/types.js';
import { silentLogger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type RuleDecision = 'allow' | 'deny' | 'require_approval';
type SnapshotKind = 'file' | 'directory' | 'git-file';

export interface PolicySnapshot {
  kind: SnapshotKind;
  source: string;
  rules: Rule[];
  rulesByTool: Map<string, Rule[]>;
  globalRules: Rule[];
}

export interface ReplaySnapshot {
  globalRules: Rule[];
  rulesByTool: Map<string, Rule[]>;
}

export interface ReplayCall {
  index: number;
  line: number;
  tool: string;
  arguments: Record<string, unknown>;
  timestamp: string;
  decision?: RuleDecision;
  ruleId?: string;
  sessionId?: string;
  agentId?: string;
  userId?: string;
  role?: string;
  custom?: Record<string, unknown>;
}

export interface ReplayDecision {
  decision: RuleDecision;
  ruleId?: string;
  ruleName?: string;
  reason?: string;
}

export interface ReplayHistoryEntry {
  toolName: string;
  arguments: Record<string, unknown>;
  decision: RuleDecision;
  timestamp: Date;
}

export interface ParsedReplayLog {
  calls: ReplayCall[];
  totalLines: number;
  invalidLines: number;
  invalidLineNumbers: number[];
}

export interface DecisionCounts {
  allow: number;
  deny: number;
  require_approval: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_SYNTHETIC_BASE_MS = Date.parse('2000-01-01T00:00:00.000Z');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

export function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function normalizeTimestamp(raw: unknown): string | null {
  if (raw instanceof Date) {
    return Number.isNaN(raw.getTime()) ? null : raw.toISOString();
  }
  if (typeof raw === 'string' || typeof raw === 'number') {
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return null;
}

// ---------------------------------------------------------------------------
// Log parsing
// ---------------------------------------------------------------------------

export function parseReplayLog(logPath: string): ParsedReplayLog {
  if (!existsSync(logPath)) {
    throw new Error(`Log file not found: ${logPath}`);
  }

  const content = readFileSync(logPath, 'utf-8');
  return parseReplayLogContent(content, logPath);
}

export function parseReplayLogContent(content: string, sourceName = 'inline'): ParsedReplayLog {
  const lines = content.split(/\r?\n/);

  const calls: ReplayCall[] = [];
  const invalidLineNumbers: number[] = [];
  let totalLines = 0;
  let syntheticCounter = 0;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const lineNumber = lineIndex + 1;
    const rawLine = lines[lineIndex].trim();

    if (!rawLine) {
      continue;
    }

    totalLines += 1;

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawLine);
    } catch {
      invalidLineNumbers.push(lineNumber);
      continue;
    }

    if (!isPlainObject(parsed)) {
      invalidLineNumbers.push(lineNumber);
      continue;
    }

    const tool = normalizeOptionalString(
      parsed.toolName ?? parsed.tool_name ?? parsed.tool ?? parsed.name
    );
    const argumentsValue = parsed.arguments ?? parsed.args;

    if (!tool || !isPlainObject(argumentsValue)) {
      invalidLineNumbers.push(lineNumber);
      continue;
    }

    let timestamp = normalizeTimestamp(parsed.timestamp);
    if (!timestamp) {
      if (parsed.timestamp === undefined) {
        timestamp = new Date(DEFAULT_SYNTHETIC_BASE_MS + (syntheticCounter * 1000)).toISOString();
        syntheticCounter += 1;
      } else {
        invalidLineNumbers.push(lineNumber);
        continue;
      }
    }

    // Parse optional original decision for replay comparison
    const rawDecision = normalizeOptionalString(parsed.decision);
    const decision = (rawDecision === 'allow' || rawDecision === 'deny' || rawDecision === 'require_approval')
      ? rawDecision
      : undefined;

    calls.push({
      index: calls.length + 1,
      line: lineNumber,
      tool,
      arguments: argumentsValue,
      timestamp,
      decision,
      ruleId: normalizeOptionalString(parsed.ruleId ?? parsed.rule_id),
      sessionId: normalizeOptionalString(parsed.sessionId ?? parsed.session_id),
      agentId: normalizeOptionalString(parsed.agentId ?? parsed.agent_id),
      userId: normalizeOptionalString(parsed.userId ?? parsed.user_id),
      role: normalizeOptionalString(parsed.role),
      custom: isPlainObject(parsed.custom) ? parsed.custom : undefined,
    });
  }

  if (calls.length === 0) {
    throw new Error(`No valid replay calls found in: ${sourceName}`);
  }

  return {
    calls,
    totalLines,
    invalidLines: invalidLineNumbers.length,
    invalidLineNumbers,
  };
}

// ---------------------------------------------------------------------------
// Expression evaluation
// ---------------------------------------------------------------------------

export function evaluateExpressionSafely(
  expression: string,
  context: Record<string, unknown>,
  cache: Map<string, ASTNode>
): boolean {
  let ast = cache.get(expression);
  if (!ast) {
    try {
      ast = compileExpression(expression);
      cache.set(expression, ast);
    } catch {
      return false;
    }
  }

  try {
    return Boolean(evaluate(ast, context));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Rule matching
// ---------------------------------------------------------------------------

function matchesRuleAgentScope(rule: Rule, agentId?: string): boolean {
  if (!rule.agents) {
    return true;
  }

  if (Array.isArray(rule.agents)) {
    const includeOnly = rule.agents.filter((value): value is string => typeof value === 'string');
    return agentId !== undefined && includeOnly.includes(agentId);
  }

  const excluded = rule.agents.not.filter((value): value is string => typeof value === 'string');
  return agentId === undefined || !excluded.includes(agentId);
}

function buildReplayCallContext(call: ReplayCall): Record<string, unknown> {
  return {
    ...call.arguments,
    tool_name: call.tool,
    arguments: call.arguments,
    session_id: call.sessionId,
    agent_id: call.agentId,
    user_id: call.userId,
    role: call.role,
    custom: call.custom,
  };
}

function buildHistoricalContext(entry: ReplayHistoryEntry): Record<string, unknown> {
  return {
    ...entry.arguments,
    tool_name: entry.toolName,
    arguments: entry.arguments,
    decision: entry.decision,
    timestamp: entry.timestamp.toISOString(),
  };
}

function hasMatchingHistoryEntry(
  constraint: NonNullable<Rule['requires']>[number],
  history: readonly ReplayHistoryEntry[],
  now: Date,
  expressionCache: Map<string, ASTNode>
): boolean {
  const nowMs = now.getTime();
  const withinMs = typeof constraint.within === 'number'
    ? Math.max(0, constraint.within) * 1000
    : null;

  return history.some((entry) => {
    if (entry.toolName !== constraint.tool) {
      return false;
    }

    if (entry.decision === 'deny') {
      return false;
    }

    if (withinMs !== null) {
      const ageMs = nowMs - entry.timestamp.getTime();
      if (ageMs < 0 || ageMs > withinMs) {
        return false;
      }
    }

    return evaluateConditionCollections(
      constraint.conditions,
      constraint.condition_groups,
      buildHistoricalContext(entry),
      {
        now: entry.timestamp,
        evaluateExpression: (expression, context) =>
          evaluateExpressionSafely(expression, context, expressionCache),
      }
    );
  });
}

function matchesSequenceConstraints(
  rule: Rule,
  history: readonly ReplayHistoryEntry[],
  now: Date,
  expressionCache: Map<string, ASTNode>
): boolean {
  const blockedBy = rule.blocked_by ?? [];
  const requires = rule.requires ?? [];

  if (blockedBy.length === 0 && requires.length === 0) {
    return true;
  }

  const blockedByMatched = blockedBy.some((constraint) =>
    hasMatchingHistoryEntry(constraint, history, now, expressionCache)
  );

  const missingRequirement = requires.some((constraint) =>
    !hasMatchingHistoryEntry(constraint, history, now, expressionCache)
  );

  return blockedByMatched || missingRequirement;
}

export function matchesReplayRule(
  rule: Rule,
  call: ReplayCall,
  history: readonly ReplayHistoryEntry[],
  expressionCache: Map<string, ASTNode>
): boolean {
  if (!matchesRuleAgentScope(rule, call.agentId)) {
    return false;
  }

  const callTime = new Date(call.timestamp);
  const context = buildReplayCallContext(call);

  const conditionsMatch = evaluateConditionCollections(
    rule.conditions,
    rule.condition_groups,
    context,
    {
      now: callTime,
      evaluateExpression: (expression, evaluationContext) =>
        evaluateExpressionSafely(expression, evaluationContext, expressionCache),
    }
  );

  if (!conditionsMatch) {
    return false;
  }

  return matchesSequenceConstraints(rule, history, callTime, expressionCache);
}

// ---------------------------------------------------------------------------
// Core replay
// ---------------------------------------------------------------------------

export function buildReplaySnapshot(snapshot: PolicySnapshot): ReplaySnapshot {
  const globalRules = snapshot.globalRules.filter((rule) => rule.enabled !== false);
  const rulesByTool = new Map<string, Rule[]>();

  for (const [toolName, rules] of snapshot.rulesByTool.entries()) {
    const enabledRules = rules.filter((rule) => rule.enabled !== false);
    if (enabledRules.length > 0) {
      rulesByTool.set(toolName, enabledRules);
    }
  }

  return {
    globalRules,
    rulesByTool,
  };
}

export function decideReplayCall(
  replaySnapshot: ReplaySnapshot,
  call: ReplayCall,
  history: readonly ReplayHistoryEntry[],
  expressionCache: Map<string, ASTNode>
): ReplayDecision {
  const toolRules = replaySnapshot.rulesByTool.get(call.tool) ?? [];
  const rules = [...replaySnapshot.globalRules, ...toolRules];

  if (rules.length === 0) {
    return { decision: 'allow' };
  }

  let firstAllowRule: Rule | null = null;

  for (const rule of rules) {
    if (!matchesReplayRule(rule, call, history, expressionCache)) {
      continue;
    }

    const reason = rule.description ?? `Matched rule: ${rule.name}`;

    if (rule.action === 'require_approval') {
      return {
        decision: 'require_approval',
        ruleId: rule.id,
        ruleName: rule.name,
        reason,
      };
    }

    if (rule.action === 'block') {
      return {
        decision: 'deny',
        ruleId: rule.id,
        ruleName: rule.name,
        reason,
      };
    }

    if (rule.action === 'allow' && !firstAllowRule) {
      firstAllowRule = rule;
    }
  }

  if (firstAllowRule) {
    return {
      decision: 'allow',
      ruleId: firstAllowRule.id,
      ruleName: firstAllowRule.name,
      reason: firstAllowRule.description ?? `Allowed by rule: ${firstAllowRule.name}`,
    };
  }

  return { decision: 'allow' };
}

export function replayCalls(snapshot: PolicySnapshot, calls: readonly ReplayCall[]): ReplayDecision[] {
  const replaySnapshot = buildReplaySnapshot(snapshot);
  const expressionCache = new Map<string, ASTNode>();
  const history: ReplayHistoryEntry[] = [];
  const decisions: ReplayDecision[] = [];

  for (const call of calls) {
    const decision = decideReplayCall(replaySnapshot, call, history, expressionCache);
    decisions.push(decision);

    history.push({
      toolName: call.tool,
      arguments: call.arguments,
      decision: decision.decision,
      timestamp: new Date(call.timestamp),
    });
  }

  return decisions;
}

export function countDecisions(decisions: readonly ReplayDecision[]): DecisionCounts {
  const counts: DecisionCounts = {
    allow: 0,
    deny: 0,
    require_approval: 0,
  };

  for (const decision of decisions) {
    counts[decision.decision] += 1;
  }

  return counts;
}

// ---------------------------------------------------------------------------
// Policy loading
// ---------------------------------------------------------------------------

export function createRuleLoader(): RuleLoader {
  const loader = new RuleLoader({ logger: silentLogger });
  loader.setYamlParser(parseYaml);
  return loader;
}

export function getPathType(inputPath: string): 'file' | 'directory' {
  if (!existsSync(inputPath)) {
    throw new Error(`Path not found: ${inputPath}`);
  }

  const stats = statSync(inputPath);
  if (stats.isFile()) return 'file';
  if (stats.isDirectory()) return 'directory';

  throw new Error(`Path must be a file or directory: ${inputPath}`);
}

export function createSnapshotFromLoader(kind: SnapshotKind, source: string, loader: RuleLoader): PolicySnapshot {
  const loaded = loader.getRules();
  const rulesByTool = new Map<string, Rule[]>();

  for (const [toolName, rules] of loaded.rulesByTool.entries()) {
    rulesByTool.set(toolName, [...rules]);
  }

  return {
    kind,
    source,
    rules: [...loaded.allRules],
    rulesByTool,
    globalRules: [...loaded.globalRules],
  };
}

export function loadPolicySnapshot(inputPath: string): PolicySnapshot {
  const resolvedPath = resolve(inputPath);
  const pathType = getPathType(resolvedPath);
  const loader = createRuleLoader();

  if (pathType === 'file') {
    const content = readFileSync(resolvedPath, 'utf-8');
    loader.loadFromString(content, resolvedPath);
    return createSnapshotFromLoader('file', resolvedPath, loader);
  }

  loader.loadFromDirectory(resolvedPath, true);
  return createSnapshotFromLoader('directory', resolvedPath, loader);
}
