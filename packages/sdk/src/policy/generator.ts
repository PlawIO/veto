/**
 * Policy generator utilities — NL-to-rule helpers for consumers who bring
 * their own LLM.
 *
 * Provides the system prompt, Zod schema, rule sanitization, and instant
 * generation for well-known patterns. Does NOT include LLM invocation.
 *
 * @module policy/generator
 */

import type { Rule, RuleCondition } from '../rules/types.js';

// Zod is an optional peer dependency — import type-only at the top,
// and dynamically import at runtime only when schema functions are called.

/**
 * Result of policy generation or validation.
 */
export interface PolicyGenerationResult {
  success: boolean;
  rules: Rule[];
  explanation: string;
  warnings?: string[];
  error?: string;
}

/**
 * Clarification request returned when a policy description is ambiguous.
 */
export interface PolicyClarificationRequest {
  explanation: string;
  questions: string[];
}

// --- System prompt ---

export const BROWSER_AGENT_SYSTEM_PROMPT = `You are a security policy compiler for a browser automation agent.

Convert the user's natural-language policy into one or more Veto rules (JSON).

## Rule Schema

Each rule is a JSON object:
{
  "id": string,           // kebab-case unique ID (e.g., "block-expensive-purchases")
  "name": string,         // short human-readable name
  "description": string,  // 1-2 sentence description
  "enabled": true,
  "severity": "critical" | "high" | "medium" | "low" | "info",
  "action": "block" | "warn" | "log" | "allow" | "require_approval",
  "tools": string[],      // which browser actions this applies to (omit for ALL)
  "conditions": [         // ALL must match (AND logic)
    { "field": string, "operator": string, "value": any }
  ],
  "condition_groups": [   // groups are OR'd; conditions within each group are AND'd
    [ { "field": ..., "operator": ..., "value": ... } ]
  ],
  "tags": string[]
}

## Available Tools (prefix: browser_)

browser_clickElement, browser_inputText, browser_goToUrl, browser_searchGoogle,
browser_scrollToPercent, browser_switchTab, browser_openTab, browser_closeTab,
browser_goBack, browser_sendKeys, browser_wait, browser_scrollToText,
browser_selectDropdownOption, browser_getDropdownOptions, browser_cacheContent,
browser_done, browser_scrollToTop, browser_scrollToBottom, browser_nextPage,
browser_previousPage

Omit "tools" to apply to ALL actions.

## Available Condition Fields

You can condition on ANY field in the action's arguments using dot notation.
The system provides these built-in fields, but you are not limited to them:

**Page context:**
- arguments.current_url (string) — current page URL
- arguments.page_title (string) — current page title
- arguments.action_index (number) — action sequence number in this task
- arguments.domain_time_seconds (number) — cumulative seconds on this domain

**Element context** (for actions targeting a specific page element — click, input, scroll-to, etc.):
- arguments.element_context.element_text (string) — the target element's own text content
- arguments.element_context.row_text (string) — ALL visible text in the element's row, list item, card, or containing group. In a spreadsheet, this is the full row (e.g. "Antler US Fund $160 1/5/2026 2026 II NYC"). Use this for per-row/per-item policy enforcement.
- arguments.element_context.tag (string) — HTML tag of the target element
- arguments.element_context.xpath (string) — XPath of the target element

**Element styles** (for actions targeting page elements):
- arguments.computed_styles.* — any CSS property (backgroundColor, color, fontSize, display, visibility, opacity, position, zIndex, pointerEvents, fontWeight, textDecoration, overflow, cursor, borderColor)

**Extracted entities** (auto-detected from visible page content):
- arguments.extracted_entities.prices (number[]) — prices in any currency
- arguments.extracted_entities.max_price (number) — highest price on page
- arguments.extracted_entities.min_price (number) — lowest price on page
- arguments.extracted_entities.emails (string[]) — email addresses
- arguments.extracted_entities.phone_numbers (string[]) — phone numbers (international)
- arguments.extracted_entities.salary_figures (number[]) — salary/compensation amounts
- arguments.extracted_entities.has_salary_figures (boolean)
- arguments.extracted_entities.equity_percentages (number[]) — equity/vesting %
- arguments.extracted_entities.has_equity_info (boolean)
- arguments.extracted_entities.has_sensitive_pii (boolean) — any PII detected
- arguments.extracted_entities.has_credit_cards (boolean) — credit card numbers detected
- arguments.extracted_entities.has_gov_ids (boolean) — government ID patterns detected
- arguments.extracted_entities.has_api_keys (boolean) — API keys/secrets detected
- arguments.extracted_entities.sensitive_terms (string[]) — categories found: salary, equity, gov_id, credit_card, api_key, email, phone

**Action-specific arguments:**
- arguments.url — target URL for navigation
- arguments.text — text being typed
- arguments.query — search query
- arguments.index — target element index

You can also use any custom field path. Unknown fields resolve to undefined and conditions on them won't match.

## Operators

equals, not_equals, contains, not_contains, starts_with, ends_with, matches,
greater_than, less_than, in, not_in, length_greater_than, percent_of,
outside_hours, within_hours

For time-based: use "HH:MM-HH:MM" format (e.g., "09:00-17:00"). Handles overnight ranges.
You can use any operator the Veto SDK supports. Unknown operators are passed through to cloud evaluation.

## Action Types

- "block" — prevent the action (hard limit)
- "require_approval" — pause and ask the human to approve/deny
- "warn" — log warning but allow
- "log" — silently log
- "allow" — explicitly allow (for exceptions)

Use "block" for hard safety limits. Use "require_approval" when the user wants case-by-case review.

## Rules

1. Rules are evaluated per-action, not per-page
2. Use "conditions" for AND logic, "condition_groups" for OR logic
3. For URL matching, prefer "contains" or "matches" over "equals"
4. For price thresholds, use "arguments.extracted_entities.max_price" with "greater_than"
5. Generate the minimum number of rules needed
6. For per-row/per-item enforcement (e.g. "block items in NYC", "hide funds from Acme"), use arguments.element_context.row_text with "contains" — this checks the specific row the agent is interacting with, NOT the entire page
7. Use extracted_entities for page-wide checks (e.g. "block when credit cards visible"). Use element_context for item-level checks (e.g. "block clicking rows where location is NYC")

## Output Format

Return JSON with exactly two fields:
{
  "rules": [ ... ],
  "explanation": "1-3 sentence plain-English explanation"
}`;

