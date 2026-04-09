import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PersistentDecisionCache } from '../src/cache.js';
import { clearLocalVetoCache } from '../src/local.js';
import { ApprovalTimeoutError, PolicyNetworkError } from '../src/policy-client.js';
import { runVetoBash } from '../src/runner.js';
import { resolveRealBashPath } from '../src/bash.js';
import type { PolicyClientLike } from '../src/types.js';

function createTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeLocalPolicy(rootDir: string, ruleBody: string): string {
  const vetoDir = join(rootDir, 'veto');
  const rulesDir = join(vetoDir, 'rules');
  mkdirSync(rulesDir, { recursive: true });
  writeFileSync(
    join(vetoDir, 'veto.config.yaml'),
    'version: "1.0"\nmode: "strict"\nrules:\n  directory: "./rules"\n  recursive: true\n',
    'utf-8'
  );
  writeFileSync(join(rulesDir, 'bash.yaml'), ruleBody, 'utf-8');
  return vetoDir;
}

function createPolicyClient(overrides: Partial<PolicyClientLike>): PolicyClientLike {
  return {
    validate: vi.fn(async () => ({ decision: 'allow' })),
    pollApproval: vi.fn(async () => ({ id: 'appr-1', status: 'approved' })),
    ...overrides,
  };
}

