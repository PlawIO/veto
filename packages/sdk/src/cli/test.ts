/**
 * veto test command implementation.
 *
 * Adversarial policy gap finder. Reads policy YAML files and
 * auto-generates adversarial analysis to find gaps. Pure static
 * analysis, no LLM calls.
 *
 * @module cli/test
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

// ── Types ──

export type GapSeverity = 'critical' | 'warning' | 'info';

export interface Gap {
  analyzer: string;
  severity: GapSeverity;
  title: string;
  description: string;
  suggestedFix: string;
  tool?: string;
  field?: string;
  ruleId?: string;
}

export interface TestReport {
  timestamp: string;
  policyDir: string;
  rulesLoaded: number;
  toolsCovered: string[];
  gaps: Gap[];
  summary: {
    critical: number;
    warning: number;
    info: number;
    total: number;
  };
}

export interface TestOptions {
  policy?: string;
  output?: string;
  quiet?: boolean;
  format?: 'text' | 'json';
}

export interface TestResult {
  success: boolean;
  report: TestReport;
}

// ── Parsed rule structures (simplified for analysis) ──

export interface ParsedCondition {
  field?: string;
  operator?: string;
  value?: unknown;
  expression?: string;
}

export interface ParsedRule {
  id: string;
  name: string;
  enabled: boolean;
  severity: string;
  action: string;
  tools: string[];
  conditions: ParsedCondition[];
  conditionGroups: ParsedCondition[][];
}

export interface ParsedRuleSet {
  version: string;
  name: string;
  rules: ParsedRule[];
  sourceFile: string;
}

// ── YAML Loading (standalone, no external deps) ──

function findYamlFiles(dirPath: string): string[] {
  const files: string[] = [];
  if (!existsSync(dirPath)) return files;

  for (const entry of readdirSync(dirPath)) {
    const fullPath = join(dirPath, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      files.push(...findYamlFiles(fullPath));
    } else if (stat.isFile()) {
      const ext = extname(entry).toLowerCase();
      if (ext === '.yaml' || ext === '.yml') {
        files.push(fullPath);
      }
    }
  }
  return files;
}

function parseYamlSafe(content: string): Record<string, unknown> | null {
  try {
    return parseYaml(content) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function loadRuleSets(policyDir: string): ParsedRuleSet[] {
  const files = findYamlFiles(policyDir);
  const ruleSets: ParsedRuleSet[] = [];

  for (const file of files) {
    const content = readFileSync(file, 'utf-8');
    const parsed = parseYamlSafe(content);
    if (!parsed) continue;

    const rules = extractRules(parsed);
    if (rules.length > 0) {
      ruleSets.push({
        version: (parsed.version as string) ?? '1.0',
        name: (parsed.name as string) ?? file,
        rules,
        sourceFile: file,
      });
    }
  }

  return ruleSets;
}

function extractRules(data: Record<string, unknown>): ParsedRule[] {
  const rawRules = data.rules as unknown[];
  if (!rawRules || !Array.isArray(rawRules)) return [];

  return rawRules.map((r) => {
    const rule = r as Record<string, unknown>;
    const conditions: ParsedCondition[] = [];
    const conditionGroups: ParsedCondition[][] = [];

    if (Array.isArray(rule.conditions)) {
      for (const c of rule.conditions) {
        const cond = c as Record<string, unknown>;
        conditions.push({
          field: cond.field as string | undefined,
          operator: cond.operator as string | undefined,
          value: cond.value,
          expression: cond.expression as string | undefined,
        });
      }
    }

    if (Array.isArray(rule.condition_groups)) {
      for (const group of rule.condition_groups) {
        if (!Array.isArray(group)) continue;
        const parsed: ParsedCondition[] = [];
        for (const c of group) {
          const cond = c as Record<string, unknown>;
          parsed.push({
            field: cond.field as string | undefined,
            operator: cond.operator as string | undefined,
            value: cond.value,
            expression: cond.expression as string | undefined,
          });
        }
        conditionGroups.push(parsed);
      }
    }

    return {
      id: (rule.id as string) ?? 'unknown',
      name: (rule.name as string) ?? 'Unnamed',
      enabled: rule.enabled !== false,
      severity: (rule.severity as string) ?? 'medium',
      action: (rule.action as string) ?? 'block',
      tools: Array.isArray(rule.tools) ? (rule.tools as string[]) : [],
      conditions,
      conditionGroups,
    };
  });
}

// ── Analyzers ──

export interface Analyzer {
  name: string;
  analyze(rules: ParsedRule[], allTools: string[]): Gap[];
}

/**
 * Finds tools that appear in some rules but have no blocking rules.
 */
