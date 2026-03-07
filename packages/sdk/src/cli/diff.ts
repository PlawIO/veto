import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { Rule, RuleCondition } from '../rules/types.js';
import {
  parseReplayLog,
  replayCalls,
  countDecisions,
  createRuleLoader,
  getPathType,
  createSnapshotFromLoader,
  loadPolicySnapshot as loadPolicySnapshotFromEngine,
  type PolicySnapshot,
  type ReplayDecision,
  type DecisionCounts,
} from './replay-engine.js';

type ReportFormat = 'text' | 'json';

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

export type { ReplayCall, ReplayDecision } from './replay-engine.js';

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

function loadPolicySnapshotFromFileOrDirectory(inputPath: string): PolicySnapshot {
  return loadPolicySnapshotFromEngine(inputPath);
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
