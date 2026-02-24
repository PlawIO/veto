import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { compile, evaluate, type ASTNode } from '../compiler/index.js';
import { RuleLoader } from '../rules/loader.js';
import { evaluateConditionCollections } from '../rules/condition-evaluator.js';
import type { Rule, RuleCondition } from '../rules/types.js';
import { silentLogger } from '../utils/logger.js';

type ReportFormat = 'text' | 'json';
type RuleDecision = 'allow' | 'deny' | 'require_approval';
type SnapshotKind = 'file' | 'directory' | 'git-file';

type ComparableRuleField =
  | 'action'
  | 'enabled'
  | 'severity'
  | 'tools'
  | 'conditions'
  | 'condition_groups'
  | 'blocked_by'
  | 'requires'
  | 'description'
  | 'name';

interface PolicySnapshot {
  kind: SnapshotKind;
  source: string;
  rules: Rule[];
  rulesByTool: Map<string, Rule[]>;
  globalRules: Rule[];
}

interface DiffSources {
  mode: 'implicit-git-file' | 'explicit-file' | 'explicit-directory';
  old: string;
  new: string;
  log?: string;
}

interface ScopeChanges {
  scope: string;
  added: RuleChange[];
  removed: RuleChange[];
  modified: RuleChange[];
}

interface RuleFieldChange {
  field: ComparableRuleField;
  oldValue: unknown;
  newValue: unknown;
}

interface ReplayHistoryEntry {
  toolName: string;
  arguments: Record<string, unknown>;
  decision: RuleDecision;
  timestamp: Date;
}

interface ParsedReplayLog {
  calls: ReplayCall[];
  totalLines: number;
  invalidLines: number;
  invalidLineNumbers: number[];
}

interface DecisionCounts {
  allow: number;
  deny: number;
  require_approval: number;
}

interface ReplaySnapshot {
  globalRules: Rule[];
  rulesByTool: Map<string, Rule[]>;
}

const COMPARABLE_RULE_FIELDS: readonly ComparableRuleField[] = [
  'action',
  'enabled',
  'severity',
  'tools',
  'conditions',
  'condition_groups',
  'blocked_by',
  'requires',
  'description',
  'name',
];

const NUMERIC_OPERATORS = new Set(['greater_than', 'less_than', 'length_greater_than']);
const DEFAULT_SYNTHETIC_BASE_MS = Date.parse('2000-01-01T00:00:00.000Z');
const MAX_IMPACT_SAMPLES = 10;

export interface DiffOptions {
  directory?: string;
  quiet?: boolean;
  old?: string;
  new?: string;
  log?: string;
  format?: ReportFormat;
  policyPath?: string;
}

export interface RuleChange {
  kind: 'added' | 'removed' | 'modified';
  ruleId: string;
  scopes: string[];
  summary: string;
  fieldChanges: RuleFieldChange[];
  oldRule?: Rule;
  newRule?: Rule;
}

export interface StructuralDiff {
  addedRuleIds: string[];
  removedRuleIds: string[];
  modifiedRuleIds: string[];
  ruleChanges: RuleChange[];
  changesByScope: ScopeChanges[];
  unchangedTools: string[];
}