export class UncoveredToolAnalyzer implements Analyzer {
  name = 'uncovered-tools';

  analyze(rules: ParsedRule[], allTools: string[]): Gap[] {
    const gaps: Gap[] = [];
    const toolsWithBlockRules = new Set<string>();
    const globalBlockRules: ParsedRule[] = [];

    for (const rule of rules) {
      if (!rule.enabled) continue;
      if (rule.action !== 'block') continue;

      if (rule.tools.length === 0) {
        globalBlockRules.push(rule);
      } else {
        for (const tool of rule.tools) {
          toolsWithBlockRules.add(tool);
        }
      }
    }

    if (globalBlockRules.length > 0) return gaps;

    for (const tool of allTools) {
      if (!toolsWithBlockRules.has(tool)) {
        gaps.push({
          analyzer: this.name,
          severity: 'warning',
          title: `Tool "${tool}" has no blocking rules`,
          description:
            `The tool "${tool}" is referenced in your policies but has no rules with action "block". ` +
            `An agent could call this tool without any guardrail constraints.`,
          suggestedFix: `Add a rule with action "block" targeting the "${tool}" tool with appropriate conditions.`,
          tool,
        });
      }
    }

    return gaps;
  }
}

/**
 * Finds numeric limits that could be bypassed by splitting across calls.
 * E.g. a $1000 limit can be bypassed with 2x$500 calls.
 */
export class SplittingAttackAnalyzer implements Analyzer {
  name = 'splitting-attacks';

  analyze(rules: ParsedRule[]): Gap[] {
    const gaps: Gap[] = [];

    for (const rule of rules) {
      if (!rule.enabled) continue;

      const allConditions = [
        ...rule.conditions,
        ...rule.conditionGroups.flat(),
      ];

      for (const condition of allConditions) {
        if (!condition.field || !condition.operator) continue;

        const isNumericLimit =
          condition.operator === 'less_than' ||
          condition.operator === 'greater_than';

        if (!isNumericLimit) continue;
        if (typeof condition.value !== 'number') continue;

        const toolList = rule.tools.length > 0
          ? rule.tools.join(', ')
          : 'all tools';

        gaps.push({
          analyzer: this.name,
          severity: 'critical',
          title: `Numeric limit on "${condition.field}" can be split across calls`,
          description:
            `Rule "${rule.name}" (${rule.id}) limits ${condition.field} with ` +
            `${condition.operator} ${condition.value} for ${toolList}. ` +
            `An agent could bypass this by splitting into multiple calls ` +
            `(e.g., 2x${Math.floor(condition.value as number / 2)} instead of 1x${condition.value}).`,
          suggestedFix:
            `Add session-level aggregate constraints or rate limits for ${condition.field}. ` +
            `Consider tracking cumulative totals across calls.`,
          tool: rule.tools[0],
          field: condition.field,
          ruleId: rule.id,
        });
      }
    }

    return gaps;
  }
}

/**
 * Identifies tools that have rules but with unconstrained fields.
 * E.g. send_email rules check "to" but not "cc" or "bcc".
 */
export class UncheckedFieldAnalyzer implements Analyzer {
  name = 'unchecked-fields';

