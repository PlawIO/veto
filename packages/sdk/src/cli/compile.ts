import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, basename, extname } from 'node:path';
import { stringify } from 'yaml';
import type { CustomProvider } from '../custom/types.js';
import {
  PROVIDER_ENV_VARS,
  PROVIDER_BASE_URLS,
  CustomError,
} from '../custom/types.js';

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

Your task: convert a natural language policy description into deterministic YAML constraint rules.

The output MUST be a valid JSON object with two fields:
- "rules": an array of rule objects (the compiled rules)
- "notes": a string with any caveats or suggestions (empty string if none)

Each rule object MUST have these fields:
- "id": kebab-case unique identifier (e.g. "block-external-emails")
- "name": short human-readable name
- "description": what the rule does
- "enabled": true
- "severity": one of "critical", "high", "medium", "low", "info"
- "action": one of "block", "warn", "log", "allow"
- "tools": array of tool name strings this applies to (use general names like "send_email", "transfer_funds", "read_file", "write_file", "execute_command", etc.)
- "conditions": array of condition objects, each with:
  - "field": dot-notation path (e.g. "arguments.to", "arguments.amount")
  - "operator": one of "equals", "not_equals", "contains", "not_contains", "starts_with", "ends_with", "matches", "greater_than", "less_than", "in", "not_in"
  - "value": the value to compare against

Common patterns:
- Domain restrictions: use "matches" operator with regex (e.g. "^[^@]+@company\\.com$")
- Amount limits: use "greater_than" or "less_than" with numeric values
- Field requirements: use "equals" with expected values
- Enum allowlists: use "in" with an array of allowed values
- Path restrictions: use "starts_with" or "matches" with path patterns

If the policy CANNOT be fully expressed as deterministic rules, include an explanation in the "notes" field describing what aspects require LLM-based evaluation.

Respond with ONLY a JSON object. No markdown, no explanation outside the JSON.`;

function buildUserPrompt(policyText: string): string {
  return `Convert this natural language policy into deterministic YAML rules:\n\n${policyText}`;
}

function resolveProvider(options: CompileOptions): CompileProviderConfig {
  const provider = options.provider ?? detectProvider();
  if (!provider) {
    throw new CompileError(
      'No LLM provider configured. Set --provider or one of: OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY'
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
    case 'openai': return 'gpt-4o';
    case 'anthropic': return 'claude-sonnet-4-5-20250929';
    case 'gemini': return 'gemini-2.0-flash';
    case 'openrouter': return 'openai/gpt-4o';
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
      const Anthropic = (await import('@anthropic-ai/sdk')).default;
      const client = new Anthropic({ apiKey: config.apiKey });
      const response = await client.messages.create({
        model: config.model,
        system: COMPILE_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
        temperature: 0.1,
        max_tokens: 4096,
      });
      const block = response.content[0];
      if (!block || block.type !== 'text') {
        throw new CompileError('Unexpected response from Anthropic');
      }
      return block.text;
    }

    case 'gemini': {
      const { GoogleGenAI } = await import('@google/genai');
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

interface LLMOutput {
  rules: CompiledRule[];
  notes: string;
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

  const VALID_OPERATORS = new Set([
    'equals', 'not_equals', 'contains', 'not_contains',
    'starts_with', 'ends_with', 'matches',
    'greater_than', 'less_than', 'in', 'not_in',
  ]);
  const VALID_ACTIONS = new Set(['block', 'warn', 'log', 'allow', 'require_approval']);
  const VALID_SEVERITIES = new Set(['critical', 'high', 'medium', 'low', 'info']);

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
    if (Array.isArray(r.conditions)) {
      for (const cond of r.conditions) {
        if (!cond || typeof cond !== 'object') {
          throw new CompileError(`Rule "${r.id}" has invalid condition`);
        }
        const c = cond as Record<string, unknown>;
        if (typeof c.operator !== 'string' || !VALID_OPERATORS.has(c.operator)) {
          throw new CompileError(`Rule "${r.id}" has invalid operator: ${c.operator}`);
        }
      }
    }
  }

  return {
    rules: obj.rules as CompiledRule[],
    notes: typeof obj.notes === 'string' ? obj.notes : '',
  };
}

function toYaml(output: LLMOutput, policyText: string): string {
  const ruleSet = {
    version: '1.0',
    name: 'compiled-rules',
    description: `Compiled from: ${policyText.slice(0, 100)}${policyText.length > 100 ? '...' : ''}`,
    rules: output.rules,
  };
  return stringify(ruleSet, { lineWidth: 120 });
}

function log(message: string, quiet: boolean): void {
  if (!quiet) {
    console.log(message);
  }
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
  result.yaml = yaml;

  const outputPath = resolve(options.output);
  const outputDir = dirname(outputPath);

  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  let finalPath: string;
  if (extname(outputPath) === '.yaml' || extname(outputPath) === '.yml') {
    finalPath = outputPath;
  } else {
    if (!existsSync(outputPath)) {
      mkdirSync(outputPath, { recursive: true });
    }
    const name = options.file
      ? basename(options.file, extname(options.file))
      : 'compiled';
    finalPath = resolve(outputPath, `${name}.yaml`);
  }

  writeFileSync(finalPath, yaml, 'utf-8');
  result.outputPath = finalPath;
  result.success = true;

  log(`  Generated ${output.rules.length} rule(s)`, quiet);
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
