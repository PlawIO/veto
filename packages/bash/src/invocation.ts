import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { BashInvocation, ParsedCliArgs, ValidationArguments, ValidationRequestContext } from './types.js';
import { DEFAULT_CACHE_TTL_SECONDS, DEFAULT_VETO_API_URL } from './types.js';

function normalizeApiUrl(value: string): string {
  return value.replace(/\/$/, '');
}

function parseIntegerFlag(flag: string, value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid ${flag} value '${value}'. Expected a non-negative integer.`);
  }
  return parsed;
}

function readFlagValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (typeof value !== 'string') {
    throw new Error(`Missing value for ${flag}.`);
  }
  return value;
}

function isShortOptionBundle(arg: string): boolean {
  return /^-[^-]+$/.test(arg);
}

function bundleIncludes(arg: string, option: string): boolean {
  return isShortOptionBundle(arg) && arg.slice(1).includes(option);
}

const LONG_OPTIONS_WITH_VALUE = new Set([
  '--rcfile',
  '--init-file',
]);

const LONG_OPTIONS_NO_VALUE = new Set([
  '--debugger',
  '--dump-po-strings',
  '--dump-strings',
]);

const SHORT_OPTIONS_WITH_VALUE = new Set([
  '-O',
  '+O',
  '-o',
  '+o',
]);

const SHORT_OPTIONS_NO_VALUE = new Set([
  '-D',
]);

function hasInlineOptionValue(arg: string): boolean {
  return arg.startsWith('--rcfile=') || arg.startsWith('--init-file=');
}

function optionConsumesNextArg(arg: string): boolean {
  return SHORT_OPTIONS_WITH_VALUE.has(arg) || LONG_OPTIONS_WITH_VALUE.has(arg);
}

function isStandaloneOption(arg: string): boolean {
  return LONG_OPTIONS_NO_VALUE.has(arg) || SHORT_OPTIONS_NO_VALUE.has(arg);
}

export function parseCliArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): ParsedCliArgs {
  let apiKey = env.VETO_API_KEY;
  let apiUrl = env.VETO_API_URL ?? DEFAULT_VETO_API_URL;
  let cacheTtlSeconds = DEFAULT_CACHE_TTL_SECONDS;
  let offline = false;

  let index = 0;
  while (index < argv.length) {
    const arg = argv[index];

    if (arg === '--') {
      return {
        options: {
          apiKey,
          apiUrl: normalizeApiUrl(apiUrl),
          cacheTtlSeconds,
          offline,
        },
        bashArgv: argv.slice(index + 1),
      };
    }

    if (arg === '--veto-api-key') {
      apiKey = readFlagValue(argv, index, arg);
      index += 2;
      continue;
    }

    if (arg === '--veto-api-url') {
      apiUrl = readFlagValue(argv, index, arg);
      index += 2;
      continue;
    }

    if (arg === '--cache-ttl') {
      cacheTtlSeconds = parseIntegerFlag(arg, readFlagValue(argv, index, arg));
      index += 2;
      continue;
    }

    if (arg === '--offline') {
      offline = true;
      index += 1;
      continue;
    }

    break;
  }

  return {
    options: {
      apiKey,
      apiUrl: normalizeApiUrl(apiUrl),
      cacheTtlSeconds,
      offline,
    },
    bashArgv: argv.slice(index),
  };
}

async function defaultReadFile(path: string): Promise<string> {
  return readFile(path, 'utf-8');
}

export async function readAllStdin(stream: NodeJS.ReadStream = process.stdin): Promise<string> {
  stream.setEncoding('utf8');

  let buffer = '';
  for await (const chunk of stream) {
    buffer += chunk;
  }
  return buffer;
}

export async function resolveBashInvocation(
  bashArgv: string[],
  options: {
    cwd: string;
    stdinIsTTY: boolean;
    readFile?: (path: string) => Promise<string>;
    readStdin?: () => Promise<string>;
  }
): Promise<BashInvocation> {
  const readFileImpl = options.readFile ?? defaultReadFile;
  const readStdinImpl = options.readStdin ?? (() => readAllStdin());
  let optionsEnded = false;
  let stdinMode = false;

  for (let index = 0; index < bashArgv.length; index += 1) {
    const arg = bashArgv[index];

    if (!optionsEnded && arg === '--') {
      optionsEnded = true;
      continue;
    }

    if (!optionsEnded && (arg === '-c' || bundleIncludes(arg, 'c'))) {
      const command = bashArgv[index + 1];
      if (typeof command !== 'string') {
        return { kind: 'interactive', bashArgv };
      }
      return {
        kind: 'command',
        bashArgv,
        command,
      };
    }

    if (!optionsEnded && (arg === '-s' || bundleIncludes(arg, 's'))) {
      stdinMode = true;
      continue;
    }

    if (!optionsEnded && optionConsumesNextArg(arg)) {
      index += 1;
      continue;
    }

    if (!optionsEnded && (hasInlineOptionValue(arg) || isStandaloneOption(arg))) {
      continue;
    }

    if (!optionsEnded && arg.startsWith('-')) {
      continue;
    }

    if (stdinMode) {
      continue;
    }

    const scriptPath = resolve(options.cwd, arg);
    try {
      const command = await readFileImpl(scriptPath);
      return {
        kind: 'script-file',
        bashArgv,
        command,
        scriptPath,
        scriptArg: arg,
      };
    } catch (error) {
      throw new Error(
        `Failed to read bash script ${scriptPath}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  if (!stdinMode) {
    return { kind: 'interactive', bashArgv };
  }

  if (options.stdinIsTTY) {
    return { kind: 'interactive', bashArgv };
  }

  const stdinText = await readStdinImpl();
  return {
    kind: 'stdin',
    bashArgv,
    command: stdinText,
    stdinText,
  };
}

export function buildValidationArguments(invocation: Extract<BashInvocation, { kind: 'command' | 'script-file' | 'stdin' }>, cwd: string): ValidationArguments {
  return {
    command: invocation.command,
    cwd,
    argv: [...invocation.bashArgv],
    shellMode: invocation.kind,
    scriptPath: invocation.kind === 'script-file' ? invocation.scriptPath : undefined,
    stdin: invocation.kind === 'stdin' ? true : undefined,
  };
}

export function buildValidationRequestContext(
  invocation: Extract<BashInvocation, { kind: 'command' | 'script-file' | 'stdin' }>,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env
): ValidationRequestContext {
  return {
    sessionId: env.VETO_SESSION_ID,
    agentId: env.VETO_AGENT_ID,
    userId: env.VETO_USER_ID,
    role: env.VETO_ROLE,
    cwd,
    shellMode: invocation.kind,
    bashArgv: [...invocation.bashArgv],
    scriptPath: invocation.kind === 'script-file' ? invocation.scriptPath : undefined,
  };
}
