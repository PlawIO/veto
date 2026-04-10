import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const NATIVE_BINARY_NAME = process.platform === 'win32'
  ? 'veto-bash-native.exe'
  : 'veto-bash-native';

export function resolveNativeBinaryPath(): string {
  const override = process.env.VETO_BASH_NATIVE_BIN?.trim();
  if (override) {
    return override;
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const packaged = resolve(here, './native', NATIVE_BINARY_NAME);
  if (existsSync(packaged)) {
    return packaged;
  }

  const repoBuilt = resolve(here, '../../../crates/veto-bash/target/release', NATIVE_BINARY_NAME);
  if (existsSync(repoBuilt)) {
    return repoBuilt;
  }

  const siblingBuilt = resolve(here, '../native', NATIVE_BINARY_NAME);
  if (existsSync(siblingBuilt)) {
    return siblingBuilt;
  }

  throw new Error(
    `Unable to locate ${NATIVE_BINARY_NAME}. Build the native runtime with 'pnpm --filter veto-bash build' or set VETO_BASH_NATIVE_BIN.`
  );
}

export function spawnNativeCli(argv: string[]): never {
  const binary = resolveNativeBinaryPath();
  const result = spawnSync(binary, argv, {
    stdio: 'inherit',
    env: process.env,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.signal) {
    process.kill(process.pid, result.signal);
  }

  process.exit(result.status ?? 1);
}

export function packagedNativeRelativePath(): string {
  return join('dist', 'native', NATIVE_BINARY_NAME);
}
