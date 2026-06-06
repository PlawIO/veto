#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { McpServeOptions } from './mcp.js';

interface ParsedMcpProxyArgs {
  flags: Record<string, boolean>;
  values: Record<string, string>;
  positionals: string[];
}

function printHelp(): void {
  console.log('Usage: veto-mcp-proxy [--config <path>] [--listen <host:port>] [--upstream <url>] [--transport <mcp-sse|mcp-stdio>] [--api-key <key>] [--policy-server <url>] [--timeout-ms <n>] [--json]');
}

function parseMcpProxyArgs(args: string[]): ParsedMcpProxyArgs {
  const valueFlags = new Set([
    'config',
    'listen',
    'upstream',
    'transport',
    'api-key',
    'policy-server',
    'timeout-ms',
  ]);
  const flags: Record<string, boolean> = {};
  const values: Record<string, string> = {};
  const positionals: string[] = [];

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

    if (arg === '-h') {
      flags.help = true;
      continue;
    }

    positionals.push(arg);
  }

  return { flags, values, positionals };
}

export function parseMcpProxyOptions(argv: string[] = process.argv.slice(2)): McpServeOptions | null {
  const { positionals, flags, values } = parseMcpProxyArgs(argv);

  if (positionals.length > 0) {
    throw new Error(`Unknown argument: ${positionals[0]}`);
  }

  if (flags.help) {
    return null;
  }

  const timeoutMs = values['timeout-ms']
    ? Number.parseInt(values['timeout-ms'], 10)
    : undefined;

  if (values['timeout-ms'] && (!Number.isInteger(timeoutMs) || (timeoutMs ?? 0) <= 0)) {
    throw new Error('veto-mcp-proxy --timeout-ms must be a positive integer.');
  }

  return {
    configPath: values.config,
    listen: values.listen,
    upstream: values.upstream,
    transport: values.transport,
    apiKey: values['api-key'],
    policyServer: values['policy-server'],
    timeoutMs,
    asJson: flags.json ?? false,
  };
}

export async function runMcpProxyCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  const options = parseMcpProxyOptions(argv);

  if (!options) {
    printHelp();
    return;
  }

  const { runMcpServeCommand } = await import('./mcp.js');
  await runMcpServeCommand(options);
}

export async function runMcpProxyCliOrExit(argv: string[] = process.argv.slice(2)): Promise<void> {
  try {
    await runMcpProxyCli(argv);
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    if (
      error instanceof Error
      && /Cannot find package ['"](?:yaml|veto-receipt-protocol)['"]/.test(error.message)
    ) {
      console.error('');
      console.error(
        'This command needs optional MCP/CLI peer dependencies. Install `veto-cli`, or install the required peers for `veto-sdk`.',
      );
    }
    process.exit(1);
  }
}

function isMainModule(): boolean {
  const entryPath = process.argv[1];
  if (!entryPath) {
    return false;
  }

  const modulePath = fileURLToPath(import.meta.url);
  try {
    return realpathSync(modulePath) === realpathSync(entryPath);
  } catch {
    return modulePath === resolve(entryPath);
  }
}

if (isMainModule()) {
  void runMcpProxyCliOrExit();
}
