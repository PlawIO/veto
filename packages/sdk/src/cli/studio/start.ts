import { resolve } from 'node:path';
import { getCliVersion } from '../version.js';
import { handleStudioEvent, buildStudioRenderModel, maybeOpenLegacyRepl } from './actions.js';
import {
  createInitialStudioState,
  loadStudioPreferences,
  resolvePreferredWorkspaceIndex,
  type StudioRenderer,
  type StudioRendererPreference,
} from './state.js';
import { createAnsiRenderer } from './renderers/ansi.js';
import { createOpenTuiRenderer } from './renderers/opentui.js';

export interface StartStudioOptions {
  cwd?: string;
  directory?: string;
  renderer?: StudioRendererPreference;
  includeExamples?: boolean;
  includeTests?: boolean;
  demoTemplate?: boolean;
  version?: string;
}

interface RendererSelectionResult {
  renderer: StudioRenderer;
  warning?: string;
}

function createRendererByMode(mode: StudioRendererPreference): StudioRenderer {
  if (mode === 'ansi') {
    return createAnsiRenderer();
  }

  if (mode === 'opentui') {
    return createOpenTuiRenderer();
  }

  return createAnsiRenderer();
}

export async function selectStudioRenderer(
  preference: StudioRendererPreference
): Promise<RendererSelectionResult> {
  if (preference === 'ansi') {
    const renderer = createRendererByMode('ansi');
    await renderer.init();
    return { renderer };
  }

  if (preference === 'opentui') {
    try {
      const renderer = createRendererByMode('opentui');
      await renderer.init();
      return { renderer };
    } catch (error) {
      const fallback = createRendererByMode('ansi');
      await fallback.init();
      return {
        renderer: fallback,
        warning: `OpenTUI unavailable, using ANSI fallback: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  try {
    const renderer = createRendererByMode('opentui');
    await renderer.init();
    return { renderer };
  } catch (error) {
    const fallback = createRendererByMode('ansi');
    await fallback.init();
    return {
      renderer: fallback,
      warning: `OpenTUI unavailable, using ANSI fallback: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function ensureWorkspaceCandidate(state: ReturnType<typeof createInitialStudioState>, directory: string): void {
  const resolvedDirectory = resolve(directory);
  const existingIndex = state.workspaceCandidates.findIndex(
    (candidate) => resolve(candidate.path) === resolvedDirectory
  );

  if (existingIndex >= 0) {
    state.selectedWorkspaceIndex = existingIndex;
    return;
  }

  state.workspaceCandidates.unshift({
    name: resolvedDirectory.split('/').pop() ?? resolvedDirectory,
    path: resolvedDirectory,
    displayPath: resolvedDirectory,
    hasPackageJson: true,
    hasPyproject: false,
    hasVetoConfig: false,
    score: 0,
  });
  state.selectedWorkspaceIndex = 0;
}

export async function startStudio(options: StartStudioOptions = {}): Promise<void> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const cwdPreferences = loadStudioPreferences(cwd);
  const version = options.version ?? getCliVersion();
  const rendererPreference = options.renderer ?? cwdPreferences.preferredRenderer;
  const includeExamples = options.includeExamples ?? cwdPreferences.includeExamples;
  const includeTests = options.includeTests ?? cwdPreferences.includeTests;

  const state = createInitialStudioState({
    cwd,
    version,
    rendererPreference,
    includeExamples,
    includeTests,
    demoTemplate: options.demoTemplate,
  });

  const preferredDirectory = options.directory
    ? resolve(options.directory)
    : cwdPreferences.defaultDirectory;

  state.selectedWorkspaceIndex = resolvePreferredWorkspaceIndex(
    state.workspaceCandidates,
    cwd,
    preferredDirectory
  );

  if (options.directory) {
    ensureWorkspaceCandidate(state, options.directory);
  }

  const { renderer, warning } = await selectStudioRenderer(state.rendererPreference);
  state.activeRenderer = renderer.mode;
  if (warning) {
    state.rendererWarning = warning;
  }

  let enteredWorkspace = false;

  try {
    if (options.directory) {
      await handleStudioEvent(state, { type: 'enter', raw: 'auto-enter' });
      enteredWorkspace = true;
    }

    while (!state.shouldExit) {
      await renderer.render(buildStudioRenderModel(state));

      const event = await renderer.readEvent();
      await handleStudioEvent(state, event);

      if (!enteredWorkspace && state.view === 'workspace' && options.directory) {
        await handleStudioEvent(state, { type: 'enter', raw: 'auto-enter' });
        enteredWorkspace = true;
      }
    }
  } finally {
    await renderer.dispose();
  }

  await maybeOpenLegacyRepl(state);
}
