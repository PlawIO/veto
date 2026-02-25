/**
 * Agent-native CLI utilities for Veto.
 *
 * Allows autonomous LLMs to configure Veto without human interaction.
 * All commands return JSON for programmatic parsing and never prompt for input.
 *
 * @module cli/agent
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseYaml, stringify } from 'yaml';
import { init, type InitResult } from './init.js';
import { scan, type ScanResult } from './scan.js';
import { generatePolicyFromPrompt } from './repl-generate.js';
import { analyzeToolImpact, type ToolImpact } from './repl.js';
import { createReplSessionContext } from './repl-context.js';
import type { Rule } from '../rules/types.js';

/**
 * Result of an agent operation.
 */
export interface AgentResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

/**
 * Policy list item.
 */
export interface PolicyListItem {
  id: string;
  name?: string;
  description?: string;
  action: string;
  tools: string[];
  enabled: boolean;
  file: string;
}

/**
 * Policy add result.
 */
export interface PolicyAddResult {
  file: string;
  rules: string[];
  impacts: ToolImpact[];
}

/**
 * Configuration for agent operations.
 */
export interface AgentOptions {
  /** Project directory */
  directory?: string;
  /** Output format: json or yaml */
  format?: 'json' | 'yaml';
}

/**
 * Initialize Veto in agent mode.
 *
 * @param options - Agent options
 * @returns Result with initialization details
 */
export async function agentInit(options: AgentOptions = {}): Promise<AgentResult<InitResult>> {
  try {
    const result = await init({
      directory: options.directory,
      agent: true,
      yes: true,
      quiet: true,
    });

    if (!options.format || options.format === 'json') {
      const output: Record<string, unknown> = { success: result.success, data: result };
      if (result.messages.length > 0) {
        output.messages = result.messages;
      }
      console.log(JSON.stringify(output));
    } else {
      console.log(stringify({ ...result }));
    }

    return { success: result.success, data: result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!options.format || options.format === 'json') {
      console.log(JSON.stringify({ success: false, error: message }));
    }
    return { success: false, error: message };
  }
}

/**
 * List all policies in the project.
 *
 * @param options - Agent options
 * @returns List of policies
 */
export async function agentPolicyList(options: AgentOptions = {}): Promise<AgentResult<PolicyListItem[]>> {
  try {
    const cwd = resolve(options.directory ?? process.cwd());
    const rulesDir = join(cwd, 'veto', 'rules');

    if (!existsSync(rulesDir)) {
      const result: PolicyListItem[] = [];
      if (!options.format || options.format === 'json') {
        console.log(JSON.stringify({ success: true, data: result }));
      } else {
        console.log(stringify({ success: true, policies: result }));
      }
      return { success: true, data: result };
    }

    const policies: PolicyListItem[] = [];
    const { readdirSync, statSync } = await import('node:fs');

    const files = readdirSync(rulesDir);
    for (const file of files) {
      if (!file.endsWith('.yaml') && !file.endsWith('.yml')) {
        continue;
      }

      const filePath = join(rulesDir, file);
      const stat = statSync(filePath);
      if (!stat.isFile()) {
        continue;
      }

      try {
        const content = readFileSync(filePath, 'utf-8');
        const parsed = parseYaml(content) as { rules?: Rule[] } | null;

        if (parsed?.rules && Array.isArray(parsed.rules)) {
          for (const rule of parsed.rules) {
            policies.push({
              id: rule.id,
              name: rule.name,
              description: rule.description,
              action: rule.action,
              tools: rule.tools ?? [],
              enabled: rule.enabled ?? true,
              file: `veto/rules/${file}`,
            });
          }
        }
      } catch {
        // Skip invalid files
      }
    }

    if (!options.format || options.format === 'json') {
      console.log(JSON.stringify({ success: true, data: policies }));
    } else {
      console.log(stringify({ success: true, policies }));
    }

    return { success: true, data: policies };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!options.format || options.format === 'json') {
      console.log(JSON.stringify({ success: false, error: message }));
    }
    return { success: false, error: message };
  }
}

/**
 * Add a new policy from a natural language prompt.
 *
 * @param prompt - Policy description
 * @param options - Agent options
 * @returns Result with policy details
 */
export async function agentPolicyAdd(prompt: string, options: AgentOptions = {}): Promise<AgentResult<PolicyAddResult>> {
  try {
    const cwd = resolve(options.directory ?? process.cwd());
    const context = await createReplSessionContext(cwd);

    const generated = await generatePolicyFromPrompt({
      prompt,
      projectDir: cwd,
      rulesDirectory: context.rulesDir,
      tools: context.discoveredTools,
      existingRules: context.allRules,
    });

    const parsed = parseYaml(generated.yaml) as { rules?: Rule[] };
    const rules = (parsed.rules ?? []) as Rule[];
    const impacts = analyzeToolImpact(rules, context.discoveredTools);

    // Determine save path
    const ruleId = rules[0]?.id ?? 'policy';
    const safeId = ruleId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const savePath = join(cwd, 'veto', 'rules', `${safeId}.yaml`);

    // Ensure directory exists
    mkdirSync(join(cwd, 'veto', 'rules'), { recursive: true });

    // Write the policy
    writeFileSync(savePath, generated.yaml, 'utf-8');

    const result: PolicyAddResult = {
      file: savePath,
      rules: rules.map((r) => r.id),
      impacts,
    };

    if (!options.format || options.format === 'json') {
      console.log(JSON.stringify({ success: true, data: result }));
    } else {
      console.log(stringify({ success: true, ...result }));
    }

    return { success: true, data: result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!options.format || options.format === 'json') {
      console.log(JSON.stringify({ success: false, error: message }));
    }
    return { success: false, error: message };
  }
}

/**
 * Scan project tools and show coverage.
 *
 * @param options - Agent options
 * @returns Scan result with tool coverage
 */
export async function agentScan(options: AgentOptions = {}): Promise<AgentResult<ScanResult>> {
  try {
    const result = await scan({
      directory: options.directory,
      quiet: true,
      failUncovered: false,
      suggest: false,
      format: 'json',
    });

    if (!options.format || options.format === 'json') {
      console.log(JSON.stringify({ success: result.success, data: result }));
    } else {
      console.log(stringify({ ...result }));
    }

    return { success: result.success, data: result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!options.format || options.format === 'json') {
      console.log(JSON.stringify({ success: false, error: message }));
    }
    return { success: false, error: message };
  }
}

/**
 * Get the current Veto configuration.
 *
 * @param options - Agent options
 * @returns Configuration object
 */
export async function agentConfig(options: AgentOptions = {}): Promise<AgentResult<Record<string, unknown>>> {
  try {
    const cwd = resolve(options.directory ?? process.cwd());
    const configPath = join(cwd, 'veto', 'veto.config.yaml');

    if (!existsSync(configPath)) {
      const result = { initialized: false };
      if (!options.format || options.format === 'json') {
        console.log(JSON.stringify({ success: true, data: result }));
      } else {
        console.log(stringify({ success: true, ...result }));
      }
      return { success: true, data: result };
    }

    const content = readFileSync(configPath, 'utf-8');
    const config = parseYaml(content) as Record<string, unknown>;

    const result = { initialized: true, ...config };

    if (!options.format || options.format === 'json') {
      console.log(JSON.stringify({ success: true, data: result }));
    } else {
      console.log(stringify({ success: true, ...result }));
    }

    return { success: true, data: result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!options.format || options.format === 'json') {
      console.log(JSON.stringify({ success: false, error: message }));
    }
    return { success: false, error: message };
  }
}
