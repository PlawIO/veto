import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { loadVetoConfig } from '../../src/cli/config.js';
import { silentLogger } from '../../src/utils/logger.js';

const TEST_DIR = `/tmp/veto-config-cli-test-${Date.now()}`;

function writeFixture(relativePath: string, content: string): void {
  const path = join(TEST_DIR, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf-8');
}

describe('loadVetoConfig', () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it('loads a valid rules directory inside the project', async () => {
    writeFixture('veto/veto.config.yaml', `version: "1.0"
rules:
  directory: ./rules
logging:
  level: silent
`);
    writeFixture('veto/rules/defaults.yaml', `version: "1.0"
name: defaults
rules:
  - id: block-shell
    name: Block shell
    action: block
    tools: [bash]
`);

    const config = await loadVetoConfig(join(TEST_DIR, 'veto'), {
      yamlParser: parseYaml,
      logger: silentLogger,
    });
    await config.validator.initialize();

    expect(config.rulesDir).toBe(join(TEST_DIR, 'veto', 'rules'));
    expect(config.validator.getRuleLoader().getRules().allRules).toHaveLength(1);
  });

  it('rejects missing configured rules directories', async () => {
    writeFixture('veto/veto.config.yaml', `version: "1.0"
rules:
  directory: ./missing-rules
`);

    await expect(loadVetoConfig(join(TEST_DIR, 'veto'), {
      yamlParser: parseYaml,
      logger: silentLogger,
    })).rejects.toThrow('Rules directory does not exist');
  });

  it('rejects rules directories outside the project boundary', async () => {
    writeFixture('veto/veto.config.yaml', `version: "1.0"
rules:
  directory: ../../outside
`);

    await expect(loadVetoConfig(join(TEST_DIR, 'veto'), {
      yamlParser: parseYaml,
      logger: silentLogger,
    })).rejects.toThrow('inside the project');
  });

  it('fails validator initialization on invalid configured policy files', async () => {
    writeFixture('veto/veto.config.yaml', `version: "1.0"
rules:
  directory: ./rules
`);
    writeFixture('veto/rules/bad.yaml', '{{not yaml');

    const config = await loadVetoConfig(join(TEST_DIR, 'veto'), {
      yamlParser: parseYaml,
      logger: silentLogger,
    });

    await expect(config.validator.initialize()).rejects.toThrow();
  });
});
