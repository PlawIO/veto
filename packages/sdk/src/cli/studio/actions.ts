import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { executeReplInput, startRepl } from '../repl.js';
import {
  createReplSessionContext,
  exportRulesYaml,
  reloadReplContext,
  rescanReplContext,
  type ReplSessionContext,
} from '../repl-context.js';
import {
  checkGenerationConnectivity,
  generatePolicyFromPrompt,
  validateGeneratedYaml,
} from '../repl-generate.js';
import type { Rule } from '../../rules/types.js';
import type { StudioEvent } from './events.js';
import {
  STUDIO_HOME_ACTIONS,
  STUDIO_POLICY_ACTIONS,
  STUDIO_SETUP_ACTIONS,
  loadStudioPreferences,
  persistStudioPreferences,
  type StudioRenderModel,
  type StudioState,
} from './state.js';

function clamp(value: number, min: number, max: number): number {
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

function isTextEntryActive(state: StudioState): boolean {
  if (state.paletteOpen) {
    return true;
  }

  if (state.view === 'wizard' && (state.wizard.stage === 'threshold' || state.wizard.stage === 'prompt')) {
    return true;
  }

  if (state.view === 'simulate' && state.simulation.stage === 'args') {
    return true;
  }

  return false;
}

function toRelative(baseDir: string, pathToFormat: string): string {
  const rel = relative(baseDir, pathToFormat);
  if (!rel || rel === '.') {
    return '.';
  }
  return rel.startsWith('..') ? pathToFormat : `./${rel}`;
}

function getPaletteActions(state: StudioState): string[] {
  const query = state.paletteQuery.trim().toLowerCase();
  if (!query) {
    return [...STUDIO_HOME_ACTIONS];
  }

  return STUDIO_HOME_ACTIONS.filter((action) => action.toLowerCase().includes(query));
}

function getWorkspaceContext(state: StudioState): ReplSessionContext {
  if (!state.context) {
    throw new Error('Workspace not loaded yet.');
  }
  return state.context;
}

function getSelectedToolName(state: StudioState): string | null {
  const tools = state.context?.discoveredTools ?? [];
  if (tools.length === 0) {
    return null;
  }
  const clampedIndex = clamp(state.wizard.selectedToolIndex, 0, tools.length - 1);
  return tools[clampedIndex]?.name ?? null;
}

function buildWizardPrompt(state: StudioState): string {
  const toolName = getSelectedToolName(state) ?? 'tool_call';
  const action = STUDIO_POLICY_ACTIONS[state.wizard.selectedActionIndex] ?? 'block';
  const thresholdText = state.wizard.thresholdInput.trim();
  const threshold = Number.parseFloat(thresholdText);
  const hasThreshold = Number.isFinite(threshold);

  const customPrompt = state.wizard.promptInput.trim();
  if (customPrompt) {
    return customPrompt;
  }

  if (hasThreshold) {
    if (action === 'require_approval') {
      return `require approval for ${toolName} above ${threshold}`;
    }
    return `${action} ${toolName} above ${threshold}`;
  }

  if (action === 'require_approval') {
    return `require approval for ${toolName}`;
  }

  return `${action} ${toolName}`;
}

function getRuleIdsFromYaml(yaml: string): string[] {
  try {
    const parsed = validateGeneratedYaml(yaml);
    const rawRules = parsed.rules;
    if (!Array.isArray(rawRules)) {
      return [];
    }

    return rawRules
      .map((rule) => {
        if (!rule || typeof rule !== 'object') {
          return null;
        }
        const id = (rule as Rule).id;
        return typeof id === 'string' ? id : null;
      })
      .filter((id): id is string => Boolean(id));
  } catch {
    return [];
  }
}

function buildSimulationCommand(toolName: string, args: Record<string, unknown>): string {
  return `/test ${toolName}(${JSON.stringify(args)})`;
}

async function selectWorkspace(state: StudioState): Promise<void> {
  const selected = state.workspaceCandidates[state.selectedWorkspaceIndex];
  if (!selected) {
    state.warningLine = 'No workspace candidate selected.';
    return;
  }

  const preferences = loadStudioPreferences(selected.path);
  state.includeExamples = state.includeExamples || preferences.includeExamples;
  state.includeTests = state.includeTests || preferences.includeTests;
  state.allowTemplateFallback = state.allowTemplateFallback || preferences.allowTemplateFallback;
  if (state.rendererPreference === 'auto' && preferences.preferredRenderer !== 'auto') {
    state.rendererPreference = preferences.preferredRenderer;
  }

  state.workspaceDir = selected.path;
  state.workspaceDisplayPath = selected.displayPath;
  state.view = 'discover';
  state.messageLines = [
    `Scanning workspace: ${selected.displayPath}`,
    `Scope: includeExamples=${state.includeExamples}, includeTests=${state.includeTests}`,
  ];

  try {
    const context = await createReplSessionContext(selected.path, {
      includeExamples: state.includeExamples,
      includeTests: state.includeTests,
    });
    state.context = context;
    state.view = 'home';
    state.warningLine = undefined;
    persistStudioPreferences(selected.path, {
      defaultDirectory: selected.path,
      includeExamples: state.includeExamples,
      includeTests: state.includeTests,
      allowTemplateFallback: state.allowTemplateFallback,
      preferredRenderer: state.rendererPreference,
    });
  } catch (error) {
    state.warningLine = `Failed to load workspace: ${error instanceof Error ? error.message : String(error)}`;
    state.view = 'workspace';
  }
}

async function runSimulation(state: StudioState): Promise<void> {
  const context = getWorkspaceContext(state);
  const tools = context.discoveredTools;
  if (tools.length === 0) {
    state.simulation.resultLines = ['No tools discovered. Run Rescan or switch workspace.'];
    return;
  }

  const tool = tools[clamp(state.simulation.selectedToolIndex, 0, tools.length - 1)];
  let args: Record<string, unknown>;

  try {
    const parsed = JSON.parse(state.simulation.argsInput || '{}') as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Arguments must be a JSON object.');
    }
    args = parsed as Record<string, unknown>;
  } catch (error) {
    state.simulation.resultLines = [
      `Invalid JSON arguments: ${error instanceof Error ? error.message : String(error)}`,
    ];
    return;
  }

  const result = await executeReplInput(buildSimulationCommand(tool.name, args), context);
  state.simulation.resultLines = result.lines;
}

