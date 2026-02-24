import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { RuleLoader } from '../rules/loader.js';
import type { Rule } from '../rules/types.js';
import { silentLogger } from '../utils/logger.js';
import { collectHeuristicPacksForSingleTool } from '../core/tool-pack-heuristics.js';

type ToolDiscoverySource = 'policy' | 'source-ts' | 'source-python';
type CoverageReason = 'global-rule' | 'tool-rule' | 'none';
type ReportFormat = 'text' | 'json';

interface MutableDiscoveredTool {
  name: string;
  parameters: Set<string>;
  locations: Set<string>;
  sources: Set<ToolDiscoverySource>;
  covered: boolean;
  coverageReason: CoverageReason;
  matchedRuleIds: Set<string>;
}

interface PolicyConfigFile {
  rules?: {
    directory?: string;
    recursive?: boolean;
  };
}

interface RuleContext {
  rulesDirectory: string;
  recursiveRules: boolean;
  sourceFiles: string[];
  allRules: Rule[];
  globalRules: Rule[];
  rulesByTool: Map<string, Rule[]>;
  toolsReferenced: string[];
}

interface SuggestionTemplate {
  pack: string;
  rationale: string;
  snippet: (toolName: string) => string;
}

export interface ScanOptions {
  directory?: string;
  quiet?: boolean;
  failUncovered?: boolean;
  suggest?: boolean;
  format?: ReportFormat;
}

export interface DiscoveredTool {
  name: string;
  parameters: string[];
  locations: string[];
  sources: ToolDiscoverySource[];
  covered: boolean;
  coverageReason: CoverageReason;
  matchedRuleIds: string[];
}

export interface Suggestion {
  tool: string;
  pack: string;
  rationale: string;
  snippet: string;
}

export interface ScanReport {
  timestamp: string;
  projectDir: string;
  policy: {
    vetoDir: string;
    rulesDirectory: string;
    recursiveRules: boolean;
    rulesLoaded: number;
    globalRules: number;
    sourceFiles: string[];
    toolsReferenced: string[];
  };
  manifest: {
    packageJsonFound: boolean;
    pyprojectFound: boolean;
    jsDependencies: string[];
    pythonDependencies: string[];
    frameworks: string[];
  };
  discoveredTools: DiscoveredTool[];
  summary: {
    total: number;
    covered: number;
    uncovered: number;
    coveragePercent: number;
  };
  suggestions: Suggestion[];
}

export interface ScanResult {
  success: boolean;
  report: ScanReport;
}

const SCAN_IGNORE_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  'test',
  'tests',
  '__tests__',
]);

const JS_SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

const PYTHON_SOURCE_EXTENSIONS = new Set(['.py']);

const FRAMEWORK_DEPENDENCY_MAP = new Map<string, string>([
  ['@langchain/core', 'langchain'],
  ['langchain', 'langchain'],
  ['langgraph', 'langchain'],
  ['ai', 'vercel-ai'],
  ['@ai-sdk/openai', 'vercel-ai'],
  ['@ai-sdk/anthropic', 'vercel-ai'],
  ['@ai-sdk/google', 'vercel-ai'],
  ['@openai/agents', 'openai-agents'],
  ['openai-agents', 'openai-agents'],
  ['browser-use-node', 'browser-use'],
  ['browser-use', 'browser-use'],
  ['crewai', 'crewai'],
  ['autogen', 'autogen'],
  ['llama-index', 'llama-index'],
  ['smolagents', 'smolagents'],
]);

