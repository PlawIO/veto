/**
 * Content extractor — deterministic regex-based entity extraction from text.
 *
 * Detects prices (multi-currency), emails, phone numbers, salary/compensation
 * figures, equity percentages, government IDs, credit cards, and API keys.
 *
 * Pure string processing with no browser dependencies.
 *
 * @module extractors/content
 */

export interface ExtractedEntities {
  prices: number[];
  max_price: number;
  min_price: number;
  emails: string[];
  phone_numbers: string[];
  salary_figures: number[];
  has_salary_figures: boolean;
  equity_percentages: number[];
  has_equity_info: boolean;
  sensitive_terms: string[];
  has_sensitive_pii: boolean;
  has_credit_cards: boolean;
  has_gov_ids: boolean;
  has_api_keys: boolean;
}

export interface ExtractEntitiesOptions {
  maxPrices?: number;
  maxEmails?: number;
  maxPhones?: number;
  maxSalaryFigures?: number;
  maxEquityPercentages?: number;
  textCap?: number;
}

const PRICE_REGEX = /(?:[$€£¥₹₩]|(?:USD|EUR|GBP|JPY|INR|CHF|AUD|CAD|CNY)\s?)\s?([\d,]+(?:\.\d{1,2})?)/gi;
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]{1,64}@[a-zA-Z0-9.-]{1,255}\.[a-zA-Z]{2,}/g;
const PHONE_REGEX = /(?:\+\d{1,3}[-.\s]?)?(?:\(?\d{2,4}\)?[-.\s]?)?\d{3,4}[-.\s]?\d{3,4}/g;
const SALARY_REGEX =
  /\b(?:salary\b|salaries\b|compensation\b|comp\b|pay\b|wage\b|wages\b|income\b|earning\b|base\b|total\s*comp\b|ote\b|ctc\b)[:\s]*(?:[$€£¥₹]|(?:USD|EUR|GBP)\s?)?\s?([\d,]+(?:\.\d{1,2})?)\s*(?:k|K|pa|p\.a\.)?/gi;
const SALARY_AMOUNT_REGEX =
  /(?:[$€£¥₹])\s?([\d,]+(?:\.\d{1,2})?)\s*(?:k|K)\s*(?:\/yr|\/year|per\s*(?:year|annum)|salary|comp|annual|base)/gi;
const EQUITY_REGEX = /([\d.]+)\s*%\s*(?:equity|vesting|options|ownership|stake|shares|stock|rsus?|esop)/gi;
const GOV_ID_REGEX = /\b\d{3}-\d{2}-\d{4}\b|\b[A-Z]{2}\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-Z]\b|\b\d{2}-\d{7}\b/g;
const CREDIT_CARD_REGEX = /\b(?:\d{4}[-\s]?){3}\d{4}\b/g;
const API_KEY_REGEX = /\b(?:sk|pk|api|key|token|secret|bearer)[-_][a-zA-Z0-9_-]{20,}\b/gi;

function parsePrice(match: string): number {
  return Number.parseFloat(match.replace(/,/g, ''));
}

function dedup(arr: string[]): string[] {
  return [...new Set(arr)];
}

