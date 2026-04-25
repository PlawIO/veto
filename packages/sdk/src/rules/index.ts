/**
 * Rules module exports.
 *
 * @module rules
 */

export * from './types.js';
export * from './loader.js';
export * from './api-client.js';
export * from './rule-validator.js';
export * from './expression-validator.js';
export * from './schema-validator.js';
export * from './policy-ir-schema.js';
export * from './condition-evaluator.js';
export * from './patterns.js';
// NOTE: `./pipeline-dsl.js` is deliberately NOT re-exported here. It depends
// on `zod` (optional peerDep) and `node:crypto`. Consumers import it via the
// dedicated `veto-sdk/rules/pipeline-dsl` subpath so that the rules barrel
// remains zod-free for existing callers.
export { InMemoryFeedProvider, resolveFeedRef } from './feed-provider.js';
export {
  evaluateRulesLocally,
  evaluateCondition as evaluateConditionLocally,
  resolveFieldPath as resolveLocalFieldPath,
  type LocalEvalResult,
  type LocalEvalOptions,
} from './local-evaluator.js';
export {
  getBuiltInPolicyPackNames,
  normalizePolicyPackName,
  resolveBuiltInPolicyPackPath,
} from './policy-packs.js';
