#!/usr/bin/env node

import { init } from './init.js';
import { Observer, PolicyGenerator, parseDuration, policiesToYaml } from './learn.js';
import type { StopCondition } from './learn.js';
import { compile } from './compile.js';
import { test } from './test.js';
import { scan } from './scan.js';
import { diff } from './diff.js';
import { startRepl } from './repl.js';
import { agentInit, agentPolicyList, agentPolicyAdd, agentScan, agentConfig } from './agent.js';
import type { CustomProvider } from '../custom/types.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const VERSION = '0.1.0';

const VALID_PROVIDERS = new Set(['openai', 'anthropic', 'gemini', 'openrouter']);

function printHelp(): void {
  console.log(`
Veto - AI Agent Tool Call Guardrail

Usage:
  veto [command] [options]

Commands:
  repl          Start interactive policy shell
  init          Initialize Veto in the current directory
  agent         Agent-native commands (policy add, list, scan, config)
  learn         Observe tool calls and generate policies
  compile       Compile natural language policies to deterministic YAML rules
  test          Run adversarial policy gap analysis
  scan          Audit tool coverage against loaded rules
  diff          Compare policy snapshots and optional log impact replay
  version       Show version information
  help          Show this help message

Agent Commands:
  agent init              Initialize Veto in agent mode (no prompts)
  agent policy add "..."  Add a policy from natural language
  agent policy list       List all policies in the project
  agent scan              Scan tools and show coverage
  agent config            Show current Veto configuration

No command:
  Starts the interactive policy REPL

Options:
  --repl               Force interactive REPL mode
  --force, -f          Force overwrite existing files (init)
  --pack <name>        Scaffold with a built-in policy pack (init)
  --mode <mode>        Validation mode: local, cloud, kernel, custom (init)
  --approval           Enable human approval webhook (init)
  --agent              Agent mode - no interactive prompts (init)
  --yes, -y            Skip confirmation prompts (init)
  --quiet, -q          Suppress output
  --help, -h           Show help

REPL Slash Commands:
  /scan                            Rescan tools and pack suggestions
  /test <tool>({args})             Local-only policy evaluation (no network)
  /test-suite                      Run generated scenarios against current rules
  /explain <ruleId>                Explain a rule in plain language
  /list                            Show loaded session rules
  /load <file>                     Merge a YAML rule file into session
  /export [file]                   Export merged session rules
  /clear                           Reload baseline rules, drop session additions
  /quit                            Exit REPL
  Aliases: /q /? /s /t /ts /e /ls /x /c

Learn Options:
  --runs <n>            Stop after n tool calls
  --duration <time>     Stop after duration (e.g., 30s, 10m, 1h)
  --output <path>       Output YAML file path (default: ./veto/rules/learned.yaml)
  --margin <n>          Numeric range margin as decimal (default: 0.1)

Compile Options:
  --input <text>       Policy description as inline text
  --file <path>        Path to a text file containing policy descriptions
  --output <path>      Output file (.yaml) or directory for generated rules
  --provider <name>    LLM provider: openai, anthropic, gemini, openrouter
  --model <name>       Model identifier (e.g. gpt-4o, claude-sonnet-4-5-20250929)

Test Options:
  --policy <path>      Policy directory (default: ./veto/rules/)
  --output <file>      Write JSON report to file
  --format <fmt>       Output format: text or json (default: text)

Scan Options:
  --fail-uncovered     Exit with code 1 when uncovered tools are found
  --suggest            Include inline YAML starter snippets for uncovered tools
  --format <fmt>       Output format: text or json (default: text)

Diff Options:
  <policy-path>        Compare working file with HEAD snapshot (git mode)
  --old <path>         Explicit old policy file or directory
  --new <path>         Explicit new policy file or directory
  --log <path>         JSONL tool-call log for deterministic impact replay
  --format <fmt>       Output format: text or json (default: text)

Examples:
  veto init                          Initialize Veto in current directory (interactive wizard)
  veto init --agent                  Initialize in agent mode (no prompts)
  veto init --agent --pack @veto/financial --mode local
  veto                               Start interactive REPL
  veto --repl                        Start interactive REPL (explicit flag)
  veto repl                          Start interactive REPL
  veto init --pack coding-agent      Initialize with extends: "@veto/coding-agent"
  veto init --mode cloud --approval  Initialize with cloud mode + human approval
  veto init --force                  Reinitialize, overwriting existing files
  veto learn --runs 10               Observe 10 tool calls then generate policies
  veto learn --duration 30m          Observe for 30 minutes
  veto compile --input 'Block emails outside company domain' --output ./veto/rules/email.yaml
  veto compile --file policies.txt --output ./veto/rules/
  veto test                          Analyze policies for gaps
  veto test --policy ./rules         Analyze specific policy directory
  veto test --output report.json     Save JSON report
  veto scan                          Audit tool coverage in current project
  veto scan --suggest                Show inline YAML snippets for uncovered tools
  veto scan --fail-uncovered         Fail CI when uncovered tools are detected
  veto diff financial.yaml           Compare veto/rules/financial.yaml vs HEAD
  veto diff --old v1 --new v2        Compare two policy directories
  veto diff financial.yaml --log calls.jsonl
`);
}

