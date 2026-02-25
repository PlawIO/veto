import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

interface PackageJson {
  name?: string;
  version?: string;
}

const FALLBACK_VERSION = '0.0.0';
const SUPPORTED_PACKAGE_NAMES = new Set(['veto-sdk', 'veto-cli']);

function readVersionFromPackageJson(packageJsonPath: string): string | undefined {
  if (!existsSync(packageJsonPath)) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as PackageJson;
    if (typeof parsed.version === 'string' && parsed.version.trim()) {
      return parsed.version.trim();
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function readVersionFromNpmEnv(): string | undefined {
  const packageName = process.env.npm_package_name?.trim();
  const packageVersion = process.env.npm_package_version?.trim();

  if (!packageVersion) {
    return undefined;
  }

  if (packageName && !SUPPORTED_PACKAGE_NAMES.has(packageName)) {
    return undefined;
  }

  return packageVersion;
}

export function getCliVersion(): string {
  const explicitVersion = process.env.VETO_CLI_VERSION?.trim();
  if (explicitVersion) {
    return explicitVersion;
  }

  const currentDir = dirname(fileURLToPath(import.meta.url));
  const packageJsonPath = join(currentDir, '..', '..', 'package.json');
  const fileVersion = readVersionFromPackageJson(packageJsonPath);
  if (fileVersion) {
    return fileVersion;
  }

  const envVersion = readVersionFromNpmEnv();
  if (envVersion) {
    return envVersion;
  }

  return FALLBACK_VERSION;
}
