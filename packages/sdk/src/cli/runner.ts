import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { init } from './init.js';
import { Observer, PolicyGenerator, parseDuration, policiesToYaml } from './learn.js';
import { runTests } from '../testing/runner.js';
import { computeChainHash, GENESIS_HASH } from '../audit/chain.js';
import { colors } from './colors.js';
import type { StopCondition } from './learn.js';
import { compile } from './compile.js';
import { test } from './test.js';
import { scan } from './scan.js';
import { diff } from './diff.js';
import { replay } from './replay.js';
import { startRepl } from './repl.js';
import { startStudio } from './studio/start.js';
import { getCliVersion } from './version.js';
import type { CustomProvider } from '../custom/types.js';
import {
  printHeadlessResult,
  resolvePolicySavePath,
  runCloudLoginCommand,
  runCloudLogoutCommand,
  runCloudOrgUseCommand,
  runCloudProjectUseCommand,
  runCloudWhoamiCommand,
  runDoctorCommand,
  runGuardCheckCommand,
  runPolicyApplyCommand,
  runPolicyGenerateCommand,
} from './headless.js';
import { agentConfig, agentInit, agentPolicyAdd, agentPolicyList, agentScan } from './agent.js';
import { runMcpConnectCommand, runMcpDoctorCommand, runMcpInitCommand, runMcpServeCommand } from './mcp.js';
import { startProxyServer } from '../proxy/server.js';

const VERSION = getCliVersion();

const VALID_PROVIDERS = new Set(['openai', 'anthropic', 'gemini', 'openrouter']);
const VALID_RENDERERS = new Set(['auto', 'ink', 'opentui', 'ansi']);
const VALID_THEMES = new Set(['veto', 'claude', 'high-contrast']);

interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Record<string, boolean>;
  values: Record<string, string>;
}

function printHelp(): void {
  console.log(`
Veto CLI

Usage:
  veto [command] [options]

Canonical Commands:
  studio                               Start Veto Studio
  policy generate --tool <name> --prompt <text> [--mode-hint auto|deterministic|llm] [--target local|cloud] [--save <path>] [--json]
  policy apply --file <path> [--target local|cloud] [--project <id>] [--json]
  guard check --tool <name> --args <json> [--context <json>] [--mode local|cloud|kernel|custom] [--json]
  cloud login
  cloud whoami
  cloud org use <id>
  cloud project use <id>
  cloud logout
  mcp connect [--output <path>] [--config <path>] [--cloud] [--json]
  mcp serve [--config <path>] [--listen <host:port>] [--upstream <url>] [--transport <mcp-sse|mcp-stdio>] [--api-key <key>] [--policy-server <url>] [--timeout-ms <n>] [--json]
  mcp doctor [--config <path>] [--json]
  mcp init [--output <path>] [--json]
  doctor

Core Commands:
  init
  learn
  compile
  test
  scan
  diff
  replay
  version
  help

Compatibility Commands:
  repl, --repl, repl --legacy
  agent init
  agent policy add "..."
  agent policy list
  agent scan
  agent config

Options:
  --repl                        Force Studio mode
  --legacy                      Use legacy line-based REPL
  --directory <path>            Workspace directory
  --renderer <mode>             Renderer: auto, ink, opentui, ansi
  --theme <name>                Theme: veto, claude, high-contrast
  --include-examples            Include examples/** in scan scope
  --include-tests               Include test/**, tests/**, __tests__/** in scan scope
  --demo-template               Allow explicit template fallback generation
  --json                        Print deterministic machine JSON output
  --non-interactive             Disable interactive prompts
  --base-url <url>              Override cloud API base URL for cloud commands
  --help, -h                    Show this help

Examples:
  veto
  veto studio --renderer ink
  veto repl --legacy
  veto policy generate --tool approve_invoice --prompt "do not approve invoices above 50" --save ./veto/rules/invoices.yaml
  veto policy apply --file ./veto/rules/invoices.yaml --target cloud --json
  veto guard check --tool approve_invoice --args '{"amount":120}' --mode local --json
  veto cloud login
  veto cloud whoami --json
  veto mcp init
  veto mcp connect --cloud
  veto mcp doctor --json
  veto mcp serve --config ./veto/mcp.config.yaml
  veto replay --policy ./veto/ --log calls.jsonl
  veto replay --policy financial.yaml --log calls.jsonl --diff
  veto replay --policy ./veto/ --log calls.jsonl --format json
  veto doctor
  veto test [path]                     # policy unit tests (YAML fixtures)
  veto test --coverage                # report rule IDs with/without tests
  veto test --gaps                    # adversarial gap analysis
  veto audit verify [file]            # verify tamper-evident audit chain
  veto intercept [--port 8080]        # zero-code proxy for OpenAI agents
`);
}

