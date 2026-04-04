import { describe, it, expect } from 'vitest';
import {
  tryInstantGeneration,
  looksLikePolicyDeclaration,
  reviewPolicyRequest,
  sanitizeGeneratedRules,
  BROWSER_AGENT_SYSTEM_PROMPT,
} from '../../src/policy/generator.js';

describe('BROWSER_AGENT_SYSTEM_PROMPT', () => {
  it('is a non-empty string', () => {
    expect(typeof BROWSER_AGENT_SYSTEM_PROMPT).toBe('string');
    expect(BROWSER_AGENT_SYSTEM_PROMPT.length).toBeGreaterThan(100);
  });

  it('contains key schema elements', () => {
    expect(BROWSER_AGENT_SYSTEM_PROMPT).toContain('Rule Schema');
    expect(BROWSER_AGENT_SYSTEM_PROMPT).toContain('browser_clickElement');
    expect(BROWSER_AGENT_SYSTEM_PROMPT).toContain('extracted_entities');
    expect(BROWSER_AGENT_SYSTEM_PROMPT).toContain('greater_than');
  });
});

describe('tryInstantGeneration', () => {
  it('generates credit card shield from natural language', () => {
    const result = tryInstantGeneration("don't be able to see any credit card number");
    expect(result).not.toBeNull();
    expect(result!.rules).toHaveLength(1);
    expect(result!.rules[0].name).toBe('Credit Card Shield');
    expect(result!.rules[0].action).toBe('block');
    expect(result!.rules[0].severity).toBe('critical');
    expect(result!.rules[0].conditions![0].field).toBe('arguments.extracted_entities.has_credit_cards');
  });

  it('generates PII shield', () => {
    const result = tryInstantGeneration('block actions when sensitive data is visible');
    expect(result).not.toBeNull();
    expect(result!.rules[0].name).toBe('PII Shield');
    expect(result!.rules[0].action).toBe('block');
  });

  it('generates price limit with require_approval for approval language', () => {
    const result = tryInstantGeneration('ask me before any purchase over $200');
    expect(result).not.toBeNull();
    expect(result!.rules[0].name).toContain('$200');
    expect(result!.rules[0].action).toBe('require_approval');
    expect(result!.rules[0].conditions![0].value).toBe(200);
  });

  it('generates price limit with block for prohibitive language', () => {
    const result = tryInstantGeneration("don't spend more than $500 on any purchase");
    expect(result).not.toBeNull();
    expect(result!.rules[0].action).toBe('block');
    expect(result!.rules[0].conditions![0].value).toBe(500);
  });

  it('infers require_approval action from approval keywords', () => {
    const result = tryInstantGeneration('require approval before accessing credit card info');
    expect(result).not.toBeNull();
    expect(result!.rules[0].action).toBe('require_approval');
  });

  it('returns null for complex policies that need LLM', () => {
    const result = tryInstantGeneration('only allow navigation to .gov domains between 9am and 5pm');
    expect(result).toBeNull();
  });

  it('generates government ID shield', () => {
    const result = tryInstantGeneration('block when SSN or social security numbers are on the page');
    expect(result).not.toBeNull();
    expect(result!.rules[0].name).toBe('Government ID Shield');
    expect(result!.rules[0].conditions![0].field).toBe('arguments.extracted_entities.has_gov_ids');
  });

  it('generates API key shield', () => {
    const result = tryInstantGeneration('block pages with API keys');
    expect(result).not.toBeNull();
    expect(result!.rules[0].name).toBe('API Key Shield');
  });

  it('generates salary shield', () => {
    const result = tryInstantGeneration('warn me when salary information is visible');
    expect(result).not.toBeNull();
    expect(result!.rules[0].name).toBe('Salary Info Shield');
    expect(result!.rules[0].action).toBe('warn');
  });

  it('block keyword overrides approval keywords in same input', () => {
    const result = tryInstantGeneration('block pages with credit card info for review');
    expect(result).not.toBeNull();
    expect(result!.rules[0].action).toBe('block');
  });

  it('returns null for NaN price threshold', () => {
    const result = tryInstantGeneration("don't spend more than $,,, on any purchase");
    expect(result).toBeNull();
  });

  it('handles comma-formatted price threshold', () => {
    const result = tryInstantGeneration('ask before any purchase over $1,500');
    expect(result).not.toBeNull();
    expect(result!.rules[0].conditions![0].value).toBe(1500);
  });
});

