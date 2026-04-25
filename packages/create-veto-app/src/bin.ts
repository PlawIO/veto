#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import {
  type CreateVetoAppTemplate,
  type ScaffoldCreateVetoAppOptions,
  getPolicyPackChoices,
  scaffoldCreateVetoApp,
} from './index.js';

interface ParsedArgs {
  projectDir?: string;
  template?: string;
  pack?: string;
  cloud?: boolean;
  apiKey?: string;
  yes: boolean;
  noInstall: boolean;
  help: boolean;
}

const USAGE = `Usage:
  create-veto-app <project-dir> --template node-ts --pack soc2-lite --cloud --yes

Options:
  --template <name>   Template to scaffold. Supported: node-ts
  --pack <name>       Built-in policy pack, or none/default
  --cloud             Generate Veto config in cloud API mode
  --api-key <value>   Write a Veto Cloud API key into veto/veto.config.yaml
  --yes, -y           Non-interactive mode
  --no-install        Accepted for compatibility; installs are never run by default
  --help, -h          Show this help
`;

function readFlagValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith('-')) {
    throw new Error(`Missing value for ${flag}.`);
  }
  return value;
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    yes: false,
    noInstall: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
      continue;
    }

    if (arg === '--yes' || arg === '-y') {
      parsed.yes = true;
      continue;
    }

    if (arg === '--no-install') {
      parsed.noInstall = true;
      continue;
    }

    if (arg === '--cloud') {
      parsed.cloud = true;
      continue;
    }

    if (arg.startsWith('--template=')) {
      parsed.template = arg.slice('--template='.length);
      continue;
    }

    if (arg === '--template') {
      parsed.template = readFlagValue(argv, index, '--template');
      index += 1;
      continue;
    }

    if (arg.startsWith('--pack=')) {
      parsed.pack = arg.slice('--pack='.length);
      continue;
    }

    if (arg === '--pack') {
      parsed.pack = readFlagValue(argv, index, '--pack');
      index += 1;
      continue;
    }

    if (arg.startsWith('--api-key=')) {
      parsed.apiKey = arg.slice('--api-key='.length);
      continue;
    }

    if (arg === '--api-key') {
      parsed.apiKey = readFlagValue(argv, index, '--api-key');
      index += 1;
      continue;
    }

    if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    }

    if (parsed.projectDir) {
      throw new Error(`Unexpected extra argument: ${arg}`);
    }
    parsed.projectDir = arg;
  }

  return parsed;
}

function isInteractive(parsed: ParsedArgs): boolean {
  return !parsed.yes && input.isTTY === true && output.isTTY === true;
}

function withDefault(value: string | undefined, fallback: string): string {
  return value && value.trim() !== '' ? value : fallback;
}

async function promptForOptions(parsed: ParsedArgs): Promise<ScaffoldCreateVetoAppOptions> {
  const rl = createInterface({ input, output });
  try {
    const defaultProjectDir = parsed.projectDir ?? 'my-veto-agent';
    const projectDirAnswer = await rl.question(`Project directory (${defaultProjectDir}): `);
    const templateDefault = parsed.template ?? 'node-ts';
    const templateAnswer = await rl.question(`Template (${templateDefault}): `);
    const packChoices = getPolicyPackChoices();
    const packDefault = parsed.pack ?? 'none';
    output.write(`Policy packs: ${packChoices.join(', ')}\n`);
    const packAnswer = await rl.question(`Policy pack (${packDefault}): `);
    const cloudDefault = parsed.cloud === true ? 'y' : 'n';
    const cloudAnswer = await rl.question(`Use Veto Cloud mode? (${cloudDefault}): `);
    const cloud = withDefault(cloudAnswer, cloudDefault).toLowerCase().startsWith('y');
    const apiKey = cloud
      ? withDefault(await rl.question('Veto Cloud API key (optional, leave blank to use VETO_API_KEY): '), '')
      : undefined;

    return {
      projectDir: withDefault(projectDirAnswer, defaultProjectDir),
      template: withDefault(templateAnswer, templateDefault) as CreateVetoAppTemplate,
      pack: withDefault(packAnswer, packDefault),
      cloud,
      apiKey: apiKey || undefined,
      noInstall: parsed.noInstall,
    };
  } finally {
    rl.close();
  }
}

function optionsFromParsed(parsed: ParsedArgs): ScaffoldCreateVetoAppOptions {
  if (!parsed.projectDir) {
    throw new Error('Project directory is required in non-interactive mode.\n\n' + USAGE);
  }

  return {
    projectDir: parsed.projectDir,
    template: (parsed.template ?? 'node-ts') as CreateVetoAppTemplate,
    pack: parsed.pack,
    cloud: parsed.cloud,
    apiKey: parsed.apiKey,
    noInstall: parsed.noInstall,
  };
}

function printResult(result: Awaited<ReturnType<typeof scaffoldCreateVetoApp>>, apiKeyWritten: boolean): void {
  output.write(`Created ${result.projectName} at ${result.targetDir}\n`);
  output.write(`Template: ${result.template}\n`);
  output.write(`Policy pack: ${result.pack ?? 'default'}\n`);
  if (apiKeyWritten) {
    output.write('API key was written to veto/veto.config.yaml; that file is ignored by .gitignore.\n');
  }
  output.write('\nNext steps:\n');
  for (const step of result.nextSteps) {
    output.write(`  ${step}\n`);
  }
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    output.write(USAGE);
    return;
  }

  const options = isInteractive(parsed)
    ? await promptForOptions(parsed)
    : optionsFromParsed(parsed);
  const result = await scaffoldCreateVetoApp(options);
  printResult(result, typeof options.apiKey === 'string' && options.apiKey.length > 0);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