  private static readonly SENSITIVE_FIELDS: Record<string, string[]> = {
    send_email: ['to', 'cc', 'bcc', 'subject', 'body', 'attachments'],
    execute_command: ['command', 'args', 'cwd', 'env'],
    run_shell: ['command', 'args', 'cwd', 'env'],
    bash: ['command', 'args', 'cwd'],
    write_file: ['path', 'content', 'permissions'],
    read_file: ['path'],
    delete_file: ['path'],
    http_request: ['url', 'method', 'headers', 'body'],
    fetch: ['url', 'method', 'headers', 'body'],
    database_query: ['query', 'params', 'database'],
    sql: ['query', 'params'],
  };

  analyze(rules: ParsedRule[]): Gap[] {
    const gaps: Gap[] = [];
    const fieldsByTool = new Map<string, Set<string>>();

    for (const rule of rules) {
      if (!rule.enabled) continue;

      const allConditions = [
        ...rule.conditions,
        ...rule.conditionGroups.flat(),
      ];

      for (const condition of allConditions) {
        if (!condition.field) continue;

        const fieldPath = condition.field;
        const fieldName = fieldPath.startsWith('arguments.')
          ? fieldPath.slice('arguments.'.length)
          : fieldPath;

        for (const tool of rule.tools) {
          if (!fieldsByTool.has(tool)) {
            fieldsByTool.set(tool, new Set());
          }
          fieldsByTool.get(tool)!.add(fieldName);
        }
      }
    }

    for (const [tool, checkedFields] of fieldsByTool) {
      const sensitiveFields = UncheckedFieldAnalyzer.SENSITIVE_FIELDS[tool];
      if (!sensitiveFields) continue;

      for (const field of sensitiveFields) {
        if (!checkedFields.has(field)) {
          gaps.push({
            analyzer: this.name,
            severity: 'warning',
            title: `Field "${field}" unchecked on "${tool}"`,
            description:
              `The tool "${tool}" has rules checking ${[...checkedFields].map(f => `"${f}"`).join(', ')} ` +
              `but "${field}" has no constraints. An agent could exploit this unchecked field.`,
            suggestedFix: `Add a condition for "arguments.${field}" on rules targeting "${tool}".`,
            tool,
            field,
          });
        }
      }
    }

    return gaps;
  }
}

/**
 * Tests regex patterns for common bypass techniques:
 * - Missing anchors (^/$)
 * - Subdomain tricks (evil.example.com matches example.com)
 * - Case sensitivity
 */
export class RegexBypassAnalyzer implements Analyzer {
  name = 'regex-bypasses';

  analyze(rules: ParsedRule[]): Gap[] {
    const gaps: Gap[] = [];

    for (const rule of rules) {
      if (!rule.enabled) continue;

      const allConditions = [
        ...rule.conditions,
        ...rule.conditionGroups.flat(),
      ];

      for (const condition of allConditions) {
        if (condition.operator === 'matches' && typeof condition.value === 'string') {
          gaps.push(...this.analyzeRegex(condition.value, condition.field, rule));
        }

        if (condition.operator === 'starts_with' && typeof condition.value === 'string') {
          gaps.push(...this.analyzeStartsWith(condition.value, condition.field, rule));
        }

        if (condition.operator === 'contains' && typeof condition.value === 'string') {
          gaps.push(...this.analyzeContains(condition.value, condition.field, rule));
        }
      }
    }

    return gaps;
  }

