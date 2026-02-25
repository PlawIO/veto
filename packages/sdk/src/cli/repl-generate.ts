import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseYaml, stringify } from 'yaml';
import type { Rule } from '../rules/types.js';
import type { DiscoveredTool } from './scan.js';
import { POLICY_IR_V1_SCHEMA } from '../rules/policy-ir-schema.js';
import { validatePolicyIR } from '../rules/schema-validator.js';

interface ReplConfigFile {
  validation?: {
    mode?: 'local' | 'cloud' | 'kernel' | 'custom' | 'api';
  };
  llm?: {
    baseUrl?: string;
    model?: string;
    apiKey?: string;
  };
  kernel?: {
    baseUrl?: string;
    model?: string;
    temperature?: number;
    maxTokens?: number;
    timeout?: number;
  };
}

export interface GeneratePolicyRequest {
  prompt: string;
  schema: Record<string, unknown>;
  tools: DiscoveredTool[];
  existingRules: Rule[];
  projectContext?: {
    cwd: string;
    rulesDirectory?: string;
  };
  model?: string;
}

export interface GeneratePolicyResponse {
  yaml: string;
  rules?: Rule[];
  notes?: string;
  explanation?: string;
}

export interface ExplainPolicyRequest {
  rule: Rule;
  tools?: DiscoveredTool[];
  model?: string;
}

export interface ExplainPolicyResponse {
  explanation: string;
}

export type GenerationMode = 'cloud' | 'self-hosted' | 'kernel' | 'template';
export type ReplIntent = 'generate' | 'simulate' | 'explain' | 'test_suite';

export interface ReplIntentResult {
  mode: GenerationMode;
  intent: ReplIntent;
  prompt?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  ruleId?: string;
  warnings: string[];
}

export interface GeneratePolicyResult {
  mode: GenerationMode;
  yaml: string;
  notes?: string;
  explanation?: string;
  warnings: string[];
}

export interface ExplainPolicyResult {
  mode: GenerationMode;
  explanation: string;
  warnings: string[];
}

type EndpointMode = Exclude<GenerationMode, 'template'>;

interface EndpointConfig {
  mode: EndpointMode;
  baseUrl: string;
  apiKey?: string;
  model: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
}

interface OpenAICompletionChoice {
  message?: {
    content?: string | null;
  };
}

interface OpenAICompletionResponse {
  choices?: OpenAICompletionChoice[];
}

const DEFAULT_CLOUD_BASE_URL = 'https://api.runveto.com';
const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_SELF_HOSTED_MODEL = 'gpt-4o';
const DEFAULT_KERNEL_BASE_URL = 'http://localhost:11434/v1';
const DEFAULT_KERNEL_MODEL = 'hf.co/ycaleb/veto-warden-4b-GGUF:Q4_K_M';
const DEFAULT_TEMPERATURE = 0.1;
const DEFAULT_MAX_TOKENS = 2048;

const KERNEL_GENERATE_SYSTEM_PROMPT = `
You are Veto REPL, a policy-authoring assistant.

Return ONLY JSON with this shape:
{
  "yaml": string,
  "notes": string,
  "explanation": string
}

Rules:
- The "yaml" must be a valid Veto policy document with version "1.0" and a "rules" array.
- Use discovered tool names exactly when possible.
- Keep rules deterministic and concise.
- Never return markdown code fences.

Few-shot examples:
Input: "block emails to external domains"
Output YAML rule concept:
- tool: send_email
- action: block
- condition: arguments.to not_contains "@company.com"

Input: "require approval for transfers above $25k"
Output YAML rule concept:
- tool: transfer_funds
- action: require_approval
- condition: arguments.amount greater_than 25000
`;

const KERNEL_EXPLAIN_SYSTEM_PROMPT = `
You explain one Veto rule in plain language.
Return ONLY JSON: {"explanation": string}.
Include what triggers it and one concise example call.
`;

const KERNEL_INTERPRET_SYSTEM_PROMPT = `
You classify REPL user input into one intent.
Return ONLY JSON:
{
  "intent": "generate" | "simulate" | "explain" | "test_suite",
  "prompt": string,
  "toolName": string,
  "args": object,
  "ruleId": string
}

Use:
- "simulate" for questions like "what would happen if..."
- "explain" for requests to explain a rule
- "test_suite" for requests to test current rules broadly
- "generate" for policy-authoring requests

Fields can be omitted if not applicable.
`;

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/$/, '');
}