async function startWizardGeneration(state: StudioState): Promise<void> {
  const context = getWorkspaceContext(state);
  const workspaceDir = state.workspaceDir ?? context.projectDir;
  const shouldAllowTemplateFallback = state.allowTemplateFallback || state.demoTemplate;

  if (!shouldAllowTemplateFallback) {
    const connectivity = await checkGenerationConnectivity({ projectDir: workspaceDir });
    if (!connectivity.connected) {
      state.setup.message = connectivity.reason
        ? `Generation is blocked: ${connectivity.reason}`
        : 'Generation is blocked: no endpoint connectivity.';
      state.view = 'setup';
      return;
    }
  }

  const prompt = buildWizardPrompt(state);
  const generated = await generatePolicyFromPrompt({
    prompt,
    projectDir: workspaceDir,
    rulesDirectory: context.rulesDir,
    tools: context.discoveredTools,
    existingRules: context.allRules,
    allowTemplateFallback: shouldAllowTemplateFallback,
  });

  const generatedPath = join(context.rulesDir, 'studio.generated.yaml');
  state.wizard.generatedYaml = generated.yaml;
  state.wizard.generatedSavePath = generatedPath;
  state.wizard.generatedWarnings = generated.warnings;
  state.wizard.generatedRuleIds = getRuleIdsFromYaml(generated.yaml);
  state.view = 'review';
}

async function saveGeneratedPolicy(state: StudioState): Promise<void> {
  const context = getWorkspaceContext(state);
  if (!state.wizard.generatedYaml) {
    state.warningLine = 'No generated YAML to save.';
    return;
  }

  const savePath = resolve(state.wizard.generatedSavePath ?? join(context.rulesDir, 'studio.generated.yaml'));
  const beforeCovered = context.scanReport.summary.covered;
  const beforeTotal = context.scanReport.summary.total;

  mkdirSync(dirname(savePath), { recursive: true });
  writeFileSync(savePath, state.wizard.generatedYaml, 'utf-8');
  await reloadReplContext(context);

  const afterCovered = context.scanReport.summary.covered;
  const afterTotal = context.scanReport.summary.total;

  state.messageLines = [
    `Saved generated policy to ${toRelative(context.projectDir, savePath)}`,
    `Coverage impact: ${beforeCovered}/${beforeTotal} -> ${afterCovered}/${afterTotal}`,
    `Rules generated: ${state.wizard.generatedRuleIds.length}`,
  ];
  state.view = 'home';
}

