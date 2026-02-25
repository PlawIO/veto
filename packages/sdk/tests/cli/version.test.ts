import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface PackageJsonFixture {
  version?: string;
}

const PACKAGE_JSON_PATH = resolve(process.cwd(), 'package.json');

function getPackageVersionFromDisk(): string {
  const parsed = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf-8')) as PackageJsonFixture;
  if (!parsed.version) {
    throw new Error('Expected package.json to define version');
  }
  return parsed.version;
}

describe('cli version', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    delete process.env.VETO_CLI_VERSION;
    delete process.env.npm_package_name;
    delete process.env.npm_package_version;
  });

  it('prefers package.json version over unrelated npm environment variables', async () => {
    process.env.npm_package_name = 'paper-heatmap-capture';
    process.env.npm_package_version = '0.1.0';

    const { getCliVersion } = await import('../../src/cli/version.js');

    expect(getCliVersion()).toBe(getPackageVersionFromDisk());
  });

  it('uses npm environment version when package metadata is unavailable and package name matches', async () => {
    process.env.npm_package_name = 'veto-cli';
    process.env.npm_package_version = '9.9.9-test';

    vi.doMock('node:fs', () => ({
      existsSync: () => false,
      readFileSync: vi.fn(),
    }));

    const { getCliVersion } = await import('../../src/cli/version.js');

    expect(getCliVersion()).toBe('9.9.9-test');
  });

  it('uses explicit VETO_CLI_VERSION when provided', async () => {
    process.env.VETO_CLI_VERSION = '1.2.3-explicit';

    const { getCliVersion } = await import('../../src/cli/version.js');

    expect(getCliVersion()).toBe('1.2.3-explicit');
  });
});
