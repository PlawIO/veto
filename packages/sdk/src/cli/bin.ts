#!/usr/bin/env node

function printBaseHelp(): void {
  console.log(`
Veto CLI

Usage:
  veto [command] [options]

Common commands:
  studio
  init
  policy generate
  guard check
  mcp serve
  receipts export
  receipts verify
  doctor
  version
  help

Options:
  --help, -h       Show this help
  --version        Show version

Some CLI commands use optional peer dependencies. If a command reports a
missing optional dependency, install the dedicated CLI package or the peer
dependencies for this package.
`);
}

function isMissingOptionalCliDependency(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const maybeError = error as Error & { code?: string };
  return (
    maybeError.code === 'ERR_MODULE_NOT_FOUND'
    || /Cannot find package ['"](?:yaml|picocolors|veto-receipt-protocol|ink|react|@opentui\/core)['"]/.test(error.message)
  );
}

function printMissingOptionalCliDependency(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  console.error('');
  console.error(
    'This command needs optional CLI peer dependencies. Install `veto-cli`, or install the required peers for `veto-sdk`.',
  );
}

async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h') || argv[0] === 'help') {
    printBaseHelp();
    return;
  }

  if (argv.includes('--version') || argv[0] === 'version') {
    const { getCliVersion } = await import('./version.js');
    console.log(`veto v${getCliVersion()}`);
    return;
  }

  try {
    const { runCli } = await import('./runner.js');
    process.exit(await runCli(argv));
  } catch (error) {
    if (isMissingOptionalCliDependency(error)) {
      printMissingOptionalCliDependency(error);
    } else {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
    process.exit(1);
  }
}

void main();