async function explainFirstRule(state: StudioState): Promise<void> {
  const context = getWorkspaceContext(state);
  if (context.allRules.length === 0) {
    state.messageLines = ['No rules loaded. Create a policy first.'];
    return;
  }

  const firstRule = context.allRules[0];
  const result = await executeReplInput(`/explain ${firstRule.id}`, context);
  state.messageLines = result.lines;
}

async function exportRules(state: StudioState): Promise<void> {
  const context = getWorkspaceContext(state);
  const outputPath = join(context.rulesDir, 'studio.export.yaml');
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, exportRulesYaml(context, 'studio-export'), 'utf-8');
  state.messageLines = [`Exported merged rules to ${toRelative(context.projectDir, outputPath)}`];
}

async function executeHomeActionByName(state: StudioState, actionName: string): Promise<void> {
  switch (actionName) {
    case 'Create Policy': {
      state.view = 'wizard';
      state.wizard.stage = 'tool';
      state.wizard.generatedWarnings = [];
      return;
    }
    case 'Simulate Tool Call': {
      state.view = 'simulate';
      state.simulation.stage = 'tool';
      state.simulation.resultLines = [];
      return;
    }
    case 'Explain Rule': {
      await explainFirstRule(state);
      return;
    }
    case 'Rescan': {
      const context = getWorkspaceContext(state);
      const report = await rescanReplContext(context);
      state.messageLines = [
        `Rescan complete: ${report.summary.covered}/${report.summary.total} covered.`,
      ];
      return;
    }
    case 'Switch Workspace': {
      state.view = 'workspace';
      return;
    }
    case 'Export Rules': {
      await exportRules(state);
      return;
    }
    case 'Open Legacy REPL': {
      state.openLegacyRequested = true;
      state.shouldExit = true;
      return;
    }
    default: {
      state.warningLine = `Unknown action: ${actionName}`;
    }
  }
}

async function executeSelectedHomeAction(state: StudioState): Promise<void> {
  const actionName = STUDIO_HOME_ACTIONS[state.selectedHomeIndex];
  if (!actionName) {
    return;
  }
  await executeHomeActionByName(state, actionName);
}

function handlePaletteCharacter(state: StudioState, event: StudioEvent): void {
  if (event.type === 'character' && event.value) {
    state.paletteQuery += event.value;
    state.selectedPaletteIndex = 0;
    return;
  }

  if (event.type === 'backspace' && state.paletteQuery.length > 0) {
    state.paletteQuery = state.paletteQuery.slice(0, -1);
    state.selectedPaletteIndex = 0;
  }
}

async function handlePaletteEvent(state: StudioState, event: StudioEvent): Promise<boolean> {
  const actions = getPaletteActions(state);

  if (event.type === 'escape') {
    state.paletteOpen = false;
    state.paletteQuery = '';
    state.selectedPaletteIndex = 0;
    return true;
  }

  if (event.type === 'up') {
    state.selectedPaletteIndex = clamp(state.selectedPaletteIndex - 1, 0, Math.max(actions.length - 1, 0));
    return true;
  }

  if (event.type === 'down') {
    state.selectedPaletteIndex = clamp(state.selectedPaletteIndex + 1, 0, Math.max(actions.length - 1, 0));
    return true;
  }

  if (event.type === 'enter') {
    const action = actions[state.selectedPaletteIndex];
    if (action) {
      state.paletteOpen = false;
      state.paletteQuery = '';
      state.selectedPaletteIndex = 0;
      await executeHomeActionByName(state, action);
    }
    return true;
  }

  handlePaletteCharacter(state, event);
  return true;
}

function goBack(state: StudioState): void {
  switch (state.view) {
    case 'workspace':
      state.shouldExit = true;
      break;
    case 'discover':
      state.view = 'workspace';
      break;
    case 'home':
      state.view = 'workspace';
      break;
    case 'wizard':
      if (state.wizard.stage === 'prompt') {
        state.wizard.stage = 'threshold';
      } else if (state.wizard.stage === 'threshold') {
        state.wizard.stage = 'action';
      } else if (state.wizard.stage === 'action') {
        state.wizard.stage = 'tool';
      } else {
        state.view = 'home';
      }
      break;
    case 'simulate':
      if (state.simulation.stage === 'args') {
        state.simulation.stage = 'tool';
      } else {
        state.view = 'home';
      }
      break;
    case 'review':
      state.view = 'wizard';
      state.wizard.stage = 'prompt';
      break;
    case 'setup':
      state.view = 'home';
      break;
    default:
      state.view = 'home';
      break;
  }
}