function parseConfig(projectDir: string): ReplConfigFile {
  const configPath = join(projectDir, 'veto', 'veto.config.yaml');
  if (!existsSync(configPath)) {
    return {};
  }

  try {
    const parsed = parseYaml(readFileSync(configPath, 'utf-8')) as ReplConfigFile | null;
    return parsed ?? {};
  } catch {
    return {};
  }
}

function resolveKernelEndpoint(config: ReplConfigFile): EndpointConfig {
  const kernelBlock = config.kernel ?? {};

  return {
    mode: 'kernel',
    baseUrl: normalizeBaseUrl(kernelBlock.baseUrl ?? DEFAULT_KERNEL_BASE_URL),
    model: kernelBlock.model ?? DEFAULT_KERNEL_MODEL,
    temperature: kernelBlock.temperature ?? DEFAULT_TEMPERATURE,
    maxTokens: kernelBlock.maxTokens ?? DEFAULT_MAX_TOKENS,
    timeoutMs: kernelBlock.timeout ?? DEFAULT_TIMEOUT_MS,
  };
}

export function resolveEndpointConfig(projectDir = process.cwd()): EndpointConfig | null {
  const cloudApiKey = process.env.VETO_API_KEY?.trim();
  if (cloudApiKey) {
    return {
      mode: 'cloud',
      baseUrl: normalizeBaseUrl(process.env.VETO_API_URL?.trim() || DEFAULT_CLOUD_BASE_URL),
      apiKey: cloudApiKey,
      model: DEFAULT_SELF_HOSTED_MODEL,
      temperature: DEFAULT_TEMPERATURE,
      maxTokens: DEFAULT_MAX_TOKENS,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    };
  }

  const config = parseConfig(resolve(projectDir));
  const llmBaseUrl = config.llm?.baseUrl?.trim();

  if (llmBaseUrl) {
    return {
      mode: 'self-hosted',
      baseUrl: normalizeBaseUrl(llmBaseUrl),
      apiKey: config.llm?.apiKey?.trim(),
      model: config.llm?.model?.trim() || DEFAULT_SELF_HOSTED_MODEL,
      temperature: DEFAULT_TEMPERATURE,
      maxTokens: DEFAULT_MAX_TOKENS,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    };
  }

  const validationMode = config.validation?.mode;
  if (validationMode === 'kernel' || config.kernel?.model || config.kernel?.baseUrl) {
    return resolveKernelEndpoint(config);
  }

  return null;
}

function createHeaders(config: EndpointConfig): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (config.mode === 'cloud' && config.apiKey) {
    headers['X-Veto-API-Key'] = config.apiKey;
  }

  if (config.mode === 'self-hosted' && config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }

  return headers;
}

async function postJson<TResponse>(
  url: string,
  body: Record<string, unknown>,
  headers: Record<string, string>,
  timeoutMs: number
): Promise<TResponse> {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: abortController.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      throw new Error(`Request failed (${response.status}): ${errorBody}`);
    }

    return await response.json() as TResponse;
  } finally {
    clearTimeout(timeout);
  }
}

function extractJsonObject(raw: string): Record<string, unknown> {
  const firstBrace = raw.indexOf('{');
  if (firstBrace === -1) {
    throw new Error('No JSON object found in LLM response');
  }

  let depth = 0;
  for (let i = firstBrace; i < raw.length; i++) {
    if (raw[i] === '{') depth += 1;
    if (raw[i] === '}') depth -= 1;

    if (depth === 0) {
      const candidate = raw.slice(firstBrace, i + 1);
      return JSON.parse(candidate) as Record<string, unknown>;
    }
  }

  throw new Error('Malformed JSON object in LLM response');
}

async function callOpenAICompatible(
  endpoint: EndpointConfig,
  systemPrompt: string,
  userPrompt: string
): Promise<string> {
  const payload = {
    model: endpoint.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: endpoint.temperature,
    max_tokens: endpoint.maxTokens,
  };

  const response = await postJson<OpenAICompletionResponse>(
    `${endpoint.baseUrl}/chat/completions`,
    payload,
    createHeaders(endpoint),
    endpoint.timeoutMs
  );

  const content = response.choices?.[0]?.message?.content;
  if (!content || content.trim() === '') {
    throw new Error('No content returned from LLM completion');
  }

  return content;
}

