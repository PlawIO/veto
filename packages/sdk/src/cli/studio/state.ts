import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parse as parseYaml, stringify } from 'yaml';
import { DEFAULT_CONFIG } from '../templates.js';
import type { ReplSessionContext } from '../repl-context.js';
import type { Rule } from '../../rules/types.js';
import type { StudioEvent } from './events.js';

export type StudioView =
  | 'workspace'
  | 'discover'
  | 'home'
  | 'wizard'
  | 'simulate'
  | 'review'
  | 'setup';

export type StudioRendererPreference = 'auto' | 'opentui' | 'ansi';
export type StudioRendererMode = 'opentui' | 'ansi';

export interface StudioWorkspaceCandidate {
  name: string;
  path: string;
  displayPath: string;
  hasPackageJson: boolean;
  hasPyproject: boolean;
  hasVetoConfig: boolean;
  score: number;
}

export interface StudioPreferences {
  defaultDirectory?: string;
  includeExamples: boolean;
  includeTests: boolean;
  allowTemplateFallback: boolean;
  preferredRenderer: StudioRendererPreference;
}

export interface StudioWizardState {
  stage: 'tool' | 'action' | 'threshold' | 'prompt';
  selectedToolIndex: number;
  selectedActionIndex: number;
  thresholdInput: string;
  promptInput: string;
  generatedYaml?: string;
  generatedSavePath?: string;
  generatedRuleIds: string[];
  generatedWarnings: string[];
}

export interface StudioSimulationState {
  stage: 'tool' | 'args';
  selectedToolIndex: number;
  argsInput: string;
  resultLines: string[];
}

export interface StudioSetupState {
  selectedIndex: number;
  message?: string;
}

export interface StudioState {
  brandName: string;
  version: string;
  cwd: string;
  view: StudioView;
  paletteOpen: boolean;
  paletteQuery: string;
  selectedWorkspaceIndex: number;
  selectedHomeIndex: number;
  selectedPaletteIndex: number;
  workspaceCandidates: StudioWorkspaceCandidate[];
  workspaceDir?: string;
  workspaceDisplayPath?: string;
  context?: ReplSessionContext;
  includeExamples: boolean;
  includeTests: boolean;
  allowTemplateFallback: boolean;
  rendererPreference: StudioRendererPreference;
  activeRenderer: StudioRendererMode;
  rendererWarning?: string;
  demoTemplate: boolean;
  messageLines: string[];
  warningLine?: string;
  wizard: StudioWizardState;
  simulation: StudioSimulationState;
  setup: StudioSetupState;
  shouldExit: boolean;
  openLegacyRequested: boolean;
}

export interface StudioRenderModel {
  title: string;
  subtitle?: string;
  lines: string[];
  footer?: string;
}

export interface StudioRenderer {
  mode: StudioRendererMode;
  init(): Promise<void>;
  render(model: StudioRenderModel): Promise<void>;
  readEvent(): Promise<StudioEvent>;
  dispose(): Promise<void>;
}

interface StudioConfigFile {
  studio?: {
    workspace?: {
      defaultDirectory?: string;
      includeExamples?: boolean;
      includeTests?: boolean;
    };
    generation?: {
      allowTemplateFallback?: boolean;
    };
    renderer?: {
      preferred?: StudioRendererPreference;
    };
  };
}

export const STUDIO_HOME_ACTIONS = [
  'Create Policy',
  'Simulate Tool Call',
  'Explain Rule',
  'Rescan',
  'Switch Workspace',
  'Export Rules',
  'Open Legacy REPL',
] as const;

export const STUDIO_POLICY_ACTIONS = [
  'block',
  'require_approval',
  'allow',
  'warn',
  'log',
] as const;

export const STUDIO_SETUP_ACTIONS = [
  'Configure Cloud',
  'Configure Kernel',
  'Configure Self-Hosted',
  'Back',
] as const;

export interface CreateInitialStudioStateOptions {
  cwd?: string;
  version: string;
  rendererPreference: StudioRendererPreference;
  includeExamples?: boolean;
  includeTests?: boolean;
  demoTemplate?: boolean;
}

