import { createAnsiRenderer } from './ansi.js';
import type { StudioEvent } from '../events.js';
import type { StudioRenderModel, StudioRenderer } from '../state.js';

const OPENTUI_CORE_MODULE = '@opentui/core';

async function dynamicImport(moduleName: string): Promise<unknown> {
  return await import(moduleName);
}

export class OpenTuiStudioRenderer implements StudioRenderer {
  readonly mode = 'opentui' as const;
  private readonly fallbackRenderer = createAnsiRenderer();
  private runtime: unknown;

  async init(): Promise<void> {
    this.runtime = await dynamicImport(OPENTUI_CORE_MODULE);
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
