import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, basename, extname } from 'node:path';
import { parse as parseYaml, stringify } from 'yaml';
import type { CustomProvider } from '../custom/types.js';
import {
  PROVIDER_ENV_VARS,
  PROVIDER_BASE_URLS,
  CustomError,
} from '../custom/types.js';
import { createSafeRegex } from '../rules/condition-evaluator.js';
import { createReplSessionContext } from './repl-context.js';
import { generatePolicyFromPrompt, validateGeneratedYaml } from './repl-generate.js';

export interface CompileOptions {
  input?: string;
  file?: string;
  output: string;
  provider?: CustomProvider;
  model?: string;
  quiet?: boolean;
}

export interface CompileResult {
  success: boolean;
  outputPath?: string;
  yaml?: string;
  messages: string[];
}

interface CompileProviderConfig {
  provider: CustomProvider;
  model: string;
  apiKey: string;
  baseUrl?: string;
}

const COMPILE_SYSTEM_PROMPT = `You are a policy compiler for Veto, an AI agent tool-call guardrail system.

Your task: convert a natural language policy description into deterministic YAML rules.

The output MUST be a valid JSON object with three fields:
- "rules": an array of input rule objects (the compiled rules)
- "output_rules": an optional array of output visibility rules
- "notes": a string with any caveats or suggestions (empty string if none)

Each rule object MUST have these fields:
- "id": kebab-case unique identifier (e.g. "block-external-emails")
- "name": short human-readable name
- "description": what the rule does
- "enabled": true
- "severity": one of "critical", "high", "medium", "low", "info"
- "action": one of "block", "warn", "log", "allow", "require_approval"
- "tools": array of tool name strings this applies to (use general names like "send_email", "transfer_funds", "read_file", "write_file", "execute_command", etc.)
- "conditions": array of condition objects, each with:
  - "field": dot-notation path (e.g. "arguments.to", "arguments.amount")
  - "operator": one of "equals", "not_equals", "contains", "not_contains", "starts_with", "ends_with", "matches", "greater_than", "greater_than_or_equal", "less_than", "less_than_or_equal", "length_greater_than", "in", "not_in", "not_exists", "outside_hours", "within_hours"
  - "value": the value to compare against

Common patterns:
- Domain restrictions: use "matches" operator with regex (e.g. "^[^@]+@company\\.com$")
- Amount limits: use "greater_than" or "less_than" with numeric values
- Field requirements: use "equals" with expected values
- Enum allowlists: use "in" with an array of allowed values
- Path restrictions: use "starts_with" or "matches" with path patterns
- Time windows: use "outside_hours" or "within_hours" on "context.time" with value:
  {"start":"HH:MM","end":"HH:MM","timezone":"IANA/Zone","days":["mon","tue","wed","thu","fri"]}
- Use "require_approval" when the policy should pause for human review rather than hard-block.

If the policy is about HIDING, REDACTING, FILTERING, or NOT SHOWING data in tool outputs, generate output_rules.

Each output rule object MUST have these fields:
- "id": kebab-case unique identifier
- "name": short human-readable name
- "action": one of "block", "redact", "log"
- "tools": array of tool name strings this applies to
- "output_conditions": array of condition objects using:
  - "field": usually "output" or an output subfield like "output.rows"
  - "operator": one of ${Array.from(new Set(['equals', 'not_equals', 'contains', 'not_contains', 'starts_with', 'ends_with', 'matches', 'greater_than', 'greater_than_or_equal', 'less_than', 'less_than_or_equal', 'length_greater_than', 'in', 'not_in', 'not_exists', 'outside_hours', 'within_hours'])).map((operator) => `"${operator}"`).join(', ')}
  - "value": the value to compare against
- "redact_with": replacement string when action is "redact"

Output rule guidance:
- Use output_rules for phrases like "do not show", "hide", "redact", "don't reveal", "mask"
- Expand named entities into safe, case-insensitive regex patterns when appropriate
- Example: "Acme Inc." -> "(?i)\\bacme\\b(?:\\s+(?:inc|corp|llc))?\\.?"
- When both input restrictions and output visibility restrictions apply, generate both "rules" and "output_rules"

If the policy CANNOT be fully expressed as deterministic rules, include an explanation in the "notes" field describing what aspects require LLM-based evaluation.

Respond with ONLY a JSON object. No markdown, no explanation outside the JSON.`;

