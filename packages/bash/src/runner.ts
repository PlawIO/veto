import { fileURLToPath } from 'node:url';
import type { GuardContext, GuardResult } from 'veto-sdk';
import { PersistentDecisionCache, hashSecret } from './cache.js';
import { buildValidationArguments, buildValidationRequestContext, parseCliArgs, readAllStdin, resolveBashInvocation } from './invocation.js';
import { executeRealBash, resolveRealBashPath } from './bash.js';
import { evaluateLocally, findLocalProject } from './local.js';
import { ApprovalTimeoutError, BashPolicyClient, PolicyHttpError, PolicyNetworkError } from './policy-client.js';
import type {
  CacheKeyInput,
  CachedDecision,
  LocalProjectConfig,
  PolicyClientLike,
  RunVetoBashOptions,
  TerminalDecision,
  ValidationArguments,
  ValidationRequestContext,
  WrapperRunResult,
} from './types.js';
import {
  DEFAULT_APPROVAL_POLL_INTERVAL_MS,
  DEFAULT_APPROVAL_TIMEOUT_MS,
} from './types.js';

function toGuardContext(context: ValidationRequestContext): GuardContext {
  return {
    sessionId: context.sessionId,
    agentId: context.agentId,
    userId: context.userId,
    role: context.role,
    custom: {
      cwd: context.cwd,
      bashArgv: context.bashArgv,
      shellMode: context.shellMode,
      scriptPath: context.scriptPath,
    },
  };
}

function formatDecisionMessage(decision: Pick<TerminalDecision, 'reason' | 'denial'>): string {
  const lines = [`[veto-bash] ${decision.reason ?? 'Blocked by policy.'}`];

  const suggestedFixes = decision.denial?.suggestedFixes?.filter((value) => value.trim().length > 0) ?? [];
  if (suggestedFixes.length > 0) {
    lines.push(`[veto-bash] fixes: ${suggestedFixes.join(' | ')}`);
  }

  if (decision.denial?.docsUrl) {
    lines.push(`[veto-bash] docs: ${decision.denial.docsUrl}`);
  }

  return `${lines.join('\n')}\n`;
}

function cacheKeyFor(
  requestedMode: 'cloud' | 'local' | 'offline',
  apiUrl: string,
  apiKey: string | undefined,
  args: ValidationArguments,
  bashArgv: string[],
  project: LocalProjectConfig | null
): CacheKeyInput {
  return {
    requestedMode,
    apiUrl,
    apiKeyHash: hashSecret(apiKey),
    command: args.command,
    cwd: args.cwd,
    bashArgv,
    shellMode: args.shellMode,
    scriptPath: args.scriptPath,
    vetoDir: project?.vetoDir,
  };
}

function toCachedDecision(decision: TerminalDecision): CachedDecision {
  return {
    decision: decision.decision,
    reason: decision.reason,
    denial: decision.denial,
    source: decision.source,
  };
}

function fromCachedDecision(decision: CachedDecision): TerminalDecision {
  return {
    decision: decision.decision,
    reason: decision.reason,
    denial: decision.denial,
    source: 'cache',
  };
}

function shouldCacheDecision(decision: TerminalDecision): boolean {
  return decision.source !== 'cloud-fallback-local';
}

function resolveApprovalOptions(project: LocalProjectConfig | null): { pollIntervalMs: number; timeoutMs: number } {
  return {
    pollIntervalMs: project?.approvalPollIntervalMs ?? DEFAULT_APPROVAL_POLL_INTERVAL_MS,
    timeoutMs: project?.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS,
  };
}

function normalizeLocalDecision(result: GuardResult, source: TerminalDecision['source']): TerminalDecision {
  if (result.decision === 'allow') {
    return {
      decision: 'allow',
      reason: result.reason,
      source,
    };
  }

  if (result.decision === 'require_approval') {
    return {
      decision: 'deny',
      reason: `Approval required: ${result.reason ?? 'Local policy requires human review, but no cloud approval flow is available.'}`,
      denial: {
        severity: 'require_approval',
      },
      source,
    };
  }

  return {
    decision: 'deny',
    reason: result.reason,
    denial: result.severity
      ? { severity: 'deny' }
      : undefined,
    source,
  };
}

