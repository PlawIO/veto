import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  discoverWorkspaceCandidates,
  loadStudioPreferences,
  persistStudioPreferences,
  resolvePreferredWorkspaceIndex,
} from '../../src/cli/studio/state.js';

const TEST_DIR = `/tmp/veto-studio-test-${Date.now()}`;

function writeFixture(relativePath: string, content: string): void {
  const absolutePath = join(TEST_DIR, relativePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content, 'utf-8');
}

describe('veto studio', () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it('discovers workspace candidates from cwd and direct children', () => {
    writeFixture('package.json', '{"name":"root"}');
    writeFixture('python-app/pyproject.toml', '[project]\nname="py-app"\n');
    writeFixture('node-app/package.json', '{"name":"node-app"}');
    writeFixture('node-app/veto/veto.config.yaml', 'version: "1.0"\n');

    const candidates = discoverWorkspaceCandidates(TEST_DIR);
    const paths = candidates.map((candidate) => candidate.path);

    expect(paths).toContain(resolve(TEST_DIR));
    expect(paths).toContain(resolve(TEST_DIR, 'python-app'));
    expect(paths).toContain(resolve(TEST_DIR, 'node-app'));
  });

  it('persists and loads studio preferences in veto.config.yaml', () => {
    persistStudioPreferences(TEST_DIR, {
      defaultDirectory: './node-app',
      includeExamples: true,
      includeTests: true,
      allowTemplateFallback: true,
      preferredRenderer: 'ansi',
    });

    const loaded = loadStudioPreferences(TEST_DIR);
    expect(loaded.defaultDirectory).toBe('./node-app');
    expect(loaded.includeExamples).toBe(true);
    expect(loaded.includeTests).toBe(true);
    expect(loaded.allowTemplateFallback).toBe(true);
    expect(loaded.preferredRenderer).toBe('ansi');
  });

  it('resolves preferred workspace index from configured directory', () => {
    writeFixture('package.json', '{"name":"root"}');
    writeFixture('node-app/package.json', '{"name":"node-app"}');

    const candidates = discoverWorkspaceCandidates(TEST_DIR);
    const index = resolvePreferredWorkspaceIndex(
      candidates,
      TEST_DIR,
      './node-app'
    );

    expect(candidates[index]?.path).toBe(resolve(TEST_DIR, 'node-app'));
  });

  it('falls back to ANSI renderer with a runtime-specific message outside Bun', async () => {
    if (process.versions.bun) {
      return;
    }

    const { selectStudioRenderer } = await import('../../src/cli/studio/start.js');
    const selection = await selectStudioRenderer('opentui');

    expect(selection.renderer.mode).toBe('ansi');
    expect(selection.warning).toContain('requires Bun runtime APIs');
    await selection.renderer.dispose();
  });

  it('falls back to ANSI renderer when OpenTUI init fails in auto mode', async () => {
    vi.doMock('../../src/cli/studio/renderers/ink.js', () => ({
      createInkRenderer: () => ({
        mode: 'ink' as const,
        init: async () => {
          throw new Error('Ink failed');
        },
        render: async () => undefined,
        readEvent: async () => ({ type: 'quit', raw: 'q' }),
        dispose: async () => undefined,
      }),
    }));

    const { selectStudioRenderer } = await import('../../src/cli/studio/start.js');
    const selection = await selectStudioRenderer('auto');

    expect(selection.renderer.mode).toBe('ansi');
    expect(selection.warning).toContain('Ink unavailable');
    await selection.renderer.dispose();
  });

  it('falls back to ANSI renderer when Ink module fails to load in auto mode', async () => {
    vi.doMock('../../src/cli/studio/renderers/ink.js', () => {
      throw new Error('Ink module load failed');
    });

    const { selectStudioRenderer } = await import('../../src/cli/studio/start.js');
    const selection = await selectStudioRenderer('auto');

    expect(selection.renderer.mode).toBe('ansi');
    expect(selection.warning).toContain('Ink unavailable');
    await selection.renderer.dispose();
  });

  it('falls back to Ink when OpenTUI init fails in explicit opentui mode', async () => {
    vi.doMock('../../src/cli/studio/renderers/opentui.js', () => ({
      createOpenTuiRenderer: () => ({
        mode: 'opentui' as const,
        init: async () => {
          throw new Error('OpenTUI failed');
        },
        render: async () => undefined,
        readEvent: async () => ({ type: 'quit', raw: 'q' }),
        dispose: async () => undefined,
      }),
    }));
    vi.doMock('../../src/cli/studio/renderers/ink.js', () => ({
      createInkRenderer: () => ({
        mode: 'ink' as const,
        init: async () => undefined,
        render: async () => undefined,
        readEvent: async () => ({ type: 'quit', raw: 'q' }),
        dispose: async () => undefined,
      }),
    }));

    const { selectStudioRenderer } = await import('../../src/cli/studio/start.js');
    const selection = await selectStudioRenderer('opentui');

    expect(selection.renderer.mode).toBe('ink');
    expect(selection.warning).toContain('OpenTUI unavailable, using Ink fallback');
    await selection.renderer.dispose();
  });
});