const VALID_OPERATORS = new Set([
  'equals', 'not_equals', 'contains', 'not_contains',
  'starts_with', 'ends_with', 'matches',
  'greater_than', 'greater_than_or_equal', 'less_than', 'less_than_or_equal',
  'length_greater_than', 'in', 'not_in', 'not_exists',
  'outside_hours', 'within_hours',
]);
const VALID_ACTIONS = new Set(['block', 'warn', 'log', 'allow', 'require_approval']);
const VALID_OUTPUT_ACTIONS = new Set(['block', 'redact', 'log']);
const VALID_SEVERITIES = new Set(['critical', 'high', 'medium', 'low', 'info']);

async function loadOptionalModule<T>(moduleName: string): Promise<T> {
  return await import(moduleName) as T;
}

function buildUserPrompt(policyText: string): string {
  return `Convert this natural language policy into deterministic YAML rules:\n\n${policyText}`;
}

function resolveProvider(options: CompileOptions): CompileProviderConfig {
  const provider = options.provider ?? detectProvider();
  if (!provider) {
    throw new CompileError(
      'No LLM provider configured. Set --provider or one of: OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY'
    );
  }

  const model = options.model ?? defaultModel(provider);
  const envVar = PROVIDER_ENV_VARS[provider];
  const apiKey = process.env[envVar];
  if (!apiKey) {
    throw new CompileError(
      `Missing API key. Set ${envVar} environment variable.`
    );
  }

  return {
    provider,
    model,
    apiKey,
    baseUrl: PROVIDER_BASE_URLS[provider],
  };
}

function detectProvider(): CustomProvider | null {
  if (process.env.OPENAI_API_KEY) return 'openai';
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (process.env.GEMINI_API_KEY) return 'gemini';
  if (process.env.OPENROUTER_API_KEY) return 'openrouter';
  return null;
}

function defaultModel(provider: CustomProvider): string {
  switch (provider) {
    case 'openai': return 'gpt-5.4';
    case 'anthropic': return 'claude-sonnet-4-5-20250929';
    case 'gemini': return 'gemini-2.0-flash';
    case 'openrouter': return 'openai/gpt-5.4';
    default: throw new CompileError(`Unsupported provider: ${provider}`);
  }
}

export class CompileError extends CustomError {
  constructor(message: string) {
    super(message);
    this.name = 'CompileError';
  }
}