  private analyzeRegex(pattern: string, field: string | undefined, rule: ParsedRule): Gap[] {
    const gaps: Gap[] = [];

    if (!pattern.startsWith('^') || !pattern.endsWith('$')) {
      gaps.push({
        analyzer: this.name,
        severity: 'warning',
        title: `Regex pattern missing anchors in rule "${rule.id}"`,
        description:
          `Pattern "${pattern}" on field "${field}" lacks start (^) and/or end ($) anchors. ` +
          `Input like "malicious-prefix${this.exampleMatch(pattern)}malicious-suffix" could match.`,
        suggestedFix: `Anchor the pattern: "^${pattern.replace(/^\^/, '').replace(/\$$/, '')}$"`,
        ruleId: rule.id,
        field,
      });
    }

    if (this.isDomainPattern(pattern)) {
      if (!pattern.includes('(^|\\.)') && !pattern.startsWith('^')) {
        gaps.push({
          analyzer: this.name,
          severity: 'critical',
          title: `Domain regex vulnerable to subdomain bypass in rule "${rule.id}"`,
          description:
            `Pattern "${pattern}" matches a domain but may allow subdomain bypasses. ` +
            `"evil.${this.exampleMatch(pattern)}" would match if the pattern isn't anchored properly.`,
          suggestedFix:
            `Use a strict domain pattern with subdomain protection, e.g., "^(.*\\.)?example\\.com$"`,
          ruleId: rule.id,
          field,
        });
      }
    }

    return gaps;
  }

  private analyzeStartsWith(value: string, field: string | undefined, rule: ParsedRule): Gap[] {
    const gaps: Gap[] = [];

    if (this.looksLikeDomain(value) && rule.action === 'allow') {
      gaps.push({
        analyzer: this.name,
        severity: 'warning',
        title: `starts_with domain check may allow unintended subdomains in rule "${rule.id}"`,
        description:
          `"starts_with" check for "${value}" on "${field}" would also match ` +
          `"${value}evil.com" or "${value}.evil.com". Consider using a regex with proper domain boundaries.`,
        suggestedFix: `Use "matches" operator with a regex that ensures domain boundaries.`,
        ruleId: rule.id,
        field,
      });
    }

    return gaps;
  }

  private analyzeContains(value: string, field: string | undefined, rule: ParsedRule): Gap[] {
    const gaps: Gap[] = [];

    if (value.length <= 3) {
      gaps.push({
        analyzer: this.name,
        severity: 'info',
        title: `Short "contains" value "${value}" may over-match in rule "${rule.id}"`,
        description:
          `The contains check for "${value}" on "${field}" is very short and may match ` +
          `unintended strings. For example, checking for "rm" would also match "format" or "transform".`,
        suggestedFix: `Use a more specific pattern, e.g., a regex with word boundaries: "\\brm\\b"`,
        ruleId: rule.id,
        field,
      });
    }

    return gaps;
  }

  private isDomainPattern(pattern: string): boolean {
    return /\.\w{2,}/.test(pattern) && /\\\./.test(pattern);
  }

  private looksLikeDomain(value: string): boolean {
    return /^https?:\/\//.test(value) || /\.\w{2,}$/.test(value);
  }

  private exampleMatch(pattern: string): string {
    return pattern
      .replace(/^\^/, '')
      .replace(/\$$/, '')
      .replace(/\\\./g, '.')
      .replace(/\[.*?\]/g, 'x')
      .replace(/[()]/g, '')
      .replace(/\.\*/g, 'abc')
      .replace(/\+/g, '')
      .replace(/\?/g, '');
  }
}

/**
 * Identifies tools that could be combined for privilege escalation
 * without cross-tool constraints.
 */
export class CrossToolAnalyzer implements Analyzer {
  name = 'cross-tool-constraints';

  private static readonly DANGEROUS_COMBOS: Array<{
    tools: string[];
    reason: string;
    fix: string;
  }> = [
    {
      tools: ['read_file', 'write_file'],
      reason: 'read+write allows copying sensitive files to attacker-controlled locations',
      fix: 'Add cross-tool constraints to prevent reading sensitive paths and writing to external locations in the same session',
    },
    {
      tools: ['execute_command', 'write_file'],
      reason: 'write+execute allows writing a script then running it, bypassing command restrictions',
      fix: 'Add session-level constraints preventing write_file to executable paths when execute_command is available',
    },
    {
      tools: ['http_request', 'read_file'],
      reason: 'read+http allows exfiltrating file contents over the network',
      fix: 'Add constraints preventing HTTP requests to external domains after reading sensitive files',
    },
    {
      tools: ['database_query', 'http_request'],
      reason: 'query+http allows exfiltrating database contents over the network',
      fix: 'Add constraints preventing HTTP requests to external domains after database queries',
    },
    {
      tools: ['send_email', 'read_file'],
      reason: 'read+email allows exfiltrating file contents via email',
      fix: 'Add constraints on email recipients and body content when files have been read',
    },
  ];