async function resolveCloudDecision(
  client: PolicyClientLike,
  args: ValidationArguments,
  context: ValidationRequestContext,
  project: LocalProjectConfig | null
): Promise<TerminalDecision> {
  const validation = await client.validate('bash', args, context);

  if (validation.decision === 'allow') {
    return {
      decision: 'allow',
      reason: validation.reason,
      source: 'cloud',
    };
  }

  if (validation.decision === 'deny') {
    return {
      decision: 'deny',
      reason: validation.reason,
      denial: validation.denial,
      source: 'cloud',
    };
  }

  const approvalId = validation.approvalId;
  if (!approvalId) {
    return {
      decision: 'deny',
      reason: validation.reason ?? 'Approval required but no approval ID was returned by the server.',
      denial: validation.denial,
      source: 'cloud',
    };
  }

  try {
    const approval = await client.pollApproval(approvalId, resolveApprovalOptions(project));

    if (approval.status === 'approved') {
      return {
        decision: 'allow',
        reason: `Approved by human${approval.resolvedBy ? `: ${approval.resolvedBy}` : ''}`,
        source: 'cloud',
      };
    }

    return {
      decision: 'deny',
      reason: `Approval ${approval.status}: ${validation.reason ?? 'no reason provided'}`,
      denial: validation.denial,
      source: 'cloud',
    };
  } catch (error) {
    if (error instanceof ApprovalTimeoutError) {
      return {
        decision: 'deny',
        reason: 'Approval timed out waiting for human review.',
        denial: validation.denial,
        source: 'cloud',
      };
    }

    throw error;
  }
}

async function resolveLocalDecision(
  project: LocalProjectConfig,
  args: ValidationArguments,
  context: ValidationRequestContext,
  source: TerminalDecision['source'],
  evaluateLocalImpl: NonNullable<RunVetoBashOptions['evaluateLocal']>
): Promise<TerminalDecision> {
  const result = await evaluateLocalImpl({
    project,
    args,
    context: toGuardContext(context),
  });

  return normalizeLocalDecision(result, source);
}

function writeStderr(stderr: Pick<NodeJS.WriteStream, 'write'>, message: string): WrapperRunResult {
  stderr.write(message);
  return { exitCode: 1 };
}

function makePolicyClient(apiKey: string, apiUrl: string): PolicyClientLike {
  return new BashPolicyClient({ apiKey, apiUrl });
}