async function callLLM(
  config: CompileProviderConfig,
  policyText: string
): Promise<string> {
  const userPrompt = buildUserPrompt(policyText);

  switch (config.provider) {
    case 'openai':
    case 'openrouter': {
      const OpenAI = (await import('openai')).default;
      const client = new OpenAI({
        apiKey: config.apiKey,
        baseURL: config.baseUrl,
      });
      const response = await client.chat.completions.create({
        model: config.model,
        messages: [
          { role: 'system', content: COMPILE_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.1,
        max_tokens: 4096,
        response_format: { type: 'json_object' },
      });
      const content = response.choices[0]?.message?.content;
      if (!content) throw new CompileError('Empty response from LLM');
      return content;
    }

    case 'anthropic': {
      const Anthropic = (await loadOptionalModule<{ default: new (options: { apiKey: string }) => {
        messages: {
          create(args: Record<string, unknown>): Promise<{
            content: Array<{ type: string; text?: string }>;
          }>;
        };
      } }>('@anthropic-ai/sdk')).default;
      const client = new Anthropic({ apiKey: config.apiKey });
      const response = await client.messages.create({
        model: config.model,
        system: COMPILE_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
        temperature: 0.1,
        max_tokens: 4096,
      });
      const block = response.content[0];
      if (!block || block.type !== 'text' || typeof block.text !== 'string') {
        throw new CompileError('Unexpected response from Anthropic');
      }
      return block.text;
    }

    case 'gemini': {
      const { GoogleGenAI } = await loadOptionalModule<{
        GoogleGenAI: new (options: { apiKey: string }) => {
          models: {
            generateContent(args: Record<string, unknown>): Promise<{ text?: string }>;
          };
        };
      }>('@google/genai');
      const ai = new GoogleGenAI({ apiKey: config.apiKey });
      const response = await ai.models.generateContent({
        model: config.model,
        contents: `${COMPILE_SYSTEM_PROMPT}\n\n${userPrompt}`,
        config: {
          temperature: 0.1,
          maxOutputTokens: 4096,
          responseMimeType: 'application/json',
        },
      });
      const text = response.text;
      if (!text) throw new CompileError('Empty response from Gemini');
      return text;
    }

    default:
      throw new CompileError(`Unsupported provider: ${config.provider}`);
  }
}

interface CompiledRule {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  severity: string;
  action: string;
  tools: string[];
  conditions: Array<{
    field: string;
    operator: string;
    value: unknown;
  }>;
}

interface CompiledOutputRule {
  id: string;
  name: string;
  description?: string;
  enabled?: boolean;
  severity?: string;
  action: string;
  tools?: string[];
  output_conditions?: Array<{
    field: string;
    operator: string;
    value: unknown;
  }>;
  output_condition_groups?: Array<Array<{
    field: string;
    operator: string;
    value: unknown;
  }>>;
  redact_with?: string;
}

interface LLMOutput {
  rules: CompiledRule[];
  output_rules?: CompiledOutputRule[];
  notes: string;
}

function validateConditionCollection(
  ruleId: string,
  conditions: unknown,
  label: 'condition' | 'output condition'
): void {
  if (!Array.isArray(conditions)) {
    return;
  }

  for (const condition of conditions) {
    validateCondition(ruleId, condition, label);
  }
}

function validateConditionGroups(
  ruleId: string,
  groups: unknown,
  label: 'condition' | 'output condition'
): void {
  if (!Array.isArray(groups)) {
    return;
  }

  for (const group of groups) {
    if (!Array.isArray(group)) {
      throw new CompileError(`Rule "${ruleId}" has invalid ${label} group`);
    }

    for (const condition of group) {
      validateCondition(ruleId, condition, label);
    }
  }
}

function validateCondition(
  ruleId: string,
  condition: unknown,
  label: 'condition' | 'output condition'
): void {
  if (!condition || typeof condition !== 'object') {
    throw new CompileError(`Rule "${ruleId}" has invalid ${label}`);
  }

  const parsedCondition = condition as Record<string, unknown>;
  if (
    typeof parsedCondition.operator !== 'string'
    || !VALID_OPERATORS.has(parsedCondition.operator)
  ) {
    throw new CompileError(
      `Rule "${ruleId}" has invalid operator: ${parsedCondition.operator}`
    );
  }

  if (parsedCondition.operator === 'matches') {
    if (typeof parsedCondition.value !== 'string' || !createSafeRegex(parsedCondition.value)) {
      throw new CompileError(`Rule "${ruleId}" has unsafe regex: ${parsedCondition.value}`);
    }
  }
}

function extractJSON(raw: string): string {
  const start = raw.indexOf('{');
  if (start === -1) throw new CompileError('No JSON found in LLM response');
  let depth = 0;
  for (let i = start; i < raw.length; i++) {
    if (raw[i] === '{') depth++;
    else if (raw[i] === '}') depth--;
    if (depth === 0) return raw.slice(start, i + 1);
  }
  throw new CompileError('No JSON found in LLM response');
}

function parseAndValidateLLMOutput(raw: string): LLMOutput {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    try {
      parsed = JSON.parse(extractJSON(raw));
    } catch {
      throw new CompileError('Invalid JSON in LLM response');
    }
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new CompileError('LLM response is not an object');
  }

  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.rules)) {
    throw new CompileError('LLM response missing "rules" array');
  }

  for (const rule of obj.rules) {
    if (!rule || typeof rule !== 'object') {
      throw new CompileError('Invalid rule in LLM output');
    }
    const r = rule as Record<string, unknown>;
    if (typeof r.id !== 'string' || !r.id) {
      throw new CompileError('Rule missing "id" field');
    }
    if (typeof r.name !== 'string' || !r.name) {
      throw new CompileError(`Rule "${r.id}" missing "name" field`);
    }
    if (typeof r.action !== 'string' || !VALID_ACTIONS.has(r.action)) {
      throw new CompileError(`Rule "${r.id}" has invalid action: ${r.action}`);
    }
    if (r.severity && !VALID_SEVERITIES.has(r.severity as string)) {
      throw new CompileError(`Rule "${r.id}" has invalid severity: ${r.severity}`);
    }
    validateConditionCollection(r.id, r.conditions, 'condition');
    validateConditionGroups(r.id, r.condition_groups, 'condition');
  }

  if (Array.isArray(obj.output_rules)) {
    for (const outputRule of obj.output_rules) {
      if (!outputRule || typeof outputRule !== 'object') {
        throw new CompileError('Invalid output rule in LLM output');
      }
      const r = outputRule as Record<string, unknown>;
      if (typeof r.id !== 'string' || !r.id) {
        throw new CompileError('Output rule missing "id" field');
      }
      if (typeof r.name !== 'string' || !r.name) {
        throw new CompileError(`Output rule "${r.id}" missing "name" field`);
      }
      if (typeof r.action !== 'string' || !VALID_OUTPUT_ACTIONS.has(r.action)) {
        throw new CompileError(`Output rule "${r.id}" has invalid output action: ${r.action}`);
      }
      if (r.severity && !VALID_SEVERITIES.has(r.severity as string)) {
        throw new CompileError(`Output rule "${r.id}" has invalid severity: ${r.severity}`);
      }
      validateConditionCollection(r.id, r.output_conditions, 'output condition');
      validateConditionGroups(r.id, r.output_condition_groups, 'output condition');
    }
  }

  return {
    rules: obj.rules as CompiledRule[],
    output_rules: Array.isArray(obj.output_rules)
      ? obj.output_rules as CompiledOutputRule[]
      : undefined,
    notes: typeof obj.notes === 'string' ? obj.notes : '',
  };
}