const SUGGESTION_TEMPLATES: Record<string, SuggestionTemplate> = {
  '@veto/financial': {
    pack: '@veto/financial',
    rationale: 'Tool name matches financial keywords (e.g. transfer/payment/funds).',
    snippet: (toolName) => `rules:\n  - id: guard-${toSlug(toolName)}\n    name: Guard ${toolName}\n    description: Require review for high-value financial operations\n    enabled: true\n    severity: high\n    action: require_approval\n    tools:\n      - ${toolName}\n    conditions:\n      - field: arguments.amount\n        operator: greater_than\n        value: 1000`,
  },
  '@veto/communication': {
    pack: '@veto/communication',
    rationale: 'Tool name matches communication keywords (e.g. email/message/notify).',
    snippet: (toolName) => `rules:\n  - id: guard-${toSlug(toolName)}\n    name: Guard ${toolName}\n    description: Restrict sensitive outbound communication\n    enabled: true\n    severity: high\n    action: block\n    tools:\n      - ${toolName}\n    conditions:\n      - field: arguments.to\n        operator: not_contains\n        value: '@company.com'`,
  },
  '@veto/browser-automation': {
    pack: '@veto/browser-automation',
    rationale: 'Tool name matches browser automation keywords (e.g. navigate/click/browser).',
    snippet: (toolName) => `rules:\n  - id: guard-${toSlug(toolName)}\n    name: Guard ${toolName}\n    description: Require approval before high-risk browser automation\n    enabled: true\n    severity: medium\n    action: require_approval\n    tools:\n      - ${toolName}`,
  },
  '@veto/data-access': {
    pack: '@veto/data-access',
    rationale: 'Tool name matches data-access keywords (e.g. query/database/read_record).',
    snippet: (toolName) => `rules:\n  - id: guard-${toSlug(toolName)}\n    name: Guard ${toolName}\n    description: Block reads against sensitive identifiers\n    enabled: true\n    severity: high\n    action: block\n    tools:\n      - ${toolName}\n    conditions:\n      - field: arguments.query\n        operator: contains\n        value: 'ssn'`,
  },
  '@veto/coding-agent': {
    pack: '@veto/coding-agent',
    rationale: 'Tool name matches coding-agent keywords (e.g. shell/exec/write_file).',
    snippet: (toolName) => `rules:\n  - id: guard-${toSlug(toolName)}\n    name: Guard ${toolName}\n    description: Prevent destructive filesystem or shell operations\n    enabled: true\n    severity: critical\n    action: block\n    tools:\n      - ${toolName}\n    conditions:\n      - field: arguments.command\n        operator: contains\n        value: 'rm -rf'`,
  },
  '@veto/deployment': {
    pack: '@veto/deployment',
    rationale: 'Tool name matches deployment keywords (e.g. deploy/release/publish).',
    snippet: (toolName) => `rules:\n  - id: guard-${toSlug(toolName)}\n    name: Guard ${toolName}\n    description: Gate deployment actions with approval\n    enabled: true\n    severity: critical\n    action: require_approval\n    tools:\n      - ${toolName}`,
  },
  generic: {
    pack: 'generic',
    rationale: 'No specialized pack match found; using a safe starter rule.',
    snippet: (toolName) => `rules:\n  - id: guard-${toSlug(toolName)}\n    name: Guard ${toolName}\n    description: Baseline approval gate for uncovered tool\n    enabled: true\n    severity: medium\n    action: require_approval\n    tools:\n      - ${toolName}`,
  },
};

const SUGGESTION_PRIORITY = [
  '@veto/financial',
  '@veto/communication',
  '@veto/browser-automation',
  '@veto/data-access',
  '@veto/coding-agent',
  '@veto/deployment',
] as const;

function toSlug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

function ensureTool(map: Map<string, MutableDiscoveredTool>, name: string): MutableDiscoveredTool {
  const existing = map.get(name);
  if (existing) {
    return existing;
  }

  const tool: MutableDiscoveredTool = {
    name,
    parameters: new Set<string>(),
    locations: new Set<string>(),
    sources: new Set<ToolDiscoverySource>(),
    covered: false,
    coverageReason: 'none',
    matchedRuleIds: new Set<string>(),
  };
  map.set(name, tool);
  return tool;
}

function addToolDiscovery(
  map: Map<string, MutableDiscoveredTool>,
  name: string,
  source: ToolDiscoverySource,
  parameters: readonly string[],
  location?: string
): void {
  const normalizedName = name.trim();
  if (!isLikelyToolName(normalizedName)) {
    return;
  }

  const entry = ensureTool(map, normalizedName);
  entry.sources.add(source);

  for (const parameter of parameters) {
    const normalizedParameter = parameter.trim();
    if (normalizedParameter) {
      entry.parameters.add(normalizedParameter);
    }
  }

  if (location) {
    entry.locations.add(location);
  }
}

function isLikelyToolName(name: string): boolean {
  if (!name) {
    return false;
  }

  if (!/^[A-Za-z0-9_.:-]+$/.test(name)) {
    return false;
  }

  if (name.length < 2) {
    return false;
  }

  if (/^[A-Z]/.test(name)) {
    return false;
  }

  const normalized = name.toLowerCase();
  return normalized !== 'tool' && normalized !== 'tools';
}