  analyze(rules: ParsedRule[], allTools: string[]): Gap[] {
    const gaps: Gap[] = [];
    const toolSet = new Set(allTools);

    for (const combo of CrossToolAnalyzer.DANGEROUS_COMBOS) {
      const present = combo.tools.filter(t => toolSet.has(t));
      if (present.length < 2) continue;

      const hasSessionConstraints = rules.some(
        r => r.enabled && r.conditions.some(c =>
          c.field?.includes('session') || c.field?.includes('history')
        )
      );

      if (!hasSessionConstraints) {
        gaps.push({
          analyzer: this.name,
          severity: 'warning',
          title: `No cross-tool constraints for ${present.join(' + ')}`,
          description:
            `Tools ${present.map(t => `"${t}"`).join(' and ')} are both available. ${combo.reason}. ` +
            `No session-level or cross-tool constraints were detected.`,
          suggestedFix: combo.fix,
        });
      }
    }

    return gaps;
  }
}

/**
 * Finds rules where string/number type mismatches could cause bypasses.
 * E.g. a rule checks arguments.amount < 1000 but the value arrives as string "1000".
 */
export class TypeCoercionAnalyzer implements Analyzer {
  name = 'type-coercion';

  analyze(rules: ParsedRule[]): Gap[] {
    const gaps: Gap[] = [];

    for (const rule of rules) {
      if (!rule.enabled) continue;

      const allConditions = [
        ...rule.conditions,
        ...rule.conditionGroups.flat(),
      ];

      for (const condition of allConditions) {
        if (!condition.operator || !condition.field) continue;

        const isNumericOp =
          condition.operator === 'greater_than' ||
          condition.operator === 'less_than';

        if (isNumericOp && typeof condition.value === 'string') {
          gaps.push({
            analyzer: this.name,
            severity: 'critical',
            title: `String value used with numeric operator in rule "${rule.id}"`,
            description:
              `Rule "${rule.name}" uses "${condition.operator}" on field "${condition.field}" ` +
              `with a string value "${condition.value}". Numeric comparison with a string value ` +
              `may produce unexpected results due to type coercion.`,
            suggestedFix:
              `Change the value to a number: ${condition.operator}: ${Number(condition.value)}`,
            ruleId: rule.id,
            field: condition.field,
          });
        }

        if (isNumericOp && typeof condition.value === 'number') {
          gaps.push({
            analyzer: this.name,
            severity: 'info',
            title: `Numeric field "${condition.field}" may receive string input in rule "${rule.id}"`,
            description:
              `Rule "${rule.name}" checks "${condition.field}" with ${condition.operator} ${condition.value}. ` +
              `If the tool receives this argument as a string (e.g., from JSON parsing), ` +
              `the comparison may silently succeed or fail depending on the validator implementation.`,
            suggestedFix:
              `Ensure the validator coerces types before comparison, or add an explicit type check.`,
            ruleId: rule.id,
            field: condition.field,
          });
        }
      }
    }

    return gaps;
  }
}

// ── Gap Analyzer Orchestrator ──

export class GapAnalyzer {
  private analyzers: Analyzer[];

  constructor(analyzers?: Analyzer[]) {
    this.analyzers = analyzers ?? [
      new UncoveredToolAnalyzer(),
      new SplittingAttackAnalyzer(),
      new UncheckedFieldAnalyzer(),
      new RegexBypassAnalyzer(),
      new CrossToolAnalyzer(),
      new TypeCoercionAnalyzer(),
    ];
  }