function toYaml(output: LLMOutput, policyText: string): string {
  const ruleSet = {
    version: '1.0',
    name: 'compiled-rules',
    description: `Compiled from: ${policyText.slice(0, 100)}${policyText.length > 100 ? '...' : ''}`,
    rules: output.rules,
    ...(output.output_rules ? { output_rules: output.output_rules } : {}),
  };
  return stringify(ruleSet, { lineWidth: 120 });
}

function log(message: string, quiet: boolean): void {
  if (!quiet) {
    console.log(message);
  }
}

function shouldUseLegacyProvider(options: CompileOptions): boolean {
  return options.provider !== undefined || detectProvider() !== null;
}

function resolveCompileOutputPath(options: CompileOptions): string {
  const outputPath = resolve(options.output);
  const outputDir = dirname(outputPath);

  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  if (extname(outputPath) === '.yaml' || extname(outputPath) === '.yml') {
    return outputPath;
  }

  if (!existsSync(outputPath)) {
    mkdirSync(outputPath, { recursive: true });
  }

  const name = options.file
    ? basename(options.file, extname(options.file))
    : 'compiled';
  return resolve(outputPath, `${name}.yaml`);
}

function countGeneratedRules(yaml: string): { inputRules: number; outputRules: number } {
  const parsed = parseYaml(yaml) as { rules?: unknown; output_rules?: unknown } | null;
  return {
    inputRules: Array.isArray(parsed?.rules) ? parsed.rules.length : 0,
    outputRules: Array.isArray(parsed?.output_rules) ? parsed.output_rules.length : 0,
  };
}

