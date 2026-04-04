import { describe, it, expect } from 'vitest';
import { extractEntities } from '../../src/extractors/content.js';

describe('extractEntities', () => {
  describe('price extraction', () => {
    it('extracts USD prices', () => {
      const result = extractEntities('Item costs $199.99 and $50');
      expect(result.prices).toContain(199.99);
      expect(result.prices).toContain(50);
      expect(result.max_price).toBe(199.99);
      expect(result.min_price).toBe(50);
    });

    it('extracts multi-currency prices', () => {
      const result = extractEntities('€100 and £250 and ¥5000');
      expect(result.prices.length).toBeGreaterThanOrEqual(2);
      expect(result.max_price).toBeGreaterThanOrEqual(250);
    });

    it('extracts USD-prefixed prices', () => {
      const result = extractEntities('Total: USD 1,234.56');
      expect(result.prices).toContain(1234.56);
    });

    it('caps at 100 prices by default', () => {
      const text = Array.from({ length: 200 }, (_, i) => `$${i + 1}`).join(' ');
      const result = extractEntities(text);
      expect(result.prices.length).toBeLessThanOrEqual(100);
    });

    it('respects maxPrices option', () => {
      const text = Array.from({ length: 50 }, (_, i) => `$${i + 1}`).join(' ');
      const result = extractEntities(text, { maxPrices: 10 });
      expect(result.prices.length).toBeLessThanOrEqual(10);
    });

    it('returns empty for no prices', () => {
      const result = extractEntities('no prices here');
      expect(result.prices).toEqual([]);
      expect(result.max_price).toBe(0);
    });
  });

  describe('email extraction', () => {
    it('extracts emails', () => {
      const result = extractEntities('Contact user@example.com or admin@test.org');
      expect(result.emails).toContain('user@example.com');
      expect(result.emails).toContain('admin@test.org');
    });

    it('deduplicates emails', () => {
      const result = extractEntities('user@test.com and USER@TEST.COM');
      expect(result.emails.length).toBe(1);
    });
  });

  describe('phone extraction', () => {
    it('extracts international phone numbers', () => {
      const result = extractEntities('Call us at +1 (415) 555-2671 for support');
      expect(result.phone_numbers).toContain('+1 (415) 555-2671');
    });

    it('does not treat short numeric sequences as phone numbers', () => {
      const result = extractEntities('Order 1234567 ships on 2024-01-05 to ZIP 94107');
      expect(result.phone_numbers).toEqual([]);
      expect(result.sensitive_terms).not.toContain('phone');
    });
  });

  describe('salary detection', () => {
    it('detects salary with keyword', () => {
      const result = extractEntities('Salary: $150,000 per year');
      expect(result.has_salary_figures).toBe(true);
      expect(result.salary_figures.length).toBeGreaterThan(0);
    });

    it('detects compensation amounts', () => {
      const result = extractEntities('Total compensation $200K annual');
      expect(result.has_salary_figures).toBe(true);
    });

    it('does not false-positive on regular prices', () => {
      const result = extractEntities('This item costs $29.99');
      expect(result.has_salary_figures).toBe(false);
    });
  });

  describe('equity detection', () => {
    it('detects equity percentages', () => {
      const result = extractEntities('You will receive 2.5% equity vesting over 4 years');
      expect(result.has_equity_info).toBe(true);
      expect(result.equity_percentages).toContain(2.5);
    });

    it('detects stock options', () => {
      const result = extractEntities('10% stock options');
      expect(result.has_equity_info).toBe(true);
    });
  });

  describe('government ID detection', () => {
    it('detects US SSN pattern', () => {
      const result = extractEntities('SSN: 123-45-6789');
      expect(result.has_gov_ids).toBe(true);
    });
  });

  describe('credit card detection', () => {
    it('detects credit card patterns', () => {
      const result = extractEntities('Card: 4111 1111 1111 1111');
      expect(result.has_credit_cards).toBe(true);
    });
  });

  describe('API key detection', () => {
    it('detects API key patterns', () => {
      const result = extractEntities('Use api_key_abcdefghijklmnopqrstuvwxyz123');
      expect(result.has_api_keys).toBe(true);
    });
  });

  describe('sensitive PII flag', () => {
    it('flags when any sensitive data found', () => {
      const result = extractEntities('Email: user@test.com');
      expect(result.has_sensitive_pii).toBe(true);
      expect(result.sensitive_terms).toContain('email');
    });

    it('is false when nothing sensitive', () => {
      const result = extractEntities('Just some plain text about dogs and cats');
      expect(result.has_sensitive_pii).toBe(false);
    });
  });

  describe('text cap', () => {
    it('handles very long text without crashing', () => {
      const text = 'x'.repeat(300_000) + ' $99.99';
      const result = extractEntities(text);
      expect(result).toBeDefined();
    });

    it('respects custom textCap option', () => {
      const text = 'x'.repeat(100) + ' $99.99';
      const result = extractEntities(text, { textCap: 50 });
      // Price is past the cap, so should not be found
      expect(result.prices).toEqual([]);
    });
  });

  describe('salary false positive resistance', () => {
    it('does not match "compare" as salary keyword', () => {
      const result = extractEntities('compare $200,000 options across providers');
      expect(result.has_salary_figures).toBe(false);
    });

    it('does not match "payload" as salary keyword', () => {
      const result = extractEntities('payload: $150,000 bytes transferred');
      expect(result.has_salary_figures).toBe(false);
    });

    it('still matches standalone "comp" as salary keyword', () => {
      const result = extractEntities('Total comp $200,000 annually');
      expect(result.has_salary_figures).toBe(true);
    });
  });

  describe('credit card Luhn validation', () => {
    it('accepts valid Luhn number (4111 1111 1111 1111)', () => {
      const result = extractEntities('Card: 4111 1111 1111 1111');
      expect(result.has_credit_cards).toBe(true);
    });

    it('rejects invalid Luhn number', () => {
      const result = extractEntities('Tracking: 1234 5678 9012 3456');
      expect(result.has_credit_cards).toBe(false);
    });

    it('accepts valid Visa test number without spaces', () => {
      const result = extractEntities('CC: 4532015112830366');
      expect(result.has_credit_cards).toBe(true);
    });
  });

  describe('empty/short input', () => {
    it('returns empty for empty string', () => {
      const result = extractEntities('');
      expect(result.prices).toEqual([]);
      expect(result.has_sensitive_pii).toBe(false);
    });

    it('returns empty for very short text', () => {
      const result = extractEntities('hi');
      expect(result.prices).toEqual([]);
    });
  });
});