describe('looksLikePolicyDeclaration', () => {
  // Should match: standing policy rules
  it('matches prohibition + conditional clause', () => {
    expect(looksLikePolicyDeclaration("Don't open any file from Acme Inc. unless Jared has forwarded me a signed NDA.")).toBe(true);
  });

  it('matches "never ... until"', () => {
    expect(looksLikePolicyDeclaration('Never share my credentials until I explicitly approve')).toBe(true);
  });

  it('matches "do not ... except when"', () => {
    expect(looksLikePolicyDeclaration('Do not submit any form except when I am on my company domain')).toBe(true);
  });

  it('matches prohibition + broad scope (any/all/every)', () => {
    expect(looksLikePolicyDeclaration("Don't click on any ad or sponsored link")).toBe(true);
  });

  it('matches "never" + "all"', () => {
    expect(looksLikePolicyDeclaration('Never enter my password on all third-party sites')).toBe(true);
  });

  it('matches "block ... from"', () => {
    expect(looksLikePolicyDeclaration('Block any request from unknown domains')).toBe(true);
  });

  it('matches "deny all"', () => {
    expect(looksLikePolicyDeclaration('Deny all downloads from untrusted sources')).toBe(true);
  });

  it('matches "require approval"', () => {
    expect(looksLikePolicyDeclaration('Require my approval before making any purchase')).toBe(true);
  });

  it('matches "require permission"', () => {
    expect(looksLikePolicyDeclaration('Require permission to access sensitive data')).toBe(true);
  });

  it('matches "warn me when"', () => {
    expect(looksLikePolicyDeclaration('Warn me when the page contains credit card fields')).toBe(true);
  });

  it('matches "alert me if"', () => {
    expect(looksLikePolicyDeclaration('Alert me if a page tries to access my location')).toBe(true);
  });

  it('matches "only if" conditional', () => {
    expect(looksLikePolicyDeclaration("Don't proceed with checkout only if the total is under $50")).toBe(true);
  });

  // Real-world policy scenarios

  it('#1 NDA Gate: prohibition + unless', () => {
    expect(
      looksLikePolicyDeclaration("Don't open any file from Acme Inc. unless Jared has forwarded me a signed NDA."),
    ).toBe(true);
  });

  it('#2 Doomscroll Kill Switch: block + all', () => {
    expect(
      looksLikePolicyDeclaration(
        "If I've spent more than 20 mins on social media today, block all social tabs and redirect me to my task list.",
      ),
    ).toBe(true);
  });

  it('#3 Shopping Guardrail: never + without + anything', () => {
    expect(
      looksLikePolicyDeclaration(
        'Never purchase anything above $150 without showing me a human approval prompt first.',
      ),
    ).toBe(true);
  });

  it('#4 Research Boundary: imperative never + competitors', () => {
    expect(looksLikePolicyDeclaration("Never visit or extract data from our top 3 competitors' pricing pages.")).toBe(
      true,
    );
  });

  it('#5 Context Collapse Prevention: never + anyone', () => {
    expect(
      looksLikePolicyDeclaration(
        'Never send an email that contains salary figures, equity percentages, or investor names to anyone outside the company domain.',
      ),
    ).toBe(true);
  });

  // Should NOT match: immediate browsing instructions
  it('rejects simple browsing task', () => {
    expect(looksLikePolicyDeclaration('Go to amazon.com and find the cheapest laptop')).toBe(false);
  });

  it('rejects specific page instruction', () => {
    expect(looksLikePolicyDeclaration('Click the submit button on the form')).toBe(false);
  });

  it('rejects search task', () => {
    expect(looksLikePolicyDeclaration('Search for flights from NYC to London')).toBe(false);
  });

  it('rejects general question', () => {
    expect(looksLikePolicyDeclaration('What is the weather in San Francisco?')).toBe(false);
  });

  it('rejects simple negation without condition or scope', () => {
    expect(looksLikePolicyDeclaration("Don't click that button")).toBe(false);
  });

  it('rejects navigation instruction', () => {
    expect(looksLikePolicyDeclaration('Open my email and check for new messages')).toBe(false);
  });

  it('rejects "never mind" as a conversational phrase', () => {
    expect(looksLikePolicyDeclaration('Never mind, just go to google.com')).toBe(false);
  });
});

describe('reviewPolicyRequest', () => {
  it('asks for clarification on social media + redirect + aggregate timing', () => {
    const clarification = reviewPolicyRequest(
      'If I have spent more than 3 mins on social media today, block all social tabs and redirect me to my task list.',
    );

    expect(clarification).not.toBeNull();
    expect(clarification?.questions).toHaveLength(3);
    expect(clarification?.questions.join(' ')).toContain('social media');
    expect(clarification?.questions.join(' ')).toContain('per domain');
    expect(clarification?.questions.join(' ')).toContain('do not perform redirects');
  });

  it('does not ask when constraints are explicit', () => {
    const clarification = reviewPolicyRequest(
      'Use the default set of social media domains. Apply the limit per domain, and make this a block only policy after 3 minutes.',
    );

    expect(clarification).toBeNull();
  });

  it('returns null for clear policy requests', () => {
    expect(reviewPolicyRequest('Block all actions when credit cards are visible')).toBeNull();
  });
});