export interface ReplayCall {
  index: number;
  line: number;
  tool: string;
  arguments: Record<string, unknown>;
  timestamp: string;
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

export interface ImpactReport {
  logPath: string;
  totalLines: number;
  validCalls: number;
  invalidLines: number;
  invalidLineNumbers: number[];
  oldDecisionCounts: DecisionCounts;
  newDecisionCounts: DecisionCounts;
  transitions: Record<string, number>;
  changedCalls: number;
  additionalDenied: number;
  additionalRequireApproval: number;
  changedByTool: Array<{ tool: string; count: number }>;
  samples: Array<{
    index: number;
    line: number;
    tool: string;
    timestamp: string;
    oldDecision: ReplayDecision;
    newDecision: ReplayDecision;
  }>;
}

export interface DiffReport {
  timestamp: string;
  projectDir: string;
  sources: DiffSources;
  structural: StructuralDiff;
  impact: ImpactReport | null;
  summary: {
    oldRules: number;
    newRules: number;
    added: number;
    removed: number;
    modified: number;
    changedScopes: number;
    unchangedTools: number;
    hasChanges: boolean;
  };
}

export interface DiffResult {
  success: boolean;
  report: DiffReport | null;
  errors: string[];
}

function createRuleLoader(): RuleLoader {
  const loader = new RuleLoader({ logger: silentLogger });
  loader.setYamlParser(parseYaml);
  return loader;
}

function getPathType(inputPath: string): 'file' | 'directory' {
  if (!existsSync(inputPath)) {
    throw new Error(`Path not found: ${inputPath}`);
  }

  const stats = statSync(inputPath);
  if (stats.isFile()) return 'file';
  if (stats.isDirectory()) return 'directory';

  throw new Error(`Path must be a file or directory: ${inputPath}`);
}

function createSnapshotFromLoader(kind: SnapshotKind, source: string, loader: RuleLoader): PolicySnapshot {
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

function loadPolicySnapshotFromFileOrDirectory(inputPath: string): PolicySnapshot {
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

function toPosixPath(pathValue: string): string {
  return pathValue.split(sep).join('/');
}

function extractExecError(error: unknown): string {
  if (!error || typeof error !== 'object') {
    return String(error);
  }

  const maybeError = error as { stderr?: Buffer | string; message?: string };
  if (typeof maybeError.stderr === 'string' && maybeError.stderr.trim()) {
    return maybeError.stderr.trim();
  }
  if (maybeError.stderr instanceof Buffer && maybeError.stderr.length > 0) {
    return maybeError.stderr.toString('utf-8').trim();
  }
  return maybeError.message ?? String(error);
}

function loadPolicySnapshotFromGitHead(filePath: string, projectDir: string): PolicySnapshot {
  const absoluteFilePath = resolve(filePath);

  let repoRoot = '';
  try {
    repoRoot = execFileSync('git', ['-C', projectDir, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf-8',
    }).trim();
  } catch (error) {
    throw new Error(`Unable to resolve git repository root for ${projectDir}: ${extractExecError(error)}`);
  }

  const normalizedRepoRoot = realpathSync(repoRoot);
  const normalizedFilePath = realpathSync(absoluteFilePath);
  const repoRelativePath = relative(normalizedRepoRoot, normalizedFilePath);
  if (!repoRelativePath || repoRelativePath.startsWith('..') || isAbsolute(repoRelativePath)) {
    throw new Error(`Policy file must be inside the git repository: ${absoluteFilePath}`);
  }

  const gitPath = toPosixPath(repoRelativePath);
  let headContent = '';

  try {
    headContent = execFileSync('git', ['-C', repoRoot, 'show', `HEAD:${gitPath}`], {
      encoding: 'utf-8',
    });
  } catch (error) {
    throw new Error(`Unable to load HEAD version of ${gitPath}: ${extractExecError(error)}`);
  }

  const loader = createRuleLoader();
  loader.loadFromString(headContent, `HEAD:${gitPath}`);

  return createSnapshotFromLoader('git-file', `HEAD:${gitPath}`, loader);
}

function resolvePolicyInputPath(projectDir: string, policyPath: string): string {
  if (!policyPath.trim()) {
    throw new Error('Policy path cannot be empty.');
  }

  if (isAbsolute(policyPath)) {
    if (existsSync(policyPath)) {
      return policyPath;
    }
    throw new Error(`Policy path not found: ${policyPath}`);
  }

  const directPath = resolve(projectDir, policyPath);
  if (existsSync(directPath)) {
    return directPath;
  }

  const fallbackPath = resolve(projectDir, 'veto', 'rules', policyPath);
  if (existsSync(fallbackPath)) {
    return fallbackPath;
  }

  throw new Error(
    `Policy path not found: ${policyPath}. Checked ${directPath} and ${fallbackPath}.`
  );
}

function resolveExplicitPath(projectDir: string, inputPath: string, label: '--old' | '--new'): string {
  const resolvedPath = isAbsolute(inputPath) ? inputPath : resolve(projectDir, inputPath);
  if (!existsSync(resolvedPath)) {
    throw new Error(`${label} path not found: ${resolvedPath}`);
  }
  return resolvedPath;
}

function assertUniqueRuleIds(snapshot: PolicySnapshot, label: string): void {
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const rule of snapshot.rules) {
    if (seen.has(rule.id)) {
      duplicates.add(rule.id);
      continue;
    }
    seen.add(rule.id);
  }

  if (duplicates.size > 0) {
    throw new Error(
      `${label} contains duplicate rule IDs: ${[...duplicates].sort((a, b) => a.localeCompare(b)).join(', ')}`
    );
  }
}

function stableStringify(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`);
    return `{${entries.join(',')}}`;
  }

  return JSON.stringify(value);
}

function normalizeUnknown(value: unknown): unknown {
  if (Array.isArray(value)) {
    const normalizedItems = value.map((item) => normalizeUnknown(item));
    return normalizedItems.sort((left, right) =>
      stableStringify(left).localeCompare(stableStringify(right))
    );
  }

  if (value && typeof value === 'object') {
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort((a, b) => a.localeCompare(b))) {
      normalized[key] = normalizeUnknown((value as Record<string, unknown>)[key]);
    }
    return normalized;
  }

  return value;
}

function normalizeStringArray(value: string[] | undefined): string[] | undefined {
  if (!value) {
    return undefined;
  }

  return [...new Set(value)].sort((a, b) => a.localeCompare(b));
}

function normalizeRuleField(rule: Rule, field: ComparableRuleField): unknown {
  switch (field) {
    case 'tools':
      return normalizeStringArray(rule.tools);
    case 'conditions':
      return normalizeUnknown(rule.conditions);
    case 'condition_groups':
      return normalizeUnknown(rule.condition_groups);
    case 'blocked_by':
      return normalizeUnknown(rule.blocked_by);
    case 'requires':
      return normalizeUnknown(rule.requires);
    case 'action':
      return rule.action;
    case 'enabled':
      return rule.enabled;
    case 'severity':
      return rule.severity;
    case 'description':
      return rule.description;
    case 'name':
      return rule.name;
  }
}

function compareRulesByComparableFields(oldRule: Rule, newRule: Rule): RuleFieldChange[] {
  const fieldChanges: RuleFieldChange[] = [];

  for (const field of COMPARABLE_RULE_FIELDS) {
    const oldValue = normalizeRuleField(oldRule, field);
    const newValue = normalizeRuleField(newRule, field);

    if (stableStringify(oldValue) !== stableStringify(newValue)) {
      fieldChanges.push({ field, oldValue, newValue });
    }
  }

  return fieldChanges;
}

function getRuleScopes(rule: Rule): string[] {
  if (!rule.tools || rule.tools.length === 0) {
    return ['GLOBAL'];
  }

  return [...new Set(rule.tools)].sort((a, b) => a.localeCompare(b));
}

function sortScopes(left: string, right: string): number {
  if (left === 'GLOBAL' && right !== 'GLOBAL') return -1;
  if (right === 'GLOBAL' && left !== 'GLOBAL') return 1;
  return left.localeCompare(right);
}

function sortRuleChanges(changes: RuleChange[]): RuleChange[] {
  return [...changes].sort((left, right) => left.ruleId.localeCompare(right.ruleId));
}

function collectNumericLimits(rule: Rule): Map<string, number> {
  const limits = new Map<string, number>();
  const conditions: RuleCondition[] = [];

  for (const condition of rule.conditions ?? []) {
    conditions.push(condition);
  }

  for (const group of rule.condition_groups ?? []) {
    for (const condition of group) {
      conditions.push(condition);
    }
  }

  for (const condition of conditions) {
    if (!condition.field || !condition.operator || typeof condition.value !== 'number') {
      continue;
    }

    if (!NUMERIC_OPERATORS.has(condition.operator)) {
      continue;
    }

    const key = JSON.stringify([condition.field, condition.operator]);
    limits.set(key, condition.value);
  }

  return limits;
}

function summarizeNumericLimitChange(oldRule: Rule, newRule: Rule): string | null {
  const oldLimits = collectNumericLimits(oldRule);
  const newLimits = collectNumericLimits(newRule);

  const changedKeys = [...oldLimits.keys()]
    .filter((key) => newLimits.has(key) && oldLimits.get(key) !== newLimits.get(key))
    .sort((a, b) => a.localeCompare(b));

  if (changedKeys.length === 0) {
    return null;
  }

  const firstKey = changedKeys[0];
  const parsed = JSON.parse(firstKey) as [string, string];
  const [field, operator] = parsed;
  const previous = oldLimits.get(firstKey);
  const next = newLimits.get(firstKey);

  return `${field} ${operator} changed ${previous} -> ${next}`;
}

function summarizeModifiedRule(oldRule: Rule, newRule: Rule, fieldChanges: readonly RuleFieldChange[]): string {
  const actionChange = fieldChanges.find((change) => change.field === 'action');
  if (actionChange) {
    return `Action changed: ${String(actionChange.oldValue)} -> ${String(actionChange.newValue)}`;
  }

  const numericSummary = summarizeNumericLimitChange(oldRule, newRule);
  if (numericSummary) {
    return numericSummary;
  }

  if (fieldChanges.length === 1) {
    return `${fieldChanges[0].field} updated`;
  }

  return `Rule modified (${fieldChanges.length} fields)`;
}

function buildStructuralDiff(oldRules: readonly Rule[], newRules: readonly Rule[]): StructuralDiff {
  const oldById = new Map<string, Rule>();
  const newById = new Map<string, Rule>();

  for (const rule of oldRules) {
    oldById.set(rule.id, rule);
  }
  for (const rule of newRules) {
    newById.set(rule.id, rule);
  }

  const addedRuleIds = [...newById.keys()]
    .filter((ruleId) => !oldById.has(ruleId))
    .sort((a, b) => a.localeCompare(b));
  const removedRuleIds = [...oldById.keys()]
    .filter((ruleId) => !newById.has(ruleId))
    .sort((a, b) => a.localeCompare(b));

  const modifiedRuleIds: string[] = [];
  const ruleChanges: RuleChange[] = [];

  for (const ruleId of addedRuleIds) {
    const newRule = newById.get(ruleId);
    if (!newRule) continue;

    ruleChanges.push({
      kind: 'added',
      ruleId,
      scopes: getRuleScopes(newRule),
      summary: `Rule added (${newRule.action})`,
      fieldChanges: [],
      newRule,
    });
  }

  for (const ruleId of removedRuleIds) {
    const oldRule = oldById.get(ruleId);
    if (!oldRule) continue;

    ruleChanges.push({
      kind: 'removed',
      ruleId,
      scopes: getRuleScopes(oldRule),
      summary: `Rule removed (${oldRule.action})`,
      fieldChanges: [],
      oldRule,
    });
  }

  const potentiallyModifiedRuleIds = [...newById.keys()]
    .filter((ruleId) => oldById.has(ruleId))
    .sort((a, b) => a.localeCompare(b));

  for (const ruleId of potentiallyModifiedRuleIds) {
    const oldRule = oldById.get(ruleId);
    const newRule = newById.get(ruleId);
    if (!oldRule || !newRule) continue;

    const fieldChanges = compareRulesByComparableFields(oldRule, newRule);
    if (fieldChanges.length === 0) {
      continue;
    }

    modifiedRuleIds.push(ruleId);

    const scopes = [...new Set([...getRuleScopes(oldRule), ...getRuleScopes(newRule)])]
      .sort((a, b) => sortScopes(a, b));

    ruleChanges.push({
      kind: 'modified',
      ruleId,
      scopes,
      summary: summarizeModifiedRule(oldRule, newRule, fieldChanges),
      fieldChanges,
      oldRule,
      newRule,
    });
  }

  modifiedRuleIds.sort((a, b) => a.localeCompare(b));

  const grouped = new Map<string, ScopeChanges>();

  for (const change of ruleChanges) {
    for (const scope of change.scopes) {
      const existing = grouped.get(scope) ?? {
        scope,
        added: [],
        removed: [],
        modified: [],
      };

      if (change.kind === 'added') existing.added.push(change);
      if (change.kind === 'removed') existing.removed.push(change);
      if (change.kind === 'modified') existing.modified.push(change);

      grouped.set(scope, existing);
    }
  }

  const changesByScope = [...grouped.values()]
    .map((entry) => ({
      scope: entry.scope,
      added: sortRuleChanges(entry.added),
      removed: sortRuleChanges(entry.removed),
      modified: sortRuleChanges(entry.modified),
    }))
    .sort((left, right) => sortScopes(left.scope, right.scope));

  const allTools = new Set<string>();
  for (const rule of [...oldRules, ...newRules]) {
    for (const scope of getRuleScopes(rule)) {
      if (scope !== 'GLOBAL') {
        allTools.add(scope);
      }
    }
  }

  const changedTools = new Set<string>();
  for (const change of ruleChanges) {
    for (const scope of change.scopes) {
      if (scope !== 'GLOBAL') {
        changedTools.add(scope);
      }
    }
  }

  const unchangedTools = [...allTools]
    .filter((tool) => !changedTools.has(tool))
    .sort((a, b) => a.localeCompare(b));

  return {
    addedRuleIds,
    removedRuleIds,
    modifiedRuleIds,
    ruleChanges: sortRuleChanges(ruleChanges),
    changesByScope,
    unchangedTools,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeTimestamp(raw: unknown): string | null {
  if (raw instanceof Date) {
    return Number.isNaN(raw.getTime()) ? null : raw.toISOString();
  }

  if (typeof raw === 'string' || typeof raw === 'number') {
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }

  return null;
}

function parseReplayLog(logPath: string): ParsedReplayLog {
  if (!existsSync(logPath)) {
    throw new Error(`Log file not found: ${logPath}`);
  }

  const content = readFileSync(logPath, 'utf-8');
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

    calls.push({
      index: calls.length + 1,
      line: lineNumber,
      tool,
      arguments: argumentsValue,
      timestamp,
      sessionId: normalizeOptionalString(parsed.sessionId ?? parsed.session_id),
      agentId: normalizeOptionalString(parsed.agentId ?? parsed.agent_id),
      userId: normalizeOptionalString(parsed.userId ?? parsed.user_id),
      role: normalizeOptionalString(parsed.role),
      custom: isPlainObject(parsed.custom) ? parsed.custom : undefined,
    });
  }

  if (calls.length === 0) {
    throw new Error(`No valid replay calls found in log file: ${logPath}`);
  }

  return {
    calls,
    totalLines,
    invalidLines: invalidLineNumbers.length,
    invalidLineNumbers,
  };
}

function evaluateExpressionSafely(
  expression: string,
  context: Record<string, unknown>,
  cache: Map<string, ASTNode>
): boolean {
  let ast = cache.get(expression);
  if (!ast) {
    try {
      ast = compile(expression);
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

function matchesReplayRule(
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

function buildReplaySnapshot(snapshot: PolicySnapshot): ReplaySnapshot {
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

function decideReplayCall(
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

function replayCalls(snapshot: PolicySnapshot, calls: readonly ReplayCall[]): ReplayDecision[] {
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

function countDecisions(decisions: readonly ReplayDecision[]): DecisionCounts {
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

function buildImpactReport(logPath: string, oldSnapshot: PolicySnapshot, newSnapshot: PolicySnapshot): ImpactReport {
  const parsedLog = parseReplayLog(logPath);
  const oldDecisions = replayCalls(oldSnapshot, parsedLog.calls);
  const newDecisions = replayCalls(newSnapshot, parsedLog.calls);

  const transitions = new Map<string, number>();
  const changedByTool = new Map<string, number>();
  const samples: ImpactReport['samples'] = [];

  let changedCalls = 0;
  let additionalDenied = 0;
  let additionalRequireApproval = 0;

  for (let index = 0; index < parsedLog.calls.length; index++) {
    const call = parsedLog.calls[index];
    const oldDecision = oldDecisions[index];
    const newDecision = newDecisions[index];

    const transitionKey = `${oldDecision.decision}->${newDecision.decision}`;
    transitions.set(transitionKey, (transitions.get(transitionKey) ?? 0) + 1);

    if (oldDecision.decision !== newDecision.decision) {
      changedCalls += 1;
      changedByTool.set(call.tool, (changedByTool.get(call.tool) ?? 0) + 1);

      if (newDecision.decision === 'deny' && oldDecision.decision !== 'deny') {
        additionalDenied += 1;
      }

      if (
        newDecision.decision === 'require_approval'
        && oldDecision.decision !== 'require_approval'
      ) {
        additionalRequireApproval += 1;
      }

      if (samples.length < MAX_IMPACT_SAMPLES) {
        samples.push({
          index: call.index,
          line: call.line,
          tool: call.tool,
          timestamp: call.timestamp,
          oldDecision,
          newDecision,
        });
      }
    }
  }

  const orderedTransitions: Record<string, number> = {};
  for (const [key, value] of [...transitions.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    orderedTransitions[key] = value;
  }

  return {
    logPath,
    totalLines: parsedLog.totalLines,
    validCalls: parsedLog.calls.length,
    invalidLines: parsedLog.invalidLines,
    invalidLineNumbers: [...parsedLog.invalidLineNumbers],
    oldDecisionCounts: countDecisions(oldDecisions),
    newDecisionCounts: countDecisions(newDecisions),
    transitions: orderedTransitions,
    changedCalls,
    additionalDenied,
    additionalRequireApproval,
    changedByTool: [...changedByTool.entries()]
      .map(([tool, count]) => ({ tool, count }))
      .sort((left, right) => {
        if (left.count !== right.count) return right.count - left.count;
        return left.tool.localeCompare(right.tool);
      }),
    samples,
  };
}

function formatStructuralText(structural: StructuralDiff): string[] {
  const lines: string[] = [];

  lines.push('Structural changes:');
  lines.push(
    `  added=${structural.addedRuleIds.length}, removed=${structural.removedRuleIds.length}, modified=${structural.modifiedRuleIds.length}`
  );

  if (structural.ruleChanges.length === 0) {
    lines.push('  No structural authorization changes detected.');
  } else {
    for (const scopeEntry of structural.changesByScope) {
      lines.push(`  Scope: ${scopeEntry.scope}`);

      for (const added of scopeEntry.added) {
        lines.push(`    + ${added.ruleId}: ${added.summary}`);
      }
      for (const removed of scopeEntry.removed) {
        lines.push(`    - ${removed.ruleId}: ${removed.summary}`);
      }
      for (const modified of scopeEntry.modified) {
        const fields = modified.fieldChanges.map((change) => change.field).join(', ');
        lines.push(`    ~ ${modified.ruleId}: ${modified.summary}`);
        if (fields) {
          lines.push(`      fields: ${fields}`);
        }
      }
    }
  }

  if (structural.unchangedTools.length > 0) {
    lines.push(`  ~ No direct tool-scoped changes to: ${structural.unchangedTools.join(', ')}`);
  }

  return lines;
}

function formatImpactText(impact: ImpactReport): string[] {
  const lines: string[] = [];

  lines.push('Impact replay:');
  lines.push(
    `  analyzed=${impact.validCalls}, invalid_lines=${impact.invalidLines}, changed=${impact.changedCalls}`
  );
  lines.push(
    `  additional_denied=${impact.additionalDenied}, additional_require_approval=${impact.additionalRequireApproval}`
  );

  const transitionEntries = Object.entries(impact.transitions);
  if (transitionEntries.length > 0) {
    lines.push(
      `  transitions: ${transitionEntries
        .map(([key, value]) => `${key}=${value}`)
        .join(', ')}`
    );
  }

  if (impact.changedByTool.length > 0) {
    lines.push(
      `  changed_tools: ${impact.changedByTool
        .map((entry) => `${entry.tool}(${entry.count})`)
        .join(', ')}`
    );
  }

  if (impact.samples.length > 0) {
    lines.push('  sample_changes:');
    for (const sample of impact.samples) {
      lines.push(
        `    #${sample.index} ${sample.tool} ${sample.oldDecision.decision} -> ${sample.newDecision.decision} (${sample.timestamp})`
      );
    }
  }

  return lines;
}