function extractConfig(vetoDir: string): { rulesDirectory: string; recursiveRules: boolean } {
  const configPath = join(vetoDir, 'veto.config.yaml');
  let rulesDirectory = resolve(vetoDir, 'rules');
  let recursiveRules = true;

  if (!existsSync(configPath)) {
    return { rulesDirectory, recursiveRules };
  }

  try {
    const parsed = parseYaml(readFileSync(configPath, 'utf-8')) as PolicyConfigFile | null;
    if (parsed?.rules?.directory) {
      rulesDirectory = resolve(vetoDir, parsed.rules.directory);
    }
    if (typeof parsed?.rules?.recursive === 'boolean') {
      recursiveRules = parsed.rules.recursive;
    }
  } catch {
    return { rulesDirectory, recursiveRules };
  }

  return { rulesDirectory, recursiveRules };
}

function loadPolicyRules(projectDir: string): RuleContext {
  const vetoDir = resolve(projectDir, 'veto');
  const config = extractConfig(vetoDir);

  if (!existsSync(vetoDir)) {
    return {
      rulesDirectory: config.rulesDirectory,
      recursiveRules: config.recursiveRules,
      sourceFiles: [],
      allRules: [],
      globalRules: [],
      rulesByTool: new Map<string, Rule[]>(),
      toolsReferenced: [],
    };
  }

  const loader = new RuleLoader({ logger: silentLogger });
  loader.setYamlParser(parseYaml);

  if (existsSync(config.rulesDirectory)) {
    loader.loadFromDirectory(config.rulesDirectory, config.recursiveRules);
  }

  const loaded = loader.getRules();

  const enabledRules = loaded.allRules.filter((rule) => rule.enabled !== false);
  const enabledGlobalRules = loaded.globalRules.filter((rule) => rule.enabled !== false);
  const enabledRulesByTool = new Map<string, Rule[]>();

  for (const [toolName, rules] of loaded.rulesByTool.entries()) {
    const enabledToolRules = rules.filter((rule) => rule.enabled !== false);
    if (enabledToolRules.length > 0) {
      enabledRulesByTool.set(toolName, enabledToolRules);
    }
  }

  const toolsReferenced = [...enabledRulesByTool.keys()].sort((a, b) => a.localeCompare(b));

  return {
    rulesDirectory: config.rulesDirectory,
    recursiveRules: config.recursiveRules,
    sourceFiles: [...loaded.sourceFiles].sort((a, b) => a.localeCompare(b)),
    allRules: enabledRules,
    globalRules: enabledGlobalRules,
    rulesByTool: enabledRulesByTool,
    toolsReferenced,
  };
}

function extractPackageJsonDependencies(projectDir: string): { found: boolean; dependencies: string[] } {
  const packageJsonPath = join(projectDir, 'package.json');
  if (!existsSync(packageJsonPath)) {
    return { found: false, dependencies: [] };
  }

  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    const dependencies = new Set<string>();

    for (const section of [parsed.dependencies, parsed.devDependencies]) {
      if (!section) {
        continue;
      }
      for (const name of Object.keys(section)) {
        dependencies.add(name);
      }
    }

    return {
      found: true,
      dependencies: [...dependencies].sort((a, b) => a.localeCompare(b)),
    };
  } catch {
    return { found: true, dependencies: [] };
  }
}

function extractTomlSection(content: string, sectionName: string): string | null {
  const escaped = sectionName.replace(/\./g, '\\.');
  const pattern = new RegExp(`\\[${escaped}\\]([\\s\\S]*?)(?=\\n\\[[^\\]]+\\]|$)`, 'm');
  const match = content.match(pattern);
  return match ? match[1] : null;
}

function extractDependencyNamesFromTomlArray(block: string): string[] {
  const names = new Set<string>();
  const quoted = /["']([^"']+)["']/g;
  let match = quoted.exec(block);

  while (match) {
    const raw = match[1].trim();
    const packageMatch = raw.match(/^([A-Za-z0-9_.-]+)/);
    if (packageMatch) {
      names.add(packageMatch[1].toLowerCase());
    }
    match = quoted.exec(block);
  }

  return [...names];
}