function appendWizardInput(state: StudioState, value: string): void {
  if (state.wizard.stage === 'threshold') {
    state.wizard.thresholdInput += value;
  } else if (state.wizard.stage === 'prompt') {
    state.wizard.promptInput += value;
  }
}

function backspaceWizardInput(state: StudioState): void {
  if (state.wizard.stage === 'threshold' && state.wizard.thresholdInput.length > 0) {
    state.wizard.thresholdInput = state.wizard.thresholdInput.slice(0, -1);
  } else if (state.wizard.stage === 'prompt' && state.wizard.promptInput.length > 0) {
    state.wizard.promptInput = state.wizard.promptInput.slice(0, -1);
  }
}

function appendSimulationInput(state: StudioState, value: string): void {
  if (state.simulation.stage === 'args') {
    state.simulation.argsInput += value;
  }
}

function backspaceSimulationInput(state: StudioState): void {
  if (state.simulation.stage === 'args' && state.simulation.argsInput.length > 0) {
    state.simulation.argsInput = state.simulation.argsInput.slice(0, -1);
  }
}

async function handleWorkspaceEvent(state: StudioState, event: StudioEvent): Promise<void> {
  if (event.type === 'up') {
    state.selectedWorkspaceIndex = clamp(state.selectedWorkspaceIndex - 1, 0, state.workspaceCandidates.length - 1);
    return;
  }

  if (event.type === 'down') {
    state.selectedWorkspaceIndex = clamp(state.selectedWorkspaceIndex + 1, 0, state.workspaceCandidates.length - 1);
    return;
  }

  if (event.type === 'enter') {
    await selectWorkspace(state);
  }
}

async function handleHomeEvent(state: StudioState, event: StudioEvent): Promise<void> {
  if (event.type === 'up') {
    state.selectedHomeIndex = clamp(state.selectedHomeIndex - 1, 0, STUDIO_HOME_ACTIONS.length - 1);
    return;
  }

  if (event.type === 'down') {
    state.selectedHomeIndex = clamp(state.selectedHomeIndex + 1, 0, STUDIO_HOME_ACTIONS.length - 1);
    return;
  }

  if (event.type === 'tab') {
    state.selectedHomeIndex = (state.selectedHomeIndex + 1) % STUDIO_HOME_ACTIONS.length;
    return;
  }

  if (event.type === 'enter') {
    await executeSelectedHomeAction(state);
  }
}

async function handleWizardEvent(state: StudioState, event: StudioEvent): Promise<void> {
  const tools = state.context?.discoveredTools ?? [];

  if (state.wizard.stage === 'tool') {
    if (event.type === 'up') {
      state.wizard.selectedToolIndex = clamp(state.wizard.selectedToolIndex - 1, 0, Math.max(tools.length - 1, 0));
      return;
    }
    if (event.type === 'down') {
      state.wizard.selectedToolIndex = clamp(state.wizard.selectedToolIndex + 1, 0, Math.max(tools.length - 1, 0));
      return;
    }
    if (event.type === 'enter' || event.type === 'tab') {
      state.wizard.stage = 'action';
      return;
    }
    return;
  }

  if (state.wizard.stage === 'action') {
    if (event.type === 'up') {
      state.wizard.selectedActionIndex = clamp(state.wizard.selectedActionIndex - 1, 0, STUDIO_POLICY_ACTIONS.length - 1);
      return;
    }
    if (event.type === 'down') {
      state.wizard.selectedActionIndex = clamp(state.wizard.selectedActionIndex + 1, 0, STUDIO_POLICY_ACTIONS.length - 1);
      return;
    }
    if (event.type === 'enter' || event.type === 'tab') {
      state.wizard.stage = 'threshold';
      return;
    }
    return;
  }

  if (state.wizard.stage === 'threshold') {
    if (event.type === 'character' && event.value && /^[0-9.kKmM ]$/.test(event.value)) {
      appendWizardInput(state, event.value);
      return;
    }
    if (event.type === 'backspace') {
      backspaceWizardInput(state);
      return;
    }
    if (event.type === 'enter' || event.type === 'tab') {
      state.wizard.stage = 'prompt';
      return;
    }
    return;
  }

  if (state.wizard.stage === 'prompt') {
    if (event.type === 'character' && event.value) {
      appendWizardInput(state, event.value);
      return;
    }
    if (event.type === 'backspace') {
      backspaceWizardInput(state);
      return;
    }
    if (event.type === 'tab') {
      state.wizard.stage = 'tool';
      return;
    }
    if (event.type === 'enter') {
      try {
        await startWizardGeneration(state);
      } catch (error) {
        state.setup.message = `Generation failed: ${error instanceof Error ? error.message : String(error)}`;
        state.view = 'setup';
      }
    }
  }
}