async function compileWithSharedGeneration(
  policyText: string,
  options: CompileOptions,
  result: CompileResult,
  quiet: boolean
): Promise<CompileResult> {
  log('Generating policy YAML from prose...', quiet);

  try {
    const projectDir = process.cwd();
    const context = await createReplSessionContext(projectDir);
    const generated = await generatePolicyFromPrompt({
      prompt: policyText,
      projectDir,
      rulesDirectory: context.rulesDir,
      tools: context.discoveredTools,
      existingRules: context.allRules,
      allowTemplateFallback: true,
      modeHint: 'deterministic',
    });

    validateGeneratedYaml(generated.yaml);

    const finalPath = resolveCompileOutputPath(options);
    writeFileSync(finalPath, generated.yaml, 'utf-8');

    result.yaml = generated.yaml;
    result.outputPath = finalPath;
    result.success = true;

    const counts = countGeneratedRules(generated.yaml);
    const generatedSummary = counts.outputRules > 0
      ? `  Generated ${counts.inputRules} input rule(s), ${counts.outputRules} output rule(s)`
      : `  Generated ${counts.inputRules} rule(s)`;
    log(generatedSummary, quiet);
    log(`  Output: ${finalPath}`, quiet);

    if (generated.notes) {
      log('', quiet);
      log('  Notes from generator:', quiet);
      log(`  ${generated.notes}`, quiet);
      result.messages.push(generated.notes);
    }

    for (const warning of generated.warnings) {
      log(`  Warning: ${warning}`, quiet);
      result.messages.push(warning);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.messages.push(`Policy generation failed: ${msg}`);
    log(`Error: Policy generation failed: ${msg}`, quiet);
  }

  return result;
}

export async function compile(options: CompileOptions): Promise<CompileResult> {
  const { quiet = false } = options;
  const result: CompileResult = {
    success: false,
    messages: [],
  };

  let policyText: string;
  if (options.input) {
    policyText = options.input;
  } else if (options.file) {
    const filePath = resolve(options.file);
    if (!existsSync(filePath)) {
      result.messages.push(`File not found: ${filePath}`);
      log(`Error: File not found: ${filePath}`, quiet);
      return result;
    }
    policyText = readFileSync(filePath, 'utf-8').trim();
  } else {
    result.messages.push('Provide --input or --file');
    log('Error: Provide --input or --file', quiet);
    return result;
  }

  if (!policyText) {
    result.messages.push('Policy text is empty');
    log('Error: Policy text is empty', quiet);
    return result;
  }

  if (!shouldUseLegacyProvider(options)) {
    return await compileWithSharedGeneration(policyText, options, result, quiet);
  }

  log('Compiling policy to deterministic rules...', quiet);

  let providerConfig: CompileProviderConfig;
  try {
    providerConfig = resolveProvider(options);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.messages.push(msg);
    log(`Error: ${msg}`, quiet);
    return result;
  }

  log(`  Provider: ${providerConfig.provider} (${providerConfig.model})`, quiet);

  let rawResponse: string;
  try {
    rawResponse = await callLLM(providerConfig, policyText);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.messages.push(`LLM call failed: ${msg}`);
    log(`Error: LLM call failed: ${msg}`, quiet);
    return result;
  }

  let output: LLMOutput;
  try {
    output = parseAndValidateLLMOutput(rawResponse);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.messages.push(`Invalid LLM output: ${msg}`);
    log(`Error: Invalid LLM output: ${msg}`, quiet);
    return result;
  }

  const yaml = toYaml(output, policyText);

  try {
    validateGeneratedYaml(yaml);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.messages.push(`Invalid compiled YAML: ${msg}`);
    log(`Error: Invalid compiled YAML: ${msg}`, quiet);
    return result;
  }

  result.yaml = yaml;

  const finalPath = resolveCompileOutputPath(options);

  writeFileSync(finalPath, yaml, 'utf-8');
  result.outputPath = finalPath;
  result.success = true;

  const outputRuleCount = output.output_rules?.length ?? 0;
  const generatedSummary = outputRuleCount > 0
    ? `  Generated ${output.rules.length} input rule(s), ${outputRuleCount} output rule(s)`
    : `  Generated ${output.rules.length} rule(s)`;
  log(generatedSummary, quiet);
  log(`  Output: ${finalPath}`, quiet);

  if (output.notes) {
    log('', quiet);
    log('  Notes from compiler:', quiet);
    log(`  ${output.notes}`, quiet);
    result.messages.push(output.notes);
  }

  return result;
}

export { COMPILE_SYSTEM_PROMPT, buildUserPrompt, parseAndValidateLLMOutput, toYaml };