  analyze(ruleSets: ParsedRuleSet[]): Gap[] {
    const allRules: ParsedRule[] = [];
    const allTools = new Set<string>();

    for (const ruleSet of ruleSets) {
      for (const rule of ruleSet.rules) {
        allRules.push(rule);
        for (const tool of rule.tools) {
          allTools.add(tool);
        }
      }
    }

    const toolList = [...allTools];
    const gaps: Gap[] = [];

    for (const analyzer of this.analyzers) {
      gaps.push(...analyzer.analyze(allRules, toolList));
    }

    return gaps;
  }
}

// ── Report Formatting ──

function formatTextReport(report: TestReport): string {
  const lines: string[] = [];

  lines.push('');
  lines.push('Veto Policy Gap Analysis');
  lines.push('========================');
  lines.push('');
  lines.push(`Policy directory: ${report.policyDir}`);
  lines.push(`Rules loaded: ${report.rulesLoaded}`);
  lines.push(`Tools covered: ${report.toolsCovered.join(', ') || 'none'}`);
  lines.push('');

  if (report.gaps.length === 0) {
    lines.push('No gaps found. Your policies look good!');
    lines.push('');
    return lines.join('\n');
  }

  lines.push(`Found ${report.summary.total} gap(s):`);
  lines.push(`  Critical: ${report.summary.critical}`);
  lines.push(`  Warning:  ${report.summary.warning}`);
  lines.push(`  Info:     ${report.summary.info}`);
  lines.push('');

  const bySeverity = { critical: [] as Gap[], warning: [] as Gap[], info: [] as Gap[] };
  for (const gap of report.gaps) {
    bySeverity[gap.severity].push(gap);
  }

  for (const severity of ['critical', 'warning', 'info'] as const) {
    const gapsInLevel = bySeverity[severity];
    if (gapsInLevel.length === 0) continue;

    const label = severity.toUpperCase();
    lines.push(`--- ${label} ---`);
    lines.push('');

    for (const gap of gapsInLevel) {
      lines.push(`  [${label}] ${gap.title}`);
      lines.push(`  ${gap.description}`);
      lines.push(`  Fix: ${gap.suggestedFix}`);
      if (gap.ruleId) lines.push(`  Rule: ${gap.ruleId}`);
      if (gap.tool) lines.push(`  Tool: ${gap.tool}`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

// ── Main Command ──

export async function test(options: TestOptions = {}): Promise<TestResult> {
  const {
    policy = join(process.cwd(), 'veto', 'rules'),
    output,
    quiet = false,
    format = 'text',
  } = options;

  const policyDir = resolve(policy);

  if (!existsSync(policyDir)) {
    if (!quiet) {
      console.error(`Policy directory not found: ${policyDir}`);
      console.error('Run "veto init" first, or specify --policy <path>');
    }
    return {
      success: false,
      report: {
        timestamp: new Date().toISOString(),
        policyDir,
        rulesLoaded: 0,
        toolsCovered: [],
        gaps: [],
        summary: { critical: 0, warning: 0, info: 0, total: 0 },
      },
    };
  }

  const ruleSets = loadRuleSets(policyDir);
  const allRules = ruleSets.flatMap(rs => rs.rules);
  const allTools = [...new Set(allRules.flatMap(r => r.tools))];

  const analyzer = new GapAnalyzer();
  const gaps = analyzer.analyze(ruleSets);

  const report: TestReport = {
    timestamp: new Date().toISOString(),
    policyDir,
    rulesLoaded: allRules.length,
    toolsCovered: allTools,
    gaps,
    summary: {
      critical: gaps.filter(g => g.severity === 'critical').length,
      warning: gaps.filter(g => g.severity === 'warning').length,
      info: gaps.filter(g => g.severity === 'info').length,
      total: gaps.length,
    },
  };

  if (output) {
    const outputPath = resolve(output);
    writeFileSync(outputPath, JSON.stringify(report, null, 2), 'utf-8');
    if (!quiet) {
      console.log(`Report written to ${outputPath}`);
    }
  }

  if (!quiet) {
    if (format === 'json') {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatTextReport(report));
    }
  }

  const hasCritical = report.summary.critical > 0;
  return { success: !hasCritical, report };
}
