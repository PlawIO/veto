/**
 * Policy generation utilities.
 *
 * @module policy
 */

export {
  BROWSER_AGENT_SYSTEM_PROMPT,
  getPolicyOutputSchema,
  sanitizeGeneratedRules,
  validatePolicyOutput,
  tryInstantGeneration,
  looksLikePolicyDeclaration,
  reviewPolicyRequest,
  type PolicyGenerationResult,
  type PolicyClarificationRequest,
} from './generator.js';
