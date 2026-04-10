import { Veto } from 'veto-sdk';
import {
  createVetoBeforeToolCallHook,
  createVetoAfterToolCallHook,
} from 'veto-sdk/integrations/openclaw';
import type { VetoApprovalMode } from 'veto-sdk/integrations/openclaw';

interface PluginApi {
  registerHook(name: string, handler: (...args: any[]) => unknown): void;
  getConfig?(): unknown;
  log?(level: string, message: string): void;
}

interface PluginEntry {
  id: string;
  name: string;
  description: string;
  register(api: PluginApi): void | Promise<void>;
}

interface VetoRuntimeInfo {
  validationMode?: string;
  cloudReady?: boolean;
}

interface VetoPluginRuntime {
  isCloudReady?: () => boolean;
  getRuntimeInfo?: () => VetoRuntimeInfo;
}

function assertApprovalModeReady(approvalMode: VetoApprovalMode, veto: Veto): void {
  if (approvalMode !== 'veto-cloud') {
    return;
  }

  const runtime = veto as unknown as VetoPluginRuntime;
  const cloudReady = runtime.isCloudReady?.() ?? runtime.getRuntimeInfo?.().cloudReady ?? false;

  if (!cloudReady) {
    throw new Error(
      '[veto] approvalMode "veto-cloud" requires Veto Cloud mode. '
      + 'Configure VETO_API_KEY or cloud.apiKey in veto/veto.config.yaml, '
      + 'or switch approvalMode to "openclaw-native".',
    );
  }
}

function getValidationMode(veto: Veto): string {
  const runtime = veto as unknown as VetoPluginRuntime;
  return runtime.getRuntimeInfo?.().validationMode ?? 'unknown';
}

async function loadDefinePluginEntry(): Promise<(entry: PluginEntry) => PluginEntry> {
  const modulePath: string = 'openclaw/plugin-sdk/plugin-entry';

  try {
    const mod = await import(modulePath) as {
      definePluginEntry?: (entry: PluginEntry) => PluginEntry;
    };

    if (typeof mod.definePluginEntry === 'function') {
      return mod.definePluginEntry;
    }
  } catch {
  }

  return (entry) => entry;
}

const definePluginEntry = await loadDefinePluginEntry();

export default definePluginEntry({
  id: 'veto',
  name: 'Veto Guardrails',
  description: 'Intercept, validate, and control every agent tool call with Veto policies',

  async register(api) {
    const veto = await Veto.init();
    const pluginConfig = api.getConfig?.() as { approvalMode?: VetoApprovalMode } | undefined;
    const approvalMode: VetoApprovalMode = pluginConfig?.approvalMode ?? 'openclaw-native';
    const validationMode = getValidationMode(veto);

    assertApprovalModeReady(approvalMode, veto);

    const beforeToolCall = createVetoBeforeToolCallHook(veto, {
      approvalMode,
      onDeny: (toolName, _args, reason) => {
        api.log?.('warn', `[veto] Blocked tool call: ${toolName} — ${reason}`);
      },
      onApprovalRequired: (toolName, _args, approvalId) => {
        api.log?.('info', `[veto] Approval required for: ${toolName} (${approvalId ?? 'local'})`);
      },
    });

    api.registerHook('before_tool_call', beforeToolCall);

    const afterToolCall = createVetoAfterToolCallHook(veto);
    api.registerHook('after_tool_call', afterToolCall);

    api.log?.(
      'info',
      `[veto] Plugin loaded (approval mode: ${approvalMode}, validation mode: ${validationMode})`,
    );
  },
});