describe('veto-bash runner', () => {
  let stderr = '';

  beforeEach(() => {
    stderr = '';
    clearLocalVetoCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('allows -c commands after a cloud allow decision', async () => {
    const executeRealBash = vi.fn(async () => ({ exitCode: 0, signal: null }));
    const policyClient = createPolicyClient({
      validate: vi.fn(async () => ({ decision: 'allow', reason: 'ok' })),
    });

    const result = await runVetoBash({
      argv: ['--veto-api-key', 'test-key', '--cache-ttl', '0', '-c', 'echo hello'],
      stderr: { write: (chunk: string) => { stderr += chunk; return true; } },
      currentScriptPath: '/tmp/veto-bash.js',
      policyClientFactory: () => policyClient,
      resolveRealBash: () => '/bin/bash',
      executeRealBash,
    });

    expect(result.exitCode).toBe(0);
    expect(policyClient.validate).toHaveBeenCalledWith(
      'bash',
      expect.objectContaining({ command: 'echo hello', shellMode: 'command' }),
      expect.objectContaining({ shellMode: 'command' })
    );
    expect(executeRealBash).toHaveBeenCalledWith('/bin/bash', ['-c', 'echo hello'], undefined);
    expect(stderr).toBe('');
  });

  it('denies -c commands and prints policy guidance', async () => {
    const policyClient = createPolicyClient({
      validate: vi.fn(async () => ({
        decision: 'deny',
        reason: 'Blocked by policy',
        denial: {
          suggestedFixes: ['Use --dry-run', 'Remove rm -rf'],
          docsUrl: 'https://docs.veto.so/bash',
        },
      })),
    });

    const result = await runVetoBash({
      argv: ['--veto-api-key', 'test-key', '--cache-ttl', '0', '-c', 'rm -rf /tmp/demo'],
      stderr: { write: (chunk: string) => { stderr += chunk; return true; } },
      currentScriptPath: '/tmp/veto-bash.js',
      policyClientFactory: () => policyClient,
      resolveRealBash: () => '/bin/bash',
      executeRealBash: vi.fn(async () => ({ exitCode: 0, signal: null })),
    });

    expect(result.exitCode).toBe(1);
    expect(stderr).toContain('Blocked by policy');
    expect(stderr).toContain('Use --dry-run');
    expect(stderr).toContain('https://docs.veto.so/bash');
  });

  it('uses offline local evaluation when requested', async () => {
    const rootDir = createTempDir('veto-bash-offline-');
    writeLocalPolicy(
      rootDir,
      'version: "1.0"\nrules:\n  - id: block-rm\n    name: Block rm\n    description: No deletes\n    enabled: true\n    action: block\n    tools: [bash]\n    conditions:\n      - field: arguments.command\n        operator: contains\n        value: "rm -rf"\n'
    );

    const result = await runVetoBash({
      argv: ['--offline', '--cache-ttl', '0', '-c', 'rm -rf /tmp/demo'],
      cwd: rootDir,
      stderr: { write: (chunk: string) => { stderr += chunk; return true; } },
      currentScriptPath: '/tmp/veto-bash.js',
      resolveRealBash: () => '/bin/bash',
      executeRealBash: vi.fn(async () => ({ exitCode: 0, signal: null })),
    });

    expect(result.exitCode).toBe(1);
    expect(stderr).toContain('No deletes');
  });

  it('falls back to local evaluation when the cloud API is unreachable', async () => {
    const rootDir = createTempDir('veto-bash-fallback-');
    writeLocalPolicy(
      rootDir,
      'version: "1.0"\nrules:\n  - id: allow-echo\n    name: Allow echo\n    description: Allow echo\n    enabled: true\n    action: allow\n    tools: [bash]\n    conditions:\n      - field: arguments.command\n        operator: contains\n        value: "echo hello"\n'
    );

    const executeRealBash = vi.fn(async () => ({ exitCode: 0, signal: null }));
    const policyClient = createPolicyClient({
      validate: vi.fn(async () => {
        throw new PolicyNetworkError('connect ECONNREFUSED');
      }),
    });

    const result = await runVetoBash({
      argv: ['--veto-api-key', 'test-key', '--cache-ttl', '0', '-c', 'echo hello'],
      cwd: rootDir,
      stderr: { write: (chunk: string) => { stderr += chunk; return true; } },
      currentScriptPath: '/tmp/veto-bash.js',
      policyClientFactory: () => policyClient,
      resolveRealBash: () => '/bin/bash',
      executeRealBash,
    });

    expect(result.exitCode).toBe(0);
    expect(executeRealBash).toHaveBeenCalledTimes(1);
  });

  it('does not reuse fallback-local cache entries for later cloud-success invocations', async () => {
    const rootDir = createTempDir('veto-bash-fallback-cache-');
    writeLocalPolicy(
      rootDir,
      'version: "1.0"\nrules:\n  - id: allow-echo\n    name: Allow echo\n    description: Allow echo\n    enabled: true\n    action: allow\n    tools: [bash]\n    conditions:\n      - field: arguments.command\n        operator: contains\n        value: "echo hello"\n'
    );

    const cachePath = join(createTempDir('veto-bash-fallback-cache-file-'), 'cache.json');
    const validate = vi
      .fn()
      .mockRejectedValueOnce(new PolicyNetworkError('connect ECONNREFUSED'))
      .mockResolvedValueOnce({ decision: 'allow', reason: 'cloud restored' });
    const executeRealBash = vi.fn(async () => ({ exitCode: 0, signal: null }));

    await runVetoBash({
      argv: ['--veto-api-key', 'test-key', '--cache-ttl', '60', '-c', 'echo hello'],
      cwd: rootDir,
      stderr: { write: (chunk: string) => { stderr += chunk; return true; } },
      cache: new PersistentDecisionCache(cachePath),
      currentScriptPath: '/tmp/veto-bash.js',
      policyClientFactory: () => createPolicyClient({
        validate,
        pollApproval: vi.fn(async () => ({ id: 'appr-1', status: 'approved' })),
      }),
      resolveRealBash: () => '/bin/bash',
      executeRealBash,
    });

    await runVetoBash({
      argv: ['--veto-api-key', 'test-key', '--cache-ttl', '60', '-c', 'echo hello'],
      cwd: rootDir,
      stderr: { write: (chunk: string) => { stderr += chunk; return true; } },
      cache: new PersistentDecisionCache(cachePath),
      currentScriptPath: '/tmp/veto-bash.js',
      policyClientFactory: () => createPolicyClient({
        validate,
        pollApproval: vi.fn(async () => ({ id: 'appr-1', status: 'approved' })),
      }),
      resolveRealBash: () => '/bin/bash',
      executeRealBash,
    });

    expect(validate).toHaveBeenCalledTimes(2);
    const cacheContent = JSON.parse(readFileSync(cachePath, 'utf-8')) as { entries: Record<string, unknown> };
    expect(Object.keys(cacheContent.entries)).toHaveLength(1);
  });

  it('reads cached decisions from disk across separate cache instances', async () => {
    const cachePath = join(createTempDir('veto-bash-cache-'), 'cache.json');
    const policyClient = createPolicyClient({
      validate: vi.fn(async () => ({ decision: 'allow', reason: 'ok' })),
    });
    const executeRealBash = vi.fn(async () => ({ exitCode: 0, signal: null }));

    await runVetoBash({
      argv: ['--veto-api-key', 'test-key', '--cache-ttl', '60', '-c', 'echo cached'],
      stderr: { write: (chunk: string) => { stderr += chunk; return true; } },
      cache: new PersistentDecisionCache(cachePath),
      currentScriptPath: '/tmp/veto-bash.js',
      policyClientFactory: () => policyClient,
      resolveRealBash: () => '/bin/bash',
      executeRealBash,
    });

    await runVetoBash({
      argv: ['--veto-api-key', 'test-key', '--cache-ttl', '60', '-c', 'echo cached'],
      stderr: { write: (chunk: string) => { stderr += chunk; return true; } },
      cache: new PersistentDecisionCache(cachePath),
      currentScriptPath: '/tmp/veto-bash.js',
      policyClientFactory: () => policyClient,
      resolveRealBash: () => '/bin/bash',
      executeRealBash,
    });

    expect(policyClient.validate).toHaveBeenCalledTimes(1);
    const cacheContent = JSON.parse(readFileSync(cachePath, 'utf-8')) as { entries: Record<string, unknown> };
    expect(Object.keys(cacheContent.entries)).toHaveLength(1);
  });

  it('validates script files before execution', async () => {
    const rootDir = createTempDir('veto-bash-script-');
    const scriptPath = join(rootDir, 'deploy.sh');
    writeFileSync(scriptPath, 'echo from script\n', 'utf-8');
    const policyClient = createPolicyClient({
      validate: vi.fn(async () => ({ decision: 'allow' })),
    });

    await runVetoBash({
      argv: ['--veto-api-key', 'test-key', '--cache-ttl', '0', scriptPath, 'staging'],
      cwd: rootDir,
      stderr: { write: (chunk: string) => { stderr += chunk; return true; } },
      currentScriptPath: '/tmp/veto-bash.js',
      policyClientFactory: () => policyClient,
      resolveRealBash: () => '/bin/bash',
      executeRealBash: vi.fn(async () => ({ exitCode: 0, signal: null })),
    });

    expect(policyClient.validate).toHaveBeenCalledWith(
      'bash',
      expect.objectContaining({ command: 'echo from script\n', shellMode: 'script-file', scriptPath }),
      expect.any(Object)
    );
  });

  it('buffers stdin for -s validation and replays it to real bash', async () => {
    const executeRealBash = vi.fn(async () => ({ exitCode: 0, signal: null }));
    const policyClient = createPolicyClient({
      validate: vi.fn(async () => ({ decision: 'allow' })),
    });

    await runVetoBash({
      argv: ['--veto-api-key', 'test-key', '--cache-ttl', '0', '-s'],
      stderr: { write: (chunk: string) => { stderr += chunk; return true; } },
      stdinIsTTY: false,
      readStdin: async () => 'echo stdin\n',
      currentScriptPath: '/tmp/veto-bash.js',
      policyClientFactory: () => policyClient,
      resolveRealBash: () => '/bin/bash',
      executeRealBash,
    });

    expect(policyClient.validate).toHaveBeenCalledWith(
      'bash',
      expect.objectContaining({ command: 'echo stdin\n', shellMode: 'stdin', stdin: true }),
      expect.any(Object)
    );
    expect(executeRealBash).toHaveBeenCalledWith('/bin/bash', ['-s'], 'echo stdin\n');
  });

  it('polls approvals until approved', async () => {
    const executeRealBash = vi.fn(async () => ({ exitCode: 0, signal: null }));
    const policyClient = createPolicyClient({
      validate: vi.fn(async () => ({ decision: 'require_approval', approvalId: 'appr-1', reason: 'Needs review' })),
      pollApproval: vi.fn(async () => ({ id: 'appr-1', status: 'approved', resolvedBy: 'admin@example.com' })),
    });

    const result = await runVetoBash({
      argv: ['--veto-api-key', 'test-key', '--cache-ttl', '0', '-c', 'echo gated'],
      stderr: { write: (chunk: string) => { stderr += chunk; return true; } },
      currentScriptPath: '/tmp/veto-bash.js',
      policyClientFactory: () => policyClient,
      resolveRealBash: () => '/bin/bash',
      executeRealBash,
    });

    expect(result.exitCode).toBe(0);
    expect(policyClient.pollApproval).toHaveBeenCalledWith('appr-1', expect.any(Object));
  });

  it('fails closed when approval polling times out', async () => {
    const policyClient = createPolicyClient({
      validate: vi.fn(async () => ({ decision: 'require_approval', approvalId: 'appr-1', reason: 'Needs review' })),
      pollApproval: vi.fn(async () => {
        throw new ApprovalTimeoutError('appr-1', 50);
      }),
    });

    const result = await runVetoBash({
      argv: ['--veto-api-key', 'test-key', '--cache-ttl', '0', '-c', 'echo gated-timeout'],
      stderr: { write: (chunk: string) => { stderr += chunk; return true; } },
      currentScriptPath: '/tmp/veto-bash.js',
      policyClientFactory: () => policyClient,
      resolveRealBash: () => '/bin/bash',
      executeRealBash: vi.fn(async () => ({ exitCode: 0, signal: null })),
    });

    expect(result.exitCode).toBe(1);
    expect(stderr).toContain('Approval timed out');
  });

  it('guards against recursively resolving the wrapper as the real bash binary', () => {
    const wrapperPath = join(createTempDir('veto-bash-wrapper-'), 'bin.js');
    writeFileSync(wrapperPath, '#!/usr/bin/env node\nconsole.log("wrapper")\n', 'utf-8');

    expect(() => resolveRealBashPath({
      env: { VETO_BASH_REAL_BASH: wrapperPath },
      currentScriptPath: wrapperPath,
    })).toThrow(/Refusing to exec veto-bash recursively/);
  });
});
