import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(scriptDir, '..');
const repoDir = resolve(packageDir, '../..');
const crateManifest = resolve(repoDir, 'crates/veto-bash/Cargo.toml');
const binaryName = process.platform === 'win32' ? 'veto-bash-native.exe' : 'veto-bash-native';
const builtBinary = resolve(repoDir, 'crates/veto-bash/target/release', binaryName);
const nativeOutDir = resolve(packageDir, 'dist/native');
const nativeOutPath = join(nativeOutDir, binaryName);

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: process.env });
  if (result.error) {
    process.stderr.write(`Failed to spawn '${command}': ${result.error.message}\n`);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

rmSync(resolve(packageDir, 'dist'), { recursive: true, force: true });
run('cargo', ['build', '--release', '--manifest-path', crateManifest], repoDir);
run('tsc', [], packageDir);
mkdirSync(nativeOutDir, { recursive: true });
cpSync(builtBinary, nativeOutPath);