function printVersion(): void {
  console.log(`veto v${VERSION}`);
}

function parseArgs(args: string[]): ParsedArgs {
  const flags: Record<string, boolean> = {};
  const values: Record<string, string> = {};
  const positionals: string[] = [];
  let command = '';

  const valueFlags = new Set([
    'runs',
    'duration',
    'output',
    'margin',
    'input',
    'file',
    'provider',
    'model',
    'policy',
    'format',
    'pack',
    'old',
    'new',
    'log',
    'mode',
    'directory',
    'prompt',
    'renderer',
    'tool',
    'mode-hint',
    'target',
    'save',
    'args',
    'context',
    'project',
    'base-url',
    'theme',
    'config',
    'listen',
    'upstream',
    'transport',
    'api-key',
    'policy-server',
    'timeout-ms',
    'port',
    'max-buffer',
  ]);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg.startsWith('--')) {
      const flag = arg.slice(2);
      if (valueFlags.has(flag) && i + 1 < args.length) {
        values[flag] = args[++i];
      } else {
        flags[flag] = true;
      }
      continue;
    }

    if (arg.startsWith('-')) {
      const shortFlags = arg.slice(1).split('');
      for (const flag of shortFlags) {
        switch (flag) {
          case 'f':
            flags.force = true;
            break;
          case 'q':
            flags.quiet = true;
            break;
          case 'y':
            flags.yes = true;
            break;
          case 'h':
            flags.help = true;
            break;
        }
      }
      continue;
    }

    if (!command) {
      command = arg;
      continue;
    }

    positionals.push(arg);
  }

  return { command, positionals, flags, values };
}

function parseRendererPreference(rawValue: string | undefined): 'auto' | 'ink' | 'opentui' | 'ansi' {
  const value = rawValue?.trim();
  if (!value) {
    return 'auto';
  }

  if (VALID_RENDERERS.has(value)) {
    return value as 'auto' | 'ink' | 'opentui' | 'ansi';
  }

  throw new Error(`Invalid --renderer value "${value}". Expected auto|ink|opentui|ansi.`);
}

function parseTheme(rawValue: string | undefined): 'veto' | 'claude' | 'high-contrast' {
  const value = rawValue?.trim();
  if (!value) {
    return 'veto';
  }

  if (VALID_THEMES.has(value)) {
    return value as 'veto' | 'claude' | 'high-contrast';
  }

  throw new Error(`Invalid --theme value "${value}". Expected veto|claude|high-contrast.`);
}

function parseTarget(rawValue: string | undefined): 'local' | 'cloud' {
  const value = rawValue?.trim();
  if (!value) {
    return 'local';
  }

  if (value === 'local' || value === 'cloud') {
    return value;
  }

  throw new Error(`Invalid --target value "${value}". Expected local|cloud.`);
}

function parseModeHint(rawValue: string | undefined): 'auto' | 'deterministic' | 'llm' | undefined {
  const value = rawValue?.trim();
  if (!value) {
    return undefined;
  }

  if (value === 'auto' || value === 'deterministic' || value === 'llm') {
    return value;
  }

  throw new Error(`Invalid --mode-hint value "${value}". Expected auto|deterministic|llm.`);
}

function parseGuardMode(rawValue: string | undefined): 'local' | 'cloud' | 'kernel' | 'custom' {
  const value = rawValue?.trim();
  if (!value) {
    return 'local';
  }

  if (value === 'local' || value === 'cloud' || value === 'kernel' || value === 'custom') {
    return value;
  }

  throw new Error(`Invalid --mode value "${value}". Expected local|cloud|kernel|custom.`);
}