function hasWorkspaceMarker(directory: string): {
  hasPackageJson: boolean;
  hasPyproject: boolean;
  hasVetoConfig: boolean;
} {
  const hasPackageJson = existsSync(join(directory, 'package.json'));
  const hasPyproject = existsSync(join(directory, 'pyproject.toml'));
  const hasVetoConfig = existsSync(join(directory, 'veto', 'veto.config.yaml'));

  return {
    hasPackageJson,
    hasPyproject,
    hasVetoConfig,
  };
}

function scoreWorkspace(marker: {
  hasPackageJson: boolean;
  hasPyproject: boolean;
  hasVetoConfig: boolean;
}): number {
  let score = 0;
  if (marker.hasVetoConfig) score += 3;
  if (marker.hasPackageJson) score += 2;
  if (marker.hasPyproject) score += 2;
  return score;
}

export function discoverWorkspaceCandidates(cwd: string): StudioWorkspaceCandidate[] {
  const resolvedCwd = resolve(cwd);
  const candidates: StudioWorkspaceCandidate[] = [];

  const addCandidate = (directory: string): void => {
    const marker = hasWorkspaceMarker(directory);
    if (!marker.hasPackageJson && !marker.hasPyproject && !marker.hasVetoConfig) {
      return;
    }

    const score = scoreWorkspace(marker);
    const displayPath = directory === resolvedCwd
      ? '.'
      : `./${relative(resolvedCwd, directory)}`;

    candidates.push({
      name: directory === resolvedCwd ? '(current directory)' : directory.split('/').pop() ?? directory,
      path: directory,
      displayPath,
      hasPackageJson: marker.hasPackageJson,
      hasPyproject: marker.hasPyproject,
      hasVetoConfig: marker.hasVetoConfig,
      score,
    });
  };

  addCandidate(resolvedCwd);

  let entries: string[] = [];
  try {
    entries = readdirSync(resolvedCwd);
  } catch {
    entries = [];
  }

  for (const entry of entries) {
    const fullPath = join(resolvedCwd, entry);

    let stats;
    try {
      stats = statSync(fullPath);
    } catch {
      continue;
    }

    if (!stats.isDirectory()) {
      continue;
    }

    addCandidate(fullPath);
  }

  if (candidates.length === 0) {
    candidates.push({
      name: '(current directory)',
      path: resolvedCwd,
      displayPath: '.',
      hasPackageJson: false,
      hasPyproject: false,
      hasVetoConfig: false,
      score: 0,
    });
  }

  return candidates.sort((a, b) => {
    if (a.path === resolvedCwd) return -1;
    if (b.path === resolvedCwd) return 1;
    if (a.score !== b.score) return b.score - a.score;
    return a.name.localeCompare(b.name);
  });
}

function getStudioConfigPath(workspaceDir: string): string {
  return join(workspaceDir, 'veto', 'veto.config.yaml');
}

function parseStudioConfig(configPath: string): StudioConfigFile {
  if (!existsSync(configPath)) {
    return {};
  }

  try {
    const parsed = parseYaml(readFileSync(configPath, 'utf-8')) as StudioConfigFile | null;
    return parsed ?? {};
  } catch {
    return {};
  }
}

export function loadStudioPreferences(workspaceDir: string): StudioPreferences {
  const configPath = getStudioConfigPath(workspaceDir);
  const config = parseStudioConfig(configPath);

  return {
    defaultDirectory: config.studio?.workspace?.defaultDirectory,
    includeExamples: config.studio?.workspace?.includeExamples ?? false,
    includeTests: config.studio?.workspace?.includeTests ?? false,
    allowTemplateFallback: config.studio?.generation?.allowTemplateFallback ?? false,
    preferredRenderer: config.studio?.renderer?.preferred ?? 'auto',
  };
}