function stringifyToolsForPrompt(tools: readonly DiscoveredTool[]): string {
  if (tools.length === 0) {
    return '[]';
  }

  return JSON.stringify(
    tools.map((tool) => ({
      name: tool.name,
      parameters: tool.parameters,
    })),
    null,
    2
  );
}

function stringifyRulesForPrompt(rules: readonly Rule[]): string {
  if (rules.length === 0) {
    return '[]';
  }

  return JSON.stringify(
    rules.map((rule) => ({
      id: rule.id,
      action: rule.action,
      tools: rule.tools ?? [],
      conditions: rule.conditions ?? [],
      condition_groups: rule.condition_groups ?? [],
      description: rule.description,
    })),
    null,
    2
  );
}

function buildKernelGenerateUserPrompt(options: {
  prompt: string;
  tools: DiscoveredTool[];
  existingRules: Rule[];
}): string {
  return [
    `User request: ${options.prompt}`,
    '',
    'Discovered tools:',
    stringifyToolsForPrompt(options.tools),
    '',
    'Existing rules:',
    stringifyRulesForPrompt(options.existingRules),
    '',
    'Policy schema:',
    JSON.stringify(POLICY_IR_V1_SCHEMA, null, 2),
  ].join('\n');
}

function buildKernelExplainUserPrompt(options: { rule: Rule; tools: DiscoveredTool[] }): string {
  return [
    'Rule:',
    JSON.stringify(options.rule, null, 2),
    '',
    'Discovered tools:',
    stringifyToolsForPrompt(options.tools),
  ].join('\n');
}

function buildKernelInterpretUserPrompt(options: {
  input: string;
  tools: DiscoveredTool[];
  existingRules: Rule[];
}): string {
  return [
    `Input: ${options.input}`,
    '',
    'Known tools:',
    stringifyToolsForPrompt(options.tools),
    '',
    'Known rules:',
    stringifyRulesForPrompt(options.existingRules),
  ].join('\n');
}

function pickRuleIdFromInput(input: string, existingRules: readonly Rule[]): string | undefined {
  const normalized = input.toLowerCase();

  const direct = existingRules.find((rule) => normalized.includes(rule.id.toLowerCase()));
  if (direct) {
    return direct.id;
  }

  const regexMatch = input.match(/rule\s+([A-Za-z0-9_.:-]+)/i);
  if (regexMatch?.[1]) {
    return regexMatch[1];
  }

  return undefined;
}

function toSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

function extractNumericAmount(prompt: string): number | null {
  const normalized = prompt.toLowerCase();
  const match = normalized.match(/(?:\$\s*)?(\d[\d,]*(?:\.\d+)?)(\s*[km])?/i);

  if (!match) {
    return null;
  }

  let value = Number(match[1].replace(/,/g, ''));
  if (!Number.isFinite(value)) {
    return null;
  }

  const suffix = match[2]?.trim().toLowerCase();
  if (suffix === 'k') {
    value *= 1_000;
  } else if (suffix === 'm') {
    value *= 1_000_000;
  }

  return value;
}

function detectAction(prompt: string): Rule['action'] {
  const normalized = prompt.toLowerCase();

  if (/require\s+approval|needs?\s+approval|ask\s+for\s+approval|approve/.test(normalized)) {
    return 'require_approval';
  }

  if (/warn|alert/.test(normalized)) {
    return 'warn';
  }

  if (/\blog\b/.test(normalized)) {
    return 'log';
  }

  if (/\ballow\b|permit/.test(normalized)) {
    return 'allow';
  }

  if (/block|deny|forbid|prevent|disallow|stop/.test(normalized)) {
    return 'block';
  }

  return 'require_approval';
}

function detectThreshold(prompt: string): { operator: 'greater_than' | 'less_than'; value: number } | null {
  const normalized = prompt.toLowerCase();
  const amount = extractNumericAmount(normalized);

  if (amount === null) {
    return null;
  }

  const operator: 'greater_than' | 'less_than' = /under|below|less than|max(?:imum)?/.test(normalized)
    ? 'less_than'
    : 'greater_than';

  return {
    operator,
    value: amount,
  };
}

