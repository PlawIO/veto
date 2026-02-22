/**
 * YAML rule loader and parser.
 *
 * Loads rules from YAML files and builds an indexed structure for
 * efficient rule lookup during validation.
 *
 * @module rules/loader
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import type { Logger } from '../utils/logger.js';
import type { Rule, RuleSet, LoadedRules, OutputRule } from './types.js';
import { validatePolicyIR, PolicySchemaError } from './schema-validator.js';

/**
 * Options for the rule loader.
 */
export interface RuleLoaderOptions {
  /** Logger instance */
  logger: Logger;
  /** Whether to watch for file changes (future feature) */
  watch?: boolean;
}

/**
 * YAML parser function type.
 * Users must provide their own YAML parser (e.g., js-yaml).
 */
export type YamlParser = (content: string) => unknown;

/**
 * Default YAML parser that throws an error.
 * Users must provide their own parser.
 */
function defaultYamlParser(): never {
  throw new Error(
    'No YAML parser provided. Please provide a YAML parser function (e.g., from js-yaml package).'
  );
}

/**
 * Loads and manages YAML-based rules.
 */
export class RuleLoader {
  private readonly logger: Logger;
  private yamlParser: YamlParser = defaultYamlParser;
  private loadedRules: LoadedRules = {
    ruleSets: [],
    allRules: [],
    allOutputRules: [],
    rulesByTool: new Map(),
    outputRulesByTool: new Map(),
    globalRules: [],
    globalOutputRules: [],
    sourceFiles: [],
  };

  constructor(options: RuleLoaderOptions) {
    this.logger = options.logger;
  }

  /**
   * Set the YAML parser to use for loading rules.
   *
   * @param parser - YAML parsing function
   *
   * @example
   * ```typescript
   * import yaml from 'js-yaml';
   * loader.setYamlParser(yaml.load);
   * ```
   */
  setYamlParser(parser: YamlParser): void {
    this.yamlParser = parser;
    this.logger.debug('YAML parser configured');
  }

  /**
   * Load rules from a directory containing YAML files.
   *
   * @param dirPath - Path to the directory
   * @param recursive - Whether to search subdirectories
   * @returns Loaded rules
   */
  loadFromDirectory(dirPath: string, recursive = true): LoadedRules {
    this.logger.info('Loading rules from directory', { path: dirPath, recursive });

    if (!existsSync(dirPath)) {
      this.logger.warn('Rules directory does not exist', { path: dirPath });
      return this.loadedRules;
    }

    const yamlFiles = this.findYamlFiles(dirPath, recursive);
    this.logger.debug('Found YAML files', { count: yamlFiles.length });

    for (const filePath of yamlFiles) {
      try {
        this.loadFromFile(filePath);
      } catch (error) {
        this.logger.error(
          'Failed to load rule file',
          { path: filePath },
          error instanceof Error ? error : new Error(String(error))
        );
      }
    }

    this.buildIndex();
    return this.loadedRules;
  }

  /**
   * Load rules from a single YAML file.
   *
   * @param filePath - Path to the YAML file
   */
  loadFromFile(filePath: string): void {
    this.logger.debug('Loading rules from file', { path: filePath });

    const content = readFileSync(filePath, 'utf-8');
    const parsed = this.yamlParser(content);

    if (!parsed || typeof parsed !== 'object') {
      this.logger.warn('Invalid YAML content', { path: filePath });
      return;
    }

    this.validateAgainstSchema(parsed, filePath);

    const ruleSet = this.parseRuleSet(parsed as Record<string, unknown>, filePath);
    if (ruleSet) {
      this.loadedRules.ruleSets.push(ruleSet);
      this.loadedRules.sourceFiles.push(filePath);
      this.logger.info('Loaded rule set', {
        name: ruleSet.name,
        ruleCount: ruleSet.rules.length,
        path: filePath,
      });
    }
  }

  /**
   * Load rules from a YAML string.
   *
   * @param content - YAML content
   * @param sourceName - Name to identify the source
   */
  loadFromString(content: string, sourceName = 'inline'): void {
    this.logger.debug('Loading rules from string', { source: sourceName });

    const parsed = this.yamlParser(content);

    if (!parsed || typeof parsed !== 'object') {
      this.logger.warn('Invalid YAML content', { source: sourceName });
      return;
    }

    this.validateAgainstSchema(parsed, sourceName);

    const ruleSet = this.parseRuleSet(parsed as Record<string, unknown>, sourceName);
    if (ruleSet) {
      this.loadedRules.ruleSets.push(ruleSet);
      this.loadedRules.sourceFiles.push(sourceName);
      this.buildIndex();
    }
  }

