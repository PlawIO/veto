import { createInterface, type Interface } from 'node:readline';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import type { Rule, RuleCondition } from '../rules/types.js';
import type { ArgumentConstraint, LocalValidationResult } from '../deterministic/types.js';
import type { DiscoveredTool } from './scan.js';
import { colors } from './colors.js';
import { validateDeterministic } from '../deterministic/validator.js';
import { Veto } from '../core/veto.js';
import { createPackRulesTemplate } from './templates.js';
import {
  clearSessionRules,
  createReplSessionContext,
  ensureRulesDirectory,
  exportRulesYaml,
  findRuleById,
  formatPolicySchemaError,
  getRuleSourceInfo,
  getRulesForTool,
  listRuleSummaries,
  loadSessionRulesFromFile,
  reloadReplContext,
  rescanReplContext,
  type ReplSessionContext,
} from './repl-context.js';
import {
  buildTemplateExplanation,
  explainRule,
  generatePolicyFromPrompt,
  interpretNaturalLanguageIntent,
  type ReplIntent,
  validateGeneratedYaml,
} from './repl-generate.js';
import { getCliVersion } from './version.js';

const DEFAULT_HISTORY_LIMIT = 1000;
const DEFAULT_EXPORT_PATH = './veto/rules/repl.generated.yaml';

const HELP_LINES = [
  'Commands:',
  '  /scan                              Rescan project tools and coverage suggestions',
  '  /test <tool>({args})               Test a tool call against local rules',
  '  /test-suite                        Run generated scenarios against loaded rules',
  '  /explain <ruleId>                  Explain rule behavior',
  '  /list                              List active rules in session',
  '  /export [file]                     Export merged rules to YAML',
  '  /load <file>                       Load a policy YAML file into current session',
  '  /clear                             Clear session rules and reload from disk',
  '  /help, /commands                   Show this help',
  '  /quit                              Exit REPL',
  '  Aliases: /q /? /s /t /ts /e /ls /x /c',
  '',
  'Free-form input supports:',
  '  - Ask/simulate: "what would happen if my agent transfers $50,000?"',
  '  - Generate: "block emails to external domains"',
  '  - Explain: "explain the transfer-limit rule"',
  '  - Suite test: "test my agent against current rules"',
] as const;

const COMMAND_COMPLETIONS = [
  '/scan',
  '/test',
  '/test-suite',
  '/explain',
  '/list',
  '/export',
  '/load',
  '/clear',
  '/help',
  '/quit',
] as const;

export interface ReplCommandResult {
  ok: boolean;
  lines: string[];
  exit?: boolean;
}

export interface ToolImpact {
  toolName: string;
  locations: string[];
  isCovered: boolean;
  matchReason: string;
}

export interface StartReplOptions {
  cwd?: string;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  version?: string;
  historyPath?: string;
  editorCommand?: string;
}

interface RuntimeOptions {
  ask?: (prompt: string) => Promise<string>;
  writeFile?: (filePath: string, content: string) => Promise<void>;
  openEditor?: (content: string) => Promise<string>;
}

interface ParsedSlashCommand {
  command: string;
  argText: string;
}

interface ParsedTestCall {
  toolName: string;
  args: Record<string, unknown>;
}

interface HybridTestResult {
  decision: 'allow' | 'deny';
  matchedRule?: Rule;
  reason: string;
}

interface ConditionConstraintMapping {
  argumentName: string;
  apply: (constraint: ArgumentConstraint) => void;
}

function toSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveHistoryPath(customPath?: string): string {
  if (customPath) {
    return resolve(customPath);
  }
  return resolve(homedir(), '.veto_history');
}

function dedupeBoundedHistory(lines: readonly string[], maxEntries: number): string[] {
  const deduped: string[] = [];
  const seen = new Set<string>();

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line || seen.has(line)) {
      continue;
    }
    seen.add(line);
    deduped.push(line);

    if (deduped.length >= maxEntries) {
      break;
    }
  }

  return deduped.reverse();
}

export function loadHistoryFile(filePath: string, maxEntries = DEFAULT_HISTORY_LIMIT): string[] {
  if (!existsSync(filePath)) {
    return [];
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
    return dedupeBoundedHistory(lines, maxEntries);
  } catch {
    return [];
  }
}