// --- Operator / tool validation sets ---

const VALID_OPERATORS = new Set([
  'equals',
  'not_equals',
  'contains',
  'not_contains',
  'starts_with',
  'ends_with',
  'matches',
  'greater_than',
  'less_than',
  'percent_of',
  'length_greater_than',
  'in',
  'not_in',
  'outside_hours',
  'within_hours',
]);

const KNOWN_TOOLS = new Set([
  'browser_clickElement',
  'browser_inputText',
  'browser_goToUrl',
  'browser_searchGoogle',
  'browser_scrollToPercent',
  'browser_switchTab',
  'browser_openTab',
  'browser_closeTab',
  'browser_goBack',
  'browser_sendKeys',
  'browser_wait',
  'browser_scrollToText',
  'browser_selectDropdownOption',
  'browser_getDropdownOptions',
  'browser_cacheContent',
  'browser_done',
  'browser_scrollToTop',
  'browser_scrollToBottom',
  'browser_nextPage',
  'browser_previousPage',
]);

// --- Zod schema for structured LLM output ---

let _policyOutputSchema: unknown = null;

/**
 * Lazily create and return the Zod schema for policy output validation.
 *
 * Requires `zod` as a peer dependency. Throws if zod is not installed.
 */
export async function getPolicyOutputSchema(): Promise<unknown> {
  if (_policyOutputSchema) return _policyOutputSchema;

  const z = await import('zod').catch(() => {
    throw new Error('zod is required for policy schema validation. Install it: npm install zod');
  });

  const conditionValueSchema = z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.array(z.string()),
    z.array(z.number()),
  ]);

  const ruleConditionSchema = z.object({
    field: z.string(),
    operator: z.string(),
    value: conditionValueSchema,
  });

  const generatedRuleSchema = z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable().optional(),
    enabled: z.literal(true).default(true),
    severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
    action: z.enum(['block', 'warn', 'log', 'allow', 'require_approval']),
    tools: z.array(z.string()).nullable().optional(),
    conditions: z.array(ruleConditionSchema).nullable().optional(),
    condition_groups: z.array(z.array(ruleConditionSchema)).nullable().optional(),
    tags: z.array(z.string()).nullable().optional(),
  });

  _policyOutputSchema = z.object({
    rules: z.array(generatedRuleSchema).min(1),
    explanation: z.string(),
  });

  return _policyOutputSchema;
}

// --- Sanitization ---

/**
 * Sanitize LLM-generated rules into valid SDK Rule objects.
 *
 * Normalizes IDs with `local-nl-` prefix, deduplicates, and passes through
 * unknown operators/tools with warnings (returned in the warnings array).
 */