function printVersion(): void {
  console.log(`veto v${VERSION}`);
}

interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Record<string, boolean>;
  values: Record<string, string>;
}

function parseArgs(args: string[]): ParsedArgs {
  const flags: Record<string, boolean> = {};
  const values: Record<string, string> = {};
  const positionals: string[] = [];
  let command = '';

  const valueFlags = new Set([
    'runs', 'duration', 'output', 'margin',
    'input', 'file', 'provider', 'model',
    'policy', 'format', 'pack',
    'old', 'new', 'log', 'mode',
    'directory', 'prompt',
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
    } else if (arg.startsWith('-')) {
      const shortFlags = arg.slice(1).split('');
      for (const f of shortFlags) {
        switch (f) {
          case 'f': flags['force'] = true; break;
          case 'q': flags['quiet'] = true; break;
          case 'y': flags['yes'] = true; break;
          case 'h': flags['help'] = true; break;
        }
      }
    } else if (!command) {
      command = arg;
    } else {
      positionals.push(arg);
    }
  }

  return { command, positionals, flags, values };
}

async function runLearn(flags: Record<string, boolean>, values: Record<string, string>): Promise<void> {
  const quiet = flags['quiet'] ?? false;

  const stopCondition: StopCondition = {};

  if (values['runs']) {
    const runs = parseInt(values['runs'], 10);
    if (isNaN(runs) || runs <= 0) {
      console.error('--runs must be a positive integer');
      process.exit(1);
    }
    stopCondition.runs = runs;
  }

  if (values['duration']) {
    stopCondition.durationMs = parseDuration(values['duration']);
  }

  if (!stopCondition.runs && !stopCondition.durationMs) {
    console.error('veto learn requires --runs or --duration');
    console.error('Example: veto learn --runs 10');
    process.exit(1);
  }

  const margin = values['margin'] ? parseFloat(values['margin']) : 0.1;
  if (values['margin'] && (isNaN(margin) || margin < 0 || margin > 1)) {
    console.error('--margin must be a number between 0 and 1');
    process.exit(1);
  }
  const outputPath = resolve(values['output'] ?? './veto/rules/learned.yaml');

  const observer = new Observer(stopCondition);
  observer.start();

  if (!quiet) {
    console.log('');
    console.log('Veto Learn - Observing tool calls...');
    if (stopCondition.runs) console.log(`  Stop after: ${stopCondition.runs} calls`);
    if (stopCondition.durationMs) console.log(`  Stop after: ${values['duration']}`);
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
      const parsed = JSON.parse(trimmed) as { tool?: string; name?: string; args?: Record<string, unknown>; arguments?: Record<string, unknown> };
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
    process.exit(0);
  }

  const yaml = policiesToYaml(policies);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, yaml, 'utf-8');

  if (!quiet) {
    console.log('');
    console.log(`Generated ${policies.length} policies from ${observer.callCount} observations.`);
    console.log(`Output: ${outputPath}`);
    console.log('');
    for (const p of policies) {
      console.log(`  ${p.toolName}: ${p.constraints.length} constraints`);
    }
    console.log('');
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const { command, positionals, flags, values } = parseArgs(args);

  if (flags['help'] || command === 'help') {
    printHelp();
    process.exit(0);
  }

  if (flags['version'] || command === 'version') {
    printVersion();
    process.exit(0);
  }

  if (flags['repl']) {
    if (command && command !== '') {
      console.error('Error: --repl cannot be combined with another command');
      process.exit(1);
    }
    await startRepl({ version: VERSION });
    process.exit(0);
  }

  switch (command) {
    case 'repl': {
      await startRepl({ version: VERSION });
      process.exit(0);
      break;
    }

    case 'init': {
      const result = await init({
        force: flags['force'],
        pack: values['pack'],
        quiet: flags['quiet'],
        agent: flags['agent'],
        yes: flags['yes'],
        mode: values['mode'] as 'local' | 'cloud' | 'kernel' | 'custom' | undefined,
        approval: flags['approval'],
      });
      process.exit(result.success ? 0 : 1);
      break;
    }

    case 'agent': {
      const subCommand = positionals[0] ?? 'help';
      const subArgs = positionals.slice(1);

      switch (subCommand) {
        case 'init': {
          await agentInit({
            directory: values['directory'],
            format: values['format'] as 'json' | 'yaml' | undefined,
          });
          process.exit(0);
          break;
        }

        case 'policy': {
          const policyCmd = subArgs[0] ?? 'help';

          switch (policyCmd) {
            case 'add': {
              const prompt = values['prompt'] ?? subArgs.slice(1).join(' ');
              if (!prompt) {
                console.error('Error: policy add requires a prompt');
                console.error('Usage: veto agent policy add "block external API calls"');
                process.exit(1);
              }
              await agentPolicyAdd(prompt, {
                directory: values['directory'],
                format: values['format'] as 'json' | 'yaml' | undefined,
              });
              process.exit(0);
              break;
            }

            case 'list': {
              await agentPolicyList({
                directory: values['directory'],
                format: values['format'] as 'json' | 'yaml' | undefined,
              });
              process.exit(0);
              break;
            }

            default: {
              console.error(`Unknown agent policy command: ${policyCmd}`);
              console.error('Usage: veto agent policy [add|list]');
              process.exit(1);
            }
          }
          break;
        }

        case 'scan': {
          await agentScan({
            directory: values['directory'],
            format: values['format'] as 'json' | 'yaml' | undefined,
          });
          process.exit(0);
          break;
        }

        case 'config': {
          await agentConfig({
            directory: values['directory'],
            format: values['format'] as 'json' | 'yaml' | undefined,
          });
          process.exit(0);
          break;
        }

        case 'help':
        default: {
          console.log('Agent commands:');
          console.log('  veto agent init              Initialize Veto in agent mode');
          console.log('  veto agent policy add "..."  Add a policy from natural language');
          console.log('  veto agent policy list       List all policies');
          console.log('  veto agent scan              Scan tools and show coverage');
          console.log('  veto agent config            Show current configuration');
          console.log('');
          console.log('Options:');
          console.log('  --directory <path>  Project directory');
          console.log('  --format json|yaml  Output format (default: json)');
          process.exit(0);
          break;
        }
      }
      break;
    }

    case 'learn': {
      await runLearn(flags, values);
      process.exit(0);
      break;
    }

    case 'compile': {
      if (!values['output']) {
        console.error('Error: --output is required for compile command');
        process.exit(1);
      }
      if (values['provider'] && !VALID_PROVIDERS.has(values['provider'])) {
        console.error(`Error: Invalid provider "${values['provider']}". Must be one of: openai, anthropic, gemini, openrouter`);
        process.exit(1);
      }
      const result = await compile({
        input: values['input'],
        file: values['file'],
        output: values['output'],
        provider: values['provider'] as CustomProvider | undefined,
        model: values['model'],
        quiet: flags['quiet'],
      });
      process.exit(result.success ? 0 : 1);
      break;
    }

    case 'test': {
      const testResult = await test({
        policy: values['policy'],
        output: values['output'],
        quiet: flags['quiet'],
        format: (values['format'] as 'text' | 'json') ?? undefined,
      });
      process.exit(testResult.success ? 0 : 1);
      break;
    }

    case 'scan': {
      const scanResult = await scan({
        quiet: flags['quiet'],
        failUncovered: flags['fail-uncovered'],
        suggest: flags['suggest'],
        format: (values['format'] as 'text' | 'json') ?? undefined,
      });
      process.exit(scanResult.success ? 0 : 1);
      break;
    }

    case 'diff': {
      if (positionals.length > 1) {
        console.error('Error: diff command accepts at most one <policy-path> positional argument');
        process.exit(1);
      }

      const diffResult = await diff({
        quiet: flags['quiet'],
        policyPath: positionals[0],
        old: values['old'],
        new: values['new'],
        log: values['log'],
        format: (values['format'] as 'text' | 'json') ?? undefined,
      });
      process.exit(diffResult.success ? 0 : 1);
      break;
    }

    case '': {
      await startRepl({ version: VERSION });
      process.exit(0);
      break;
    }

    default: {
      console.error(`Unknown command: ${command}`);
      console.error('Run "veto help" for usage information.');
      process.exit(1);
    }
  }
}

main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