function findMatchingToolNames(prompt: string, tools: readonly DiscoveredTool[]): string[] {
  const normalized = prompt.toLowerCase();
  const matches = new Set<string>();

  for (const tool of tools) {
    const name = tool.name.toLowerCase();
    if (normalized.includes(name)) {
      matches.add(tool.name);
      continue;
    }

    const tokenized = name.split(/[_\-:.]/).filter(Boolean);
    if (tokenized.length > 1 && tokenized.every((token) => normalized.includes(token))) {
      matches.add(tool.name);
    }
  }

  if (matches.size > 0) {
    return [...matches];
  }

  if (/transfer|payment|wire|fund/.test(normalized)) {
    const financialTool = tools.find((tool) => /transfer|payment|wire|fund/.test(tool.name));
    if (financialTool) {
      return [financialTool.name];
    }
  }

  if (/email|message|notify/.test(normalized)) {
    const commTool = tools.find((tool) => /email|message|notify/.test(tool.name));
    if (commTool) {
      return [commTool.name];
    }
  }

  return [];
}

function buildTemplateRules(prompt: string, tools: readonly DiscoveredTool[], existingRules: readonly Rule[]): Rule[] {
  const action = detectAction(prompt);
  const threshold = detectThreshold(prompt);
  const toolNames = findMatchingToolNames(prompt, tools);
  const fallbackTool = tools[0]?.name ?? 'tool_call';
  const selectedTools = toolNames.length > 0 ? toolNames : [fallbackTool];

  const existingIds = new Set(existingRules.map((rule) => rule.id));
  const generatedRules: Rule[] = [];

  for (const toolName of selectedTools) {
    const slug = toSlug(`${toolName}-${action}`);
    let ruleId = `${slug}${threshold ? `-${threshold.value}` : ''}`;
    let attempt = 1;
    while (existingIds.has(ruleId)) {
      ruleId = `${slug}-${attempt}`;
      attempt += 1;
    }
    existingIds.add(ruleId);

    const conditions = threshold
      ? [
          {
            field: 'arguments.amount',
            operator: threshold.operator,
            value: threshold.value,
          },
        ]
      : undefined;

    generatedRules.push({
      id: ruleId,
      name: `${action.replace('_', ' ')} ${toolName}`,
      description: `Generated from prompt: ${prompt}`,
      enabled: true,
      severity: action === 'block' ? 'high' : 'medium',
      action,
      tools: [toolName],
      conditions,
    });
  }

  return generatedRules;
}

function toPolicyYaml(rules: readonly Rule[], prompt: string): string {
  return stringify(
    {
      version: '1.0',
      name: 'repl-generated',
      description: `Generated from REPL prompt: ${prompt}`,
      rules,
    },
    { lineWidth: 120 }
  );
}

function coerceGenerateResponse(raw: unknown): GeneratePolicyResponse {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid generate response payload');
  }

  const response = raw as Record<string, unknown>;
  if (typeof response.yaml === 'string' && response.yaml.trim().length > 0) {
    return {
      yaml: response.yaml,
      rules: Array.isArray(response.rules) ? response.rules as Rule[] : undefined,
      notes: typeof response.notes === 'string' ? response.notes : undefined,
      explanation: typeof response.explanation === 'string' ? response.explanation : undefined,
    };
  }

  if (Array.isArray(response.rules)) {
    const yaml = toPolicyYaml(response.rules as Rule[], 'generated by endpoint');
    return {
      yaml,
      rules: response.rules as Rule[],
      notes: typeof response.notes === 'string' ? response.notes : undefined,
      explanation: typeof response.explanation === 'string' ? response.explanation : undefined,
    };
  }

  throw new Error('Generate response missing "yaml" field');
}

function coerceExplainResponse(raw: unknown): ExplainPolicyResponse {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid explain response payload');
  }

  const response = raw as Record<string, unknown>;
  if (typeof response.explanation !== 'string' || response.explanation.trim() === '') {
    throw new Error('Explain response missing "explanation" field');
  }

  return {
    explanation: response.explanation,
  };
}

