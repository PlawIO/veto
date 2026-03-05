import { createAnsiRenderer } from './ansi.js';
import type { StudioEvent } from '../events.js';
import type { StudioRenderModel, StudioRenderer } from '../state.js';

const OPENTUI_CORE_MODULE = '@opentui/core';
const NODE_RUNTIME_NAME = 'Node.js';

async function dynamicImport(moduleName: string): Promise<unknown> {
  return await import(moduleName);
}

function resolveRuntimeName(): string {
  if (process.versions?.bun) {
    return 'Bun';
  }
  return NODE_RUNTIME_NAME;
}

function normalizeOpenTuiImportError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);

  if (message.includes('Cannot find package')) {
    return new Error(
      `OpenTUI package "${OPENTUI_CORE_MODULE}" is not installed in this environment.`
    );
  }

  if (message.includes("protocol 'bun:'") || message.includes('bun:ffi')) {
    return new Error(
      `OpenTUI currently requires Bun runtime APIs (bun:ffi). Current runtime: ${resolveRuntimeName()}.`
    );
  }

  return new Error(message);
}

export class OpenTuiStudioRenderer implements StudioRenderer {
  readonly mode = 'opentui' as const;
  private readonly fallbackRenderer = createAnsiRenderer();
  private runtime: unknown;

  async init(): Promise<void> {
    if (!process.versions?.bun) {
      throw new Error(
        `OpenTUI currently requires Bun runtime APIs (bun:ffi). Current runtime: ${resolveRuntimeName()}.`
      );
    }

    try {
      this.runtime = await dynamicImport(OPENTUI_CORE_MODULE);
    } catch (error) {
      throw normalizeOpenTuiImportError(error);
    }

    if (!this.runtime || typeof this.runtime !== 'object') {
      throw new Error('OpenTUI runtime initialized with an invalid module object.');
    }

    await this.fallbackRenderer.init();
  }

  async render(model: StudioRenderModel): Promise<void> {
    await this.fallbackRenderer.render(model);
  }

  async readEvent(): Promise<StudioEvent> {
    return await this.fallbackRenderer.readEvent();
  }

  async dispose(): Promise<void> {
    await this.fallbackRenderer.dispose();
  }
}

export function createOpenTuiRenderer(): StudioRenderer {
  return new OpenTuiStudioRenderer();
}
