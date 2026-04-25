import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scaffoldCreateVetoApp } from '../src/index.js';

let tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe('create-veto-app scaffolder', () => {
  afterEach(() => {
    for (const tempDir of tempDirs) {
      rmSync(tempDir, { recursive: true, force: true });
    }
    tempDirs = [];
  });

  it('scaffolds a node-ts app without installs or committed secrets', async () => {
    const parentDir = makeTempDir('create-veto-app-');
    const projectDir = join(parentDir, 'agent');

    const result = await scaffoldCreateVetoApp({
      projectDir,
      template: 'node-ts',
      pack: 'soc2-lite',
      cloud: true,
      apiKey: 'veto_test_secret',
      noInstall: true,
    });

    expect(result.pack).toBe('@veto/soc2-lite');
    expect(existsSync(join(projectDir, 'package.json'))).toBe(true);
    expect(existsSync(join(projectDir, 'README.md'))).toBe(true);
    expect(existsSync(join(projectDir, '.gitignore'))).toBe(true);
    expect(existsSync(join(projectDir, '.env.example'))).toBe(true);
    expect(existsSync(join(projectDir, 'tsconfig.json'))).toBe(true);
    expect(existsSync(join(projectDir, 'src', 'index.ts'))).toBe(true);
    expect(existsSync(join(projectDir, 'veto', 'veto.config.yaml'))).toBe(true);
    expect(existsSync(join(projectDir, 'veto', 'rules', 'defaults.yaml'))).toBe(true);

    const defaultsYaml = readFileSync(join(projectDir, 'veto', 'rules', 'defaults.yaml'), 'utf-8');
    expect(defaultsYaml).toContain('extends: "@veto/soc2-lite"');

    const envExample = readFileSync(join(projectDir, '.env.example'), 'utf-8');
    expect(envExample).toContain('# VETO_API_KEY=veto_...');
    expect(envExample).not.toContain('veto_test_secret');

    const gitignore = readFileSync(join(projectDir, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('node_modules');
    expect(gitignore).toContain('dist');
    expect(gitignore).toContain('.env');
    expect(gitignore).toContain('veto/.env');
    expect(gitignore).toContain('veto/*.local.yaml');
    expect(gitignore).toContain('veto/veto.config.yaml');

    expect(existsSync(join(projectDir, 'node_modules'))).toBe(false);
    expect(existsSync(join(projectDir, 'package-lock.json'))).toBe(false);
    expect(existsSync(join(projectDir, 'pnpm-lock.yaml'))).toBe(false);
    expect(existsSync(join(projectDir, 'yarn.lock'))).toBe(false);
    expect(existsSync(join(projectDir, 'bun.lockb'))).toBe(false);
  });

  it('rejects non-empty existing target directories', async () => {
    const projectDir = makeTempDir('create-veto-app-nonempty-');
    writeFileSync(join(projectDir, 'existing.txt'), 'do not overwrite', 'utf-8');

    await expect(scaffoldCreateVetoApp({
      projectDir,
      template: 'node-ts',
      pack: 'none',
    })).rejects.toThrow(/not empty/);
  });
});