export function persistHistoryFile(
  filePath: string,
  existing: readonly string[],
  newEntries: readonly string[],
  maxEntries = DEFAULT_HISTORY_LIMIT
): void {
  const merged = dedupeBoundedHistory([...existing, ...newEntries], maxEntries);

  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${merged.join('\n')}\n`, 'utf-8');
}

function parseSlashCommand(input: string): ParsedSlashCommand {
  const trimmed = input.trim();
  const firstSpace = trimmed.indexOf(' ');

  if (firstSpace === -1) {
    return {
      command: trimmed.slice(1).toLowerCase(),
      argText: '',
    };
  }

  return {
    command: trimmed.slice(1, firstSpace).toLowerCase(),
    argText: trimmed.slice(firstSpace + 1).trim(),
  };
}

export function parseTestInvocation(value: string): ParsedTestCall {
  const trimmed = value.trim();
  const match = trimmed.match(/^([A-Za-z0-9_.:-]+)\((.*)\)$/s);

  if (!match) {
    throw new Error('Expected format: /test <tool>({"arg":"value"})');
  }

  const toolName = match[1];
  const rawArgs = match[2]?.trim();

  if (!rawArgs || rawArgs.length === 0) {
    return { toolName, args: {} };
  }

  try {
    const parsed = JSON.parse(rawArgs) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Arguments must be a JSON object');
    }

    return {
      toolName,
      args: parsed as Record<string, unknown>,
    };
  } catch (error) {
    throw new Error(`Invalid JSON arguments: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mapConditionToConstraint(condition: RuleCondition): ConditionConstraintMapping | null {
  if (!condition.field || !condition.operator) {
    return null;
  }

  const fieldMatch = condition.field.match(/^arguments\.([A-Za-z_][A-Za-z0-9_]*)$/);
  if (!fieldMatch) {
    return null;
  }

  const argumentName = fieldMatch[1];

  switch (condition.operator) {
    case 'equals':
      return {
        argumentName,
        apply: (constraint) => {
          constraint.in = [condition.value];
        },
      };
    case 'not_equals':
      return {
        argumentName,
        apply: (constraint) => {
          constraint.notIn = [condition.value];
        },
      };
    case 'greater_than':
      if (typeof condition.value !== 'number') {
        return null;
      }
      return {
        argumentName,
        apply: (constraint) => {
          constraint.greaterThan = condition.value as number;
        },
      };
    case 'less_than':
      if (typeof condition.value !== 'number') {
        return null;
      }
      return {
        argumentName,
        apply: (constraint) => {
          constraint.lessThan = condition.value as number;
        },
      };
    case 'matches':
      if (typeof condition.value !== 'string') {
        return null;
      }
      return {
        argumentName,
        apply: (constraint) => {
          constraint.regex = condition.value as string;
        },
      };
    case 'starts_with':
      if (typeof condition.value !== 'string') {
        return null;
      }
      return {
        argumentName,
        apply: (constraint) => {
          constraint.regex = `^${escapeRegex(condition.value as string)}`;
        },
      };
    case 'ends_with':
      if (typeof condition.value !== 'string') {
        return null;
      }
      return {
        argumentName,
        apply: (constraint) => {
          constraint.regex = `${escapeRegex(condition.value as string)}$`;
        },
      };
    case 'in':
      if (!Array.isArray(condition.value)) {
        return null;
      }
      return {
        argumentName,
        apply: (constraint) => {
          constraint.in = condition.value as unknown[];
        },
      };
    case 'not_in':
      if (!Array.isArray(condition.value)) {
        return null;
      }
      return {
        argumentName,
        apply: (constraint) => {
          constraint.notIn = condition.value as unknown[];
        },
      };
    case 'length_greater_than':
      if (typeof condition.value !== 'number') {
        return null;
      }
      return {
        argumentName,
        apply: (constraint) => {
          constraint.minLength = Math.floor(condition.value as number) + 1;
        },
      };
    default:
      return null;
  }
}

function evaluateRuleDeterministic(rule: Rule, args: Record<string, unknown>): { supported: true; result: LocalValidationResult } | { supported: false } {
  if (rule.conditions === undefined || rule.conditions.length === 0) {
    return { supported: false };
  }

  if ((rule.condition_groups && rule.condition_groups.length > 0) || rule.blocked_by || rule.requires || rule.agents) {
    return { supported: false };
  }

  const constraintsByArgument = new Map<string, ArgumentConstraint>();

  for (const condition of rule.conditions) {
    const mapping = mapConditionToConstraint(condition);
    if (!mapping) {
      return { supported: false };
    }

    const existing = constraintsByArgument.get(mapping.argumentName) ?? {
      argumentName: mapping.argumentName,
      enabled: true,
      required: true,
    };

    mapping.apply(existing);
    constraintsByArgument.set(mapping.argumentName, existing);
  }

  const constraints = [...constraintsByArgument.values()];
  if (constraints.length === 0) {
    return { supported: false };
  }

  return {
    supported: true,
    result: validateDeterministic('repl-test', args, constraints),
  };
}

function describeRuleMatch(rule: Rule, args: Record<string, unknown>): string {
  const firstCondition = rule.conditions?.[0];
  if (!firstCondition?.field || !firstCondition.operator) {
    return rule.description ?? `Matched rule '${rule.id}'`;
  }

  const fieldMatch = firstCondition.field.match(/^arguments\.(.+)$/);
  const fieldPath = fieldMatch ? fieldMatch[1] : firstCondition.field;
  const actualValue = fieldMatch ? args[fieldMatch[1]] : undefined;

  if (firstCondition.operator === 'greater_than') {
    return `${fieldPath} ${JSON.stringify(actualValue)} exceeds limit of ${JSON.stringify(firstCondition.value)}`;
  }

  if (firstCondition.operator === 'less_than') {
    return `${fieldPath} ${JSON.stringify(actualValue)} is below minimum of ${JSON.stringify(firstCondition.value)}`;
  }

  return `${fieldPath} matched ${firstCondition.operator} ${JSON.stringify(firstCondition.value)}`;
}

export async function evaluateToolCallHybrid(
  context: ReplSessionContext,
  toolName: string,
  args: Record<string, unknown>,
): Promise<HybridTestResult> {
  const rules = getRulesForTool(context, toolName);

  if (rules.length === 0) {
    return {
      decision: 'allow',
      reason: 'No matching rules found for tool',
    };
  }

  let firstAllowRule: Rule | undefined;
  let requiresFallback = false;

  for (const rule of rules) {
    const deterministic = evaluateRuleDeterministic(rule, args);
    if (!deterministic.supported) {
      requiresFallback = true;
      continue;
    }

    if (deterministic.result.decision !== 'allow') {
      continue;
    }

    if (rule.action === 'warn' || rule.action === 'log') {
      continue;
    }

    if (rule.action === 'allow') {
      if (!firstAllowRule) {
        firstAllowRule = rule;
      }
      continue;
    }

    if (rule.action === 'require_approval') {
      return {
        decision: 'deny',
        matchedRule: rule,
        reason: `Rule requires approval: ${describeRuleMatch(rule, args)}`,
      };
    }

    if (rule.action === 'block') {
      return {
        decision: 'deny',
        matchedRule: rule,
        reason: describeRuleMatch(rule, args),
      };
    }
  }

  if (!requiresFallback) {
    if (firstAllowRule) {
      return {
        decision: 'allow',
        matchedRule: firstAllowRule,
        reason: firstAllowRule.description ?? `Allowed by rule '${firstAllowRule.id}'`,
      };
    }

    return {
      decision: 'allow',
      reason: 'No blocking rules matched',
    };
  }

  const fallbackVeto = Veto.fromRules({
    rules: context.allRules,
    logLevel: 'silent',
  });
  const fallbackResult = await fallbackVeto.guard(toolName, args);

  if (fallbackResult.decision === 'deny' || fallbackResult.decision === 'require_approval') {
    const matchedRule = fallbackResult.ruleId
      ? context.allRules.find((rule) => rule.id === fallbackResult.ruleId)
      : undefined;

    return {
      decision: 'deny',
      matchedRule,
      reason: fallbackResult.reason ?? 'Denied by local rule evaluation',
    };
  }

  if (fallbackResult.ruleId) {
    const matchedAllowRule = context.allRules.find((rule) => rule.id === fallbackResult.ruleId);
    if (matchedAllowRule) {
      return {
        decision: 'allow',
        matchedRule: matchedAllowRule,
        reason: fallbackResult.reason ?? matchedAllowRule.description ?? `Allowed by rule '${matchedAllowRule.id}'`,
      };
    }
  }

  if (firstAllowRule) {
    return {
      decision: 'allow',
      matchedRule: firstAllowRule,
      reason: firstAllowRule.description ?? `Allowed by rule '${firstAllowRule.id}'`,
    };
  }

  return {
    decision: 'allow',
    reason: fallbackResult.reason ?? 'No blocking rules matched',
  };
}

function formatScanSummary(context: ReplSessionContext): string[] {
  const report = context.scanReport;
  const lines: string[] = [];

  lines.push(
    `Loaded ${context.allRules.length} rules from ${report.policy.rulesDirectory}. Found ${report.summary.total} tools in project.`
  );

  if (report.summary.total > 0) {
    lines.push(
      `Coverage: ${report.summary.covered}/${report.summary.total} (${report.summary.coveragePercent.toFixed(1)}%).`
    );
  }

  if (report.suggestions.length > 0) {
    const packs = [...new Set(report.suggestions.map((suggestion) => suggestion.pack))];
    lines.push(`Suggested packs: ${packs.join(', ')}`);
  }

  return lines;
}

function formatToolList(context: ReplSessionContext): string[] {
  const lines: string[] = [];
  const tools = context.discoveredTools;

  if (tools.length === 0) {
    return ['  (no tools discovered)'];
  }

  const maxToolsToShow = 20;
  const displayTools = tools.slice(0, maxToolsToShow);
  const truncated = tools.length > maxToolsToShow;

  for (const tool of displayTools) {
    const location = tool.locations[0] || 'unknown';
    const status = tool.covered ? '' : ' [uncovered]';
    lines.push(`  - ${tool.name} (${location})${status}`);
  }

  if (truncated) {
    lines.push(`  ... and ${tools.length - maxToolsToShow} more`);
  }

  return lines;
}

export function analyzeToolImpact(rules: Rule[], tools: DiscoveredTool[]): ToolImpact[] {
  const targetTools = new Set<string>();
  for (const rule of rules) {
    if (rule.tools) {
      for (const t of rule.tools) {
        targetTools.add(t);
      }
    }
  }

  const impacts: ToolImpact[] = [];
  for (const toolName of targetTools) {
    const tool = tools.find((t) => t.name === toolName);
    if (tool) {
      impacts.push({
        toolName,
        locations: [...tool.locations],
        isCovered: tool.covered,
        matchReason: tool.coverageReason ?? (tool.covered ? 'Tool is covered by existing rules' : 'No matching rules found'),
      });
    } else {
      impacts.push({
        toolName,
        locations: [],
        isCovered: false,
        matchReason: 'Tool not discovered in project',
      });
    }
  }
  return impacts;
}

function formatToolImpactSummary(impacts: ToolImpact[]): string[] {
  const lines: string[] = [];

  if (impacts.length === 0) {
    return lines;
  }

  const covered = impacts.filter((i) => i.isCovered);
  const uncovered = impacts.filter((i) => !i.isCovered);

  for (const impact of uncovered) {
    const locs = impact.locations.length > 0
      ? impact.locations.slice(0, 2).join(', ')
      : 'not found in project';
    lines.push(`  ${colors.uncoveredBadge} ${impact.toolName} -> ${locs}`);
  }

  for (const impact of covered) {
    const locs = impact.locations.length > 0
      ? impact.locations.slice(0, 2).join(', ')
      : 'unknown';
    lines.push(`  ${colors.coveredBadge} ${impact.toolName} -> ${locs}`);
  }

  return lines;
}

function formatStartupBanner(version: string, context: ReplSessionContext): string[] {
  const lines: string[] = [];

  lines.push(`=== Veto Policy Shell v${version} ===`);
  lines.push(`Project: ${context.projectDir}`);
  lines.push('');
  lines.push(`Tools discovered: ${context.discoveredTools.length}`);
  lines.push(...formatToolList(context));
  lines.push('');
  lines.push(`Rules loaded: ${context.allRules.length}`);

  const coverage = context.scanReport.summary;
  if (coverage.total > 0) {
    lines.push(`Coverage: ${coverage.covered}/${coverage.total} (${coverage.coveragePercent.toFixed(1)}%)`);
  }

  lines.push('');
  lines.push('What policy do you want? (or "help" for commands)');

  return lines;
}

async function writeFileContent(filePath: string, content: string): Promise<void> {
  const resolvedPath = resolve(filePath);
  mkdirSync(dirname(resolvedPath), { recursive: true });
  writeFileSync(resolvedPath, content, 'utf-8');
}

async function openWithEditor(content: string, editorCommand?: string): Promise<string> {
  const editor = editorCommand ?? process.env.EDITOR ?? 'vi';
  const tempDir = mkdtempSync(join(tmpdir(), 'veto-repl-'));
  const tempPath = join(tempDir, 'generated.yaml');

  writeFileSync(tempPath, content, 'utf-8');

  const escapedPath = tempPath.replace(/(["\\$`])/g, '\\$1');
  const result = spawnSync(`${editor} "${escapedPath}"`, {
    stdio: 'inherit',
    shell: true,
  });

  if (result.error) {
    rmSync(tempDir, { recursive: true, force: true });
    throw result.error;
  }

  const edited = readFileSync(tempPath, 'utf-8');
  rmSync(tempDir, { recursive: true, force: true });
  return edited;
}

async function maybeApplySuggestedPacks(
  context: ReplSessionContext,
  ask: (prompt: string) => Promise<string>,
  writeFile: (filePath: string, content: string) => Promise<void>
): Promise<string[]> {
  const suggestedPacks = [...new Set(
    context.scanReport.suggestions
      .map((suggestion) => suggestion.pack)
      .filter((pack) => pack.startsWith('@veto/'))
  )];

  if (suggestedPacks.length === 0) {
    return [];
  }

  const answer = (await ask(`Apply suggested packs (${suggestedPacks.join(', ')})? [y/N] `)).trim().toLowerCase();
  if (!['y', 'yes'].includes(answer)) {
    return [];
  }

  const lines: string[] = [];
  ensureRulesDirectory(context);

  for (const pack of suggestedPacks) {
    const slug = pack.replace(/^@veto\//, '');
    const targetPath = resolve(context.rulesDir, `${slug}.yaml`);

    if (existsSync(targetPath)) {
      const overwrite = (await ask(`Overwrite ${targetPath}? [y/N] `)).trim().toLowerCase();
      if (!['y', 'yes'].includes(overwrite)) {
        lines.push(`Skipped ${targetPath}`);
        continue;
      }
    }

    await writeFile(targetPath, createPackRulesTemplate(pack));
    lines.push(`Applied ${pack} -> ${targetPath}`);
  }

  await reloadReplContext(context);
  return [...lines, ...formatScanSummary(context)];
}

function resolveArgumentField(condition: RuleCondition): string | null {
  if (!condition.field) {
    return null;
  }

  const match = condition.field.match(/^arguments\.([A-Za-z_][A-Za-z0-9_]*)$/);
  if (!match) {
    return null;
  }

  return match[1];
}

function buildConditionMatchingValue(condition: RuleCondition): unknown {
  switch (condition.operator) {
    case 'equals':
      return condition.value;
    case 'not_equals':
      if (typeof condition.value === 'number') {
        return condition.value + 1;
      }
      if (typeof condition.value === 'string') {
        return `${condition.value}-other`;
      }
      return true;
    case 'greater_than':
      return typeof condition.value === 'number'
        ? condition.value + 1
        : condition.value;
    case 'less_than':
      return typeof condition.value === 'number'
        ? condition.value - 1
        : condition.value;
    case 'contains':
      return typeof condition.value === 'string'
        ? `prefix-${condition.value}-suffix`
        : condition.value;
    case 'not_contains':
      return typeof condition.value === 'string'
        ? 'safe-value'
        : 'safe-value';
    case 'starts_with':
      return typeof condition.value === 'string'
        ? `${condition.value}/sample`
        : condition.value;
    case 'ends_with':
      return typeof condition.value === 'string'
        ? `sample-${condition.value}`
        : condition.value;
    case 'in':
      return Array.isArray(condition.value) ? condition.value[0] : undefined;
    case 'not_in':
      return '__outside_scope__';
    case 'length_greater_than':
      return typeof condition.value === 'number'
        ? 'x'.repeat(Math.max(1, Math.floor(condition.value) + 1))
        : 'sample';
    default:
      return condition.value;
  }
}

function buildScenarioArgsForRule(rule: Rule): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const sourceConditions = rule.conditions ?? [];

  for (const condition of sourceConditions) {
    const argumentName = resolveArgumentField(condition);
    if (!argumentName || !condition.operator) {
      continue;
    }

    args[argumentName] = buildConditionMatchingValue(condition);
  }

  return args;
}

async function runScenarioSuite(context: ReplSessionContext): Promise<ReplCommandResult> {
  const lines: string[] = [];
  const candidateRules = context.allRules.filter((rule) => rule.enabled !== false);
  const scenarios = candidateRules.slice(0, 20);

  if (scenarios.length === 0) {
    return {
      ok: true,
      lines: ['No rules loaded. Nothing to scenario-test.'],
    };
  }

  let denied = 0;
  let allowed = 0;

  for (const rule of scenarios) {
    const toolName = rule.tools?.[0];
    if (!toolName) {
      continue;
    }

    const args = buildScenarioArgsForRule(rule);
    const result = await evaluateToolCallHybrid(context, toolName, args);

    if (result.decision === 'deny') {
      denied += 1;
      lines.push(`DENY  ${toolName}(${JSON.stringify(args)}) -> ${result.matchedRule?.id ?? 'unknown'}`);
    } else {
      allowed += 1;
      lines.push(`ALLOW ${toolName}(${JSON.stringify(args)}) -> ${result.matchedRule?.id ?? 'no-match'}`);
    }
  }

  lines.unshift(`Scenario suite complete: ${allowed + denied} simulated call(s), ${denied} denied, ${allowed} allowed.`);

  return {
    ok: true,
    lines,
  };
}

async function handleSimulationRequest(
  context: ReplSessionContext,
  toolName: string | undefined,
  args: Record<string, unknown> | undefined
): Promise<ReplCommandResult> {
  if (!toolName) {
    return {
      ok: false,
      lines: [
        'Unable to infer a tool from your question.',
        'Try: "what would happen if transfer_funds amount is 50000?"',
      ],
    };
  }

  const safeArgs = args ?? {};
  const result = await evaluateToolCallHybrid(context, toolName, safeArgs);
  const source = result.matchedRule
    ? getRuleSourceInfo(context, result.matchedRule.id)
    : undefined;
  const sourceText = source
    ? `${source.source}${source.line ? `:${source.line}` : ''}`
    : 'unknown source';

  if (result.decision === 'deny') {
    return {
      ok: false,
      lines: [
        `Simulated ${toolName}(${JSON.stringify(safeArgs)})`,
        `[DENIED] by '${result.matchedRule?.id ?? 'unknown-rule'}' (${sourceText})`,
        `  ${result.reason}`,
        '  Local evaluation path: deterministic + full local fallback (no network).',
      ],
    };
  }

  return {
    ok: true,
    lines: [
      `Simulated ${toolName}(${JSON.stringify(safeArgs)})`,
      result.matchedRule
        ? `[OK] ALLOWED by '${result.matchedRule.id}'`
        : '[OK] ALLOWED',
      `  ${result.reason}`,
      '  Local evaluation path: deterministic + full local fallback (no network).',
    ],
  };
}

function resolveRuleIdFromText(text: string, context: ReplSessionContext): string | undefined {
  const lower = text.toLowerCase();
  const direct = context.allRules.find((rule) => lower.includes(rule.id.toLowerCase()));
  if (direct) {
    return direct.id;
  }

  const regexMatch = text.match(/rule\s+([A-Za-z0-9_.:-]+)/i);
  if (regexMatch?.[1]) {
    return regexMatch[1];
  }

  return undefined;
}

async function handleNaturalLanguageInput(
  input: string,
  context: ReplSessionContext,
  runtime: RuntimeOptions
): Promise<ReplCommandResult> {
  const interpreted = await interpretNaturalLanguageIntent({
    input,
    projectDir: context.projectDir,
    tools: context.discoveredTools,
    existingRules: context.allRules,
  });

  const warnings = interpreted.warnings.map((warning) => `Warning: ${warning}`);
  const intent = interpreted.intent as ReplIntent;

  if (intent === 'simulate') {
    const simulation = await handleSimulationRequest(context, interpreted.toolName, interpreted.args);
    return {
      ...simulation,
      lines: [...simulation.lines, ...warnings],
    };
  }

  if (intent === 'explain') {
    const ruleId = interpreted.ruleId ?? resolveRuleIdFromText(input, context);
    if (!ruleId) {
      return {
        ok: false,
        lines: [
          'Unable to resolve a rule id to explain.',
          'Try: "explain <rule-id>" or "/explain <rule-id>".',
          ...warnings,
        ],
      };
    }

    const explained = await handleExplainCommand(ruleId, context);
    return {
      ...explained,
      lines: [...explained.lines, ...warnings],
    };
  }

  if (intent === 'test_suite') {
    const suite = await runScenarioSuite(context);
    return {
      ...suite,
      lines: [...suite.lines, ...warnings],
    };
  }

  const generated = await handleGenerationPrompt(interpreted.prompt ?? input, context, runtime);
  return {
    ...generated,
    lines: [...generated.lines, ...warnings],
  };
}

async function handleExportCommand(
  context: ReplSessionContext,
  targetPathArg: string,
  runtime: RuntimeOptions
): Promise<ReplCommandResult> {
  const ask = runtime.ask ?? (async () => 'y');
  const writeFile = runtime.writeFile ?? writeFileContent;

  const relativeTarget = targetPathArg || DEFAULT_EXPORT_PATH;
  const resolvedTarget = resolve(context.projectDir, relativeTarget);

  const answer = (await ask(`Export merged rules to ${relativeTarget}? [Y/n] `)).trim().toLowerCase();
  if (answer === 'n' || answer === 'no') {
    return {
      ok: true,
      lines: ['Export canceled.'],
    };
  }

  const yaml = exportRulesYaml(context);
  await writeFile(resolvedTarget, yaml);

  return {
    ok: true,
    lines: [`Exported ${context.allRules.length} rules to ${resolvedTarget}`],
  };
}

async function handleGenerationPrompt(
  input: string,
  context: ReplSessionContext,
  runtime: RuntimeOptions
): Promise<ReplCommandResult> {
  const ask = runtime.ask ?? (async () => 'n');
  const writeFile = runtime.writeFile ?? writeFileContent;
  const openEditor = runtime.openEditor ?? (async (content) => openWithEditor(content));

  const generated = await generatePolicyFromPrompt({
    prompt: input,
    projectDir: context.projectDir,
    rulesDirectory: context.rulesDir,
    tools: context.discoveredTools,
    existingRules: context.allRules,
  });

  const parsed = validateGeneratedYaml(generated.yaml);
  const parsedRules = (Array.isArray(parsed.rules) ? parsed.rules : []) as Rule[];
  const suggestedRuleId = parsedRules.length === 1 && parsedRules[0]?.id
    ? parsedRules[0].id
    : undefined;
  const suggestedSavePath = suggestedRuleId
    ? `./veto/rules/${toSlug(suggestedRuleId)}.yaml`
    : DEFAULT_EXPORT_PATH;

  const impacts = analyzeToolImpact(parsedRules, context.discoveredTools);

  const lines: string[] = [];

  lines.push('Proposed Policy:');
  lines.push('-'.repeat(40));
  lines.push(generated.yaml.trimEnd());
  lines.push('-'.repeat(40));

  if (impacts.length > 0) {
    lines.push('');
    lines.push('Tool Impact:');
    const impactLines = formatToolImpactSummary(impacts);
    for (const line of impactLines) {
      lines.push(line);
    }
    const covered = impacts.filter((i) => i.isCovered).length;
    const total = impacts.length;
    lines.push(`Impact: ${total} tool(s) affected by this policy (${covered}/${total} covered)`);
  }

  if (generated.notes) {
    lines.push(`Notes: ${generated.notes}`);
  }

  for (const warning of generated.warnings) {
    lines.push(`Warning: ${warning}`);
  }

  let yamlToSave = generated.yaml;
  const selectedSavePath = suggestedSavePath;

  while (true) {
    const answer = (await ask('[A]ccept [M]odify [S]kip [I]nspect [?]help: ')).trim();
    const normalizedAnswer = answer.toLowerCase();

    if (normalizedAnswer === '?' || normalizedAnswer === 'help') {
      lines.push('');
      lines.push('A - Accept and save the generated policy to file');
      lines.push('M - Modify the policy in your editor');
      lines.push('S - Skip and discard the generated policy');
      lines.push('I - Inspect tool details and coverage');
      lines.push('? - Show this help');
      lines.push('');
      continue;
    }

    if (normalizedAnswer === 'i' || normalizedAnswer === 'inspect') {
      lines.push('');
      lines.push('=== Tool Impact Details ===');
      for (const impact of impacts) {
        lines.push('');
        lines.push(`Tool: ${colors.tool(impact.toolName)}`);
        lines.push(`  Status: ${impact.isCovered ? colors.covered('Covered') : colors.uncovered('Uncovered')}`);
        lines.push(`  Reason: ${impact.matchReason}`);
        if (impact.locations.length > 0) {
          lines.push(`  Locations:`);
          for (const loc of impact.locations) {
            lines.push(`    - ${colors.path(loc)}`);
          }
        }
      }
      lines.push('');
      lines.push('Proposed Policy:');
      lines.push('-'.repeat(40));
      lines.push(yamlToSave.trimEnd());
      lines.push('-'.repeat(40));
      continue;
    }

    if (normalizedAnswer === 's' || normalizedAnswer === 'skip') {
      lines.push('Skipped. Not saved.');
      break;
    }

    if (normalizedAnswer === 'edit') {
      try {
        const edited = await openEditor(yamlToSave);
        validateGeneratedYaml(edited);
        yamlToSave = edited;
        lines.push('Edited YAML validated successfully.');
        lines.push('');
        lines.push('Proposed Policy (edited):');
        lines.push('-'.repeat(40));
        lines.push(yamlToSave.trimEnd());
        lines.push('-'.repeat(40));
      } catch (error) {
        const details = formatPolicySchemaError(error);
        lines.push('Edited YAML is invalid:');
        for (const detail of details) {
          lines.push(`  - ${detail}`);
        }
      }
      continue;
    }

    if (normalizedAnswer === 'm' || normalizedAnswer === 'modify') {
      try {
        const edited = await openEditor(yamlToSave);
        validateGeneratedYaml(edited);
        yamlToSave = edited;
        lines.push('Edited YAML validated successfully.');
        lines.push('');
        lines.push('Proposed Policy (edited):');
        lines.push('-'.repeat(40));
        lines.push(yamlToSave.trimEnd());
        lines.push('-'.repeat(40));
      } catch (error) {
        const details = formatPolicySchemaError(error);
        lines.push('Edited YAML is invalid:');
        for (const detail of details) {
          lines.push(`  - ${detail}`);
        }
      }
      continue;
    }

    if (normalizedAnswer === '' || normalizedAnswer === 'a' || normalizedAnswer === 'accept' || normalizedAnswer === 'y') {
      const outputPath = resolve(context.projectDir, selectedSavePath);

      if (existsSync(outputPath)) {
        const overwrite = (await ask(`Overwrite ${selectedSavePath}? [y/N] `)).trim().toLowerCase();
        if (!['y', 'yes'].includes(overwrite)) {
          lines.push('Not saved.');
          break;
        }
      }

      await writeFile(outputPath, yamlToSave);
      await reloadReplContext(context);
      lines.push(`Saved generated rules to ${outputPath}`);
      break;
    }

    lines.push('Please answer A, M, S, or ? for help.');
  }

  return {
    ok: true,
    lines,
  };
}

async function handleTestCommand(argText: string, context: ReplSessionContext): Promise<ReplCommandResult> {
  if (!argText) {
    return {
      ok: false,
      lines: ['Usage: /test <tool>({"arg":"value"}) or /test-suite'],
    };
  }

  if (!argText.includes('(') && /my agent|current rules|suite|scenario/i.test(argText)) {
    return runScenarioSuite(context);
  }

  let parsed: ParsedTestCall;
  try {
    parsed = parseTestInvocation(argText);
  } catch (error) {
    return {
      ok: false,
      lines: [error instanceof Error ? error.message : String(error)],
    };
  }

  const result = await evaluateToolCallHybrid(context, parsed.toolName, parsed.args);

  if (result.decision === 'allow') {
    if (result.matchedRule) {
      return {
        ok: true,
        lines: [
          `[OK] ALLOWED by '${result.matchedRule.id}'`,
          `  ${result.reason}`,
          '  Local evaluation path: deterministic + full local fallback (no network).',
        ],
      };
    }

    return {
      ok: true,
      lines: [
        '[OK] ALLOWED',
        `  ${result.reason}`,
        '  Local evaluation path: deterministic + full local fallback (no network).',
      ],
    };
  }

  const source = result.matchedRule
    ? getRuleSourceInfo(context, result.matchedRule.id)
    : undefined;
  const sourceText = source
    ? `${source.source}${source.line ? `:${source.line}` : ''}`
    : 'unknown source';

  return {
    ok: false,
    lines: [
      `[DENIED] by '${result.matchedRule?.id ?? 'unknown-rule'}' (${sourceText})`,
      `  ${result.reason}`,
      '  Local evaluation path: deterministic + full local fallback (no network).',
    ],
  };
}

async function handleExplainCommand(argText: string, context: ReplSessionContext): Promise<ReplCommandResult> {
  const ruleId = argText.trim();
  if (!ruleId) {
    return {
      ok: false,
      lines: ['Usage: /explain <ruleId>'],
    };
  }

  const rule = findRuleById(context, ruleId);
  if (!rule) {
    return {
      ok: false,
      lines: [`Rule not found: ${ruleId}`],
    };
  }

  const explained = await explainRule({
    rule,
    tools: context.discoveredTools,
    projectDir: context.projectDir,
  });

  const lines = [explained.explanation];
  if (explained.warnings.length > 0) {
    for (const warning of explained.warnings) {
      lines.push(`Warning: ${warning}`);
    }
  }

  return {
    ok: true,
    lines,
  };
}

export async function executeReplInput(
  input: string,
  context: ReplSessionContext,
  runtime: RuntimeOptions = {}
): Promise<ReplCommandResult> {
  const trimmed = input.trim();

  if (!trimmed) {
    return { ok: true, lines: [] };
  }

  if (!trimmed.startsWith('/')) {
    return handleNaturalLanguageInput(trimmed, context, runtime);
  }

  const { command, argText } = parseSlashCommand(trimmed);
  const ask = runtime.ask ?? (async () => 'n');
  const writeFile = runtime.writeFile ?? writeFileContent;
  const normalizedCommand = (
    command === '?' ? 'help'
      : command === 'q' ? 'quit'
        : command === 's' ? 'scan'
          : command === 't' ? 'test'
            : command === 'ts' ? 'test-suite'
              : command === 'e' ? 'explain'
                : command === 'ls' ? 'list'
                  : command === 'x' ? 'export'
                    : command === 'c' ? 'clear'
                      : command
  );

  switch (normalizedCommand) {
    case 'help':
    case 'commands':
      return { ok: true, lines: [...HELP_LINES] };

    case 'quit':
    case 'exit':
      return { ok: true, lines: ['Bye.'], exit: true };

    case 'scan': {
      await rescanReplContext(context);
      const lines = formatScanSummary(context);
      const applyLines = await maybeApplySuggestedPacks(context, ask, writeFile);
      return {
        ok: true,
        lines: [...lines, ...applyLines],
      };
    }

    case 'test':
      return handleTestCommand(argText, context);

    case 'test-suite':
      return runScenarioSuite(context);

    case 'explain':
      return handleExplainCommand(argText, context);

    case 'list': {
      const summaries = listRuleSummaries(context);
      if (summaries.length === 0) {
        return { ok: true, lines: ['No rules loaded.'] };
      }

      return {
        ok: true,
        lines: [`Loaded rules (${summaries.length}):`, ...summaries],
      };
    }

    case 'load': {
      if (!argText) {
        return { ok: false, lines: ['Usage: /load <file>'] };
      }

      try {
        const loaded = await loadSessionRulesFromFile(context, argText);
        return {
          ok: true,
          lines: [`Loaded ${loaded.length} rule(s) from ${argText}`],
        };
      } catch (error) {
        return {
          ok: false,
          lines: [error instanceof Error ? error.message : String(error)],
        };
      }
    }

    case 'export':
      return handleExportCommand(context, argText, runtime);

    case 'clear':
      await clearSessionRules(context);
      return {
        ok: true,
        lines: ['Cleared session rules and reloaded local rule files.'],
      };

    default:
      return {
        ok: false,
        lines: [`Unknown command: /${command}`, 'Use /help to see available commands.'],
      };
  }
}

function askQuestion(rl: Interface, prompt: string): Promise<string | null> {
  const withClosed = rl as Interface & { closed?: boolean };
  if (withClosed.closed) {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    const onClose = () => resolve(null);
    rl.once('close', onClose);
    rl.question(prompt, (answer) => {
      rl.off('close', onClose);
      resolve(answer);
    });
  });
}

function createReplCompleter(context: ReplSessionContext): (line: string) => [string[], string] {
  return (line: string) => {
    if (!line.startsWith('/')) {
      return [[], line];
    }

    if (line.startsWith('/explain ')) {
      const fragment = line.slice('/explain '.length).trim().toLowerCase();
      const candidates = context.allRules
        .map((rule) => rule.id)
        .filter((ruleId) => ruleId.toLowerCase().startsWith(fragment))
        .map((ruleId) => `/explain ${ruleId}`);
      return [candidates, line];
    }

    if (line.startsWith('/test ')) {
      const fragment = line.slice('/test '.length).trim().toLowerCase();
      const candidates = context.discoveredTools
        .map((tool) => `${tool.name}({})`)
        .filter((toolCall) => toolCall.toLowerCase().startsWith(fragment))
        .map((toolCall) => `/test ${toolCall}`);
      return [candidates, line];
    }

    const candidates = COMMAND_COMPLETIONS.filter((command) => command.startsWith(line.toLowerCase()));
    return [candidates as string[], line];
  };
}

export async function startRepl(options: StartReplOptions = {}): Promise<void> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const context = await createReplSessionContext(cwd);
  const version = options.version ?? getCliVersion();

  const historyPath = resolveHistoryPath(options.historyPath);
  const priorHistory = loadHistoryFile(historyPath, DEFAULT_HISTORY_LIMIT);
  const enteredHistory: string[] = [];

  const rl = createInterface({
    input: options.input ?? process.stdin,
    output: options.output ?? process.stdout,
    historySize: DEFAULT_HISTORY_LIMIT,
    completer: createReplCompleter(context),
  });

  if (priorHistory.length > 0) {
    const withHistory = rl as Interface & { history?: string[] };
    withHistory.history = [...priorHistory].reverse();
  }

  const output = options.output ?? process.stdout;
  const writeLine = (line = '') => {
    output.write(`${line}\n`);
  };

  for (const line of formatStartupBanner(version, context)) {
    writeLine(line);
  }
  writeLine();

  let shouldExit = false;
  rl.on('SIGINT', () => {
    shouldExit = true;
    writeLine();
    rl.close();
  });

  try {
    while (!shouldExit) {
      const line = await askQuestion(rl, 'policy> ');
      if (line === null) {
        break;
      }
      const trimmed = line.trim();

      if (!trimmed) {
        continue;
      }

      enteredHistory.push(trimmed);

      let result: ReplCommandResult;
      try {
        result = await executeReplInput(trimmed, context, {
          ask: async (prompt) => (await askQuestion(rl, prompt)) ?? '',
          openEditor: (content) => openWithEditor(content, options.editorCommand),
          writeFile: writeFileContent,
        });
      } catch (error) {
        result = {
          ok: false,
          lines: [`Error: ${toErrorMessage(error)}`],
        };
      }

      for (const outputLine of result.lines) {
        writeLine(outputLine);
      }

      if (result.exit) {
        shouldExit = true;
      }
    }
  } finally {
    try {
      persistHistoryFile(historyPath, priorHistory, enteredHistory, DEFAULT_HISTORY_LIMIT);
    } catch {
      // Ignore history persistence errors to avoid masking session output.
    }
    rl.close();
  }
}

export { buildTemplateExplanation, formatStartupBanner };
