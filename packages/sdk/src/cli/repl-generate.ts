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
  studio?: {
    generation?: {
      allowTemplateFallback?: boolean;
    };
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

export interface GenerationConnectivityResult {
  connected: boolean;
  mode?: EndpointMode;
  reason?: string;
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

const DEFAULT_CLOUD_BASE_URL = 'https://api.veto.so';
const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_SELF_HOSTED_MODEL = 'gpt-5.4';
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

function resolveAllowTemplateFallback(
  config: ReplConfigFile,
  explicitAllowTemplateFallback: boolean | undefined
): boolean {
  if (explicitAllowTemplateFallback !== undefined) {
    return explicitAllowTemplateFallback;
  }

  if (config.studio?.generation?.allowTemplateFallback !== undefined) {
    return config.studio.generation.allowTemplateFallback;
  }

  return false;
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

export async function checkGenerationConnectivity(options: {
  projectDir?: string;
  timeoutMs?: number;
} = {}): Promise<GenerationConnectivityResult> {
  const projectDir = resolve(options.projectDir ?? process.cwd());
  const endpoint = resolveEndpointConfig(projectDir);

  if (!endpoint) {
    return {
      connected: false,
      reason: 'No generation endpoint configured.',
    };
  }

  const timeoutMs = options.timeoutMs ?? Math.min(endpoint.timeoutMs, 5000);
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), timeoutMs);

  try {
    const response = await fetch(endpoint.baseUrl, {
      method: 'GET',
      headers: createHeaders(endpoint),
      signal: abortController.signal,
    });

    if (response.status >= 500) {
      return {
        connected: false,
        mode: endpoint.mode,
        reason: `Endpoint responded with status ${response.status}.`,
      };
    }

    return {
      connected: true,
      mode: endpoint.mode,
    };
  } catch (error) {
    return {
      connected: false,
      mode: endpoint.mode,
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
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
  const lower = value.toLowerCase();
  let slug = '';
  let previousWasDash = false;

  for (let i = 0; i < lower.length; i++) {
    const code = lower.charCodeAt(i);
    const isLetter = code >= 97 && code <= 122;
    const isDigit = code >= 48 && code <= 57;

    if (isLetter || isDigit) {
      slug += lower[i];
      previousWasDash = false;
      continue;
    }

    if (slug.length > 0 && !previousWasDash) {
      slug += '-';
      previousWasDash = true;
    }
  }

  return slug.endsWith('-') ? slug.slice(0, -1) : slug;
}

function includesAnyPhrase(value: string, phrases: readonly string[]): boolean {
  for (const phrase of phrases) {
    if (value.includes(phrase)) {
      return true;
    }
  }

  return false;
}

function isAsciiLetterOrDigit(code: number): boolean {
  return (code >= 48 && code <= 57)
    || (code >= 65 && code <= 90)
    || (code >= 97 && code <= 122);
}

function isEmailTokenChar(char: string): boolean {
  const code = char.charCodeAt(0);
  return isAsciiLetterOrDigit(code)
    || char === '.'
    || char === '_'
    || char === '%'
    || char === '+'
    || char === '-'
    || char === '@';
}

function isLocalEmailChar(char: string): boolean {
  const code = char.charCodeAt(0);
  return isAsciiLetterOrDigit(code)
    || char === '.'
    || char === '_'
    || char === '%'
    || char === '+'
    || char === '-';
}

function isDomainEmailChar(char: string): boolean {
  const code = char.charCodeAt(0);
  return isAsciiLetterOrDigit(code)
    || char === '.'
    || char === '-';
}

function isLikelyEmailAddress(value: string): boolean {
  const atIndex = value.indexOf('@');
  if (atIndex <= 0 || atIndex !== value.lastIndexOf('@')) {
    return false;
  }

  const local = value.slice(0, atIndex);
  const domain = value.slice(atIndex + 1);

  if (!local || domain.length < 3) {
    return false;
  }

  if (
    domain.startsWith('.')
    || domain.endsWith('.')
    || domain.startsWith('-')
    || domain.endsWith('-')
  ) {
    return false;
  }

  const lastDotIndex = domain.lastIndexOf('.');
  if (lastDotIndex <= 0 || lastDotIndex >= domain.length - 1) {
    return false;
  }

  if (domain.length - lastDotIndex - 1 < 2) {
    return false;
  }

  for (let i = 0; i < local.length; i++) {
    if (!isLocalEmailChar(local[i])) {
      return false;
    }
  }

  for (let i = 0; i < domain.length; i++) {
    if (!isDomainEmailChar(domain[i])) {
      return false;
    }
  }

  return true;
}

function extractEmailFromText(input: string): string | undefined {
  let token = '';

  const flush = (): string | undefined => {
    if (token.length === 0) {
      return undefined;
    }

    const candidate = token;
    token = '';
    return isLikelyEmailAddress(candidate) ? candidate : undefined;
  };

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if (isEmailTokenChar(char)) {
      token += char;
      continue;
    }

    const candidate = flush();
    if (candidate) {
      return candidate;
    }
  }

  return flush();
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

function isAsciiDigit(char: string | undefined): boolean {
  return char !== undefined && char >= '0' && char <= '9';
}

function isWordChar(char: string | undefined): boolean {
  return char !== undefined
    && ((char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || isAsciiDigit(char) || char === '_');
}

function skipWhitespace(input: string, index: number): number {
  let cursor = index;

  while (cursor < input.length) {
    const char = input[cursor];
    if (char !== ' ' && char !== '\t' && char !== '\n' && char !== '\r') {
      break;
    }
    cursor += 1;
  }

  return cursor;
}

function parseNumberAt(
  input: string,
  startIndex: number
): { value: number; nextIndex: number; hadCurrencySymbol: boolean; hadDecimal: boolean } | null {
  let cursor = skipWhitespace(input, startIndex);
  const hadCurrencySymbol = input[cursor] === '$';
  if (hadCurrencySymbol) {
    cursor += 1;
    cursor = skipWhitespace(input, cursor);
  }

  const rawStart = cursor;
  let sawDigit = false;
  let sawDot = false;

  while (cursor < input.length) {
    const char = input[cursor];
    if (isAsciiDigit(char)) {
      sawDigit = true;
      cursor += 1;
      continue;
    }
    if (char === ',') {
      cursor += 1;
      continue;
    }
    if (char === '.' && !sawDot) {
      sawDot = true;
      cursor += 1;
      continue;
    }
    break;
  }

  if (!sawDigit) {
    return null;
  }

  let value = Number(input.slice(rawStart, cursor).replaceAll(',', ''));
  if (!Number.isFinite(value)) {
    return null;
  }

  let nextIndex = cursor;
  const suffixIndex = skipWhitespace(input, cursor);
  const suffix = input[suffixIndex]?.toLowerCase();
  if (suffix === 'k') {
    value *= 1_000;
    nextIndex = suffixIndex + 1;
  } else if (suffix === 'm') {
    value *= 1_000_000;
    nextIndex = suffixIndex + 1;
  }

  return {
    value,
    nextIndex,
    hadCurrencySymbol,
    hadDecimal: sawDot,
  };
}

function findKeyword(
  input: string,
  keywords: readonly string[],
  fromIndex = 0
): { index: number; keyword: string } | null {
  let bestMatch: { index: number; keyword: string } | null = null;

  for (const keyword of keywords) {
    let searchFrom = fromIndex;

    while (searchFrom < input.length) {
      const matchIndex = input.indexOf(keyword, searchFrom);
      if (matchIndex === -1) {
        break;
      }

      const before = matchIndex === 0 ? undefined : input[matchIndex - 1];
      const afterIndex = matchIndex + keyword.length;
      const after = afterIndex >= input.length ? undefined : input[afterIndex];
      if (!isWordChar(before) && !isWordChar(after)) {
        if (!bestMatch || matchIndex < bestMatch.index) {
          bestMatch = { index: matchIndex, keyword };
        }
        break;
      }

      searchFrom = matchIndex + 1;
    }
  }

  return bestMatch;
}

function hasKeywordAt(input: string, index: number, keyword: string): boolean {
  const before = index === 0 ? undefined : input[index - 1];
  const afterIndex = index + keyword.length;
  const after = afterIndex >= input.length ? undefined : input[afterIndex];
  return input.startsWith(keyword, index) && !isWordChar(before) && !isWordChar(after);
}

function detectAction(prompt: string): Rule['action'] {
  const normalized = prompt.toLowerCase();

  if (/(do\s+not|don't|never|cannot|can't|without)\s+approve|no\s+approval/.test(normalized)) {
    return 'block';
  }

  if (/block|deny|forbid|prevent|disallow|stop/.test(normalized)) {
    return 'block';
  }

  if (/require\s+approval|needs?\s+approval|ask\s+for\s+approval|manual\s+approval|human\s+approval/.test(normalized)) {
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

  if (/\bapprove\b/.test(normalized)) {
    return 'allow';
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

function extractPercent(prompt: string): number | null {
  const normalized = prompt.toLowerCase();

  for (let index = 0; index < normalized.length; index += 1) {
    if (!isAsciiDigit(normalized[index])) {
      continue;
    }

    const parsed = parseNumberAt(normalized, index);
    if (!parsed) {
      continue;
    }

    const suffixIndex = skipWhitespace(normalized, parsed.nextIndex);
    if (normalized[suffixIndex] === '%') {
      return parsed.value;
    }

    index = parsed.nextIndex - 1;
  }

  return null;
}

function extractRemainingBudgetCap(prompt: string): number | null {
  const normalized = prompt.toLowerCase();
  if (!/remaining budget/.test(normalized) || !/position|trade|market/.test(normalized)) {
    return null;
  }

  return extractPercent(normalized);
}

function extractVolumeFloor(prompt: string): number | null {
  const normalized = prompt.toLowerCase();
  const comparator = findKeyword(normalized, ['under', 'below', 'less than']);
  if (!comparator) {
    return null;
  }

  if (!findKeyword(normalized, ['volume'], comparator.index + comparator.keyword.length)) {
    return null;
  }

  const parsed = parseNumberAt(normalized, comparator.index + comparator.keyword.length);
  if (!parsed) {
    return null;
  }

  const unitIndex = skipWhitespace(normalized, parsed.nextIndex);
  return hasKeywordAt(normalized, unitIndex, 'volume') ? parsed.value : null;
}

function extractBuyPriceCap(prompt: string): number | null {
  const normalized = prompt.toLowerCase();
  const buyVerb = findKeyword(normalized, ['buying', 'buys', 'buy']);
  if (!buyVerb) {
    return null;
  }

  const comparator = findKeyword(normalized, ['above', 'over'], buyVerb.index + buyVerb.keyword.length);
  if (!comparator) {
    return null;
  }

  const parsed = parseNumberAt(normalized, comparator.index + comparator.keyword.length);
  if (!parsed) {
    return null;
  }

  const unitIndex = skipWhitespace(normalized, parsed.nextIndex);
  if (hasKeywordAt(normalized, unitIndex, 'cents') || hasKeywordAt(normalized, unitIndex, 'cent')) {
    const normalizedCents = parsed.value / 100;
    return normalizedCents <= 1 ? normalizedCents : null;
  }

  if (!parsed.hadCurrencySymbol && !parsed.hadDecimal && parsed.value > 1 && parsed.value <= 100) {
    return parsed.value / 100;
  }

  // Bare decimal caps are treated as Polymarket-style probabilities, so values above 1 are ignored.
  return parsed.value <= 1 ? parsed.value : null;
}

function hasUnsupportedBuyPriceCap(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  const buyVerb = findKeyword(normalized, ['buying', 'buys', 'buy']);
  if (!buyVerb) {
    return false;
  }

  const comparator = findKeyword(normalized, ['above', 'over'], buyVerb.index + buyVerb.keyword.length);
  if (!comparator) {
    return false;
  }

  return parseNumberAt(normalized, comparator.index + comparator.keyword.length) !== null
    && extractBuyPriceCap(prompt) === null;
}

function parseOrdinalValue(rawValue: string): number | null {
  const normalized = rawValue.toLowerCase();
  const numeric = Number(normalized.replace(/(?:st|nd|rd|th)$/i, ''));
  if (Number.isFinite(numeric)) {
    return numeric;
  }

  const ordinals: Record<string, number> = {
    first: 1,
    second: 2,
    third: 3,
    fourth: 4,
    fifth: 5,
    sixth: 6,
    seventh: 7,
    eighth: 8,
    ninth: 9,
    tenth: 10,
  };

  return ordinals[normalized] ?? null;
}

function extractApprovalPositionThreshold(prompt: string): number | null {
  const normalized = prompt.toLowerCase();
  if (!/require approval/.test(normalized) || !/position/.test(normalized)) {
    return null;
  }

  const match = normalized.match(/(?:opening|open)\s+(?:a\s+)?([a-z]+|\d+(?:st|nd|rd|th)?)\s+position/);
  if (!match) {
    return null;
  }

  const ordinal = parseOrdinalValue(match[1]);
  if (ordinal === null) {
    return null;
  }

  return Math.max(0, ordinal - 1);
}

function selectTemplateTools(prompt: string, tools: readonly DiscoveredTool[]): string[] {
  const directMatches = findMatchingToolNames(prompt, tools);
  if (directMatches.length > 0) {
    return directMatches;
  }

  const normalized = prompt.toLowerCase();
  if (/(budget|market|position|buy|price|volume|trade)/.test(normalized)) {
    const tradingTools = tools
      .filter((tool) => /order|trade|position/.test(tool.name.toLowerCase()))
      .map((tool) => tool.name);
    if (tradingTools.length > 0) {
      return tradingTools;
    }
  }

  const fallbackTool = tools[0]?.name;
  return fallbackTool ? [fallbackTool] : ['tool_call'];
}

function nextGeneratedRuleId(baseId: string, existingIds: Set<string>): string {
  let candidate = toSlug(baseId);
  let attempt = 1;

  while (existingIds.has(candidate)) {
    candidate = `${toSlug(baseId)}-${attempt}`;
    attempt += 1;
  }

  existingIds.add(candidate);
  return candidate;
}

function buildTradingTemplateRules(
  prompt: string,
  selectedTools: readonly string[],
  existingIds: Set<string>
): Rule[] {
  const rules: Rule[] = [];
  const budgetCap = extractRemainingBudgetCap(prompt);
  const volumeFloor = extractVolumeFloor(prompt);
  const buyPriceCap = extractBuyPriceCap(prompt);
  const approvalThreshold = extractApprovalPositionThreshold(prompt);

  if (budgetCap !== null) {
    rules.push({
      id: nextGeneratedRuleId('block-position-size-percent-of-budget', existingIds),
      name: 'Block oversized position by budget',
      description: `Generated from prompt: ${prompt}`,
      enabled: true,
      severity: 'high',
      action: 'block',
      tools: [...selectedTools],
      conditions: [
        {
          field: 'arguments.amount_usd',
          operator: 'percent_of',
          value: budgetCap,
          reference: 'budget.remaining',
        },
      ],
    });
  }

  if (volumeFloor !== null) {
    rules.push({
      id: nextGeneratedRuleId('block-low-volume-markets', existingIds),
      name: 'Block low-volume markets',
      description: `Generated from prompt: ${prompt}`,
      enabled: true,
      severity: 'high',
      action: 'block',
      tools: [...selectedTools],
      conditions: [
        {
          field: 'market.volume',
          operator: 'less_than',
          value: volumeFloor,
        },
      ],
    });
  }

  if (buyPriceCap !== null) {
    rules.push({
      id: nextGeneratedRuleId('block-high-price-buys', existingIds),
      name: 'Block high-price buys',
      description: `Generated from prompt: ${prompt}`,
      enabled: true,
      severity: 'high',
      action: 'block',
      tools: [...selectedTools],
      conditions: [
        {
          field: 'arguments.side',
          operator: 'equals',
          value: 'buy',
        },
        {
          field: 'arguments.price',
          operator: 'greater_than',
          value: buyPriceCap,
        },
      ],
    });
  }

  if (approvalThreshold !== null) {
    rules.push({
      id: nextGeneratedRuleId('require-approval-for-position-count', existingIds),
      name: 'Require approval for additional positions',
      description: `Generated from prompt: ${prompt}`,
      enabled: true,
      severity: 'medium',
      action: 'require_approval',
      tools: [...selectedTools],
      conditions: [
        {
          field: 'portfolio.open_count',
          operator: 'greater_than',
          value: approvalThreshold,
        },
      ],
    });
  }

  return rules;
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
  const existingIds = new Set(existingRules.map((rule) => rule.id));
  const selectedTools = selectTemplateTools(prompt, tools);
  const tradingRules = buildTradingTemplateRules(prompt, selectedTools, existingIds);

  if (tradingRules.length > 0) {
    return tradingRules;
  }

  if (hasUnsupportedBuyPriceCap(prompt)) {
    return [];
  }

  const action = detectAction(prompt);
  const threshold = detectThreshold(prompt);
  const generatedRules: Rule[] = [];

  for (const toolName of selectedTools) {
    const ruleId = nextGeneratedRuleId(
      `${toolName}-${action}${threshold ? `-${threshold.value}` : ''}`,
      existingIds
    );

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
  const normalizedInput = input.toLowerCase();

  const amount = extractNumericAmount(input);
  if (amount !== null) {
    args.amount = amount;
  }

  const email = extractEmailFromText(input);
  if (email) {
    args.to = email;
  } else if (includesAnyPhrase(normalizedInput, ['external domain', 'outside company', 'non-company'])) {
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

  const hasRunScenarioPhrase = normalized.includes('run') && normalized.includes('scenario');

  if (
    includesAnyPhrase(normalized, [
      'test my agent',
      'test current rules',
      'test the rules',
      'scenario suite',
    ])
    || hasRunScenarioPhrase
  ) {
    return {
      mode: 'template',
      intent: 'test_suite',
      prompt: input,
      warnings: [],
    };
  }

  const startsWithExplain = normalized === 'explain' || normalized.startsWith('explain ');
  const asksWhatRuleDoes = normalized.includes('what does') && normalized.includes('rule');

  if (
    startsWithExplain
    || includesAnyPhrase(normalized, ['explain the', 'explain rule'])
    || asksWhatRuleDoes
  ) {
    return {
      mode: 'template',
      intent: 'explain',
      ruleId: pickRuleIdFromInput(input, existingRules),
      prompt: input,
      warnings: [],
    };
  }

  const asksWouldDecision = normalized.includes('would')
    && includesAnyPhrase(normalized, ['be blocked', 'be allowed', 'be denied']);

  if (
    includesAnyPhrase(normalized, ['what would happen', 'if my agent', 'simulate', 'dry run', 'try to'])
    || asksWouldDecision
  ) {
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
  return input.includes('?')
    || includesAnyPhrase(normalized, ['what', 'would', 'happen', 'if', 'should', 'explain', 'why', 'test', 'suite', 'scenario']);
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

  const warnings = [
    'No API key or kernel config configured. Using template fallback generation.',
    'Set VETO_API_KEY or enable kernel mode in veto.config.yaml for LLM generation.',
  ];

  if (hasUnsupportedBuyPriceCap(prompt)) {
    warnings.push(
      'Template fallback could not infer the buy price cap. Use cents (e.g. "85 cents") or a probability between 0 and 1.'
    );
  }

  return {
    mode: 'template',
    yaml,
    warnings,
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
  toolName?: string;
  projectDir?: string;
  rulesDirectory?: string;
  tools: DiscoveredTool[];
  existingRules: Rule[];
  allowTemplateFallback?: boolean;
}): Promise<GeneratePolicyResult> {
  const projectDir = resolve(options.projectDir ?? process.cwd());
  const config = parseConfig(projectDir);
  const endpoint = resolveEndpointConfig(projectDir);
  const allowTemplateFallback = resolveAllowTemplateFallback(
    config,
    options.allowTemplateFallback
  );
  const requestedTool = options.toolName?.trim();
  const matchedRequestedTool = requestedTool
    ? options.tools.find((tool) => tool.name === requestedTool)
    : undefined;
  const generationTools = requestedTool
    ? [
        matchedRequestedTool ?? {
          name: requestedTool,
          parameters: [],
          locations: [],
          sources: [],
          covered: false,
          coverageReason: 'none',
          matchedRuleIds: [],
        },
      ]
    : options.tools;

  if (!endpoint) {
    if (!allowTemplateFallback) {
      throw new Error(
        'No generation endpoint configured. Configure VETO_API_KEY, kernel mode, or self-hosted llm.baseUrl, or enable demo template fallback.'
      );
    }
    return generateTemplatePolicy(options.prompt, generationTools, options.existingRules);
  }

  if (endpoint.mode === 'kernel') {
    try {
      return await generateViaKernel({
        endpoint,
        prompt: options.prompt,
        tools: generationTools,
        existingRules: options.existingRules,
      });
    } catch (error) {
      if (!allowTemplateFallback) {
        throw new Error(
          `Kernel generation failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }

      const fallback = generateTemplatePolicy(options.prompt, generationTools, options.existingRules);
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
    tools: generationTools,
    existingRules: options.existingRules,
    projectContext: {
      cwd: projectDir,
      rulesDirectory: options.rulesDirectory,
    },
    model: endpoint.model,
  };

  if (endpoint.mode === 'cloud') {
    const matchedTools = findMatchingToolNames(options.prompt, generationTools);
    const selectedToolName = requestedTool ?? matchedTools[0] ?? generationTools[0]?.name;

    if (!selectedToolName) {
      if (!allowTemplateFallback) {
        throw new Error('Cloud generation requires at least one discovered tool in the workspace.');
      }

      return generateTemplatePolicy(options.prompt, generationTools, options.existingRules);
    }

    try {
      const response = await postJson<GeneratePolicyResponse>(
        `${endpoint.baseUrl}/v1/policies/generate`,
        {
          toolName: selectedToolName,
          prompt: options.prompt,
          modeHint: 'auto',
        },
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
      if (!allowTemplateFallback) {
        throw new Error(
          `Generation endpoint failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }

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
    if (!allowTemplateFallback) {
      throw new Error(
        `Generation endpoint failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }

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