export function persistStudioPreferences(
  workspaceDir: string,
  preferences: Partial<StudioPreferences>
): void {
  const configPath = getStudioConfigPath(workspaceDir);
  const vetoDir = join(workspaceDir, 'veto');

  let parsed = parseStudioConfig(configPath) as Record<string, unknown>;
  if (Object.keys(parsed).length === 0) {
    parsed = (parseYaml(DEFAULT_CONFIG) as Record<string, unknown> | null) ?? {};
  }

  const studio = (parsed.studio as Record<string, unknown> | undefined) ?? {};
  const workspace = (studio.workspace as Record<string, unknown> | undefined) ?? {};
  const generation = (studio.generation as Record<string, unknown> | undefined) ?? {};
  const renderer = (studio.renderer as Record<string, unknown> | undefined) ?? {};

  if (preferences.defaultDirectory !== undefined) {
    workspace.defaultDirectory = preferences.defaultDirectory;
  }
  if (preferences.includeExamples !== undefined) {
    workspace.includeExamples = preferences.includeExamples;
  }
  if (preferences.includeTests !== undefined) {
    workspace.includeTests = preferences.includeTests;
  }
  if (preferences.allowTemplateFallback !== undefined) {
    generation.allowTemplateFallback = preferences.allowTemplateFallback;
  }
  if (preferences.preferredRenderer !== undefined) {
    renderer.preferred = preferences.preferredRenderer;
  }

  studio.workspace = workspace;
  studio.generation = generation;
  studio.renderer = renderer;
  parsed.studio = studio;

  mkdirSync(vetoDir, { recursive: true });
  writeFileSync(configPath, stringify(parsed, { lineWidth: 120 }), 'utf-8');
}

export function resolvePreferredWorkspaceIndex(
  candidates: readonly StudioWorkspaceCandidate[],
  cwd: string,
  preferredDirectory?: string
): number {
  if (!preferredDirectory || preferredDirectory.trim().length === 0) {
    return 0;
  }

  const preferred = preferredDirectory.trim();
  const absolutePreferred = preferred.startsWith('/')
    ? resolve(preferred)
    : resolve(cwd, preferred);

  const exactIndex = candidates.findIndex((candidate) => resolve(candidate.path) === absolutePreferred);
  if (exactIndex >= 0) {
    return exactIndex;
  }

  const relativePreferred = `./${relative(resolve(cwd), absolutePreferred)}`;
  const relativeIndex = candidates.findIndex((candidate) => candidate.displayPath === relativePreferred);
  if (relativeIndex >= 0) {
    return relativeIndex;
  }

  return 0;
}

export function createInitialStudioState(options: CreateInitialStudioStateOptions): StudioState {
  const cwd = resolve(options.cwd ?? process.cwd());
  const candidates = discoverWorkspaceCandidates(cwd);

  const initialIncludeExamples = options.includeExamples ?? false;
  const initialIncludeTests = options.includeTests ?? false;
  const initialAllowTemplateFallback = options.demoTemplate ?? false;

  return {
    brandName: 'Veto Studio',
    version: options.version,
    cwd,
    view: 'workspace',
    paletteOpen: false,
    paletteQuery: '',
    selectedWorkspaceIndex: 0,
    selectedHomeIndex: 0,
    selectedPaletteIndex: 0,
    workspaceCandidates: candidates,
    includeExamples: initialIncludeExamples,
    includeTests: initialIncludeTests,
    allowTemplateFallback: initialAllowTemplateFallback,
    rendererPreference: options.rendererPreference,
    activeRenderer: 'ansi',
    demoTemplate: options.demoTemplate ?? false,
    messageLines: [],
    wizard: {
      stage: 'tool',
      selectedToolIndex: 0,
      selectedActionIndex: 0,
      thresholdInput: '',
      promptInput: '',
      generatedRuleIds: [],
      generatedWarnings: [],
    },
    simulation: {
      stage: 'tool',
      selectedToolIndex: 0,
      argsInput: '{}',
      resultLines: [],
    },
    setup: {
      selectedIndex: 0,
    },
    shouldExit: false,
    openLegacyRequested: false,
  };
}

export function getWorkspaceRules(context: ReplSessionContext | undefined): Rule[] {
  return context?.allRules ?? [];
}

export function getWorkspaceTools(context: ReplSessionContext | undefined): string[] {
  if (!context) {
    return [];
  }

  return context.discoveredTools.map((tool) => tool.name);
}
