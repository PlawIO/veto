#!/usr/bin/env node

import { init } from './init.js';
import { Observer, PolicyGenerator, parseDuration, policiesToYaml } from './learn.js';
import type { StopCondition } from './learn.js';
import { compile } from './compile.js';
import { test } from './test.js';
import type { CustomProvider } from '../custom/types.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const VERSION = '0.1.0';

const VALID_PROVIDERS = new Set(['openai', 'anthropic', 'gemini', 'openrouter']);

function printHelp(): void {
  console.log(`
Veto - AI Agent Tool Call Guardrail

Usage:
  veto <command> [options]

Commands:
  init          Initialize Veto in the current directory
  learn         Observe tool calls and generate policies
  compile       Compile natural language policies to deterministic YAML rules
  test          Run adversarial policy gap analysis
  version       Show version information
  help          Show this help message

Options:
  --force, -f          Force overwrite existing files (init)
  --quiet, -q          Suppress output
  --help, -h           Show help

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

Examples:
  veto init                          Initialize Veto in current directory
  veto init --force                  Reinitialize, overwriting existing files
  veto learn --runs 10               Observe 10 tool calls then generate policies
  veto learn --duration 30m          Observe for 30 minutes
  veto compile --input 'Block emails outside company domain' --output ./veto/rules/email.yaml
  veto compile --file policies.txt --output ./veto/rules/
  veto test                          Analyze policies for gaps
  veto test --policy ./rules         Analyze specific policy directory
  veto test --output report.json     Save JSON report
`);
}

function printVersion(): void {
  console.log(`veto v${VERSION}`);
}

interface ParsedArgs {
  command: string;
  flags: Record<string, boolean>;
  values: Record<string, string>;
}

function parseArgs(args: string[]): ParsedArgs {
  const flags: Record<string, boolean> = {};
  const values: Record<string, string> = {};
  let command = '';

  const valueFlags = new Set([
    'runs', 'duration', 'output', 'margin',
    'input', 'file', 'provider', 'model',
    'policy', 'format',
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
          case 'h': flags['help'] = true; break;
        }
      }
    } else if (!command) {
      command = arg;
    }
  }

  return { command, flags, values };
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
  const { command, flags, values } = parseArgs(args);

  if (flags['help'] || command === 'help') {
    printHelp();
    process.exit(0);
  }

  if (flags['version'] || command === 'version') {
    printVersion();
    process.exit(0);
  }

  switch (command) {
    case 'init': {
      const result = await init({
        force: flags['force'],
        quiet: flags['quiet'],
      });
      process.exit(result.success ? 0 : 1);
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

    case '': {
      console.log('Veto - AI Agent Tool Call Guardrail');
      console.log('');
      console.log('Run "veto help" for usage information.');
      console.log('Run "veto init" to initialize Veto in your project.');
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