function formatTextReport(report: DiffReport): string {
  const lines: string[] = [];

  lines.push('');
  lines.push('Veto Policy Diff');
  lines.push('================');
  lines.push(`Project directory: ${report.projectDir}`);
  lines.push(`Mode: ${report.sources.mode}`);
  lines.push(`Old source: ${report.sources.old}`);
  lines.push(`New source: ${report.sources.new}`);

  if (report.sources.log) {
    lines.push(`Log source: ${report.sources.log}`);
  }

  lines.push(`Rules: old=${report.summary.oldRules}, new=${report.summary.newRules}`);
  lines.push('');
  lines.push(...formatStructuralText(report.structural));

  if (report.impact) {
    lines.push('');
    lines.push(...formatImpactText(report.impact));
  }

  lines.push('');

  return lines.join('\n');
}

function normalizeFormat(format: ReportFormat | undefined): ReportFormat {
  return format === 'json' ? 'json' : 'text';
}

function resolveSources(
  projectDir: string,
  options: DiffOptions
): { oldSnapshot: PolicySnapshot; newSnapshot: PolicySnapshot; sources: DiffSources } {
  const policyPath = options.policyPath?.trim();
  const hasOld = Boolean(options.old);
  const hasNew = Boolean(options.new);

  if (hasOld !== hasNew) {
    throw new Error('Provide both --old and --new for explicit diff mode.');
  }

  if (hasOld && hasNew) {
    if (policyPath) {
      throw new Error('Do not pass <policy-path> when using --old and --new.');
    }

    const oldPath = resolveExplicitPath(projectDir, options.old as string, '--old');
    const newPath = resolveExplicitPath(projectDir, options.new as string, '--new');

    const oldType = getPathType(oldPath);
    const newType = getPathType(newPath);

    if (oldType !== newType) {
      throw new Error('Explicit diff mode requires both paths to be files or both directories.');
    }

    const oldSnapshot = loadPolicySnapshotFromFileOrDirectory(oldPath);
    const newSnapshot = loadPolicySnapshotFromFileOrDirectory(newPath);

    return {
      oldSnapshot,
      newSnapshot,
      sources: {
        mode: oldType === 'directory' ? 'explicit-directory' : 'explicit-file',
        old: oldPath,
        new: newPath,
      },
    };
  }

  if (!policyPath) {
    throw new Error('Usage: veto diff <policy-path> OR veto diff --old <path> --new <path>.');
  }

  const resolvedPolicyPath = resolvePolicyInputPath(projectDir, policyPath);
  const policyType = getPathType(resolvedPolicyPath);

  if (policyType !== 'file') {
    throw new Error('Implicit diff mode supports file input only. Use --old and --new for directories.');
  }

  const oldSnapshot = loadPolicySnapshotFromGitHead(resolvedPolicyPath, projectDir);
  const newSnapshot = loadPolicySnapshotFromFileOrDirectory(resolvedPolicyPath);

  return {
    oldSnapshot,
    newSnapshot,
    sources: {
      mode: 'implicit-git-file',
      old: oldSnapshot.source,
      new: resolvedPolicyPath,
    },
  };
}

