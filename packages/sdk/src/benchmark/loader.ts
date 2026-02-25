/**
 * Dataset loader for benchmark samples.
 *
 * Parses JSONL training data files and extracts benchmark samples
 * with tool calls, rules, and expected decisions.
 *
 * @module benchmark/loader
 */

import { readFileSync, existsSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { glob } from '../utils/glob.js';
import type { Rule, RuleCondition } from '../rules/types.js';
import type { BenchmarkSample } from './types.js';

/**
 * ChatML message format from training data.
 */
interface ChatMLMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Training data format (JSONL line).
 */
interface TrainingExample {
  messages: ChatMLMessage[];
}

/**
 * Expected response format from assistant.
 */
interface ExpectedResponse {
  pass_weight: number;
  block_weight: number;
  decision: 'pass' | 'block';
  reasoning: string;
  matched_rules?: string[];
}

/**
 * Load benchmark samples from a glob pattern.
 *
 * @param pattern - Glob pattern for JSONL files
 * @param maxSamples - Maximum samples to load (0 = all)
 * @param shuffle - Whether to shuffle samples
 * @param seed - Random seed for shuffling
 */
export async function loadBenchmarkSamples(
  pattern: string,
  maxSamples: number = 0,
  shuffle: boolean = false,
  seed?: number
): Promise<BenchmarkSample[]> {
  const files = await glob(pattern);
  
  if (files.length === 0) {
    throw new Error(`No files found matching pattern: ${pattern}`);
  }

  const samples: BenchmarkSample[] = [];
  let sampleId = 0;

  for (const file of files) {
    if (!existsSync(file)) continue;

    const category = extractCategory(file);
    const content = readFileSync(file, 'utf-8');
    const lines = content.trim().split('\n').filter(line => line.trim());

    for (const line of lines) {
      try {
        const example = JSON.parse(line) as TrainingExample;
        const sample = parseTrainingExample(example, sampleId++, file, category);
        
        if (sample) {
          samples.push(sample);
        }
      } catch {
        // Skip malformed lines
        continue;
      }
    }
  }

  if (samples.length === 0) {
    throw new Error('No valid samples found in dataset');
  }

  // Shuffle if requested
  let result = shuffle ? shuffleArray(samples, seed) : samples;

  // Limit samples if requested
  if (maxSamples > 0 && result.length > maxSamples) {
    result = result.slice(0, maxSamples);
  }

  return result;
}

/**
 * Parse a training example into a benchmark sample.
 */
function parseTrainingExample(
  example: TrainingExample,
  id: number,
  sourceFile: string,
  category: string
): BenchmarkSample | null {
  if (!example.messages || example.messages.length < 3) {
    return null;
  }

  const userMessage = example.messages.find(m => m.role === 'user');
  const assistantMessage = example.messages.find(m => m.role === 'assistant');

  if (!userMessage || !assistantMessage) {
    return null;
  }

  // Parse user content to extract tool call and rules
  const { tool, arguments: args, rules } = parseUserContent(userMessage.content);
  
  if (!tool || !rules) {
    return null;
  }

  // Parse expected response
  const expected = parseExpectedResponse(assistantMessage.content);
  
  if (!expected) {
    return null;
  }

  return {
    id: `sample-${id}`,
    tool,
    arguments: args,
    rules,
    expectedDecision: expected.decision,
    expectedPassWeight: expected.pass_weight,
    expectedBlockWeight: expected.block_weight,
    sourceFile,
    category,
  };
}

/**
 * Parse user content to extract tool call and rules.
 */
function parseUserContent(content: string): {
  tool: string | null;
  arguments: Record<string, unknown>;
  rules: Rule[] | null;
} {
  const result: {
    tool: string | null;
    arguments: Record<string, unknown>;
    rules: Rule[] | null;
  } = {
    tool: null,
    arguments: {},
    rules: null,
  };

  // Split into TOOL CALL and RULES sections
  const toolCallMatch = content.match(/TOOL CALL:\s*\n([\s\S]*?)(?=\nRULES:|$)/);
  const rulesMatch = content.match(/RULES:\s*\n([\s\S]*?)$/);

  if (toolCallMatch) {
    const toolSection = toolCallMatch[1];
    
    // Extract tool name
    const toolNameMatch = toolSection.match(/tool:\s*(\S+)/);
    if (toolNameMatch) {
      result.tool = toolNameMatch[1];
    }

    // Extract arguments (YAML-like format)
    const argsMatch = toolSection.match(/arguments:\s*\n([\s\S]*)/);
    if (argsMatch) {
      result.arguments = parseYamlLikeArgs(argsMatch[1]);
    }
  }

  if (rulesMatch) {
    result.rules = parseRulesSection(rulesMatch[1]);
  }

  return result;
}

/**
 * Parse YAML-like arguments.
 */
function parseYamlLikeArgs(content: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const lines = content.split('\n');

  for (const line of lines) {
    const match = line.match(/^\s{2}(\w+):\s*(.*)$/);
    if (match) {
      const [, key, rawValue] = match;
      args[key] = parseValue(rawValue.trim());
    }
  }

  return args;
}

/**
 * Parse a YAML-like value.
 */
function parseValue(value: string): unknown {
  // Empty string
  if (value === '""' || value === "''") return '';
  
  // Quoted string
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }

  // Boolean
  if (value === 'true') return true;
  if (value === 'false') return false;

  // Null
  if (value === 'null' || value === '~') return null;

  // Number
  const num = Number(value);
  if (!isNaN(num) && value !== '') return num;

  // Array (simple)
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1);
    if (inner === '') return [];
    return inner.split(',').map(v => parseValue(v.trim()));
  }

  // Default to string
  return value;
}