export function sanitizeGeneratedRules(
  parsed: { rules: Array<{ id: string; name: string; description?: string | null; enabled?: boolean; severity: string; action: string; tools?: string[] | null; conditions?: Array<{ field: string; operator: string; value?: unknown }> | null; condition_groups?: Array<Array<{ field: string; operator: string; value?: unknown }>> | null; tags?: string[] | null }> },
): { rules: Rule[]; warnings: string[] } {
  const seenIds = new Set<string>();
  const warnings: string[] = [];

  const rules = parsed.rules.map(r => {
    const baseId = `local-nl-${r.id.replace(/[^a-z0-9-]/gi, '-').toLowerCase()}`;
    let id = baseId;
    let localSuffix = 0;
    while (seenIds.has(id)) {
      id = `${baseId}-${++localSuffix}`;
    }
    seenIds.add(id);

    if (r.tools) {
      for (const t of r.tools) {
        if (!KNOWN_TOOLS.has(t)) {
          warnings.push(`Unknown tool "${t}" in rule "${r.name}" — kept (may match future/cloud tools)`);
        }
      }
    }

    const toCondition = (c: { field: string; operator: string; value?: unknown }): RuleCondition => {
      if (!VALID_OPERATORS.has(c.operator)) {
        warnings.push(`Unrecognized operator "${c.operator}" in rule "${r.name}" — kept for cloud evaluation`);
      }
      return {
        field: c.field,
        operator: c.operator as RuleCondition['operator'],
        value: c.value,
      };
    };

    const VALID_SEVERITIES: Set<string> = new Set(['low', 'medium', 'high', 'critical', 'info']);
    const VALID_ACTIONS: Set<string> = new Set(['allow', 'block', 'require_approval', 'warn', 'log']);

    let severity: Rule['severity'] = 'medium';
    if (VALID_SEVERITIES.has(r.severity)) {
      severity = r.severity as Rule['severity'];
    } else {
      warnings.push(`Invalid severity "${r.severity}" in rule "${r.name}" — defaulting to "medium"`);
    }

    let action: Rule['action'] = 'block';
    if (VALID_ACTIONS.has(r.action)) {
      action = r.action as Rule['action'];
    } else {
      warnings.push(`Invalid action "${r.action}" in rule "${r.name}" — defaulting to "block"`);
    }

    const rule: Rule = {
      id,
      name: r.name,
      description: r.description ?? undefined,
      enabled: true,
      severity,
      action,
      tools: r.tools ?? undefined,
      conditions: r.conditions?.map(toCondition),
      condition_groups: r.condition_groups?.map(group => group.map(toCondition)),
      tags: r.tags ?? ['nl-generated'],
    };

    return rule;
  });

  return { rules, warnings };
}

/**
 * Validate raw LLM output against the policy schema and sanitize into Rules.
 *
 * Requires `zod` as a peer dependency.
 */
export async function validatePolicyOutput(raw: unknown): Promise<PolicyGenerationResult> {
  try {
    const schema = await getPolicyOutputSchema();
     
    const parsed = (schema as any).parse(raw);
    const { rules, warnings } = sanitizeGeneratedRules(parsed);
    return { success: true, rules, explanation: parsed.explanation, warnings };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, rules: [], explanation: '', error: msg };
  }
}

// --- Instant generation ---

type InstantAction = 'block' | 'require_approval' | 'warn' | 'log';

function inferActionFromIntent(input: string): InstantAction {
  const lower = input.toLowerCase();
  if (/\b(block|prohibit|deny|prevent|stop|restrict|forbid)/.test(lower)) return 'block';
  if (/\b(warn|alert|notify|flag)/.test(lower)) return 'warn';
  if (/\b(ask|approv|confirm|review|check with|permission)/.test(lower)) return 'require_approval';
  if (/\b(log|track|monitor|record)/.test(lower)) return 'log';
  return 'block';
}

function actionVerb(action: string): string {
  if (action === 'block') return 'Blocks';
  if (action === 'require_approval') return 'Requires approval for';
  if (action === 'warn') return 'Warns about';
  return 'Logs';
}

function extractPriceThreshold(input: string): number | null {
  const match = input.match(/\$\s*([0-9,]+(?:\.[0-9]{1,2})?)/);
  if (match) {
    const price = parseFloat(match[1].replace(/,/g, ''));
    if (isNaN(price)) return null;
    return price;
  }
  const wordMatch = input.match(/(\d+(?:\.\d{1,2})?)\s*(?:dollars?|usd)/i);
  if (wordMatch) {
    const price = parseFloat(wordMatch[1]);
    if (isNaN(price)) return null;
    return price;
  }
  return null;
}