export async function runVetoBash(options: RunVetoBashOptions = {}): Promise<WrapperRunResult> {
  const argv = options.argv ?? process.argv.slice(2);
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const stderr = options.stderr ?? process.stderr;
  const currentScriptPath = options.currentScriptPath ?? fileURLToPath(import.meta.url);
  const cache = options.cache ?? new PersistentDecisionCache();
  const policyClientFactory = options.policyClientFactory ?? ((input) => makePolicyClient(input.apiKey, input.apiUrl));
  const findLocalProjectImpl = options.findLocalProject ?? findLocalProject;
  const evaluateLocalImpl = options.evaluateLocal ?? evaluateLocally;
  const executeRealBashImpl = options.executeRealBash ?? executeRealBash;
  const resolveRealBashImpl = options.resolveRealBash ?? resolveRealBashPath;

  const parsed = parseCliArgs(argv, env);
  const invocation = await resolveBashInvocation(parsed.bashArgv, {
    cwd,
    stdinIsTTY: options.stdinIsTTY ?? process.stdin.isTTY ?? false,
    readFile: options.readFile,
    readStdin: options.readStdin ?? (() => readAllStdin()),
  });

  const realBashPath = resolveRealBashImpl({ env, currentScriptPath });

  if (invocation.kind === 'interactive') {
    const result = await executeRealBashImpl(realBashPath, invocation.bashArgv);
    return result.signal
      ? { exitCode: 128, signal: result.signal }
      : { exitCode: result.exitCode ?? 0 };
  }

  const validationArgs = buildValidationArguments(invocation, cwd);
  const validationContext = buildValidationRequestContext(invocation, cwd, env);
  const requestedMode = parsed.options.offline
    ? 'offline'
    : parsed.options.apiKey
      ? 'cloud'
      : 'local';
  const project = findLocalProjectImpl(cwd);
  const cacheEnabled = parsed.options.cacheTtlSeconds > 0;
  const cacheKey = cacheKeyFor(
    requestedMode,
    parsed.options.apiUrl,
    parsed.options.apiKey,
    validationArgs,
    invocation.bashArgv,
    project
  );
  const cached = cacheEnabled ? cache.get(cacheKey) : null;

  if (cached) {
    const decision = fromCachedDecision(cached);
    if (decision.decision === 'deny') {
      return writeStderr(stderr, formatDecisionMessage(decision));
    }

    const result = await executeRealBashImpl(
      realBashPath,
      invocation.bashArgv,
      invocation.kind === 'stdin' ? invocation.stdinText : undefined
    );
    return result.signal
      ? { exitCode: 128, signal: result.signal }
      : { exitCode: result.exitCode ?? 0 };
  }

  let terminalDecision: TerminalDecision;

  if (parsed.options.offline) {
    if (!project) {
      return writeStderr(
        stderr,
        `[veto-bash] Offline mode requested but no local veto/veto.config.yaml was found from ${cwd}.\n`
      );
    }

    terminalDecision = await resolveLocalDecision(project, validationArgs, validationContext, 'local', evaluateLocalImpl);
  } else if (parsed.options.apiKey) {
    const client = policyClientFactory({ apiKey: parsed.options.apiKey, apiUrl: parsed.options.apiUrl });

    try {
      terminalDecision = await resolveCloudDecision(client, validationArgs, validationContext, project);
    } catch (error) {
      if (error instanceof PolicyNetworkError) {
        if (!project) {
          return writeStderr(
            stderr,
            `[veto-bash] Cloud validation failed: ${error.message}. No local veto/veto.config.yaml was found from ${cwd}, so execution was blocked.\n`
          );
        }

        terminalDecision = await resolveLocalDecision(project, validationArgs, validationContext, 'cloud-fallback-local', evaluateLocalImpl);
      } else if (error instanceof PolicyHttpError) {
        return writeStderr(stderr, `[veto-bash] ${error.message}\n`);
      } else {
        throw error;
      }
    }
  } else if (project) {
    terminalDecision = await resolveLocalDecision(project, validationArgs, validationContext, 'local', evaluateLocalImpl);
  } else {
    return writeStderr(
      stderr,
      `[veto-bash] No Veto policy source configured. Set VETO_API_KEY or add veto/veto.config.yaml near ${cwd}.\n`
    );
  }

  if (terminalDecision.decision === 'deny') {
    if (cacheEnabled && shouldCacheDecision(terminalDecision)) {
      cache.set(cacheKey, toCachedDecision(terminalDecision), parsed.options.cacheTtlSeconds);
    }
    return writeStderr(stderr, formatDecisionMessage(terminalDecision));
  }

  if (cacheEnabled && shouldCacheDecision(terminalDecision)) {
    cache.set(cacheKey, toCachedDecision(terminalDecision), parsed.options.cacheTtlSeconds);
  }
  const result = await executeRealBashImpl(
    realBashPath,
    invocation.bashArgv,
    invocation.kind === 'stdin' ? invocation.stdinText : undefined
  );

  return result.signal
    ? { exitCode: 128, signal: result.signal }
    : { exitCode: result.exitCode ?? 0 };
}

export async function runCliOrExit(options: RunVetoBashOptions = {}): Promise<void> {
  try {
    const result = await runVetoBash(options);
    if (result.signal) {
      process.kill(process.pid, result.signal);
    }
    process.exit(result.exitCode);
  } catch (error) {
    const stderr = options.stderr ?? process.stderr;
    stderr.write(`[veto-bash] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