  /**
   * Add rules directly without YAML parsing.
   *
   * @param rules - Rules to add
   * @param setName - Name for the rule set
   */
  addRules(rules: Rule[], setName = 'programmatic'): void {
    const ruleSet: RuleSet = {
      version: '1.0',
      name: setName,
      rules,
    };
    this.loadedRules.ruleSets.push(ruleSet);
    this.buildIndex();
    this.logger.info('Added rules programmatically', {
      name: setName,
      count: rules.length,
    });
  }

  /**
   * Get all loaded rules.
   */
  getRules(): LoadedRules {
    return this.loadedRules;
  }

  /**
   * Get rules applicable to a specific tool.
   *
   * @param toolName - Name of the tool
   * @returns Rules that apply to the tool
   */
  getRulesForTool(toolName: string): Rule[] {
    const toolSpecific = this.loadedRules.rulesByTool.get(toolName) ?? [];
    return [...this.loadedRules.globalRules, ...toolSpecific].filter(
      (rule) => rule.enabled
    );
  }

  /**
   * Get output rules applicable to a specific tool.
   */
  getOutputRulesForTool(toolName: string): OutputRule[] {
    const toolSpecific = this.loadedRules.outputRulesByTool.get(toolName) ?? [];
    return [...this.loadedRules.globalOutputRules, ...toolSpecific].filter(
      (rule) => rule.enabled
    );
  }

  /**
   * Clear all loaded rules.
   */
  clear(): void {
    this.loadedRules = {
      ruleSets: [],
      allRules: [],
      allOutputRules: [],
      rulesByTool: new Map(),
      outputRulesByTool: new Map(),
      globalRules: [],
      globalOutputRules: [],
      sourceFiles: [],
    };
    this.logger.debug('Cleared all rules');
  }

  /**
   * Reload rules from previously loaded sources.
   */
  reload(): LoadedRules {
    const sources = [...this.loadedRules.sourceFiles];
    this.clear();

    for (const source of sources) {
      if (existsSync(source)) {
        this.loadFromFile(source);
      }
    }

    this.buildIndex();
    this.logger.info('Reloaded rules', { sourceCount: sources.length });
    return this.loadedRules;
  }

  /**
   * Validate parsed YAML against the Policy IR v1 schema.
   * Throws PolicySchemaError with actionable details on failure.
   */
  private validateAgainstSchema(data: unknown, source: string): void {
    try {
      validatePolicyIR(data);
    } catch (error) {
      if (error instanceof PolicySchemaError) {
        this.logger.error(
          'Policy schema validation failed',
          { source, errorCount: error.errors.length },
          error
        );
      }
      throw error;
    }
  }

  /**
   * Find YAML files in a directory.
   */
  private findYamlFiles(dirPath: string, recursive: boolean): string[] {
    const files: string[] = [];
    const entries = readdirSync(dirPath);

    for (const entry of entries) {
      const fullPath = join(dirPath, entry);
      const stat = statSync(fullPath);

      if (stat.isDirectory() && recursive) {
        files.push(...this.findYamlFiles(fullPath, recursive));
      } else if (stat.isFile()) {
        const ext = extname(entry).toLowerCase();
        if (ext === '.yaml' || ext === '.yml') {
          files.push(fullPath);
        }
      }
    }

    return files;
  }

  /**
   * Parse a rule set from parsed YAML.
   */
  private parseRuleSet(
    data: Record<string, unknown>,
    source: string
  ): RuleSet | null {
    // Check if this is a rule set format or just a list of rules
    if (Array.isArray(data)) {
      // It's just an array of rules
      return {
        version: '1.0',
        name: source,
        rules: data.map((r, i) => this.parseRule(r, `${source}:rule-${i}`)),
      };
    }

    // Check for rules array in the object
    const rules = data.rules as unknown[];
    if (!rules || !Array.isArray(rules)) {
      // Maybe it's a single rule
      if (data.id && data.name) {
        return {
          version: '1.0',
          name: source,
          rules: [this.parseRule(data, source)],
        };
      }
      this.logger.warn('No rules found in file', { source });
      return null;
    }

    return {
      version: (data.version as string) ?? '1.0',
      name: (data.name as string) ?? source,
      description: data.description as string | undefined,
      rules: rules.map((r, i) => this.parseRule(r, `${source}:rule-${i}`)),
      output_rules: Array.isArray(data.output_rules)
        ? data.output_rules.map((r, i) => this.parseOutputRule(r, `${source}:output-rule-${i}`))
        : undefined,
      settings: data.settings as RuleSet['settings'],
    };
  }