function extractPyprojectDependencies(projectDir: string): { found: boolean; dependencies: string[] } {
  const pyprojectPath = join(projectDir, 'pyproject.toml');
  if (!existsSync(pyprojectPath)) {
    return { found: false, dependencies: [] };
  }

  const dependencies = new Set<string>();

  try {
    const content = readFileSync(pyprojectPath, 'utf-8');

    const projectSection = extractTomlSection(content, 'project');
    if (projectSection) {
      const dependenciesArray = projectSection.match(/dependencies\s*=\s*\[([\s\S]*?)\]/m);
      if (dependenciesArray) {
        for (const name of extractDependencyNamesFromTomlArray(dependenciesArray[1])) {
          dependencies.add(name);
        }
      }
    }

    const optionalSection = extractTomlSection(content, 'project.optional-dependencies');
    if (optionalSection) {
      const arrayPattern = /[A-Za-z0-9_.-]+\s*=\s*\[([\s\S]*?)\]/g;
      let match = arrayPattern.exec(optionalSection);

      while (match) {
        for (const name of extractDependencyNamesFromTomlArray(match[1])) {
          dependencies.add(name);
        }
        match = arrayPattern.exec(optionalSection);
      }
    }

    return {
      found: true,
      dependencies: [...dependencies].sort((a, b) => a.localeCompare(b)),
    };
  } catch {
    return { found: true, dependencies: [] };
  }
}

function detectFrameworks(jsDependencies: readonly string[], pythonDependencies: readonly string[]): string[] {
  const frameworks = new Set<string>();

  for (const dependency of [...jsDependencies, ...pythonDependencies]) {
    const mapped = FRAMEWORK_DEPENDENCY_MAP.get(dependency);
    if (mapped) {
      frameworks.add(mapped);
    }
  }

  return [...frameworks].sort((a, b) => a.localeCompare(b));
}

function walkSourceFiles(dirPath: string, files: string[]): void {
  if (!existsSync(dirPath)) {
    return;
  }

  const entries = readdirSync(dirPath);

  for (const entry of entries) {
    const fullPath = join(dirPath, entry);
    const stats = statSync(fullPath);

    if (stats.isDirectory()) {
      if (SCAN_IGNORE_DIRECTORIES.has(entry)) {
        continue;
      }
      walkSourceFiles(fullPath, files);
      continue;
    }

    if (!stats.isFile()) {
      continue;
    }

    const extension = extname(entry).toLowerCase();
    if (JS_SOURCE_EXTENSIONS.has(extension) || PYTHON_SOURCE_EXTENSIONS.has(extension)) {
      files.push(fullPath);
    }
  }
}

function parseParameterList(rawList: string): string[] {
  const parameters = new Set<string>();

  for (const chunk of rawList.split(',')) {
    let value = chunk.trim();
    if (!value || value === '*' || value === '/') {
      continue;
    }

    value = value.replace(/^\*+/, '');
    value = value.split(':')[0].split('=')[0].trim();

    if (!value || value === 'self' || value === 'cls') {
      continue;
    }

    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
      parameters.add(value);
    }
  }

  return [...parameters].sort((a, b) => a.localeCompare(b));
}

function extractTypeScriptParameters(content: string, anchorIndex: number): string[] {
  const start = Math.max(anchorIndex - 250, 0);
  const end = Math.min(anchorIndex + 1400, content.length);
  const snippet = content.slice(start, end);

  const parameters = new Set<string>();

  const destructuredPatterns = [
    /tool\s*\(\s*(?:async\s*)?\(\s*\{\s*([^}]*)\}\s*(?::[^)]*)?\)\s*=>/g,
    /\b(?:execute|handler|func)\s*:\s*(?:async\s*)?\(\s*\{\s*([^}]*)\}\s*(?::[^)]*)?\)\s*=>/g,
  ];

  for (const pattern of destructuredPatterns) {
    let match = pattern.exec(snippet);
    while (match) {
      for (const parameter of parseParameterList(match[1])) {
        parameters.add(parameter);
      }
      match = pattern.exec(snippet);
    }
  }

  const zObjectPattern = /z\.object\s*\(\s*\{([\s\S]*?)\}\s*\)/g;
  let zMatch = zObjectPattern.exec(snippet);

  while (zMatch) {
    const keyPattern = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/gm;
    let keyMatch = keyPattern.exec(zMatch[1]);

    while (keyMatch) {
      parameters.add(keyMatch[1]);
      keyMatch = keyPattern.exec(zMatch[1]);
    }

    zMatch = zObjectPattern.exec(snippet);
  }

  return [...parameters].sort((a, b) => a.localeCompare(b));
}

