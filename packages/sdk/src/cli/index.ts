/**
 * CLI module exports.
 *
 * @module cli
 */

export { init, isInitialized, getVetoDir, type InitOptions, type InitResult } from './init.js';
export {
  loadVetoConfig,
  findVetoDir,
  loadEnvOverrides,
  type VetoConfigFile,
  type LoadedVetoConfig,
  type LoadConfigOptions,
} from './config.js';
export { DEFAULT_CONFIG, DEFAULT_RULES } from './templates.js';
export {
  Observer,
  PolicyGenerator,
  parseDuration,
  policiesToYaml,
  type ObservedCall,
  type StopCondition,
  type LearnOptions,
  type ToolObservation,
  type ArgumentObservation,
  type GeneratedPolicy,
} from './learn.js';
export { compile, CompileError, type CompileOptions, type CompileResult } from './compile.js';
export {
  test,
  GapAnalyzer,
  UncoveredToolAnalyzer,
  SplittingAttackAnalyzer,
  UncheckedFieldAnalyzer,
  RegexBypassAnalyzer,
  CrossToolAnalyzer,
  TypeCoercionAnalyzer,
  loadRuleSets,
  type TestOptions,
  type TestResult,
  type TestReport,
  type Gap,
  type GapSeverity,
  type Analyzer,
  type ParsedRule,
  type ParsedRuleSet,
  type ParsedCondition,
} from './test.js';
export {
  scan,
  type ScanOptions,
  type ScanResult,
  type ScanReport,
  type DiscoveredTool,
  type Suggestion,
} from './scan.js';
export {
  startRepl,
  executeReplInput,
  parseTestInvocation,
  evaluateToolCallHybrid,
  loadHistoryFile,
  persistHistoryFile,
  type ReplCommandResult,
  type StartReplOptions,
} from './repl.js';
export {
  createReplSessionContext,
  clearSessionRules,
  loadSessionRulesFromFile,
  exportRulesYaml,
  listRuleSummaries,
  rescanReplContext,
  reloadReplContext,
  findRuleById,
  getRuleSourceInfo,
  getRulesForTool,
  type ReplSessionContext,
  type RuleSourceInfo,
} from './repl-context.js';
export {
  resolveEndpointConfig,
  generatePolicyFromPrompt,
  explainRule,
  interpretNaturalLanguageIntent,
  generateTemplatePolicy,
  validateGeneratedYaml,
  buildTemplateExplanation,
  type ReplIntent,
  type ReplIntentResult,
  type GeneratePolicyRequest,
  type GeneratePolicyResponse,
  type GeneratePolicyResult,
  type ExplainPolicyRequest,
  type ExplainPolicyResponse,
  type ExplainPolicyResult,
  type GenerationMode,
} from './repl-generate.js';
export {
  diff,
  type DiffOptions,
  type DiffResult,
  type DiffReport,
  type StructuralDiff,
  type ImpactReport,
  type ReplayCall,
  type ReplayDecision,
  type RuleChange,
} from './diff.js';
