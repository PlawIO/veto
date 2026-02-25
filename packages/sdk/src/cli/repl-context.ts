import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { parse as parseYaml, stringify } from 'yaml';
import { RuleLoader } from '../rules/loader.js';
import type { LoadedRules, Rule, RuleSet } from '../rules/types.js';
import { silentLogger } from '../utils/logger.js';
import { scan, type DiscoveredTool, type ScanReport } from './scan.js';
import { PolicySchemaError } from '../rules/schema-validator.js';

interface ReplConfigFile {
  rules?: {
    directory?: string;
    recursive?: boolean;
  };
}

export interface RuleSourceInfo {
  source: string;
  line?: number;
}

export interface ReplSessionContext {
  projectDir: string;
  vetoDir: string;
  rulesDir: string;
  recursiveRules: boolean;
  baselineRules: Rule[];
  sessionRules: Rule[];
  allRules: Rule[];
  rulesByTool: Map<string, Rule[]>;
  globalRules: Rule[];
  sourceByRuleId: Map<string, RuleSourceInfo>;
  scanReport: ScanReport;
  discoveredTools: DiscoveredTool[];
}

interface LoadedRuleState {
  rules: Rule[];
  sourceByRuleId: Map<string, RuleSourceInfo>;
  rulesByTool: Map<string, Rule[]>;
  globalRules: Rule[];
}

function createEmptyScanReport(projectDir: string, rulesDir: string): ScanReport {
  return {
    timestamp: new Date().toISOString(),
    projectDir,
    policy: {
      vetoDir: join(projectDir, 'veto'),
      rulesDirectory: rulesDir,
      recursiveRules: true,
      rulesLoaded: 0,
      globalRules: 0,
      sourceFiles: [],
      toolsReferenced: [],
    },
    manifest: {
      packageJsonFound: false,
      pyprojectFound: false,
      jsDependencies: [],
      pythonDependencies: [],
      frameworks: [],
    },
    discoveredTools: [],
    summary: {
      total: 0,
      covered: 0,
      uncovered: 0,
      coveragePercent: 100,
    },
    suggestions: [],
  };
}

function normalizeRulesConfig(projectDir: string): { vetoDir: string; rulesDir: string; recursiveRules: boolean } {
  const vetoDir = resolve(projectDir, 'veto');
  const configPath = join(vetoDir, 'veto.config.yaml');

  let rulesDir = resolve(vetoDir, 'rules');
  let recursiveRules = true;

  if (!existsSync(configPath)) {
    return { vetoDir, rulesDir, recursiveRules };
  }

  try {
    const parsed = parseYaml(readFileSync(configPath, 'utf-8')) as ReplConfigFile | null;
    if (parsed?.rules?.directory) {
      rulesDir = resolve(vetoDir, parsed.rules.directory);
    }
    if (typeof parsed?.rules?.recursive === 'boolean') {
      recursiveRules = parsed.rules.recursive;
    }
  } catch {
    return { vetoDir, rulesDir, recursiveRules };
  }

  return { vetoDir, rulesDir, recursiveRules };
}

function buildRuleLineIndex(content: string): Map<string, number> {
  const index = new Map<string, number>();
  const lines = content.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^\s*-?\s*id:\s*['"]?([^'"\s#]+)['"]?/);
    if (!match) {
      continue;
    }

    const ruleId = match[1]?.trim();
    if (ruleId && !index.has(ruleId)) {
      index.set(ruleId, i + 1);
    }
  }

  return index;
}

function safeReadRuleLineIndex(source: string): Map<string, number> {
  if (!existsSync(source)) {
    return new Map<string, number>();
  }

  try {
    return buildRuleLineIndex(readFileSync(source, 'utf-8'));
  } catch {
    return new Map<string, number>();
  }
}

function getRuleSetSource(loaded: LoadedRules, ruleSet: RuleSet, index: number): string {
  if (loaded.sourceFiles[index]) {
    return loaded.sourceFiles[index];
  }

  if (ruleSet.name) {
    return ruleSet.name;
  }

  return 'unknown';
}

function createLoadedRuleState(loaded: LoadedRules): LoadedRuleState {
  const sourceByRuleId = new Map<string, RuleSourceInfo>();

  for (let i = 0; i < loaded.ruleSets.length; i++) {
    const ruleSet = loaded.ruleSets[i];
    const source = getRuleSetSource(loaded, ruleSet, i);
    const lineIndex = safeReadRuleLineIndex(source);

    for (const rule of ruleSet.rules) {
      sourceByRuleId.set(rule.id, {
        source,
        line: lineIndex.get(rule.id),
      });
    }
  }

  const rulesByTool = new Map<string, Rule[]>();
  const globalRules: Rule[] = [];

  for (const rule of loaded.allRules) {
    if (rule.enabled === false) {
      continue;
    }

    if (!rule.tools || rule.tools.length === 0) {
      globalRules.push(rule);
      continue;
    }

    for (const toolName of rule.tools) {
      const existing = rulesByTool.get(toolName) ?? [];
      existing.push(rule);
      rulesByTool.set(toolName, existing);
    }
  }

  return {
    rules: loaded.allRules.filter((rule) => rule.enabled !== false),
    sourceByRuleId,
    rulesByTool,
    globalRules,
  };
}