interface InstantRuleDef {
  id: string;
  name: string;
  description: string;
  enabled: true;
  severity: 'critical' | 'high';
  action: InstantAction;
  conditions: Array<{ field: string; operator: string; value: string | number | boolean }>;
}

function instantRule(
  id: string,
  name: string,
  description: string,
  severity: 'critical' | 'high',
  action: InstantAction,
  conditions: Array<{ field: string; operator: string; value: string | number | boolean }>,
): InstantRuleDef {
  return { id, name, description, enabled: true, severity, action, conditions };
}

interface InstantOutput {
  rules: InstantRuleDef[];
  explanation: string;
}

/**
 * Zero-latency deterministic rule generation for common intents.
 *
 * Handles credit card shields, PII shields, gov ID shields, API key shields,
 * price limits, and salary info shields. Returns null for anything that
 * needs an LLM.
 */
export function tryInstantGeneration(input: string): InstantOutput | null {
  const lower = input.toLowerCase();
  const action = inferActionFromIntent(input);
  const verb = actionVerb(action);

  if (/\bcredit\s*cards?\b|\bcard\s*numbers?\b|\bcc\s*num/i.test(lower)) {
    return {
      rules: [
        instantRule(
          'instant-credit-card-shield',
          'Credit Card Shield',
          'Prevents actions when credit card numbers are detected on the page',
          'critical',
          action,
          [{ field: 'arguments.extracted_entities.has_credit_cards', operator: 'equals', value: true }],
        ),
      ],
      explanation: `${verb} all browser actions when credit card numbers are detected on the page.`,
    };
  }

  if (/\b(pii|personal\s*(data|info(rmation)?)|sensitive\s*(data|info))\b/i.test(lower)) {
    return {
      rules: [
        instantRule(
          'instant-pii-shield',
          'PII Shield',
          'Prevents actions when sensitive personal information is detected',
          'critical',
          action,
          [{ field: 'arguments.extracted_entities.has_sensitive_pii', operator: 'equals', value: true }],
        ),
      ],
      explanation: `${verb} all browser actions when sensitive personal data is detected on the page.`,
    };
  }

  if (/\b(gov(ernment)?\s*id|ssn|social\s*security|passport|driver'?s?\s*licen[sc]e)\b/i.test(lower)) {
    return {
      rules: [
        instantRule(
          'instant-gov-id-shield',
          'Government ID Shield',
          'Prevents actions when government ID patterns are detected',
          'critical',
          action,
          [{ field: 'arguments.extracted_entities.has_gov_ids', operator: 'equals', value: true }],
        ),
      ],
      explanation: `${verb} all browser actions when government ID patterns (SSN, passport, license numbers) are detected.`,
    };
  }

  if (/\b(api\s*keys?|secret\s*keys?|access\s*tokens?|credentials?)\b/i.test(lower)) {
    return {
      rules: [
        instantRule(
          'instant-api-key-shield',
          'API Key Shield',
          'Prevents actions when API keys or secrets are detected',
          'critical',
          action,
          [{ field: 'arguments.extracted_entities.has_api_keys', operator: 'equals', value: true }],
        ),
      ],
      explanation: `${verb} all browser actions when API keys or secrets are detected on the page.`,
    };
  }

  const price = extractPriceThreshold(input);
  if (price !== null && /price|cost|spend|purchas|buy|order|checkout|cart|limit/i.test(lower)) {
    const priceAction: InstantAction = /\b(block|stop|prevent|never|don'?t)\b/i.test(lower)
      ? 'block'
      : 'require_approval';
    return {
      rules: [
        instantRule(
          `instant-price-limit-${price}`,
          `Price Limit ($${price})`,
          `Controls actions when prices exceed $${price}`,
          'high',
          priceAction,
          [{ field: 'arguments.extracted_entities.max_price', operator: 'greater_than', value: price }],
        ),
      ],
      explanation: `${actionVerb(priceAction)} actions when the highest price on the page exceeds $${price}.`,
    };
  }

  if (/\b(salary|salaries|compensation|pay\s*(rate|scale|range)|wage)\b/i.test(lower)) {
    return {
      rules: [
        instantRule(
          'instant-salary-shield',
          'Salary Info Shield',
          'Prevents actions when salary or compensation data is detected',
          'high',
          action,
          [{ field: 'arguments.extracted_entities.has_salary_figures', operator: 'equals', value: true }],
        ),
      ],
      explanation: `${verb} all browser actions when salary or compensation figures are detected.`,
    };
  }

  return null;
}

// --- Policy declaration detection ---

/**
 * Detect natural-language policy declarations — standing rules with conditions
 * that should route to policy generation rather than the automation loop.
 */
export function looksLikePolicyDeclaration(task: string): boolean {
  const t = task.toLowerCase().trim();

  const hasProhibition = /\b(?:don'?t|do\s*not|never)\b/.test(t);
  const hasCondition = /\b(?:unless|until|without|except\s+(?:if|when)|only\s+(?:if|when))\b/.test(t);
  const hasScope = /\b(?:any(?:thing|one|where)?|all|every(?:thing|one|where)?)\b/.test(t);

  if (hasProhibition && hasCondition) return true;

  if (hasProhibition && hasScope) return true;

  // Imperative "never" at the start is a standing rule, not a one-off instruction.
  // Excludes "never mind".
  if (/^(?:please\s+)?never\b/.test(t) && !/^(?:please\s+)?never\s*mind\b/.test(t)) return true;

  if (/\b(?:block|deny|restrict|prevent)\b/.test(t) && (hasScope || /\bfrom\s+\w+/.test(t))) return true;

  if (/\brequire\s+(?:my\s+)?(?:approval|permission)\b/.test(t)) return true;
  if (/\b(?:warn|alert)\s+me\b/.test(t) && /\b(?:if|when|before|whenever)\b/.test(t)) return true;

  return false;
}

// --- Review / clarification ---

function hasExplicitDomainList(input: string): boolean {
  return /\b(x|twitter|reddit|instagram|facebook|tiktok|youtube|linkedin)\.com\b/i.test(input);
}

function hasSupportedRedirectFallback(input: string): boolean {
  return /\b(block only|just block|no redirect|don't redirect|do not redirect|skip redirect)\b/i.test(input);
}

/**
 * Check if a policy request needs clarification before generation.
 *
 * Returns null if the request is clear enough to proceed.
 */
export function reviewPolicyRequest(input: string): PolicyClarificationRequest | null {
  const normalizedInput = input.replace(/\s+/g, ' ').trim();
  const lowerInput = normalizedInput.toLowerCase();
  const questions: string[] = [];

  const mentionsRedirect =
    /\bredirect\b|\broute me to\b|\bsend me to\b|\btake me to\b|\bopen my\b|\bopen the\b/.test(lowerInput) &&
    /(task list|todo|to-do|tasks|calendar|planner|inbox)/.test(lowerInput);

  const mentionsSocialCategory = /social media|social tabs|social sites|social apps/.test(lowerInput);
  const mentionsTimeThreshold =
    /\b\d+\s*(min|mins|minute|minutes|hour|hours|hr|hrs)\b/.test(lowerInput) ||
    /\bmore than\b|\bover\b|\bafter\b/.test(lowerInput);
  const mentionsCrossSiteWindow = /\btoday\b|\bdaily\b|\bacross\b|\ball social\b/.test(lowerInput);
  const acceptsDefaultSocialDomains = /\bdefault\b|\bstandard set\b/.test(lowerInput);

  if (mentionsSocialCategory && !hasExplicitDomainList(normalizedInput) && !acceptsDefaultSocialDomains) {
    questions.push(
      'Which domains should count as social media for this rule? If you want, say "use the default set" and I\'ll use x.com, twitter.com, reddit.com, instagram.com, facebook.com, tiktok.com, youtube.com, and linkedin.com.',
    );
  }

  if (mentionsSocialCategory && mentionsTimeThreshold && mentionsCrossSiteWindow) {
    questions.push(
      'Should that time limit apply per domain (for example 3 minutes on x.com) or across all social sites combined? The current policy engine enforces per-domain time reliably.',
    );
  }

  if (mentionsRedirect && !hasSupportedRedirectFallback(normalizedInput)) {
    questions.push(
      'Veto policies can block, require approval, warn, or log, but they do not perform redirects on their own. Do you want a block-only policy, or a separate follow-up automation? If you want the follow-up flow, what exact task-list URL should be used?',
    );
  }

  if (questions.length === 0) {
    return null;
  }

  return {
    explanation:
      'I need a couple of clarifications before I can create this policy without guessing or silently encoding the wrong behavior.',
    questions,
  };
}
