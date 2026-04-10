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
export { startStudio, selectStudioRenderer, type StartStudioOptions } from './studio/start.js';
export { runCli, runCliOrExit } from './runner.js';
export {
  printHeadlessResult,
  runPolicyGenerateCommand,
  runPolicyApplyCommand,
  runGuardCheckCommand,
  runDoctorCommand,
  runCloudLoginCommand,
  runCloudWhoamiCommand,
  runCloudOrgUseCommand,
  runCloudProjectUseCommand,
  runCloudLogoutCommand,
  resolvePolicySavePath,
  type HeadlessResult,
} from './headless.js';
export {
  loadMcpConfig,
  createDefaultMcpConfigTemplate,
  runMcpInitCommand,
  runMcpConnectCommand,
  runMcpDoctorCommand,
  runMcpServeCommand,
  resolveMcpConfigForTesting,
  type McpConfig,
  type McpServeOptions,
  type McpDoctorOptions,
  type McpInitOptions,
  type McpConnectOptions,
  type McpDoctorReport,
} from './mcp.js';
export {
  createInitialStudioState,
  discoverWorkspaceCandidates,
  loadStudioPreferences,
  persistStudioPreferences,
  resolvePreferredWorkspaceIndex,
  type StudioState,
  type StudioView,
  type StudioRendererPreference,
  type StudioRendererMode,
  type StudioWorkspaceCandidate,
} from './studio/state.js';
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
  checkGenerationConnectivity,
  type ReplIntent,
  type ReplIntentResult,
  type GeneratePolicyRequest,
  type GeneratePolicyResponse,
  type GeneratePolicyResult,
  type GenerationConnectivityResult,
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
  type RuleChange,
} from './diff.js';
export {
  replay,
  type ReplayOptions,
  type ReplayResult,
  type ReplayReport,
  type ReplayChangedCall,
  type ReplayDeniedGroup,
} from './replay.js';
export {
  parseReplayLog,
  parseReplayLogContent,
  replayCalls,
  countDecisions,
  loadPolicySnapshot,
  type ReplayCall,
  type ReplayDecision,
  type PolicySnapshot,
  type DecisionCounts,
  type ParsedReplayLog,
} from './replay-engine.js';