  /**
   * Parse a single rule from YAML data.
   */
  private parseRule(data: unknown, source: string): Rule {
    if (!data || typeof data !== 'object') {
      throw new Error(`Invalid rule at ${source}`);
    }

    const ruleData = data as Record<string, unknown>;

    return {
      id: (ruleData.id as string) ?? `auto-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      name: (ruleData.name as string) ?? 'Unnamed Rule',
      description: ruleData.description as string | undefined,
      enabled: ruleData.enabled !== false, // Default to true
      severity: (ruleData.severity as Rule['severity']) ?? 'medium',
      action: (ruleData.action as Rule['action']) ?? 'block',
      tools: ruleData.tools as string[] | undefined,
      conditions: ruleData.conditions as Rule['conditions'],
      condition_groups: ruleData.condition_groups as Rule['condition_groups'],
      blocked_by: ruleData.blocked_by as Rule['blocked_by'],
      requires: ruleData.requires as Rule['requires'],
      tags: ruleData.tags as string[] | undefined,
      metadata: ruleData.metadata as Record<string, unknown> | undefined,
    };
  }

  /**
   * Parse a single output rule from YAML data.
   */
  private parseOutputRule(data: unknown, source: string): OutputRule {
    if (!data || typeof data !== 'object') {
      throw new Error(`Invalid output rule at ${source}`);
    }

    const ruleData = data as Record<string, unknown>;

    return {
      id: (ruleData.id as string) ?? `auto-output-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      name: (ruleData.name as string) ?? 'Unnamed Output Rule',
      description: ruleData.description as string | undefined,
      enabled: ruleData.enabled !== false,
      severity: (ruleData.severity as OutputRule['severity']) ?? 'medium',
      action: (ruleData.action as OutputRule['action']) ?? 'log',
      tools: ruleData.tools as string[] | undefined,
      output_conditions: ruleData.output_conditions as OutputRule['output_conditions'],
      output_condition_groups: ruleData.output_condition_groups as OutputRule['output_condition_groups'],
      redact_with: ruleData.redact_with as string | undefined,
      tags: ruleData.tags as string[] | undefined,
      metadata: ruleData.metadata as Record<string, unknown> | undefined,
    };
  }

  /**
   * Build the rule index for efficient lookup.
   */
  private buildIndex(): void {
    this.loadedRules.allRules = [];
    this.loadedRules.allOutputRules = [];
    this.loadedRules.rulesByTool = new Map();
    this.loadedRules.outputRulesByTool = new Map();
    this.loadedRules.globalRules = [];
    this.loadedRules.globalOutputRules = [];

    for (const ruleSet of this.loadedRules.ruleSets) {
      for (const rule of ruleSet.rules) {
        this.loadedRules.allRules.push(rule);

        if (!rule.tools || rule.tools.length === 0) {
          // Global rule applies to all tools
          this.loadedRules.globalRules.push(rule);
        } else {
          // Tool-specific rule
          for (const toolName of rule.tools) {
            const existing = this.loadedRules.rulesByTool.get(toolName) ?? [];
            existing.push(rule);
            this.loadedRules.rulesByTool.set(toolName, existing);
          }
        }
      }

      for (const outputRule of ruleSet.output_rules ?? []) {
        this.loadedRules.allOutputRules.push(outputRule);

        if (!outputRule.tools || outputRule.tools.length === 0) {
          this.loadedRules.globalOutputRules.push(outputRule);
        } else {
          for (const toolName of outputRule.tools) {
            const existing = this.loadedRules.outputRulesByTool.get(toolName) ?? [];
            existing.push(outputRule);
            this.loadedRules.outputRulesByTool.set(toolName, existing);
          }
        }
      }
    }

    this.logger.debug('Built rule index', {
      totalRules: this.loadedRules.allRules.length,
      globalRules: this.loadedRules.globalRules.length,
      toolsWithRules: this.loadedRules.rulesByTool.size,
      totalOutputRules: this.loadedRules.allOutputRules.length,
      globalOutputRules: this.loadedRules.globalOutputRules.length,
      toolsWithOutputRules: this.loadedRules.outputRulesByTool.size,
    });
  }
}

/**
 * Create a new rule loader.
 *
 * @param options - Loader options
 * @returns RuleLoader instance
 */
export function createRuleLoader(options: RuleLoaderOptions): RuleLoader {
  return new RuleLoader(options);
}