function coerceIntent(raw: unknown, fallbackPrompt: string): ReplIntentResult {
  const fallback: ReplIntentResult = {
    mode: 'template',
    intent: 'generate',
    prompt: fallbackPrompt,
    warnings: [],
  };

  if (!raw || typeof raw !== 'object') {
    return fallback;
  }

  const data = raw as Record<string, unknown>;
  const rawIntent = typeof data.intent === 'string' ? data.intent : 'generate';
  const intent: ReplIntent = (
    rawIntent === 'simulate'
    || rawIntent === 'explain'
    || rawIntent === 'test_suite'
    || rawIntent === 'generate'
  )
    ? rawIntent
    : 'generate';

  const argsValue = data.args;
  const args = argsValue && typeof argsValue === 'object' && !Array.isArray(argsValue)
    ? argsValue as Record<string, unknown>
    : undefined;

  return {
    mode: 'template',
    intent,
    prompt: typeof data.prompt === 'string' && data.prompt.trim().length > 0
      ? data.prompt
      : fallbackPrompt,
    toolName: typeof data.toolName === 'string' ? data.toolName : undefined,
    ruleId: typeof data.ruleId === 'string' ? data.ruleId : undefined,
    args,
    warnings: [],
  };
}

function inferSimulationCall(
  input: string,
  tools: readonly DiscoveredTool[],
  existingRules: readonly Rule[]
): { toolName?: string; args: Record<string, unknown> } {
  const toolNames = findMatchingToolNames(input, tools);
  const args: Record<string, unknown> = {};

  const amount = extractNumericAmount(input);
  if (amount !== null) {
    args.amount = amount;
  }

  const emailMatch = input.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  if (emailMatch) {
    args.to = emailMatch[0];
  } else if (/external domain|outside company|non-company/i.test(input)) {
    args.to = 'user@gmail.com';
  }

  const pathMatch = input.match(/(\/[A-Za-z0-9_./-]+)/);
  if (pathMatch?.[1]) {
    args.path = pathMatch[1];
  }

  const quotedCommand = input.match(/command\s+['"]([^'"]+)['"]/i) ?? input.match(/['"]([^'"]+)['"]/);
  if (quotedCommand?.[1] && /command|shell|bash|exec/i.test(input)) {
    args.command = quotedCommand[1];
  }

  if (/production|prod/i.test(input)) {
    args.environment = 'production';
  }

  if (toolNames.length > 0) {
    return {
      toolName: toolNames[0],
      args,
    };
  }

  for (const rule of existingRules) {
    if (rule.tools && rule.tools.length > 0) {
      return {
        toolName: rule.tools[0],
        args,
      };
    }
  }

  if (tools[0]?.name) {
    return {
      toolName: tools[0].name,
      args,
    };
  }

  return { args };
}

function interpretIntentHeuristically(
  input: string,
  tools: readonly DiscoveredTool[],
  existingRules: readonly Rule[]
): ReplIntentResult {
  const normalized = input.toLowerCase();

  if (/test my agent|test current rules|test the rules|run .*scenario|scenario suite/.test(normalized)) {
    return {
      mode: 'template',
      intent: 'test_suite',
      prompt: input,
      warnings: [],
    };
  }

  if (/^explain\b|\bexplain the\b|\bexplain rule\b|\bwhat does .* rule\b/.test(normalized)) {
    return {
      mode: 'template',
      intent: 'explain',
      ruleId: pickRuleIdFromInput(input, existingRules),
      prompt: input,
      warnings: [],
    };
  }

  if (/what would happen|would .* be (blocked|allowed|denied)|if my agent|simulate|dry run|try to/.test(normalized)) {
    const simulated = inferSimulationCall(input, tools, existingRules);
    return {
      mode: 'template',
      intent: 'simulate',
      toolName: simulated.toolName,
      args: simulated.args,
      prompt: input,
      warnings: [],
    };
  }

  return {
    mode: 'template',
    intent: 'generate',
    prompt: input,
    warnings: [],
  };
}

function shouldAttemptRemoteIntentParsing(input: string, heuristic: ReplIntentResult): boolean {
  if (heuristic.intent !== 'generate') {
    return false;
  }

  const normalized = input.toLowerCase();
  return /\?|what|would|happen|if|should|explain|why|test|suite|scenario/.test(normalized);
}

