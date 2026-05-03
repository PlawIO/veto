import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInstallCommand } from '../../src/cli/install.js';

const TMP_ROOT = `/tmp/veto-install-cli-test-${Date.now()}`;

function tmpDir(name: string): string {
  return join(TMP_ROOT, name);
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
}

describe('install cli commands', () => {
  afterEach(() => {
    if (existsSync(TMP_ROOT)) {
      rmSync(TMP_ROOT, { recursive: true, force: true });
    }
  });

  it('installs Claude Code hook and merges settings idempotently', () => {
    const projectDir = tmpDir('claude');
    const settingsPath = join(projectDir, '.claude', 'settings.json');
    mkdirSync(join(projectDir, '.claude'), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({
      permissions: {
        allow: ['Bash(git status)'],
      },
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [
              {
                type: 'command',
                command: 'echo existing',
              },
            ],
          },
        ],
      },
    }, null, 2), 'utf-8');

    const first = runInstallCommand({ target: 'claude-code', directory: projectDir });
    expect(first.ok).toBe(true);
    expect(first.data?.target).toBe('claude-code');
    expect(first.data?.hookStatus).toBe('created');
    expect(first.data?.settingsUpdated).toBe(true);

    const hookPath = join(projectDir, '.claude', 'hooks', 'veto-hook.mjs');
    expect(existsSync(hookPath)).toBe(true);
    const hook = readFileSync(hookPath, 'utf-8');
    expect(hook).toContain('hookSpecificOutput');
    expect(hook).toContain("permissionDecision,\n      permissionDecisionReason");
    expect(hook).toContain("decision === 'require_approval'");
    expect(hook).toContain("respond('ask'");
    expect(hook).toContain('Veto is not initialized');

    const settings = readJson(settingsPath) as {
      permissions?: { allow?: string[] };
      hooks?: { PreToolUse?: Array<{ hooks?: Array<{ command?: string }> }> };
    };
    expect(settings.permissions?.allow).toEqual(['Bash(git status)']);
    const preToolUse = settings.hooks?.PreToolUse ?? [];
    const commands = preToolUse.flatMap((block) => block.hooks ?? []).map((hookConfig) => hookConfig.command);
    expect(commands).toContain('echo existing');
    expect(commands.filter((command) => command === '$CLAUDE_PROJECT_DIR/.claude/hooks/veto-hook.mjs')).toHaveLength(1);

    const afterFirst = readFileSync(settingsPath, 'utf-8');
    const second = runInstallCommand({ target: 'claude-code', directory: projectDir });
    expect(second.ok).toBe(true);
    expect(second.data?.hookStatus).toBe('unchanged');
    expect(second.data?.settingsUpdated).toBe(false);
    expect(readFileSync(settingsPath, 'utf-8')).toBe(afterFirst);
  });

  it('does not overwrite custom Claude hook without --force', () => {
    const projectDir = tmpDir('claude-force');
    const hookPath = join(projectDir, '.claude', 'hooks', 'veto-hook.mjs');
    mkdirSync(join(projectDir, '.claude', 'hooks'), { recursive: true });
    writeFileSync(hookPath, 'custom hook', 'utf-8');

    const skipped = runInstallCommand({ target: 'claude-code', directory: projectDir });
    expect(skipped.ok).toBe(true);
    expect(skipped.data?.hookStatus).toBe('skipped_existing');
    expect(readFileSync(hookPath, 'utf-8')).toBe('custom hook');

    const forced = runInstallCommand({ target: 'claude-code', directory: projectDir, force: true });
    expect(forced.ok).toBe(true);
    expect(forced.data?.hookStatus).toBe('updated');
    expect(readFileSync(hookPath, 'utf-8')).toContain('hookSpecificOutput');
  });

  it.each([
    ['wrong type', { type: 'shell', command: '$CLAUDE_PROJECT_DIR/.claude/hooks/veto-hook.mjs' }],
    ['missing type', { command: '$CLAUDE_PROJECT_DIR/.claude/hooks/veto-hook.mjs' }],
  ])('normalizes existing Claude Veto hook with %s idempotently', (_caseName, hookConfig) => {
    const projectDir = tmpDir(`claude-normalize-${_caseName.replace(/\s+/g, '-')}`);
    const settingsPath = join(projectDir, '.claude', 'settings.json');
    mkdirSync(join(projectDir, '.claude'), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: '',
            hooks: [hookConfig],
          },
        ],
      },
    }, null, 2), 'utf-8');

    const first = runInstallCommand({ target: 'claude-code', directory: projectDir });
    expect(first.ok).toBe(true);
    expect(first.data?.settingsUpdated).toBe(true);

    const settings = readJson(settingsPath) as {
      hooks?: { PreToolUse?: Array<{ hooks?: Array<{ type?: string; command?: string }> }> };
    };
    const vetoHooks = (settings.hooks?.PreToolUse ?? [])
      .flatMap((block) => block.hooks ?? [])
      .filter((hook) => hook.command === '$CLAUDE_PROJECT_DIR/.claude/hooks/veto-hook.mjs');
    expect(vetoHooks).toHaveLength(1);
    expect(vetoHooks[0]?.type).toBe('command');

    const afterFirst = readFileSync(settingsPath, 'utf-8');
    const second = runInstallCommand({ target: 'claude-code', directory: projectDir });
    expect(second.ok).toBe(true);
    expect(second.data?.settingsUpdated).toBe(false);
    expect(readFileSync(settingsPath, 'utf-8')).toBe(afterFirst);
  });

  it('writes Cursor MCP config with proxy binary and preserves unrelated servers', () => {
    const projectDir = tmpDir('cursor');
    const outputPath = join(projectDir, '.cursor', 'mcp.json');
    mkdirSync(join(projectDir, '.cursor'), { recursive: true });
    writeFileSync(outputPath, JSON.stringify({
      version: 1,
      mcpServers: {
        existing: {
          command: 'node',
          args: ['server.js'],
        },
      },
    }, null, 2), 'utf-8');

    const first = runInstallCommand({ target: 'cursor', directory: projectDir, serverName: 'veto-local' });
    expect(first.ok).toBe(true);
    expect(first.data?.target).toBe('cursor');
    expect(first.data?.serverCreated).toBe(true);
    expect(first.data?.updated).toBe(true);
    expect(first.data?.gatewayConfigCreated).toBe(true);
    expect(existsSync(join(projectDir, 'veto', 'mcp.config.yaml'))).toBe(true);

    const parsed = readJson(outputPath) as {
      version?: number;
      mcpServers?: Record<string, unknown>;
    };
    expect(parsed.version).toBe(1);
    expect(parsed.mcpServers?.existing).toEqual({ command: 'node', args: ['server.js'] });
    expect(parsed.mcpServers?.['veto-local']).toEqual({
      command: 'veto-mcp-proxy',
      args: ['--config', './veto/mcp.config.yaml'],
      env: {
        VETO_API_KEY: '${env:VETO_API_KEY}',
      },
    });

    const afterFirst = readFileSync(outputPath, 'utf-8');
    const second = runInstallCommand({ target: 'cursor', directory: projectDir, serverName: 'veto-local' });
    expect(second.ok).toBe(true);
    expect(second.data?.serverCreated).toBe(false);
    expect(second.data?.updated).toBe(false);
    expect(second.data?.gatewayConfigCreated).toBe(false);
    expect(readFileSync(outputPath, 'utf-8')).toBe(afterFirst);
  });

  it('writes Cursor cloud MCP config without storing secrets', () => {
    const projectDir = tmpDir('cursor-cloud');
    const result = runInstallCommand({ target: 'cursor', directory: projectDir, cloud: true });
    expect(result.ok).toBe(true);
    expect(result.data?.target).toBe('cursor');
    expect(result.data?.mode).toBe('cloud');
    expect(result.data?.gatewayConfigPath).toBeUndefined();
    expect(existsSync(join(projectDir, 'veto', 'mcp.config.yaml'))).toBe(false);

    const parsed = readJson(join(projectDir, '.cursor', 'mcp.json')) as {
      mcpServers?: Record<string, unknown>;
    };
    expect(parsed.mcpServers?.veto).toEqual({
      url: 'https://api.veto.so/v1/mcp/default',
      serverUrl: 'https://api.veto.so/v1/mcp/default',
      headers: {
        'X-Veto-API-Key': '${env:VETO_API_KEY}',
      },
    });
  });

  it('merges Codex TOML config and updates Veto section idempotently', () => {
    const projectDir = tmpDir('codex');
    const outputPath = join(projectDir, '.codex', 'config.toml');
    mkdirSync(join(projectDir, '.codex'), { recursive: true });
    writeFileSync(outputPath, 'model = "gpt-5"\n\n[mcp_servers.existing]\ncommand = "node"\nargs = ["server.js"]\n', 'utf-8');

    const first = runInstallCommand({ target: 'codex', directory: projectDir, serverName: 'veto.local' });
    expect(first.ok).toBe(true);
    expect(first.data?.target).toBe('codex');
    expect(first.data?.serverCreated).toBe(true);
    expect(first.data?.updated).toBe(true);
    expect(first.data?.gatewayConfigCreated).toBe(true);
    expect(first.data?.trustHint).toContain('trusted');

    const content = readFileSync(outputPath, 'utf-8');
    expect(content).toContain('model = "gpt-5"');
    expect(content).toContain('[mcp_servers.existing]');
    expect(content).toContain('[mcp_servers."veto.local"]');
    expect(content).toContain('command = "veto-mcp-proxy"');
    expect(content).toContain('args = ["--config", "./veto/mcp.config.yaml"]');
    expect(content).toContain('enabled = true');
    expect(content).toContain('env_vars = ["VETO_API_KEY"]');
    expect(existsSync(join(projectDir, 'veto', 'mcp.config.yaml'))).toBe(true);

    const second = runInstallCommand({ target: 'codex', directory: projectDir, serverName: 'veto.local' });
    expect(second.ok).toBe(true);
    expect(second.data?.serverCreated).toBe(false);
    expect(second.data?.updated).toBe(false);
    expect(second.data?.gatewayConfigCreated).toBe(false);
    expect(readFileSync(outputPath, 'utf-8')).toBe(content);
  });

  it('returns deterministic error envelopes for unknown targets', () => {
    const result = runInstallCommand({ target: 'windsurf', directory: tmpDir('unknown') });
    expect(result).toEqual({
      ok: false,
      error: {
        code: 'install_target_unknown',
        message: 'Unknown install target: windsurf',
        details: {
          targets: ['claude-code', 'cursor', 'codex'],
        },
      },
    });
  });
});
