import type { GuardContext, GuardResult } from 'veto-sdk';

export const DEFAULT_VETO_API_URL = 'https://api.veto.so';
export const DEFAULT_CACHE_TTL_SECONDS = 60;
export const DEFAULT_APPROVAL_POLL_INTERVAL_MS = 2_000;
export const DEFAULT_APPROVAL_TIMEOUT_MS = 300_000;

export interface WrapperCliOptions {
  apiKey?: string;
  apiUrl: string;
  cacheTtlSeconds: number;
  offline: boolean;
}

export interface ParsedCliArgs {
  options: WrapperCliOptions;
  bashArgv: string[];
}

export type BashInvocation =
  | {
      kind: 'interactive';
      bashArgv: string[];
    }
  | {
      kind: 'command';
      bashArgv: string[];
      command: string;
    }
  | {
      kind: 'script-file';
      bashArgv: string[];
      command: string;
      scriptPath: string;
      scriptArg: string;
    }
  | {
      kind: 'stdin';
      bashArgv: string[];
      command: string;
      stdinText: string;
    };

export interface ValidationArguments extends Record<string, unknown> {
  command: string;
  cwd: string;
  argv: string[];
  shellMode: 'command' | 'script-file' | 'stdin';
  scriptPath?: string;
  stdin?: boolean;
}

export interface ValidationRequestContext extends Record<string, unknown> {
  sessionId?: string;
  agentId?: string;
  userId?: string;
  role?: string;
  cwd: string;
  shellMode: 'command' | 'script-file' | 'stdin';
  bashArgv: string[];
  scriptPath?: string;
}

export interface DenialDetails {
  policyId?: string;
  policyName?: string;
  severity?: 'deny' | 'require_approval';
  matchedCondition?: string;
  suggestedFixes?: string[];
  docsUrl?: string;
  input?: Record<string, unknown>;
}

export interface ValidationDecision {
  decision: 'allow' | 'deny' | 'require_approval';
  reason?: string;
  approvalId?: string;
  denial?: DenialDetails;
  metadata?: Record<string, unknown>;
}

export interface TerminalDecision {
  decision: 'allow' | 'deny';
  reason?: string;
  denial?: DenialDetails;
  source: 'cloud' | 'local' | 'cloud-fallback-local' | 'cache';
}

export interface ApprovalRecord {
  id: string;
  toolName?: string;
  arguments?: Record<string, unknown>;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  expiresAt?: string;
  resolvedBy?: string;
  resolvedAt?: string;
  createdAt?: string;
}

export interface ApprovalPollOptions {
  pollIntervalMs?: number;
  timeoutMs?: number;
}

export interface PolicyClientLike {
  validate(
    toolName: string,
    args: Record<string, unknown>,
    context?: Record<string, unknown>
  ): Promise<ValidationDecision>;
  pollApproval(approvalId: string, options?: ApprovalPollOptions): Promise<ApprovalRecord>;
}

export interface LocalProjectConfig {
  vetoDir: string;
  configPath: string;
  mode?: 'strict' | 'log' | 'shadow';
  rulesDir: string;
  recursive: boolean;
  approvalPollIntervalMs?: number;
  approvalTimeoutMs?: number;
}

export interface LocalEvaluationInput {
  project: LocalProjectConfig;
  args: ValidationArguments;
  context: GuardContext;
}

export interface CachedDecision {
  decision: 'allow' | 'deny';
  reason?: string;
  denial?: DenialDetails;
  source: TerminalDecision['source'];
}

export interface CacheKeyInput {
  requestedMode: 'cloud' | 'local' | 'offline';
  apiUrl?: string;
  apiKeyNamespace?: string;
  command: string;
  cwd: string;
  bashArgv: string[];
  shellMode: 'command' | 'script-file' | 'stdin';
  scriptPath?: string;
  vetoDir?: string;
}

export interface DecisionCacheLike {
  get(key: CacheKeyInput): CachedDecision | null;
  set(key: CacheKeyInput, value: CachedDecision, ttlSeconds: number): void;
}

export interface ExecutionResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export interface WrapperRunResult {
  exitCode: number;
  signal?: NodeJS.Signals;
}

export interface RunVetoBashOptions {
  argv?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stderr?: Pick<NodeJS.WriteStream, 'write'>;
  stdinIsTTY?: boolean;
  readStdin?: () => Promise<string>;
  readFile?: (path: string) => Promise<string>;
  currentScriptPath?: string;
  policyClientFactory?: (options: { apiKey: string; apiUrl: string }) => PolicyClientLike;
  cache?: DecisionCacheLike;
  findLocalProject?: (startDir: string) => LocalProjectConfig | null;
  evaluateLocal?: (input: LocalEvaluationInput) => Promise<GuardResult>;
  resolveRealBash?: (options: { env: NodeJS.ProcessEnv; currentScriptPath: string }) => string;
  executeRealBash?: (
    realBashPath: string,
    bashArgv: string[],
    stdinText?: string
  ) => Promise<ExecutionResult>;
}