function detectTypeScriptTools(
  content: string,
  relativePath: string,
  discovered: Map<string, MutableDiscoveredTool>
): void {
  const namedToolPattern = /tool\s*\([\s\S]{0,800}?name\s*:\s*["'`]([^"'`]+)["'`]/g;
  let namedMatch = namedToolPattern.exec(content);

  while (namedMatch) {
    addToolDiscovery(
      discovered,
      namedMatch[1],
      'source-ts',
      extractTypeScriptParameters(content, namedMatch.index),
      relativePath
    );
    namedMatch = namedToolPattern.exec(content);
  }

  const objectKeyPattern = /([A-Za-z_][A-Za-z0-9_]*)\s*:\s*tool\s*\(/g;
  let objectMatch = objectKeyPattern.exec(content);

  while (objectMatch) {
    addToolDiscovery(
      discovered,
      objectMatch[1],
      'source-ts',
      extractTypeScriptParameters(content, objectMatch.index),
      relativePath
    );
    objectMatch = objectKeyPattern.exec(content);
  }

  const dynamicToolPattern = /new\s+DynamicTool\s*\(\s*\{[\s\S]{0,600}?name\s*:\s*["'`]([^"'`]+)["'`]/g;
  let dynamicMatch = dynamicToolPattern.exec(content);

  while (dynamicMatch) {
    addToolDiscovery(
      discovered,
      dynamicMatch[1],
      'source-ts',
      extractTypeScriptParameters(content, dynamicMatch.index),
      relativePath
    );
    dynamicMatch = dynamicToolPattern.exec(content);
  }

  const functionToolPattern = /function_tool\s*\(\s*(?:\{[\s\S]{0,500}?name\s*:\s*["'`]([^"'`]+)["'`]|["'`]([^"'`]+)["'`])/g;
  let functionToolMatch = functionToolPattern.exec(content);

  while (functionToolMatch) {
    const name = functionToolMatch[1] ?? functionToolMatch[2];
    if (name) {
      addToolDiscovery(
        discovered,
        name,
        'source-ts',
        extractTypeScriptParameters(content, functionToolMatch.index),
        relativePath
      );
    }
    functionToolMatch = functionToolPattern.exec(content);
  }

  const namedHandlerPattern = /name\s*:\s*["'`]([^"'`]+)["'`][\s\S]{0,250}?handler\s*:/g;
  let namedHandlerMatch = namedHandlerPattern.exec(content);

  while (namedHandlerMatch) {
    addToolDiscovery(
      discovered,
      namedHandlerMatch[1],
      'source-ts',
      extractTypeScriptParameters(content, namedHandlerMatch.index),
      relativePath
    );
    namedHandlerMatch = namedHandlerPattern.exec(content);
  }
}

function extractDecoratorToolName(decoratorArgs: string | undefined, fallbackName: string): string {
  if (!decoratorArgs) {
    return fallbackName;
  }

  const namedArgMatch = decoratorArgs.match(/name\s*=\s*["']([^"']+)["']/);
  if (namedArgMatch) {
    return namedArgMatch[1];
  }

  const positionalMatch = decoratorArgs.match(/["']([^"']+)["']/);
  if (positionalMatch) {
    return positionalMatch[1];
  }

  return fallbackName;
}

function detectPythonTools(
  content: string,
  relativePath: string,
  discovered: Map<string, MutableDiscoveredTool>
): void {
  const decoratedFunctionPattern = /@(?:[A-Za-z_][A-Za-z0-9_]*\.)*(tool(?:_plain)?)(?:\(([^)]*)\))?[^\n]*\n\s*(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)/g;
  let decoratorMatch = decoratedFunctionPattern.exec(content);

  while (decoratorMatch) {
    const toolName = extractDecoratorToolName(decoratorMatch[2], decoratorMatch[3]);
    const parameters = parseParameterList(decoratorMatch[4]);

    addToolDiscovery(discovered, toolName, 'source-python', parameters, relativePath);
    decoratorMatch = decoratedFunctionPattern.exec(content);
  }

  const classPattern = /class\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*BaseTool[^)]*\)\s*:\s*([\s\S]{0,1800})/g;
  let classMatch = classPattern.exec(content);

  while (classMatch) {
    const classBody = classMatch[2];
    const nameMatch = classBody.match(/^\s*name\s*=\s*["']([^"']+)["']/m);

    if (nameMatch) {
      const runSignatureMatch = classBody.match(/def\s+_?run\s*\(([^)]*)\)/);
      const parameters = runSignatureMatch ? parseParameterList(runSignatureMatch[1]) : [];
      addToolDiscovery(discovered, nameMatch[1], 'source-python', parameters, relativePath);
    }

    classMatch = classPattern.exec(content);
  }

  const functionToolPattern = /function_tool\s*\(\s*([\s\S]{0,300}?)\)/g;
  let functionToolMatch = functionToolPattern.exec(content);

  while (functionToolMatch) {
    const body = functionToolMatch[1];
    const namedMatch = body.match(/name\s*=\s*["']([^"']+)["']/);
    const positionalMatch = body.match(/^[\s\n]*["']([^"']+)["']/);
    const toolName = namedMatch?.[1] ?? positionalMatch?.[1];

    if (toolName) {
      addToolDiscovery(discovered, toolName, 'source-python', [], relativePath);
    }

    functionToolMatch = functionToolPattern.exec(content);
  }
}

function scanSourceFiles(projectDir: string, discovered: Map<string, MutableDiscoveredTool>): void {
  const files: string[] = [];
  walkSourceFiles(projectDir, files);

  for (const filePath of files) {
    const extension = extname(filePath).toLowerCase();
    const relativePath = relative(projectDir, filePath);

    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    if (JS_SOURCE_EXTENSIONS.has(extension)) {
      detectTypeScriptTools(content, relativePath, discovered);
      continue;
    }

    if (PYTHON_SOURCE_EXTENSIONS.has(extension)) {
      detectPythonTools(content, relativePath, discovered);
    }
  }
}

function applyCoverage(
  discovered: Map<string, MutableDiscoveredTool>,
  rulesByTool: Map<string, Rule[]>,
  globalRules: Rule[]
): void {
  const hasGlobalRules = globalRules.length > 0;

  for (const tool of discovered.values()) {
    const matchingRules = rulesByTool.get(tool.name) ?? [];
    for (const rule of matchingRules) {
      tool.matchedRuleIds.add(rule.id);
    }

    if (hasGlobalRules) {
      tool.covered = true;
      tool.coverageReason = 'global-rule';
      continue;
    }

    if (matchingRules.length > 0) {
      tool.covered = true;
      tool.coverageReason = 'tool-rule';
      continue;
    }

    tool.covered = false;
    tool.coverageReason = 'none';
  }
}

function selectSuggestionTemplate(toolName: string): SuggestionTemplate {
  const packs = collectHeuristicPacksForSingleTool(toolName);

  for (const candidate of SUGGESTION_PRIORITY) {
    if (packs.includes(candidate)) {
      return SUGGESTION_TEMPLATES[candidate];
    }
  }

  return SUGGESTION_TEMPLATES.generic;
}

function createSuggestions(discoveredTools: readonly DiscoveredTool[]): Suggestion[] {
  const suggestions: Suggestion[] = [];

  for (const tool of discoveredTools) {
    if (tool.covered) {
      continue;
    }

    const template = selectSuggestionTemplate(tool.name);
    suggestions.push({
      tool: tool.name,
      pack: template.pack,
      rationale: template.rationale,
      snippet: template.snippet(tool.name),
    });
  }

  return suggestions;
}

function toSerializableTools(discovered: Map<string, MutableDiscoveredTool>): DiscoveredTool[] {
  return [...discovered.values()]
    .map((tool) => ({
      name: tool.name,
      parameters: [...tool.parameters].sort((a, b) => a.localeCompare(b)),
      locations: [...tool.locations].sort((a, b) => a.localeCompare(b)),
      sources: [...tool.sources].sort((a, b) => a.localeCompare(b)) as ToolDiscoverySource[],
      covered: tool.covered,
      coverageReason: tool.coverageReason,
      matchedRuleIds: [...tool.matchedRuleIds].sort((a, b) => a.localeCompare(b)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function formatToolSignature(tool: DiscoveredTool): string {
  if (tool.parameters.length === 0) {
    return `${tool.name}()`;
  }

  return `${tool.name}(${tool.parameters.join(', ')})`;
}

function formatTextReport(report: ScanReport): string {
  const lines: string[] = [];

  lines.push('');
  lines.push('Veto Scan Coverage Audit');
  lines.push('========================');
  lines.push('');
  lines.push(`Project directory: ${report.projectDir}`);
  lines.push(`Rules directory: ${report.policy.rulesDirectory}`);
  lines.push(`Rules loaded: ${report.policy.rulesLoaded} (global: ${report.policy.globalRules})`);
  lines.push(`Framework hints: ${report.manifest.frameworks.join(', ') || 'none detected'}`);
  lines.push(
    `Coverage: ${report.summary.covered}/${report.summary.total} ` +
      `(${report.summary.coveragePercent.toFixed(1)}%)`
  );
  lines.push('');

  if (report.discoveredTools.length === 0) {
    lines.push('No tools discovered from policy files or source heuristics.');
    lines.push('');
    return lines.join('\n');
  }

  lines.push('Discovered tools:');

  for (const tool of report.discoveredTools) {
    const status = tool.covered ? 'COVERED' : 'UNCOVERED';
    lines.push(`  [${status}] ${formatToolSignature(tool)}`);
    if (tool.locations.length > 0) {
      lines.push(`    locations: ${tool.locations.join(', ')}`);
    }
    lines.push(`    sources: ${tool.sources.join(', ')}`);
  }

  if (report.suggestions.length > 0) {
    lines.push('');
    lines.push('Suggested starter rules:');

    for (const suggestion of report.suggestions) {
      lines.push('');
      lines.push(`  ${suggestion.tool} (${suggestion.pack})`);
      lines.push(`  Rationale: ${suggestion.rationale}`);
      lines.push('  Snippet:');
      for (const snippetLine of suggestion.snippet.split('\n')) {
        lines.push(`    ${snippetLine}`);
      }
    }
  }

  lines.push('');
  return lines.join('\n');
}

export async function scan(options: ScanOptions = {}): Promise<ScanResult> {
  const {
    directory = process.cwd(),
    quiet = false,
    failUncovered = false,
    suggest = false,
    format = 'text',
  } = options;

  const normalizedFormat: ReportFormat = format === 'json' ? 'json' : 'text';
  const projectDir = resolve(directory);
  const policyContext = loadPolicyRules(projectDir);

  const discovered = new Map<string, MutableDiscoveredTool>();

  for (const toolName of policyContext.toolsReferenced) {
    addToolDiscovery(discovered, toolName, 'policy', []);
  }

  scanSourceFiles(projectDir, discovered);
  applyCoverage(discovered, policyContext.rulesByTool, policyContext.globalRules);

  const packageJson = extractPackageJsonDependencies(projectDir);
  const pyproject = extractPyprojectDependencies(projectDir);
  const frameworks = detectFrameworks(packageJson.dependencies, pyproject.dependencies);

  const discoveredTools = toSerializableTools(discovered);
  const suggestions = suggest ? createSuggestions(discoveredTools) : [];

  const covered = discoveredTools.filter((tool) => tool.covered).length;
  const total = discoveredTools.length;
  const uncovered = total - covered;
  const coveragePercent = total === 0 ? 100 : Number(((covered / total) * 100).toFixed(2));

  const report: ScanReport = {
    timestamp: new Date().toISOString(),
    projectDir,
    policy: {
      vetoDir: join(projectDir, 'veto'),
      rulesDirectory: policyContext.rulesDirectory,
      recursiveRules: policyContext.recursiveRules,
      rulesLoaded: policyContext.allRules.length,
      globalRules: policyContext.globalRules.length,
      sourceFiles: policyContext.sourceFiles,
      toolsReferenced: policyContext.toolsReferenced,
    },
    manifest: {
      packageJsonFound: packageJson.found,
      pyprojectFound: pyproject.found,
      jsDependencies: packageJson.dependencies,
      pythonDependencies: pyproject.dependencies,
      frameworks,
    },
    discoveredTools,
    summary: {
      total,
      covered,
      uncovered,
      coveragePercent,
    },
    suggestions,
  };

  if (!quiet) {
    if (normalizedFormat === 'json') {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatTextReport(report));
    }
  }

  return {
    success: !(failUncovered && uncovered > 0),
    report,
  };
}