async function runStudio(flags: Record<string, boolean>, values: Record<string, string>): Promise<number> {
  if (flags.legacy) {
    await startRepl({
      cwd: values.directory,
      version: VERSION,
    });
    return 0;
  }

  await startStudio({
    cwd: process.cwd(),
    directory: values.directory,
    renderer: parseRendererPreference(values.renderer),
    includeExamples: flags['include-examples'],
    includeTests: flags['include-tests'],
    demoTemplate: flags['demo-template'],
    version: VERSION,
    theme: parseTheme(values.theme),
  });
  return 0;
}

async function runLearn(flags: Record<string, boolean>, values: Record<string, string>): Promise<number> {
  const quiet = flags.quiet ?? false;

  const stopCondition: StopCondition = {};

  if (values.runs) {
    const runs = Number.parseInt(values.runs, 10);
    if (Number.isNaN(runs) || runs <= 0) {
      throw new Error('--runs must be a positive integer');
    }
    stopCondition.runs = runs;
  }

  if (values.duration) {
    stopCondition.durationMs = parseDuration(values.duration);
  }

  if (!stopCondition.runs && !stopCondition.durationMs) {
    throw new Error('veto learn requires --runs or --duration');
  }

  const margin = values.margin ? Number.parseFloat(values.margin) : 0.1;
  if (values.margin && (Number.isNaN(margin) || margin < 0 || margin > 1)) {
    throw new Error('--margin must be a number between 0 and 1');
  }

  const outputPath = resolve(values.output ?? './veto/rules/learned.yaml');

  const observer = new Observer(stopCondition);
  observer.start();

  if (!quiet) {
    console.log('');
    console.log('Veto Learn - Observing tool calls...');
    if (stopCondition.runs) console.log(`  Stop after: ${stopCondition.runs} calls`);
    if (stopCondition.durationMs) console.log(`  Stop after: ${values.duration}`);
    console.log(`  Output: ${outputPath}`);
    console.log(`  Margin: ${margin}`);
    console.log('');
    console.log('Reading tool calls from stdin (one JSON object per line)...');
    console.log('Format: {"tool": "tool_name", "args": {...}}');
    console.log('');
  }

  const readline = await import('node:readline');
  const rl = readline.createInterface({ input: process.stdin });

  for await (const line of rl) {
    if (observer.stopped) break;

    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const parsed = JSON.parse(trimmed) as {
        tool?: string;
        name?: string;
        args?: Record<string, unknown>;
        arguments?: Record<string, unknown>;
      };

      const toolName = parsed.tool ?? parsed.name;
      const args = parsed.args ?? parsed.arguments ?? {};

      if (!toolName || typeof toolName !== 'string') {
        if (!quiet) console.error('  Skipping line: missing "tool" or "name" field');
        continue;
      }

      observer.recordRaw(toolName, args as Record<string, unknown>);
      if (!quiet) console.log(`  [${observer.callCount}] ${toolName}(${JSON.stringify(args).slice(0, 60)})`);
    } catch {
      if (!quiet) console.error(`  Skipping invalid JSON: ${trimmed.slice(0, 50)}`);
    }

    if (observer.shouldStop()) break;
  }

  rl.close();

  const observations = observer.getObservations();
  const generator = new PolicyGenerator(margin);
  const policies = generator.generate(observations);

  if (policies.length === 0) {
    if (!quiet) console.log('No tool calls observed. No policies generated.');
    return 0;
  }

  const yaml = policiesToYaml(policies);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, yaml, 'utf-8');

  if (!quiet) {
    console.log('');
    console.log(`Generated ${policies.length} policies from ${observer.callCount} observations.`);
    console.log(`Output: ${outputPath}`);
    console.log('');
    for (const policy of policies) {
      console.log(`  ${policy.toolName}: ${policy.constraints.length} constraints`);
    }
    console.log('');
  }

  return 0;
}

