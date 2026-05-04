#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMcpServeCommand, type McpServeOptions } from './mcp.js';
import { parseArgs } from './runner.js';

function printHelp(): void {
  console.log('Usage: veto-mcp-proxy [--config <path>] [--listen <host:port>] [--upstream <url>] [--transport <mcp-sse|mcp-stdio>] [--api-key <key>] [--policy-server <url>] [--timeout-ms <n>] [--json]');
}

export function parseMcpProxyOptions(argv: string[] = process.argv.slice(2)): McpServeOptions | null {
  const { command, positionals, flags, values } = parseArgs(['veto-mcp-proxy', ...argv]);

  if (command !== 'veto-mcp-proxy') {
    throw new Error(`Unknown command: ${command}`);
  }

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

  await runMcpServeCommand(options);
}

export async function runMcpProxyCliOrExit(argv: string[] = process.argv.slice(2)): Promise<void> {
  try {
    await runMcpProxyCli(argv);
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
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
