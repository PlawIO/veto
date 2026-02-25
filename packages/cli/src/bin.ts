#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCliOrExit } from 'veto-sdk/cli-runner';

interface PackageMetadata {
  version?: string;
}

function setExplicitCliVersion(): void {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const packageJsonPath = join(currentDir, '..', 'package.json');

  if (!existsSync(packageJsonPath)) {
    return;
  }

  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as PackageMetadata;
    if (typeof parsed.version === 'string' && parsed.version.trim().length > 0) {
      process.env.VETO_CLI_VERSION = parsed.version.trim();
    }
  } catch {
    // Ignore invalid package metadata and let runner resolve version normally.
  }
}

setExplicitCliVersion();
void runCliOrExit();