function passesLuhn(digits: string): boolean {
  let sum = 0;
  let alternate = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = parseInt(digits[i], 10);
    if (alternate) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

function isLikelyPhoneNumber(value: string): boolean {
  const normalized = value.trim();
  const digits = normalized.replace(/\D/g, '');

  if (normalized.startsWith('+')) {
    return digits.length >= 8;
  }

  return digits.length >= 10;
}

/**
 * Extract structured entities from arbitrary text.
 *
 * Returns prices, emails, phone numbers, salary figures, equity percentages,
 * and boolean flags for credit cards, government IDs, and API keys.
 */
export function extractEntities(
  text: string,
  options?: ExtractEntitiesOptions,
): ExtractedEntities {
  if (!text || text.length < 3) return {
    prices: [],
    max_price: 0,
    min_price: 0,
    emails: [],
    phone_numbers: [],
    salary_figures: [],
    has_salary_figures: false,
    equity_percentages: [],
    has_equity_info: false,
    sensitive_terms: [],
    has_sensitive_pii: false,
    has_credit_cards: false,
    has_gov_ids: false,
    has_api_keys: false,
  };

  const maxPrices = options?.maxPrices ?? 100;
  const maxEmails = options?.maxEmails ?? 50;
  const maxPhones = options?.maxPhones ?? 50;
  const maxSalaryFigures = options?.maxSalaryFigures ?? 50;
  const maxEquityPercentages = options?.maxEquityPercentages ?? 50;
  const textCap = options?.textCap ?? 200_000;

  const capped = text.length > textCap ? text.slice(0, textCap) : text;

  const prices: number[] = [];
  for (const match of capped.matchAll(PRICE_REGEX)) {
    const price = parsePrice(match[1]);
    if (price > 0 && price < 1_000_000) {
      prices.push(price);
    }
    if (prices.length >= maxPrices) break;
  }

  const emails = dedup(
    [...capped.matchAll(EMAIL_REGEX)].map(m => m[0].toLowerCase()),
  ).slice(0, maxEmails);

  const phoneNumbers = dedup(
    [...capped.matchAll(PHONE_REGEX)]
      .map(m => m[0].trim())
      .filter(isLikelyPhoneNumber)
      .slice(0, maxPhones),
  );

  const salaryFigures: number[] = [];
  for (const regex of [SALARY_REGEX, SALARY_AMOUNT_REGEX]) {
    regex.lastIndex = 0;
    for (const match of capped.matchAll(regex)) {
      const raw = match[1].replace(/,/g, '');
      let amount = Number.parseFloat(raw);
      if (match[0].toLowerCase().includes('k')) amount *= 1000;
      if (amount > 1000 && amount < 10_000_000) {
        salaryFigures.push(amount);
      }
      if (salaryFigures.length >= maxSalaryFigures) break;
    }
  }

  const equityPercentages: number[] = [];
  for (const match of capped.matchAll(EQUITY_REGEX)) {
    const pct = Number.parseFloat(match[1]);
    if (pct > 0 && pct <= 100) equityPercentages.push(pct);
    if (equityPercentages.length >= maxEquityPercentages) break;
  }

  const govIdCount = [...capped.matchAll(GOV_ID_REGEX)].length;
  const creditCardMatches = [...capped.matchAll(CREDIT_CARD_REGEX)];
  const creditCardCount = creditCardMatches.filter(m => passesLuhn(m[0].replace(/\D/g, ''))).length;
  const apiKeyCount = [...capped.matchAll(API_KEY_REGEX)].length;

  const sensitiveTerms: string[] = [];
  if (salaryFigures.length > 0) sensitiveTerms.push('salary');
  if (equityPercentages.length > 0) sensitiveTerms.push('equity');
  if (govIdCount > 0) sensitiveTerms.push('gov_id');
  if (creditCardCount > 0) sensitiveTerms.push('credit_card');
  if (apiKeyCount > 0) sensitiveTerms.push('api_key');
  if (emails.length > 0) sensitiveTerms.push('email');
  if (phoneNumbers.length > 0) sensitiveTerms.push('phone');

  return {
    prices,
    max_price: prices.length > 0 ? prices.reduce((a, b) => a > b ? a : b, -Infinity) : 0,
    min_price: prices.length > 0 ? prices.reduce((a, b) => a < b ? a : b, Infinity) : 0,
    emails,
    phone_numbers: phoneNumbers,
    salary_figures: salaryFigures,
    has_salary_figures: salaryFigures.length > 0,
    equity_percentages: equityPercentages,
    has_equity_info: equityPercentages.length > 0,
    sensitive_terms: sensitiveTerms,
    has_sensitive_pii: sensitiveTerms.length > 0,
    has_credit_cards: creditCardCount > 0,
    has_gov_ids: govIdCount > 0,
    has_api_keys: apiKeyCount > 0,
  };
}