async function generateViaKernel(options: {
  endpoint: EndpointConfig;
  prompt: string;
  tools: DiscoveredTool[];
  existingRules: Rule[];
}): Promise<GeneratePolicyResult> {
  const raw = await callOpenAICompatible(
    options.endpoint,
    KERNEL_GENERATE_SYSTEM_PROMPT,
    buildKernelGenerateUserPrompt(options)
  );

  const parsed = extractJsonObject(raw);
  const normalized = coerceGenerateResponse(parsed);
  validateGeneratedYaml(normalized.yaml);

  return {
    mode: 'kernel',
    yaml: normalized.yaml,
    notes: normalized.notes,
    explanation: normalized.explanation,
    warnings: [],
  };
}

async function explainViaKernel(options: {
  endpoint: EndpointConfig;
  rule: Rule;
  tools: DiscoveredTool[];
}): Promise<ExplainPolicyResult> {
  const raw = await callOpenAICompatible(
    options.endpoint,
    KERNEL_EXPLAIN_SYSTEM_PROMPT,
    buildKernelExplainUserPrompt(options)
  );

  const parsed = extractJsonObject(raw);
  const normalized = coerceExplainResponse(parsed);

  return {
    mode: 'kernel',
    explanation: normalized.explanation,
    warnings: [],
  };
}

async function interpretViaKernel(options: {
  endpoint: EndpointConfig;
  input: string;
  tools: DiscoveredTool[];
  existingRules: Rule[];
}): Promise<ReplIntentResult> {
  const raw = await callOpenAICompatible(
    options.endpoint,
    KERNEL_INTERPRET_SYSTEM_PROMPT,
    buildKernelInterpretUserPrompt(options)
  );

  const parsed = extractJsonObject(raw);
  return {
    ...coerceIntent(parsed, options.input),
    mode: 'kernel',
  };
}

export function validateGeneratedYaml(yaml: string): Record<string, unknown> {
  const parsed = parseYaml(yaml) as Record<string, unknown> | null;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Generated YAML is not a valid policy document object');
  }

  validatePolicyIR(parsed);
  return parsed;
}

export function buildTemplateExplanation(rule: Rule): string {
  const action = rule.action.replace(/_/g, ' ');
  const tools = rule.tools && rule.tools.length > 0
    ? rule.tools.join(', ')
    : 'all tools';

  if (!rule.conditions || rule.conditions.length === 0) {
    return `${action} calls to ${tools}.`;
  }

  const firstCondition = rule.conditions[0];
  if (firstCondition.field && firstCondition.operator) {
    return `${action} calls to ${tools} when ${firstCondition.field} ${firstCondition.operator} ${JSON.stringify(firstCondition.value)}.`;
  }

  return `${action} calls to ${tools} when configured conditions match.`;
}

export function generateTemplatePolicy(
  prompt: string,
  tools: readonly DiscoveredTool[],
  existingRules: readonly Rule[]
): GeneratePolicyResult {
  const rules = buildTemplateRules(prompt, tools, existingRules);
  const yaml = toPolicyYaml(rules, prompt);
  validateGeneratedYaml(yaml);

  return {
    mode: 'template',
    yaml,
    warnings: [
      'No API key or kernel config configured. Using template fallback generation.',
      'Set VETO_API_KEY or enable kernel mode in veto.config.yaml for LLM generation.',
    ],
  };
}