async function handleSimulationEvent(state: StudioState, event: StudioEvent): Promise<void> {
  const tools = state.context?.discoveredTools ?? [];

  if (state.simulation.stage === 'tool') {
    if (event.type === 'up') {
      state.simulation.selectedToolIndex = clamp(state.simulation.selectedToolIndex - 1, 0, Math.max(tools.length - 1, 0));
      return;
    }
    if (event.type === 'down') {
      state.simulation.selectedToolIndex = clamp(state.simulation.selectedToolIndex + 1, 0, Math.max(tools.length - 1, 0));
      return;
    }
    if (event.type === 'enter' || event.type === 'tab') {
      state.simulation.stage = 'args';
      return;
    }
    return;
  }

  if (state.simulation.stage === 'args') {
    if (event.type === 'character' && event.value) {
      appendSimulationInput(state, event.value);
      return;
    }
    if (event.type === 'backspace') {
      backspaceSimulationInput(state);
      return;
    }
    if (event.type === 'tab') {
      state.simulation.stage = 'tool';
      return;
    }
    if (event.type === 'enter') {
      await runSimulation(state);
    }
  }
}

async function handleReviewEvent(state: StudioState, event: StudioEvent): Promise<void> {
  if (event.type === 'enter') {
    await saveGeneratedPolicy(state);
  }
}

async function handleSetupEvent(state: StudioState, event: StudioEvent): Promise<void> {
  if (event.type === 'up') {
    state.setup.selectedIndex = clamp(state.setup.selectedIndex - 1, 0, STUDIO_SETUP_ACTIONS.length - 1);
    return;
  }
  if (event.type === 'down') {
    state.setup.selectedIndex = clamp(state.setup.selectedIndex + 1, 0, STUDIO_SETUP_ACTIONS.length - 1);
    return;
  }
  if (event.type !== 'enter') {
    return;
  }

  const selectedAction = STUDIO_SETUP_ACTIONS[state.setup.selectedIndex];
  if (selectedAction === 'Back') {
    state.view = 'home';
    return;
  }

  if (selectedAction === 'Configure Cloud') {
    state.setup.message = 'Set VETO_API_KEY and rerun generation.';
  } else if (selectedAction === 'Configure Kernel') {
    state.setup.message = 'Set validation.mode: kernel in veto.config.yaml with kernel.baseUrl and kernel.model.';
  } else if (selectedAction === 'Configure Self-Hosted') {
    state.setup.message = 'Set llm.baseUrl and llm.model in veto.config.yaml (optional llm.apiKey).';
  }
}

export async function handleStudioEvent(state: StudioState, event: StudioEvent): Promise<void> {
  if (event.type === 'quit') {
    state.shouldExit = true;
    return;
  }

  if (event.type === 'character' && event.value?.toLowerCase() === 'q' && !isTextEntryActive(state)) {
    state.shouldExit = true;
    return;
  }

  if (state.paletteOpen) {
    await handlePaletteEvent(state, event);
    return;
  }

  if (event.type === 'palette') {
    state.paletteOpen = true;
    state.paletteQuery = '';
    state.selectedPaletteIndex = 0;
    return;
  }

  if (event.type === 'escape') {
    goBack(state);
    return;
  }

  switch (state.view) {
    case 'workspace':
      await handleWorkspaceEvent(state, event);
      break;
    case 'discover':
      state.view = 'home';
      break;
    case 'home':
      await handleHomeEvent(state, event);
      break;
    case 'wizard':
      await handleWizardEvent(state, event);
      break;
    case 'simulate':
      await handleSimulationEvent(state, event);
      break;
    case 'review':
      await handleReviewEvent(state, event);
      break;
    case 'setup':
      await handleSetupEvent(state, event);
      break;
    default:
      break;
  }
}