/**
 * Parse RULES section into Rule objects.
 */
function parseRulesSection(content: string): Rule[] {
  const rules: Rule[] = [];
  const ruleBlocks = content.split(/^- id:/m).filter(Boolean);

  for (const block of ruleBlocks) {
    const rule = parseRuleBlock('- id:' + block);
    if (rule) {
      rules.push(rule);
    }
  }

  return rules;
}

/**
 * Parse a single rule block.
 */
function parseRuleBlock(block: string): Rule | null {
  const lines = block.split('\n');
  const rule: Partial<Rule> = {};
  let currentSection: 'conditions' | 'condition_groups' | 'tools' | null = null;
  let conditions: RuleCondition[] = [];
  let currentCondition: Partial<RuleCondition> = {};

  for (const line of lines) {
    // Rule ID
    const idMatch = line.match(/^- id:\s*(.+)$/);
    if (idMatch) {
      rule.id = idMatch[1].trim();
      continue;
    }

    // Simple fields
    const fieldMatch = line.match(/^\s{2}(\w+):\s*(.+)$/);
    if (fieldMatch) {
      const [, key, value] = fieldMatch;
      switch (key) {
        case 'name':
          rule.name = value;
          break;
        case 'enabled':
          rule.enabled = value === 'true';
          break;
        case 'severity':
          rule.severity = value as Rule['severity'];
          break;
        case 'action':
          rule.action = value as Rule['action'];
          break;
        case 'tools':
          // Parse inline array: [tool1, tool2]
          if (value.startsWith('[')) {
            rule.tools = value.slice(1, -1).split(',').map(t => t.trim());
          }
          currentSection = 'tools';
          break;
        case 'conditions':
          currentSection = 'conditions';
          conditions = [];
          break;
        case 'condition_groups':
          currentSection = 'condition_groups';
          break;
      }
      continue;
    }

    // Condition fields
    if (currentSection === 'conditions') {
      const condFieldMatch = line.match(/^\s{4,6}- field:\s*(.+)$/);
      if (condFieldMatch) {
        if (Object.keys(currentCondition).length > 0) {
          conditions.push(currentCondition as RuleCondition);
        }
        currentCondition = { field: condFieldMatch[1].trim() };
        continue;
      }

      const operatorMatch = line.match(/^\s{6,8}operator:\s*(.+)$/);
      if (operatorMatch) {
        currentCondition.operator = operatorMatch[1].trim() as RuleCondition['operator'];
        continue;
      }

      const valueMatch = line.match(/^\s{6,8}value:\s*(.+)$/);
      if (valueMatch) {
        currentCondition.value = parseValue(valueMatch[1].trim());
        continue;
      }
    }
  }

  // Add last condition
  if (Object.keys(currentCondition).length > 0) {
    conditions.push(currentCondition as RuleCondition);
  }

  if (conditions.length > 0) {
    rule.conditions = conditions;
  }

  // Validate required fields
  if (!rule.id || !rule.name || rule.enabled === undefined || !rule.severity || !rule.action) {
    return null;
  }

  return rule as Rule;
}

/**
 * Parse expected response from assistant content.
 */
function parseExpectedResponse(content: string): ExpectedResponse | null {
  try {
    // Extract JSON from content (might have extra text)
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);

    if (typeof parsed.pass_weight !== 'number' ||
        typeof parsed.block_weight !== 'number' ||
        (parsed.decision !== 'pass' && parsed.decision !== 'block')) {
      return null;
    }

    return parsed as ExpectedResponse;
  } catch {
    return null;
  }
}

/**
 * Extract category from file path.
 */
function extractCategory(filePath: string): string {
  const dir = basename(dirname(filePath));
  const file = basename(filePath, '.jsonl');
  return `${dir}/${file}`;
}

/**
 * Shuffle array using Fisher-Yates algorithm with optional seed.
 */
function shuffleArray<T>(array: T[], seed?: number): T[] {
  const result = [...array];
  const random = seed !== undefined ? seededRandom(seed) : Math.random;

  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }

  return result;
}

/**
 * Create a seeded random number generator.
 */
function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}
