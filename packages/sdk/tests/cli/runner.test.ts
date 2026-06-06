import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('cli agent compatibility', () => {
  const originalCwd = process.cwd();

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
    vi.doUnmock('../../src/cli/agent.js');
    vi.doUnmock('../../src/cli/install.js');
    vi.doUnmock('../../src/cli/headless.js');
    vi.doUnmock('../../src/cli/mcp.js');
    vi.doUnmock('../../src/cli/mcp-import.js');
    vi.doUnmock('../../src/cli/receipts.js');
  });

  it('prints agent help without deprecated label or warning', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const { runCli } = await import('../../src/cli/runner.js');

    await expect(runCli(['agent'])).resolves.toBe(0);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith('Agent commands:');
    expect(logSpy).not.toHaveBeenCalledWith('Agent commands (deprecated):');
  });

  it('dispatches compatibility subcommands without deprecation warning', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const agentPolicyList = vi.fn().mockResolvedValue(undefined);

    vi.doMock('../../src/cli/agent.js', () => ({
      agentConfig: vi.fn(),
      agentInit: vi.fn(),
      agentPolicyAdd: vi.fn(),
      agentPolicyList,
      agentScan: vi.fn(),
    }));

    const { runCli } = await import('../../src/cli/runner.js');

    await expect(runCli(['agent', 'policy', 'list'])).resolves.toBe(0);
    expect(agentPolicyList).toHaveBeenCalledWith({
      directory: undefined,
      format: undefined,
    });
    expect(errorSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('deprecated'));
  });

  it('passes --directory through to init', async () => {
    const initMock = vi.fn().mockResolvedValue({ success: true });

    vi.doMock('../../src/cli/init.js', () => ({
      init: initMock,
    }));

    const { runCli } = await import('../../src/cli/runner.js');

    await expect(runCli(['init', '--directory', '/tmp/veto-cli-target', '--quiet'])).resolves.toBe(0);
    expect(initMock).toHaveBeenCalledWith(expect.objectContaining({
      directory: '/tmp/veto-cli-target',
      quiet: true,
    }));
  });

  it('prints top-level help with install targets', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const { runCli } = await import('../../src/cli/runner.js');

    await expect(runCli(['help'])).resolves.toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('install <claude-code|cursor|codex>'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('veto install claude-code'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('veto install cursor'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('veto install codex'));
  });

  it('prints canonical elevated commands in top-level help', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const { runCli } = await import('../../src/cli/runner.js');

    await expect(runCli(['help'])).resolves.toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('validate --tool <name>'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('login'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('whoami'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('mcp start'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('mcp restore'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('receipts show <receipt-id>'));
  });

  it('prints version as stable JSON', async () => {
    const originalVersion = process.env.VETO_CLI_VERSION;
    process.env.VETO_CLI_VERSION = '9.8.7-test';
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      const { runCli } = await import('../../src/cli/runner.js');

      await expect(runCli(['version', '--json'])).resolves.toBe(0);
      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toMatchObject({
        ok: true,
        data: {
          name: 'veto',
          version: '9.8.7-test',
          runtime: expect.stringMatching(/^(node|bun)$/),
        },
      });
    } finally {
      if (originalVersion === undefined) {
        delete process.env.VETO_CLI_VERSION;
      } else {
        process.env.VETO_CLI_VERSION = originalVersion;
      }
    }
  });

  it('dispatches validate as the canonical guard check alias', async () => {
    const result = { ok: true, data: { decision: 'allow' } };
    const runGuardCheckCommand = vi.fn().mockResolvedValue(result);
    const printHeadlessResult = vi.fn();

    vi.doMock('../../src/cli/headless.js', () => ({
      printHeadlessResult,
      resolvePolicySavePath: vi.fn(),
      runCloudLoginCommand: vi.fn(),
      runCloudLogoutCommand: vi.fn(),
      runCloudOrgUseCommand: vi.fn(),
      runCloudProjectUseCommand: vi.fn(),
      runCloudWhoamiCommand: vi.fn(),
      runDoctorCommand: vi.fn(),
      runGuardCheckCommand,
      runPolicyApplyCommand: vi.fn(),
      runPolicyGenerateCommand: vi.fn(),
    }));

    const { runCli } = await import('../../src/cli/runner.js');

    await expect(runCli([
      'validate',
      '--tool',
      'approve_invoice',
      '--args',
      '{"amount":120}',
      '--context',
      '{"department":"ap"}',
      '--mode',
      'local',
      '--json',
    ])).resolves.toBe(0);

    expect(runGuardCheckCommand).toHaveBeenCalledWith(expect.objectContaining({
      projectDir: process.cwd(),
      tool: 'approve_invoice',
      argsJson: '{"amount":120}',
      contextJson: '{"department":"ap"}',
      mode: 'local',
    }));
    expect(printHeadlessResult).toHaveBeenCalledWith(result, true);
  });

  it('dispatches top-level cloud aliases', async () => {
    const result = { ok: true, data: { user: 'operator@example.com' } };
    const runCloudWhoamiCommand = vi.fn().mockResolvedValue(result);
    const printHeadlessResult = vi.fn();

    vi.doMock('../../src/cli/headless.js', () => ({
      printHeadlessResult,
      resolvePolicySavePath: vi.fn(),
      runCloudLoginCommand: vi.fn(),
      runCloudLogoutCommand: vi.fn(),
      runCloudOrgUseCommand: vi.fn(),
      runCloudProjectUseCommand: vi.fn(),
      runCloudWhoamiCommand,
      runDoctorCommand: vi.fn(),
      runGuardCheckCommand: vi.fn(),
      runPolicyApplyCommand: vi.fn(),
      runPolicyGenerateCommand: vi.fn(),
    }));

    const { runCli } = await import('../../src/cli/runner.js');

    await expect(runCli(['whoami', '--base-url', 'https://api.veto.example', '--json'])).resolves.toBe(0);

    expect(runCloudWhoamiCommand).toHaveBeenCalledWith({
      baseUrl: 'https://api.veto.example',
    });
    expect(printHeadlessResult).toHaveBeenCalledWith(result, true);
  });

  it('dispatches mcp start as the canonical serve alias', async () => {
    const runMcpServeCommand = vi.fn().mockResolvedValue(undefined);

    vi.doMock('../../src/cli/mcp.js', () => ({
      runMcpConnectCommand: vi.fn(),
      runMcpDoctorCommand: vi.fn(),
      runMcpInitCommand: vi.fn(),
      runMcpServeCommand,
    }));

    const { runCli } = await import('../../src/cli/runner.js');

    await expect(runCli([
      'mcp',
      'start',
      '--config',
      './veto/mcp.config.yaml',
      '--transport',
      'mcp-stdio',
      '--json',
    ])).resolves.toBe(0);

    expect(runMcpServeCommand).toHaveBeenCalledWith(expect.objectContaining({
      configPath: './veto/mcp.config.yaml',
      transport: 'mcp-stdio',
      asJson: true,
    }));
  });

  it('dispatches mcp restore through import restore mode', async () => {
    const result = { ok: true, data: { clients: [], gatewayConfigPath: './veto/mcp.config.yaml' } };
    const runMcpImportCommand = vi.fn().mockReturnValue(result);
    const printHeadlessResult = vi.fn();

    vi.doMock('../../src/cli/mcp-import.js', () => ({
      runMcpImportCommand,
    }));
    vi.doMock('../../src/cli/headless.js', () => ({
      printHeadlessResult,
      resolvePolicySavePath: vi.fn(),
      runCloudLoginCommand: vi.fn(),
      runCloudLogoutCommand: vi.fn(),
      runCloudOrgUseCommand: vi.fn(),
      runCloudProjectUseCommand: vi.fn(),
      runCloudWhoamiCommand: vi.fn(),
      runDoctorCommand: vi.fn(),
      runGuardCheckCommand: vi.fn(),
      runPolicyApplyCommand: vi.fn(),
      runPolicyGenerateCommand: vi.fn(),
    }));

    const { runCli } = await import('../../src/cli/runner.js');

    await expect(runCli([
      'mcp',
      'restore',
      '--input',
      './backup.json',
      '--config',
      './veto/mcp.config.yaml',
      '--json',
    ])).resolves.toBe(0);

    expect(runMcpImportCommand).toHaveBeenCalledWith(expect.objectContaining({
      inputPath: './backup.json',
      configPath: './veto/mcp.config.yaml',
      restore: true,
    }));
    expect(printHeadlessResult).toHaveBeenCalledWith(result, true);
  });

  it('dispatches receipts show with positional and flag receipt ids', async () => {
    const result = {
      ok: true,
      data: {
        path: 'receipts.ndjson',
        index: 0,
        receiptHash: 'sha256:abc',
        receipt: { receipt_id: 'rcp_positional' },
      },
    };
    const runReceiptsShowCommand = vi.fn().mockReturnValue(result);
    const printHeadlessResult = vi.fn();

    vi.doMock('../../src/cli/receipts.js', () => ({
      runReceiptsExportCommand: vi.fn(),
      runReceiptsShowCommand,
      runReceiptsVerifyCommand: vi.fn(),
    }));
    vi.doMock('../../src/cli/headless.js', () => ({
      printHeadlessResult,
      resolvePolicySavePath: vi.fn(),
      runCloudLoginCommand: vi.fn(),
      runCloudLogoutCommand: vi.fn(),
      runCloudOrgUseCommand: vi.fn(),
      runCloudProjectUseCommand: vi.fn(),
      runCloudWhoamiCommand: vi.fn(),
      runDoctorCommand: vi.fn(),
      runGuardCheckCommand: vi.fn(),
      runPolicyApplyCommand: vi.fn(),
      runPolicyGenerateCommand: vi.fn(),
    }));

    const { runCli } = await import('../../src/cli/runner.js');

    await expect(runCli([
      'receipts',
      'show',
      'rcp_positional',
      '--input',
      'receipts.ndjson',
      '--json',
    ])).resolves.toBe(0);
    await expect(runCli([
      'receipts',
      'show',
      '--receipt-id',
      'rcp_flag',
      '--input',
      'receipts.ndjson',
      '--json',
    ])).resolves.toBe(0);

    expect(runReceiptsShowCommand).toHaveBeenNthCalledWith(1, {
      inputPath: 'receipts.ndjson',
      receiptId: 'rcp_positional',
    });
    expect(runReceiptsShowCommand).toHaveBeenNthCalledWith(2, {
      inputPath: 'receipts.ndjson',
      receiptId: 'rcp_flag',
    });
    expect(printHeadlessResult).toHaveBeenCalledWith(result, true);
  });

  it('prints policy generate help with keyless fallback opt-out', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const { runCli } = await import('../../src/cli/runner.js');

    await expect(runCli(['help'])).resolves.toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('--no-template-fallback'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('local deterministic fallback'));
  });

  it('passes --no-template-fallback through to policy generate', async () => {
    const result = { ok: false, error: { code: 'policy_generate_failed', message: 'No generation endpoint configured.' } };
    const runPolicyGenerateCommand = vi.fn().mockResolvedValue(result);
    const printHeadlessResult = vi.fn();

    vi.doMock('../../src/cli/headless.js', () => ({
      printHeadlessResult,
      resolvePolicySavePath: vi.fn((_projectDir: string, _tool: string, savePath?: string) => savePath),
      runCloudLoginCommand: vi.fn(),
      runCloudLogoutCommand: vi.fn(),
      runCloudOrgUseCommand: vi.fn(),
      runCloudProjectUseCommand: vi.fn(),
      runCloudWhoamiCommand: vi.fn(),
      runDoctorCommand: vi.fn(),
      runGuardCheckCommand: vi.fn(),
      runPolicyApplyCommand: vi.fn(),
      runPolicyGenerateCommand,
    }));

    const { runCli } = await import('../../src/cli/runner.js');

    await expect(runCli([
      'policy',
      'generate',
      '--tool',
      'bash',
      '--prompt',
      'block rm -rf',
      '--mode-hint',
      'deterministic',
      '--no-template-fallback',
    ])).resolves.toBe(1);

    expect(runPolicyGenerateCommand).toHaveBeenCalledWith(expect.objectContaining({
      tool: 'bash',
      prompt: 'block rm -rf',
      modeHint: 'deterministic',
      allowTemplateFallback: false,
    }));
    expect(printHeadlessResult).toHaveBeenCalledWith(result, false);
  });

  it('prints install subcommand help', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const { runCli } = await import('../../src/cli/runner.js');

    await expect(runCli(['install'])).resolves.toBe(0);
    expect(logSpy).toHaveBeenCalledWith('  veto install claude-code [--directory <path>] [--force] [--json]');
    expect(logSpy).toHaveBeenCalledWith('  veto install cursor [--directory <path>] [--output <path>] [--config <path>] [--server-name <name>] [--cloud] [--json]');
    expect(logSpy).toHaveBeenCalledWith('  veto install codex [--directory <path>] [--output <path>] [--config <path>] [--server-name <name>] [--json]');
  });

  it('dispatches install command with parsed flags and JSON output', async () => {
    const result = {
      ok: true,
      data: {
        target: 'cursor',
        projectDir: '/tmp/project',
        path: '/tmp/project/.cursor/mcp.json',
        serverName: 'team-veto',
        serverCreated: true,
        updated: true,
        mode: 'local',
        endpoint: './veto/mcp.config.yaml',
        messages: ['updated'],
      },
    };
    const runInstallCommand = vi.fn().mockReturnValue(result);
    const formatInstallResult = vi.fn().mockReturnValue('formatted');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    vi.doMock('../../src/cli/install.js', () => ({
      formatInstallResult,
      runInstallCommand,
    }));

    const { runCli } = await import('../../src/cli/runner.js');

    await expect(runCli([
      'install',
      'cursor',
      '--directory',
      '/tmp/project',
      '--output',
      '.cursor/mcp.json',
      '--config',
      'veto/mcp.config.yaml',
      '--server-name',
      'team-veto',
      '--cloud',
      '--force',
      '--json',
    ])).resolves.toBe(0);

    expect(runInstallCommand).toHaveBeenCalledWith({
      target: 'cursor',
      directory: '/tmp/project',
      outputPath: '.cursor/mcp.json',
      configPath: 'veto/mcp.config.yaml',
      serverName: 'team-veto',
      cloud: true,
      force: true,
    });
    expect(formatInstallResult).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(result));
  });

  it('prints formatted install errors and exits non-zero', async () => {
    const result = {
      ok: false,
      error: {
        code: 'install_target_unknown',
        message: 'Unknown install target: nope',
      },
    };
    const runInstallCommand = vi.fn().mockReturnValue(result);
    const formatInstallResult = vi.fn().mockReturnValue('formatted error');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    vi.doMock('../../src/cli/install.js', () => ({
      formatInstallResult,
      runInstallCommand,
    }));

    const { runCli } = await import('../../src/cli/runner.js');

    await expect(runCli(['install', 'nope'])).resolves.toBe(1);
    expect(errorSpy).toHaveBeenCalledWith('formatted error');
  });
});