function buildWorkspaceLines(state: StudioState): string[] {
  const lines: string[] = [
    'Select a workspace to index:',
    '',
  ];

  for (let i = 0; i < state.workspaceCandidates.length; i++) {
    const candidate = state.workspaceCandidates[i];
    const selected = i === state.selectedWorkspaceIndex ? '>' : ' ';
    const markers = [
      candidate.hasVetoConfig ? 'veto' : '',
      candidate.hasPackageJson ? 'node' : '',
      candidate.hasPyproject ? 'python' : '',
    ].filter(Boolean).join(', ');

    lines.push(`${selected} ${candidate.name} (${candidate.displayPath})${markers ? ` [${markers}]` : ''}`);
  }

  return lines;
}

function buildHomeLines(state: StudioState): string[] {
  const context = state.context;
  const lines: string[] = [];

  if (!context) {
    lines.push('Workspace is not loaded.');
    return lines;
  }

  lines.push(`Workspace: ${state.workspaceDisplayPath ?? toRelative(state.cwd, context.projectDir)}`);
  lines.push(`Coverage: ${context.scanReport.summary.covered}/${context.scanReport.summary.total} (${context.scanReport.summary.coveragePercent.toFixed(1)}%)`);
  lines.push(`Scope: includeExamples=${state.includeExamples}, includeTests=${state.includeTests}`);
  lines.push(`Template fallback: ${state.allowTemplateFallback || state.demoTemplate ? 'enabled' : 'disabled'}`);
  lines.push('');
  lines.push('Quick actions:');

  for (let i = 0; i < STUDIO_HOME_ACTIONS.length; i++) {
    const selected = i === state.selectedHomeIndex ? '>' : ' ';
    lines.push(`${selected} ${STUDIO_HOME_ACTIONS[i]}`);
  }

  if (state.messageLines.length > 0) {
    lines.push('');
    lines.push('Messages:');
    lines.push(...state.messageLines);
  }

  return lines;
}

function buildWizardLines(state: StudioState): string[] {
  const context = state.context;
  const tools = context?.discoveredTools ?? [];
  const lines: string[] = [
    'First-policy wizard (<2 minutes target)',
    '',
    `Stage: ${state.wizard.stage}`,
    '',
  ];

  if (state.wizard.stage === 'tool') {
    if (tools.length === 0) {
      lines.push('No discovered tools. Run Rescan first.');
      return lines;
    }

    lines.push('1) Pick tool(s):');
    for (let i = 0; i < tools.length; i++) {
      const selected = i === state.wizard.selectedToolIndex ? '>' : ' ';
      lines.push(`${selected} ${tools[i].name}`);
    }
    return lines;
  }

  if (state.wizard.stage === 'action') {
    lines.push('2) Pick action:');
    for (let i = 0; i < STUDIO_POLICY_ACTIONS.length; i++) {
      const selected = i === state.wizard.selectedActionIndex ? '>' : ' ';
      lines.push(`${selected} ${STUDIO_POLICY_ACTIONS[i]}`);
    }
    return lines;
  }

  if (state.wizard.stage === 'threshold') {
    lines.push('3) Enter threshold/condition (numeric, optional):');
    lines.push(`> ${state.wizard.thresholdInput || '(empty)'}`);
    return lines;
  }

  lines.push('4) Refine natural-language rule prompt:');
  lines.push(`> ${state.wizard.promptInput || '(auto-generated from selections)'}`);
  lines.push('');
  lines.push(`Preview: ${buildWizardPrompt(state)}`);
  return lines;
}

