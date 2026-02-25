import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

interface PackageJson {
  version?: string;
}

const FALLBACK_VERSION = '0.0.0';

export function getCliVersion(): string {
  if (typeof process.env.npm_package_version === 'string' && process.env.npm_package_version.trim()) {
    return process.env.npm_package_version.trim();
  }

  const currentDir = dirname(fileURLToPath(import.meta.url));
  const packageJsonPath = join(currentDir, '..', '..', 'package.json');

  if (!existsSync(packageJsonPath)) {
    return FALLBACK_VERSION;
  }

  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as PackageJson;
    if (typeof parsed.version === 'string' && parsed.version.trim()) {
      return parsed.version.trim();
    }
  } catch {
    return FALLBACK_VERSION;
  }

  return FALLBACK_VERSION;
}
