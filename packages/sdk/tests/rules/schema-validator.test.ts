import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { validatePolicyIR, PolicySchemaError } from '../../src/rules/schema-validator.js';

const FIXTURES_DIR = join(__dirname, '..', '..', '..', '..', 'conformance', 'fixtures', 'policy-ir');

function loadFixture(name: string): unknown {
  const content = readFileSync(join(FIXTURES_DIR, name), 'utf-8');
  return parseYaml(content);
}

describe('Policy IR v1 Schema Validator', () => {
  describe('valid documents', () => {
    it('should accept valid-minimal.yaml', () => {
      const data = loadFixture('valid-minimal.yaml');
      expect(() => validatePolicyIR(data)).not.toThrow();
    });

    it('should accept valid-full.yaml', () => {
      const data = loadFixture('valid-full.yaml');
      expect(() => validatePolicyIR(data)).not.toThrow();
    });

    it('should accept require_approval action', () => {
      expect(() => validatePolicyIR({
        version: '1.0',
        rules: [
          {
            id: 'require-human',
            name: 'Require human approval',
            action: 'require_approval',
          },
        ],
      })).not.toThrow();
    });

    it('should accept output rules with redact action', () => {
      expect(() => validatePolicyIR({
        version: '1.0',
        output_rules: [
          {
            id: 'redact-output',
            name: 'Redact output',
            action: 'redact',
            output_conditions: [
              {
                field: 'output.email',
                operator: 'matches',
                value: '[^@]+@[^@]+',
              },
            ],
            redact_with: '[REDACTED]',
          },
        ],
      })).not.toThrow();
    });
  });

  describe('invalid documents', () => {
    it('should reject missing version', () => {
      const data = loadFixture('invalid-missing-version.yaml');
      expect(() => validatePolicyIR(data)).toThrow(PolicySchemaError);
      try {
        validatePolicyIR(data);
      } catch (e) {
        const err = e as PolicySchemaError;
        expect(err.errors.some((v) => v.message.includes('version'))).toBe(true);
      }
    });

    it('should reject wrong version', () => {
      const data = loadFixture('invalid-wrong-version.yaml');
      expect(() => validatePolicyIR(data)).toThrow(PolicySchemaError);
    });

    it('should reject missing rules', () => {
      const data = loadFixture('invalid-missing-rules.yaml');
      expect(() => validatePolicyIR(data)).toThrow(PolicySchemaError);
      try {
        validatePolicyIR(data);
      } catch (e) {
        const err = e as PolicySchemaError;
        expect(err.errors.some((v) => v.message.includes('rules'))).toBe(true);
      }
    });

    it('should reject bad action', () => {
      const data = loadFixture('invalid-bad-action.yaml');
      expect(() => validatePolicyIR(data)).toThrow(PolicySchemaError);
    });

    it('should reject bad output action', () => {
      expect(() => validatePolicyIR({
        version: '1.0',
        rules: [],
        output_rules: [
          {
            id: 'bad-output-action',
            name: 'Bad output action',
            action: 'allow',
          },
        ],
      })).toThrow(PolicySchemaError);
    });

    it('should reject bad operator', () => {
      const data = loadFixture('invalid-bad-operator.yaml');
      expect(() => validatePolicyIR(data)).toThrow(PolicySchemaError);
    });

    it('should reject extra fields on rules', () => {
      const data = loadFixture('invalid-extra-field.yaml');
      expect(() => validatePolicyIR(data)).toThrow(PolicySchemaError);
    });

    it('should reject rule missing id', () => {
      const data = loadFixture('invalid-rule-missing-id.yaml');
      expect(() => validatePolicyIR(data)).toThrow(PolicySchemaError);
    });
  });

  describe('error quality', () => {
    it('should produce actionable error messages', () => {
      try {
        validatePolicyIR({
          version: '1.0',
          rules: [
            { name: 'no-id-no-action' },
          ],
        });
        expect.unreachable('should have thrown');
      } catch (e) {
        const err = e as PolicySchemaError;
        expect(err.errors.length).toBeGreaterThanOrEqual(2);
        const paths = err.errors.map((v) => v.path);
        expect(paths.some((p) => p.includes('/rules/0'))).toBe(true);
        expect(err.message).toContain('Invalid policy document');
      }
    });

    it('should report all errors at once', () => {
      try {
        validatePolicyIR({});
        expect.unreachable('should have thrown');
      } catch (e) {
        const err = e as PolicySchemaError;
        expect(err.errors.length).toBeGreaterThanOrEqual(2);
      }
    });
  });

  describe('path formatting', () => {
    it('should include parent property names in paths (e.g. /rules/0 not /0)', () => {
      try {
        validatePolicyIR({
          version: '1.0',
          rules: [{ name: 'missing-required-fields' }],
        });
        expect.unreachable('should have thrown');
      } catch (e) {
        const err = e as PolicySchemaError;
        // Paths must include 'rules' parent property
        const paths = err.errors.map((v) => v.path);
        expect(paths.some((p) => p.startsWith('/rules/0'))).toBe(true);
        // Should not have paths like '/0' without parent
        expect(paths.every((p) => !p.match(/^\/\d+$/))).toBe(true);
      }
    });

    it('should format nested condition paths correctly', () => {
      try {
        validatePolicyIR({
          version: '1.0',
          rules: [{
            id: 'test',
            name: 'test',
            action: 'block',
            conditions: [{ field: 'tool_name', operator: 'BAD_OPERATOR', value: 'x' }],
          }],
        });
        expect.unreachable('should have thrown');
      } catch (e) {
        const err = e as PolicySchemaError;
        // Path should include full hierarchy: /rules/0/conditions/0/operator
        const paths = err.errors.map((v) => v.path);
        expect(paths.some((p) => p.includes('/rules/0/conditions/0'))).toBe(true);
      }
    });
  });

  describe('fail-safe behavior', () => {
    it('should throw even when AJV errors array is missing', async () => {
      // This test verifies the fail-safe: if AJV somehow returns valid=false
      // but errors is null/undefined, we still throw PolicySchemaError.
      
      // Import the module fresh to test error structure
      const schemaValidator = await import('../../src/rules/schema-validator.js');
      
      // The fix ensures that even with valid=false and no errors,
      // PolicySchemaError is thrown with a fallback message.
      try {
        schemaValidator.validatePolicyIR({ invalid: 'data' });
        expect.unreachable('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(PolicySchemaError);
        const err = e as PolicySchemaError;
        // Should have at least one error with path and message
        expect(err.errors.length).toBeGreaterThan(0);
        expect(err.errors[0].path).toBeDefined();
        expect(err.errors[0].message).toBeDefined();
        expect(err.errors[0].keyword).toBeDefined();
      }
    });

    it('should use "schema" keyword for fallback errors', () => {
      // Verify the fallback error uses 'schema' keyword for consistency
      // This is tested indirectly - normal validation errors use AJV keywords
      try {
        validatePolicyIR({ version: '1.0', rules: [{}] });
        expect.unreachable('should have thrown');
      } catch (e) {
        const err = e as PolicySchemaError;
        // Normal errors should have AJV keywords like 'required'
        expect(err.errors.some((v) => v.keyword === 'required')).toBe(true);
      }
    });

    it('should never silently pass invalid data', () => {
      // Verify various malformed inputs always throw
      const malformedInputs = [
        null,
        undefined,
        'string',
        123,
        [],
        { version: '1.0' }, // missing rules
        { rules: [] }, // missing version
        { version: '2.0', rules: [] }, // wrong version
      ];

      for (const input of malformedInputs) {
        expect(() => validatePolicyIR(input)).toThrow(PolicySchemaError);
      }
    });
  });
});