function buildSimulationLines(state: StudioState): string[] {
  const context = state.context;
  const tools = context?.discoveredTools ?? [];
  const lines: string[] = [
    'Simulation (what-if)',
    '',
    `Stage: ${state.simulation.stage}`,
    '',
  ];

  if (state.simulation.stage === 'tool') {
    lines.push('Select tool:');
    if (tools.length === 0) {
      lines.push('No tools discovered.');
      return lines;
    }
    for (let i = 0; i < tools.length; i++) {
      const selected = i === state.simulation.selectedToolIndex ? '>' : ' ';
      lines.push(`${selected} ${tools[i].name}`);
    }
    return lines;
  }

  const selectedTool = tools[clamp(state.simulation.selectedToolIndex, 0, Math.max(tools.length - 1, 0))];
  lines.push(`Tool: ${selectedTool?.name ?? '(none)'}`);
  lines.push('Args (JSON object):');
  lines.push(`> ${state.simulation.argsInput}`);
  if (state.simulation.resultLines.length > 0) {
    lines.push('');
    lines.push('Result:');
    lines.push(...state.simulation.resultLines);
  }
  return lines;
}

function buildReviewLines(state: StudioState): string[] {
  const lines: string[] = [
    'Review & Save',
    '',
  ];

  if (!state.wizard.generatedYaml) {
    lines.push('No generated YAML available.');
    return lines;
  }

  lines.push(`Save target: ${state.wizard.generatedSavePath ?? '(default rules path)'}`);
  lines.push(`Generated rules: ${state.wizard.generatedRuleIds.join(', ') || '(none detected)'}`);

  if (state.wizard.generatedWarnings.length > 0) {
    lines.push('');
    lines.push('Warnings:');
    lines.push(...state.wizard.generatedWarnings.map((warning) => `- ${warning}`));
  }

  lines.push('');
  lines.push('YAML preview:');
  for (const line of state.wizard.generatedYaml.split('\n').slice(0, 24)) {
    lines.push(line);
  }
  if (state.wizard.generatedYaml.split('\n').length > 24) {
    lines.push('...');
  }
  lines.push('');
  lines.push('Press Enter to save and rescan coverage.');

  return lines;
}

function buildSetupLines(state: StudioState): string[] {
  const lines: string[] = [
    'Generation Setup',
    '',
    state.setup.message ?? 'No endpoint configured and demo-template is disabled.',
    '',
    'Choose setup path:',
  ];

  for (let i = 0; i < STUDIO_SETUP_ACTIONS.length; i++) {
    const selected = i === state.setup.selectedIndex ? '>' : ' ';
    lines.push(`${selected} ${STUDIO_SETUP_ACTIONS[i]}`);
  }

  return lines;
}

function buildDiscoverLines(state: StudioState): string[] {
  if (state.messageLines.length > 0) {
    return [...state.messageLines];
  }
  return ['Discovering tools...'];
}

function buildPaletteLines(state: StudioState): string[] {
  const actions = getPaletteActions(state);
  const lines: string[] = [
    `/${state.paletteQuery}`,
    '',
  ];

  if (actions.length === 0) {
    lines.push('No actions match query.');
    return lines;
  }

  for (let i = 0; i < actions.length; i++) {
    const selected = i === state.selectedPaletteIndex ? '>' : ' ';
    lines.push(`${selected} ${actions[i]}`);
  }
  return lines;
}

export function buildStudioRenderModel(state: StudioState): StudioRenderModel {
  let lines: string[];
  let subtitle = `${state.brandName} v${state.version} | renderer=${state.activeRenderer}`;

  if (state.paletteOpen) {
    lines = buildPaletteLines(state);
    subtitle += ' | command palette';
  } else if (state.view === 'workspace') {
    lines = buildWorkspaceLines(state);
  } else if (state.view === 'discover') {
    lines = buildDiscoverLines(state);
  } else if (state.view === 'home') {
    lines = buildHomeLines(state);
  } else if (state.view === 'wizard') {
    lines = buildWizardLines(state);
  } else if (state.view === 'simulate') {
    lines = buildSimulationLines(state);
  } else if (state.view === 'review') {
    lines = buildReviewLines(state);
  } else {
    lines = buildSetupLines(state);
  }

  if (state.warningLine) {
    lines.push('');
    lines.push(`Warning: ${state.warningLine}`);
  }

  if (state.rendererWarning) {
    lines.push('');
    lines.push(`Renderer: ${state.rendererWarning}`);
  }

  return {
    title: state.brandName,
    subtitle,
    lines,
    footer: 'Keys: ↑/↓ navigate | Enter select | Tab next | Esc back | / palette | q quit',
  };
}

export async function maybeOpenLegacyRepl(state: StudioState): Promise<void> {
  if (!state.openLegacyRequested) {
    return;
  }

  await startRepl({
    cwd: state.workspaceDir ?? state.cwd,
    version: state.version,
  });
}