export async function diff(options: DiffOptions = {}): Promise<DiffResult> {
  const projectDir = resolve(options.directory ?? process.cwd());
  const quiet = options.quiet ?? false;
  const format = normalizeFormat(options.format);

  try {
    const { oldSnapshot, newSnapshot, sources } = resolveSources(projectDir, options);

    assertUniqueRuleIds(oldSnapshot, 'Old snapshot');
    assertUniqueRuleIds(newSnapshot, 'New snapshot');

    const structural = buildStructuralDiff(oldSnapshot.rules, newSnapshot.rules);

    const logPath = options.log
      ? (isAbsolute(options.log) ? options.log : resolve(projectDir, options.log))
      : undefined;

    const impact = logPath
      ? buildImpactReport(logPath, oldSnapshot, newSnapshot)
      : null;

    const report: DiffReport = {
      timestamp: new Date().toISOString(),
      projectDir,
      sources: {
        ...sources,
        log: logPath,
      },
      structural,
      impact,
      summary: {
        oldRules: oldSnapshot.rules.length,
        newRules: newSnapshot.rules.length,
        added: structural.addedRuleIds.length,
        removed: structural.removedRuleIds.length,
        modified: structural.modifiedRuleIds.length,
        changedScopes: structural.changesByScope.length,
        unchangedTools: structural.unchangedTools.length,
        hasChanges: structural.ruleChanges.length > 0,
      },
    };

    if (!quiet) {
      if (format === 'json') {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(formatTextReport(report));
      }
    }

    return {
      success: true,
      report,
      errors: [],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (!quiet) {
      console.error(`Error: ${message}`);
    }

    return {
      success: false,
      report: null,
      errors: [message],
    };
  }
}