export async function interpretNaturalLanguageIntent(options: {
  input: string;
  projectDir?: string;
  tools: DiscoveredTool[];
  existingRules: Rule[];
}): Promise<ReplIntentResult> {
  const projectDir = resolve(options.projectDir ?? process.cwd());
  const endpoint = resolveEndpointConfig(projectDir);

  const heuristic = interpretIntentHeuristically(options.input, options.tools, options.existingRules);
  if (!endpoint || !shouldAttemptRemoteIntentParsing(options.input, heuristic)) {
    return heuristic;
  }

  if (endpoint.mode === 'kernel') {
    try {
      return await interpretViaKernel({
        endpoint,
        input: options.input,
        tools: options.tools,
        existingRules: options.existingRules,
      });
    } catch (error) {
      return {
        ...heuristic,
        warnings: [
          `Kernel intent parsing failed, using heuristic fallback: ${error instanceof Error ? error.message : String(error)}`,
        ],
      };
    }
  }

  try {
    const response = await postJson<ReplIntentResult>(
      `${endpoint.baseUrl}/v1/repl/interpret`,
      {
        input: options.input,
        tools: options.tools,
        existingRules: options.existingRules,
      },
      createHeaders(endpoint),
      endpoint.timeoutMs
    );

    const normalized = coerceIntent(response, options.input);
    return {
      ...normalized,
      mode: endpoint.mode,
    };
  } catch (error) {
    return {
      ...heuristic,
      warnings: [
        `Intent endpoint failed, using heuristic fallback: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
}

export async function generatePolicyFromPrompt(options: {
  prompt: string;
  projectDir?: string;
  rulesDirectory?: string;
  tools: DiscoveredTool[];
  existingRules: Rule[];
}): Promise<GeneratePolicyResult> {
  const projectDir = resolve(options.projectDir ?? process.cwd());
  const endpoint = resolveEndpointConfig(projectDir);

  if (!endpoint) {
    return generateTemplatePolicy(options.prompt, options.tools, options.existingRules);
  }

  if (endpoint.mode === 'kernel') {
    try {
      return await generateViaKernel({
        endpoint,
        prompt: options.prompt,
        tools: options.tools,
        existingRules: options.existingRules,
      });
    } catch (error) {
      const fallback = generateTemplatePolicy(options.prompt, options.tools, options.existingRules);
      return {
        ...fallback,
        warnings: [
          `Kernel generation failed, using template fallback: ${error instanceof Error ? error.message : String(error)}`,
          ...fallback.warnings,
        ],
      };
    }
  }

  const request: GeneratePolicyRequest = {
    prompt: options.prompt,
    schema: POLICY_IR_V1_SCHEMA as Record<string, unknown>,
    tools: options.tools,
    existingRules: options.existingRules,
    projectContext: {
      cwd: projectDir,
      rulesDirectory: options.rulesDirectory,
    },
    model: endpoint.model,
  };

  try {
    const response = await postJson<GeneratePolicyResponse>(
      `${endpoint.baseUrl}/v1/repl/generate`,
      request as unknown as Record<string, unknown>,
      createHeaders(endpoint),
      endpoint.timeoutMs
    );

    const normalized = coerceGenerateResponse(response);
    validateGeneratedYaml(normalized.yaml);

    return {
      mode: endpoint.mode,
      yaml: normalized.yaml,
      notes: normalized.notes,
      explanation: normalized.explanation,
      warnings: [],
    };
  } catch (error) {
    const fallback = generateTemplatePolicy(options.prompt, options.tools, options.existingRules);
    return {
      ...fallback,
      warnings: [
        `Generation endpoint failed, falling back to template mode: ${error instanceof Error ? error.message : String(error)}`,
        ...fallback.warnings,
      ],
    };
  }
}

export async function explainRule(options: {
  rule: Rule;
  tools: DiscoveredTool[];
  projectDir?: string;
}): Promise<ExplainPolicyResult> {
  const projectDir = resolve(options.projectDir ?? process.cwd());
  const endpoint = resolveEndpointConfig(projectDir);

  if (!endpoint) {
    return {
      mode: 'template',
      explanation: buildTemplateExplanation(options.rule),
      warnings: [],
    };
  }

  if (endpoint.mode === 'kernel') {
    try {
      return await explainViaKernel({
        endpoint,
        rule: options.rule,
        tools: options.tools,
      });
    } catch (error) {
      return {
        mode: 'template',
        explanation: buildTemplateExplanation(options.rule),
        warnings: [
          `Kernel explain failed, using template explanation: ${error instanceof Error ? error.message : String(error)}`,
        ],
      };
    }
  }

  const payload: ExplainPolicyRequest = {
    rule: options.rule,
    tools: options.tools,
    model: endpoint.model,
  };

  try {
    const response = await postJson<ExplainPolicyResponse>(
      `${endpoint.baseUrl}/v1/repl/explain`,
      payload as unknown as Record<string, unknown>,
      createHeaders(endpoint),
      endpoint.timeoutMs
    );

    const normalized = coerceExplainResponse(response);

    return {
      mode: endpoint.mode,
      explanation: normalized.explanation,
      warnings: [],
    };
  } catch (error) {
    return {
      mode: 'template',
      explanation: buildTemplateExplanation(options.rule),
      warnings: [
        `Explain endpoint failed, using template explanation: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
}
