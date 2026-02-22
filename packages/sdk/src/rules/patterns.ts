/**
 * Common sensitive-data regex patterns for output redaction rules.
 *
 * These are references only. They are not applied automatically.
 */
export const OUTPUT_PATTERN_SSN = '\\b\\d{3}-\\d{2}-\\d{4}\\b';
export const OUTPUT_PATTERN_CREDIT_CARD = '\\b(?:\\d[ -]*?){13,16}\\b';
export const OUTPUT_PATTERN_OPENAI_API_KEY = '\\bsk-(?:proj-)?[A-Za-z0-9]{20,}\\b';
export const OUTPUT_PATTERN_GITHUB_API_KEY =
  '(?:\\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\\b|\\bgithub_pat_[A-Za-z0-9_]{82}\\b)';
export const OUTPUT_PATTERN_AWS_API_KEY = '\\b(?:A3T|AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA)[A-Z0-9]{16}\\b';
export const OUTPUT_PATTERN_EMAIL = '\\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}\\b';
export const OUTPUT_PATTERN_US_PHONE =
  '\\b(?:\\+1[-.\\s]?)?(?:\\(?\\d{3}\\)?[-.\\s]?)\\d{3}[-.\\s]?\\d{4}\\b';

export const OUTPUT_PATTERNS = {
  ssn: OUTPUT_PATTERN_SSN,
  creditCard: OUTPUT_PATTERN_CREDIT_CARD,
  openAIApiKey: OUTPUT_PATTERN_OPENAI_API_KEY,
  githubApiKey: OUTPUT_PATTERN_GITHUB_API_KEY,
  awsApiKey: OUTPUT_PATTERN_AWS_API_KEY,
  email: OUTPUT_PATTERN_EMAIL,
  usPhone: OUTPUT_PATTERN_US_PHONE,
} as const;