async function runPolicyCommand(
  positionals: string[],
  flags: Record<string, boolean>,
  values: Record<string, string>
): Promise<number> {
  const subCommand = positionals[0] ?? 'help';
  const json = flags.json ?? false;
  const projectDir = resolve(values.directory ?? process.cwd());

  if (subCommand === 'generate') {
    if (!values.tool) {
      throw new Error('policy generate requires --tool <name>');
    }

    if (!values.prompt) {
      throw new Error('policy generate requires --prompt <text>');
    }

    const target = parseTarget(values.target);
    const modeHint = parseModeHint(values['mode-hint']);
    const savePath = target === 'local'
      ? resolvePolicySavePath(projectDir, values.tool, values.save)
      : values.save
        ? resolve(projectDir, values.save)
        : undefined;

    const result = await runPolicyGenerateCommand({
      projectDir,
      tool: values.tool,
      prompt: values.prompt,
      modeHint,
      target,
      savePath,
      demoTemplate: flags['demo-template'],
    });

    printHeadlessResult(result, json);
    return result.ok ? 0 : 1;
  }

  if (subCommand === 'apply') {
    if (!values.file) {
      throw new Error('policy apply requires --file <path>');
    }

    const result = await runPolicyApplyCommand({
      projectDir,
      filePath: values.file,
      target: parseTarget(values.target),
      projectId: values.project,
    });

    printHeadlessResult(result, json);
    return result.ok ? 0 : 1;
  }

  if (subCommand === 'help') {
    console.log('Usage:');
    console.log('  veto policy generate --tool <name> --prompt <text> [--mode-hint auto|deterministic|llm] [--target local|cloud] [--save <path>] [--json]');
    console.log('  veto policy apply --file <path> [--target local|cloud] [--project <id>] [--json]');
    return 0;
  }

  throw new Error(`Unknown policy command: ${subCommand}`);
}

async function runGuardCommand(
  positionals: string[],
  flags: Record<string, boolean>,
  values: Record<string, string>
): Promise<number> {
  const subCommand = positionals[0] ?? 'help';
  const json = flags.json ?? false;

  if (subCommand === 'check') {
    if (!values.tool) {
      throw new Error('guard check requires --tool <name>');
    }

    const result = await runGuardCheckCommand({
      projectDir: values.directory ?? process.cwd(),
      tool: values.tool,
      argsJson: values.args,
      contextJson: values.context,
      mode: parseGuardMode(values.mode),
    });

    printHeadlessResult(result, json);
    return result.ok ? 0 : 1;
  }

  if (subCommand === 'help') {
    console.log('Usage:');
    console.log('  veto guard check --tool <name> --args <json> [--context <json>] [--mode local|cloud|kernel|custom] [--json]');
    return 0;
  }

  throw new Error(`Unknown guard command: ${subCommand}`);
}

async function runCloudCommand(
  positionals: string[],
  flags: Record<string, boolean>,
  values: Record<string, string>
): Promise<number> {
  const subCommand = positionals[0] ?? 'help';
  const json = flags.json ?? false;

  if (subCommand === 'login') {
    const result = await runCloudLoginCommand({
      baseUrl: values['base-url'],
    });
    printHeadlessResult(result, json);
    return result.ok ? 0 : 1;
  }

  if (subCommand === 'whoami') {
    const result = await runCloudWhoamiCommand({
      baseUrl: values['base-url'],
    });
    printHeadlessResult(result, json);
    return result.ok ? 0 : 1;
  }

  if (subCommand === 'org') {
    const action = positionals[1];
    const id = positionals[2];

    if (action !== 'use' || !id) {
      throw new Error('Usage: veto cloud org use <id>');
    }

    const result = runCloudOrgUseCommand(id);
    printHeadlessResult(result, json);
    return result.ok ? 0 : 1;
  }

  if (subCommand === 'project') {
    const action = positionals[1];
    const id = positionals[2];

    if (action !== 'use' || !id) {
      throw new Error('Usage: veto cloud project use <id>');
    }

    const result = runCloudProjectUseCommand(id);
    printHeadlessResult(result, json);
    return result.ok ? 0 : 1;
  }

  if (subCommand === 'logout') {
    const result = runCloudLogoutCommand();
    printHeadlessResult(result, json);
    return result.ok ? 0 : 1;
  }

  if (subCommand === 'help') {
    console.log('Usage:');
    console.log('  veto cloud login');
    console.log('  veto cloud whoami');
    console.log('  veto cloud org use <id>');
    console.log('  veto cloud project use <id>');
    console.log('  veto cloud logout');
    return 0;
  }

  throw new Error(`Unknown cloud command: ${subCommand}`);
}

async function runDoctor(flags: Record<string, boolean>, values: Record<string, string>): Promise<number> {
  const result = await runDoctorCommand({
    projectDir: values.directory ?? process.cwd(),
  });

  printHeadlessResult(result, flags.json ?? false);
  return result.ok ? 0 : 1;
}