describe('sanitizeGeneratedRules', () => {
  it('normalizes rule IDs with local-nl- prefix', () => {
    const { rules } = sanitizeGeneratedRules({
      rules: [{
        id: 'My Rule ID!',
        name: 'Test',
        severity: 'high',
        action: 'block',
        conditions: [{ field: 'x', operator: 'equals', value: 'y' }],
      }],
    });

    expect(rules[0].id).toMatch(/^local-nl-/);
    expect(rules[0].id).not.toContain('!');
  });

  it('deduplicates IDs', () => {
    const { rules } = sanitizeGeneratedRules({
      rules: [
        { id: 'same', name: 'A', severity: 'high', action: 'block', conditions: [{ field: 'x', operator: 'equals', value: '1' }] },
        { id: 'same', name: 'B', severity: 'high', action: 'block', conditions: [{ field: 'x', operator: 'equals', value: '2' }] },
      ],
    });

    expect(rules[0].id).not.toBe(rules[1].id);
  });

  it('warns on unknown tools but keeps them', () => {
    const { rules, warnings } = sanitizeGeneratedRules({
      rules: [{
        id: 'test',
        name: 'Test',
        severity: 'high',
        action: 'block',
        tools: ['browser_clickElement', 'unknown_tool'],
        conditions: [{ field: 'x', operator: 'equals', value: 'y' }],
      }],
    });

    expect(rules[0].tools).toContain('unknown_tool');
    expect(warnings.some(w => w.includes('unknown_tool'))).toBe(true);
  });

  it('warns on unknown operators but keeps them', () => {
    const { rules, warnings } = sanitizeGeneratedRules({
      rules: [{
        id: 'test',
        name: 'Test',
        severity: 'high',
        action: 'block',
        conditions: [{ field: 'x', operator: 'custom_op', value: 'y' }],
      }],
    });

    expect(rules[0].conditions![0].operator).toBe('custom_op');
    expect(warnings.some(w => w.includes('custom_op'))).toBe(true);
  });

  it('sets enabled to true and adds nl-generated tag', () => {
    const { rules } = sanitizeGeneratedRules({
      rules: [{
        id: 'test',
        name: 'Test',
        severity: 'high',
        action: 'block',
        conditions: [{ field: 'x', operator: 'equals', value: 'y' }],
      }],
    });

    expect(rules[0].enabled).toBe(true);
    expect(rules[0].tags).toContain('nl-generated');
  });

  it('preserves condition_groups', () => {
    const { rules } = sanitizeGeneratedRules({
      rules: [{
        id: 'test',
        name: 'Test',
        severity: 'high',
        action: 'block',
        condition_groups: [
          [{ field: 'a', operator: 'equals', value: '1' }],
          [{ field: 'b', operator: 'equals', value: '2' }],
        ],
      }],
    });

    expect(rules[0].condition_groups).toHaveLength(2);
  });

  it('defaults invalid severity to medium with warning', () => {
    const { rules, warnings } = sanitizeGeneratedRules({
      rules: [{
        id: 'test',
        name: 'Test',
        severity: 'banana',
        action: 'block',
        conditions: [{ field: 'x', operator: 'equals', value: 'y' }],
      }],
    });

    expect(rules[0].severity).toBe('medium');
    expect(warnings.some(w => w.includes('banana'))).toBe(true);
  });

  it('defaults invalid action to block with warning', () => {
    const { rules, warnings } = sanitizeGeneratedRules({
      rules: [{
        id: 'test',
        name: 'Test',
        severity: 'high',
        action: 'yeet',
        conditions: [{ field: 'x', operator: 'equals', value: 'y' }],
      }],
    });

    expect(rules[0].action).toBe('block');
    expect(warnings.some(w => w.includes('yeet'))).toBe(true);
  });

  it('uses deterministic ID deduplication', () => {
    const input = {
      rules: [
        { id: 'same-id', name: 'Rule 1', action: 'block', severity: 'high', conditions: [] },
        { id: 'same-id', name: 'Rule 2', action: 'warn', severity: 'high', conditions: [] },
      ],
    };
    const { rules } = sanitizeGeneratedRules(input);
    expect(rules[0].id).toBe('local-nl-same-id');
    expect(rules[1].id).toMatch(/^local-nl-same-id-\d+$/);

    // Run again to verify determinism
    const { rules: rules2 } = sanitizeGeneratedRules(input);
    expect(rules2[1].id).toBe(rules[1].id);
  });
});