function loadRulesFromDirectory(rulesDir: string, recursiveRules: boolean): LoadedRuleState {
  const loader = new RuleLoader({ logger: silentLogger });
  loader.setYamlParser(parseYaml);

  if (existsSync(rulesDir)) {
    loader.loadFromDirectory(rulesDir, recursiveRules);
  }

  return createLoadedRuleState(loader.getRules());
}

function mergeRulesById(baseRules: readonly Rule[], sessionRules: readonly Rule[]): Rule[] {
  const merged = [...baseRules];
  const indexById = new Map<string, number>();

  for (let i = 0; i < merged.length; i++) {
    indexById.set(merged[i].id, i);
  }

  for (const sessionRule of sessionRules) {
    const existingIndex = indexById.get(sessionRule.id);
    if (existingIndex !== undefined) {
      merged[existingIndex] = sessionRule;
      continue;
    }

    indexById.set(sessionRule.id, merged.length);
    merged.push(sessionRule);
  }

  return merged;
}

function buildRuleIndex(rules: readonly Rule[]): { globalRules: Rule[]; rulesByTool: Map<string, Rule[]> } {
  const globalRules: Rule[] = [];
  const rulesByTool = new Map<string, Rule[]>();

  for (const rule of rules) {
    if (rule.enabled === false) {
      continue;
    }

    if (!rule.tools || rule.tools.length === 0) {
      globalRules.push(rule);
      continue;
    }

    for (const toolName of rule.tools) {
      const existing = rulesByTool.get(toolName) ?? [];
      existing.push(rule);
      rulesByTool.set(toolName, existing);
    }
  }

  return { globalRules, rulesByTool };
}

function computeSessionSourceMap(sessionRules: readonly Rule[], sessionSourceByRuleId: Map<string, RuleSourceInfo>): Map<string, RuleSourceInfo> {
  const map = new Map<string, RuleSourceInfo>();

  for (const rule of sessionRules) {
    const source = sessionSourceByRuleId.get(rule.id);
    if (source) {
      map.set(rule.id, source);
    }
  }

  return map;
}

async function createScanReport(projectDir: string, rulesDir: string): Promise<ScanReport> {
  try {
    const result = await scan({ directory: projectDir, quiet: true, suggest: true });
    return result.report;
  } catch {
    return createEmptyScanReport(projectDir, rulesDir);
  }
}

function resolveDisplaySource(projectDir: string, source: string): string {
  if (!source) {
    return 'unknown';
  }

  if (!source.startsWith('/')) {
    return source;
  }

  const rel = relative(projectDir, source);
  if (rel && !rel.startsWith('..')) {
    return rel;
  }

  return source;
}

function applyContextRules(
  context: ReplSessionContext,
  baseline: LoadedRuleState,
  sessionSourceByRuleId: Map<string, RuleSourceInfo>
): void {
  context.baselineRules = baseline.rules;
  context.sourceByRuleId = new Map<string, RuleSourceInfo>(baseline.sourceByRuleId);

  const mergedRules = mergeRulesById(context.baselineRules, context.sessionRules);
  const mergedIndex = buildRuleIndex(mergedRules);

  const activeSessionSource = computeSessionSourceMap(context.sessionRules, sessionSourceByRuleId);
  for (const [ruleId, source] of activeSessionSource.entries()) {
    context.sourceByRuleId.set(ruleId, source);
  }

  context.allRules = mergedRules;
  context.globalRules = mergedIndex.globalRules;
  context.rulesByTool = mergedIndex.rulesByTool;
}

export async function createReplSessionContext(projectDir: string = process.cwd()): Promise<ReplSessionContext> {
  const resolvedProjectDir = resolve(projectDir);
  const config = normalizeRulesConfig(resolvedProjectDir);

  const baseline = loadRulesFromDirectory(config.rulesDir, config.recursiveRules);
  const report = await createScanReport(resolvedProjectDir, config.rulesDir);

  const context: ReplSessionContext = {
    projectDir: resolvedProjectDir,
    vetoDir: config.vetoDir,
    rulesDir: config.rulesDir,
    recursiveRules: config.recursiveRules,
    baselineRules: baseline.rules,
    sessionRules: [],
    allRules: baseline.rules,
    rulesByTool: baseline.rulesByTool,
    globalRules: baseline.globalRules,
    sourceByRuleId: baseline.sourceByRuleId,
    scanReport: report,
    discoveredTools: report.discoveredTools,
  };

  return context;
}

export async function rescanReplContext(context: ReplSessionContext): Promise<ScanReport> {
  const report = await createScanReport(context.projectDir, context.rulesDir);
  context.scanReport = report;
  context.discoveredTools = report.discoveredTools;
  return report;
}