async function runMcpCommand(
  positionals: string[],
  flags: Record<string, boolean>,
  values: Record<string, string>,
): Promise<number> {
  const subCommand = positionals[0] ?? 'help';
  const asJson = flags.json ?? false;

  if (subCommand === 'serve') {
    const timeoutMs = values['timeout-ms']
      ? Number.parseInt(values['timeout-ms'], 10)
      : undefined;

    if (values['timeout-ms'] && (!Number.isInteger(timeoutMs) || (timeoutMs ?? 0) <= 0)) {
      throw new Error('mcp serve --timeout-ms must be a positive integer.');
    }

    await runMcpServeCommand({
      configPath: values.config,
      listen: values.listen,
      upstream: values.upstream,
      transport: values.transport,
      apiKey: values['api-key'],
      policyServer: values['policy-server'],
      timeoutMs,
      asJson,
    });
    return 0;
  }

  if (subCommand === 'connect') {
    const result = runMcpConnectCommand({
      outputPath: values.output,
      configPath: values.config,
      cloud: flags.cloud ?? false,
    });
    printHeadlessResult(result, asJson);
    return result.ok ? 0 : 1;
  }

  if (subCommand === 'doctor') {
    const result = await runMcpDoctorCommand({
      configPath: values.config,
    });
    printHeadlessResult(result, asJson);
    return result.ok ? 0 : 1;
  }

  if (subCommand === 'init') {
    const result = runMcpInitCommand({
      outputPath: values.output,
    });
    printHeadlessResult(result, asJson);
    return result.ok ? 0 : 1;
  }

  if (subCommand === 'help') {
    console.log('Usage:');
    console.log('  veto mcp connect [--output <path>] [--config <path>] [--cloud] [--json]');
    console.log('  veto mcp serve [--config <path>] [--listen <host:port>] [--upstream <url>] [--transport <mcp-sse|mcp-stdio>] [--api-key <key>] [--policy-server <url>] [--timeout-ms <n>] [--json]');
    console.log('  veto mcp doctor [--config <path>] [--json]');
    console.log('  veto mcp init [--output <path>] [--json]');
    return 0;
  }

  throw new Error(`Unknown mcp command: ${subCommand}`);
}

async function runRunTests(
  positionals: string[],
  flags: Record<string, boolean>,
  values: Record<string, string>,
): Promise<number> {
  const fixturesPath = positionals[0] ?? './veto/tests';
  const policyPath = values.policy ?? './veto';
  const result = await runTests({
    fixturesPath,
    policyPath,
    coverage: flags.coverage ?? false,
    quiet: flags.quiet ?? false,
  });
  return result.failed === 0 && (result.loadErrors?.length ?? 0) === 0 ? 0 : 1;
}

async function runAuditCommand(
  positionals: string[],
  _flags: Record<string, boolean>,
  _values: Record<string, string>,
): Promise<number> {
  const subCommand = positionals[0] ?? 'help';

  if (subCommand === 'verify') {
    const logFile = positionals[1] ?? '.veto/audit.log';
    const resolvedLog = resolve(logFile);

    if (!existsSync(resolvedLog)) {
      console.error(colors.error(`Audit log not found: ${resolvedLog}`));
      return 1;
    }

    const content = readFileSync(resolvedLog, 'utf-8');
    const lines = content.split('\n').filter((l) => l.trim().length > 0);

    let prevHash = GENESIS_HASH;
    let index = 0;

    for (const line of lines) {
      index += 1;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        console.error(colors.error(`  Invalid JSON at record ${index}: ${line.slice(0, 80)}`));
        return 1;
      }

      const storedHash = parsed['chain_hash'] as string | undefined;
      if (!storedHash) {
        console.error(colors.error(`  Missing chain_hash at record ${index}`));
        return 1;
      }

      const { chain_hash: _, ...recordWithoutHash } = parsed;
      const expected = computeChainHash(prevHash, recordWithoutHash);

      if (expected !== storedHash) {
        console.error(
          colors.error(`Chain broken at record ${index}: expected ${expected} got ${storedHash}`),
        );
        return 1;
      }

      prevHash = storedHash;
    }

    console.log(colors.success(`Audit log verified: ${index} records, chain intact`));
    return 0;
  }

  if (subCommand === 'help') {
    console.log('Usage:');
    console.log('  veto audit verify [file]   # default: .veto/audit.log');
    return 0;
  }

  throw new Error(`Unknown audit command: ${subCommand}`);
}

async function runInterceptCommand(
  flags: Record<string, boolean>,
  values: Record<string, string>,
): Promise<number> {
  const port = parseInt(values.port ?? '8080', 10);
  const target = values.target ?? 'https://api.openai.com';
  const configDir = values.config ?? './veto';
  const maxBufferBytes = parseInt(values['max-buffer'] ?? String(1024 * 1024), 10);
  const format = (values.format ?? 'auto') as 'openai' | 'anthropic' | 'auto';

  if (flags.help) {
    console.log('Usage: veto intercept [options]');
    console.log('');
    console.log('Start a local HTTP proxy that intercepts API requests and');
    console.log('validates tool calls against your Veto policies before forwarding.');
    console.log('');
    console.log('Options:');
    console.log('  --port <port>         Proxy listen port (default: 8080)');
    console.log('  --target <url>        Upstream API base URL (default: https://api.openai.com)');
    console.log('  --format <fmt>        API format: openai, anthropic, or auto (default: auto)');
    console.log('  --config <dir>        Veto config directory (default: ./veto)');
    console.log('  --max-buffer <bytes>  Buffer limit per response in bytes (default: 1048576)');
    console.log('');
    console.log('Usage with your agent:');
    console.log('  OPENAI_BASE_URL=http://localhost:8080 node your-agent.js');
    console.log('  ANTHROPIC_BASE_URL=http://localhost:8080 node your-agent.js');
    return 0;
  }

  console.log(colors.bold(`veto intercept`));
  console.log(`  Proxy: http://127.0.0.1:${port} (localhost only)`);
  console.log(`  Target: ${target}`);
  console.log(`  Format: ${format}`);
  console.log(`  Config: ${configDir}`);
  console.log('');
  console.log(colors.dim('Point your agent at the proxy:'));
  console.log(colors.bold(`  OPENAI_BASE_URL=http://localhost:${port} <your-command>`));
  console.log('');
  console.log(colors.dim('Press Ctrl+C to stop.'));

  const stopServer = await startProxyServer({ port, target, configDir, maxBufferBytes, format });

  // Keep running until SIGINT/SIGTERM
  await new Promise<void>((resolve) => {
    process.on('SIGINT', () => resolve());
    process.on('SIGTERM', () => resolve());
  });

  await stopServer();
  return 0;
}

async function runAgentCompatibility(
  positionals: string[],
  values: Record<string, string>
): Promise<number> {
  const subCommand = positionals[0] ?? 'help';
  const subArgs = positionals.slice(1);
  console.error('Warning: `veto agent` commands are deprecated. Use `veto policy` and `veto guard` commands.');

  switch (subCommand) {
    case 'init': {
      await agentInit({
        directory: values.directory,
        format: values.format as 'json' | 'yaml' | undefined,
      });
      return 0;
    }
    case 'policy': {
      const policyCommand = subArgs[0] ?? 'help';
      if (policyCommand === 'add') {
        const prompt = values.prompt ?? subArgs.slice(1).join(' ');
        if (!prompt) {
          throw new Error('agent policy add requires prompt text');
        }

        await agentPolicyAdd(prompt, {
          directory: values.directory,
          format: values.format as 'json' | 'yaml' | undefined,
        });
        return 0;
      }

      if (policyCommand === 'list') {
        await agentPolicyList({
          directory: values.directory,
          format: values.format as 'json' | 'yaml' | undefined,
        });
        return 0;
      }

      throw new Error(`Unknown agent policy command: ${policyCommand}`);
    }
    case 'scan': {
      await agentScan({
        directory: values.directory,
        format: values.format as 'json' | 'yaml' | undefined,
      });
      return 0;
    }
    case 'config': {
      await agentConfig({
        directory: values.directory,
        format: values.format as 'json' | 'yaml' | undefined,
      });
      return 0;
    }
    case 'help':
    default: {
      console.log('Agent commands (deprecated):');
      console.log('  veto agent init');
      console.log('  veto agent policy add "..."');
      console.log('  veto agent policy list');
      console.log('  veto agent scan');
      console.log('  veto agent config');
      return 0;
    }
  }
}