export async function reloadReplContext(context: ReplSessionContext): Promise<void> {
  const baseline = loadRulesFromDirectory(context.rulesDir, context.recursiveRules);

  const sessionSourceByRuleId = new Map<string, RuleSourceInfo>();
  for (const [ruleId, source] of context.sourceByRuleId.entries()) {
    if (source.source.startsWith('session:')) {
      sessionSourceByRuleId.set(ruleId, source);
    }
  }

  applyContextRules(context, baseline, sessionSourceByRuleId);
  await rescanReplContext(context);
}

export async function clearSessionRules(context: ReplSessionContext): Promise<void> {
  context.sessionRules = [];
  const baseline = loadRulesFromDirectory(context.rulesDir, context.recursiveRules);
  applyContextRules(context, baseline, new Map<string, RuleSourceInfo>());
  await rescanReplContext(context);
}

export function getRulesForTool(context: ReplSessionContext, toolName: string): Rule[] {
  const toolRules = context.rulesByTool.get(toolName) ?? [];
  return [...context.globalRules, ...toolRules].filter((rule) => rule.enabled !== false);
}

export function findRuleById(context: ReplSessionContext, ruleId: string): Rule | undefined {
  return context.allRules.find((rule) => rule.id === ruleId);
}

export function getRuleSourceInfo(context: ReplSessionContext, ruleId: string): RuleSourceInfo | undefined {
  const source = context.sourceByRuleId.get(ruleId);
  if (!source) {
    return undefined;
  }

  return {
    source: resolveDisplaySource(context.projectDir, source.source),
    line: source.line,
  };
}

export function listRuleSummaries(context: ReplSessionContext): string[] {
  if (context.allRules.length === 0) {
    return [];
  }

  return context.allRules.map((rule) => {
    const tools = rule.tools && rule.tools.length > 0
      ? rule.tools.join(', ')
      : 'all tools';
    const source = getRuleSourceInfo(context, rule.id);
    const sourceText = source
      ? `${source.source}${source.line ? `:${source.line}` : ''}`
      : 'unknown';

    return `${rule.id} | ${rule.action} | ${tools} | ${sourceText}`;
  });
}

export function exportRulesYaml(context: ReplSessionContext, name = 'repl-generated'): string {
  const doc = {
    version: '1.0',
    name,
    rules: context.allRules,
  };

  return stringify(doc, { lineWidth: 120 });
}

export async function addSessionRulesFromYaml(
  context: ReplSessionContext,
  yamlContent: string,
  sourceName = 'session:inline'
): Promise<Rule[]> {
  const loader = new RuleLoader({ logger: silentLogger });
  loader.setYamlParser(parseYaml);
  loader.loadFromString(yamlContent, sourceName);

  const loaded = loader.getRules();
  const loadedState = createLoadedRuleState(loaded);

  if (loadedState.rules.length === 0) {
    return [];
  }

  const sessionSourceByRuleId = new Map<string, RuleSourceInfo>();
  for (const [ruleId, source] of context.sourceByRuleId.entries()) {
    if (source.source.startsWith('session:')) {
      sessionSourceByRuleId.set(ruleId, source);
    }
  }
  const lineIndex = buildRuleLineIndex(yamlContent);

  for (const rule of loadedState.rules) {
    sessionSourceByRuleId.set(rule.id, {
      source: sourceName.startsWith('session:') ? sourceName : `session:${sourceName}`,
      line: lineIndex.get(rule.id) ?? loadedState.sourceByRuleId.get(rule.id)?.line,
    });
  }

  const existingIndexById = new Map<string, number>();
  for (let i = 0; i < context.sessionRules.length; i++) {
    existingIndexById.set(context.sessionRules[i].id, i);
  }

  for (const rule of loadedState.rules) {
    const existingIndex = existingIndexById.get(rule.id);
    if (existingIndex !== undefined) {
      context.sessionRules[existingIndex] = rule;
      continue;
    }
    context.sessionRules.push(rule);
  }

  const baseline = loadRulesFromDirectory(context.rulesDir, context.recursiveRules);
  applyContextRules(context, baseline, sessionSourceByRuleId);

  return loadedState.rules;
}

export async function loadSessionRulesFromFile(
  context: ReplSessionContext,
  filePath: string
): Promise<Rule[]> {
  const resolvedPath = resolve(context.projectDir, filePath);
  if (!existsSync(resolvedPath)) {
    throw new Error(`Rule file not found: ${resolvedPath}`);
  }

  const content = readFileSync(resolvedPath, 'utf-8');
  return addSessionRulesFromYaml(context, content, resolvedPath);
}

export function ensureRulesDirectory(context: ReplSessionContext): void {
  if (existsSync(context.rulesDir)) {
    return;
  }

  mkdirSync(dirname(context.rulesDir), { recursive: true });
  mkdirSync(context.rulesDir, { recursive: true });
}

export function formatPolicySchemaError(error: unknown): string[] {
  if (error instanceof PolicySchemaError) {
    return error.errors.map((schemaError) => `${schemaError.path}: ${schemaError.message}`);
  }

  if (error instanceof Error) {
    return [error.message];
  }

  return [String(error)];
}