export async function runCli(argv: string[] = process.argv.slice(2)): Promise<number> {
  const { command, positionals, flags, values } = parseArgs(argv);

  if (flags.help || command === 'help') {
    printHelp();
    return 0;
  }

  if (flags.version || command === 'version') {
    printVersion();
    return 0;
  }

  if (flags.repl) {
    if (command) {
      throw new Error('--repl cannot be combined with another command');
    }
    return await runStudio(flags, values);
  }

  switch (command) {
    case '': {
      if (!process.stdout.isTTY) {
        printHelp();
        return 1;
      }
      return await runStudio(flags, values);
    }
    case 'studio':
    case 'repl':
      return await runStudio(flags, values);
    case 'policy':
      return await runPolicyCommand(positionals, flags, values);
    case 'guard':
      return await runGuardCommand(positionals, flags, values);
    case 'cloud':
      return await runCloudCommand(positionals, flags, values);
    case 'doctor':
      return await runDoctor(flags, values);
    case 'mcp':
      return await runMcpCommand(positionals, flags, values);
    case 'init': {
      const result = await init({
        force: flags.force,
        pack: values.pack,
        quiet: flags.quiet,
        agent: flags.agent,
        yes: flags.yes,
        mode: values.mode as 'local' | 'cloud' | 'kernel' | 'custom' | undefined,
        approval: flags.approval,
      });
      return result.success ? 0 : 1;
    }
    case 'learn':
      return await runLearn(flags, values);
    case 'compile': {
      if (!values.output) {
        throw new Error('compile requires --output');
      }
      if (values.provider && !VALID_PROVIDERS.has(values.provider)) {
        throw new Error(`Invalid --provider value "${values.provider}". Expected openai|anthropic|gemini|openrouter.`);
      }

      const result = await compile({
        input: values.input,
        file: values.file,
        output: values.output,
        provider: values.provider as CustomProvider | undefined,
        model: values.model,
        quiet: flags.quiet,
      });
      return result.success ? 0 : 1;
    }
    case 'test': {
      if (flags.gaps) {
        const result = await test({
          policy: values.policy,
          output: values.output,
          quiet: flags.quiet,
          format: (values.format as 'text' | 'json') ?? undefined,
        });
        return result.success ? 0 : 1;
      }
      return await runRunTests(positionals, flags, values);
    }
    case 'scan': {
      const result = await scan({
        directory: values.directory,
        quiet: flags.quiet,
        failUncovered: flags['fail-uncovered'],
        suggest: flags.suggest,
        includeExamples: flags['include-examples'],
        includeTests: flags['include-tests'],
        format: (values.format as 'text' | 'json') ?? undefined,
      });
      return result.success ? 0 : 1;
    }
    case 'diff': {
      if (positionals.length > 1) {
        throw new Error('diff accepts at most one positional <policy-path>.');
      }

      const result = await diff({
        quiet: flags.quiet,
        policyPath: positionals[0],
        old: values.old,
        new: values.new,
        log: values.log,
        format: (values.format as 'text' | 'json') ?? undefined,
      });
      return result.success ? 0 : 1;
    }
    case 'replay': {
      const result = await replay({
        policy: values.policy ?? positionals[0],
        log: values.log ?? positionals[1],
        diff: flags.diff,
        format: (values.format as 'text' | 'json') ?? undefined,
        quiet: flags.quiet,
      });
      if (!result.success) {
        for (const error of result.errors) {
          process.stderr.write(`Error: ${error}\n`);
        }
      }
      return result.success ? 0 : 1;
    }
    case 'run-tests':
      console.error('Warning: `veto run-tests` is deprecated. Use `veto test` instead.');
      return await runRunTests(positionals, flags, values);
    case 'audit':
      return await runAuditCommand(positionals, flags, values);
    case 'intercept':
      return await runInterceptCommand(flags, values);
    case 'agent':
      return await runAgentCompatibility(positionals, values);
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

export async function runCliOrExit(argv: string[] = process.argv.slice(2)): Promise<void> {
  try {
    const exitCode = await runCli(argv);
    process.exit(exitCode);
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
