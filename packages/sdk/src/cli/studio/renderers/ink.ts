import { createElement } from 'react';
import { Box, Text, render, useInput, type Key } from 'ink';
import { type FC, useEffect, useState } from 'react';
import type { StudioEvent } from '../events.js';
import type { StudioRenderModel, StudioRenderer, StudioTheme } from '../state.js';

interface ThemePalette {
  title: string;
  subtitle: string;
  text: string;
  muted: string;
  accent: string;
  section: string;
  warning: string;
  footer: string;
}

interface AppBridge {
  setModel: (model: StudioRenderModel) => void;
}

interface StudioInkAppProps {
  initialModel: StudioRenderModel;
  onEvent: (event: StudioEvent) => void;
  onReady: (bridge: AppBridge) => void;
}

function getThemePalette(theme: StudioTheme): ThemePalette {
  if (theme === 'claude') {
    return {
      title: 'cyan',
      subtitle: 'gray',
      text: 'white',
      muted: 'gray',
      accent: 'yellow',
      section: 'cyan',
      warning: 'red',
      footer: 'gray',
    };
  }

  if (theme === 'high-contrast') {
    return {
      title: 'white',
      subtitle: 'yellow',
      text: 'white',
      muted: 'white',
      accent: 'green',
      section: 'magenta',
      warning: 'red',
      footer: 'yellow',
    };
  }

  return {
    title: 'yellow',
    subtitle: 'gray',
    text: 'white',
    muted: 'gray',
    accent: 'yellow',
    section: 'cyan',
    warning: 'red',
    footer: 'gray',
  };
}

function classifyLineColor(line: string, palette: ThemePalette): string {
  const trimmed = line.trim();

  if (!trimmed) {
    return palette.muted;
  }

  if (line.startsWith('Warning:') || line.startsWith('Renderer:')) {
    return palette.warning;
  }

  if (line.startsWith('> ')) {
    return palette.accent;
  }

  if (line.endsWith(':')) {
    return palette.section;
  }

  return palette.text;
}

function mapInkInputToStudioEvent(input: string, key: Key): StudioEvent {
  if (key.ctrl && input.toLowerCase() === 'c') {
    return { type: 'quit', raw: input };
  }

  if (key.upArrow) {
    return { type: 'up', raw: input };
  }

  if (key.downArrow) {
    return { type: 'down', raw: input };
  }

  if (key.leftArrow) {
    return { type: 'left', raw: input };
  }

  if (key.rightArrow) {
    return { type: 'right', raw: input };
  }

  if (key.return) {
    return { type: 'enter', raw: input };
  }

  if (key.tab) {
    return { type: 'tab', raw: input };
  }

  if (key.escape) {
    return { type: 'escape', raw: input };
  }

  if (key.backspace || key.delete) {
    return { type: 'backspace', raw: input };
  }

  if (input === '/') {
    return { type: 'palette', raw: input };
  }

  if (/^[\x20-\x7E]$/.test(input)) {
    return {
      type: 'character',
      value: input,
      raw: input,
    };
  }

  return { type: 'unknown', raw: input };
}

const StudioInkApp: FC<StudioInkAppProps> = ({ initialModel, onEvent, onReady }) => {
  const [model, setModel] = useState<StudioRenderModel>(initialModel);

  useEffect(() => {
    onReady({ setModel });
  }, [onReady]);

  useInput((input, key) => {
    onEvent(mapInkInputToStudioEvent(input, key));
  });

  const palette = getThemePalette(model.theme);

  return createElement(
    Box,
    {
      flexDirection: 'column',
      paddingX: 1,
      paddingY: 0,
    },
    createElement(Text, { color: palette.title, bold: true }, model.title),
    model.subtitle
      ? createElement(Text, { color: palette.subtitle }, model.subtitle)
      : null,
    createElement(Text, { color: palette.muted }, ''),
    ...model.lines.map((line, index) =>
      createElement(Text, { key: `${index}-${line}`, color: classifyLineColor(line, palette) }, line)
    ),
    model.footer
      ? createElement(
          Box,
          {
            marginTop: 1,
          },
          createElement(Text, { color: palette.footer }, model.footer)
        )
      : null
  );
};

export class InkStudioRenderer implements StudioRenderer {
  readonly mode = 'ink' as const;

  private initialized = false;
  private updater: ((model: StudioRenderModel) => void) | null = null;
  private inkApp: ReturnType<typeof render> | null = null;
  private readonly queue: StudioEvent[] = [];
  private readonly waiters: Array<(event: StudioEvent) => void> = [];
  private readyPromise: Promise<void> = Promise.resolve();
  private resolveReady: (() => void) | null = null;

  private pushEvent(event: StudioEvent): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(event);
      return;
    }

    this.queue.push(event);
  }

  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }

    if (!process.stdout.isTTY || !process.stdin.isTTY) {
      throw new Error('Ink renderer requires an interactive TTY terminal.');
    }

    this.readyPromise = new Promise<void>((resolveReady) => {
      this.resolveReady = resolveReady;
    });

    this.inkApp = render(
      createElement(StudioInkApp, {
        initialModel: {
          title: 'Veto Studio',
          subtitle: 'Booting…',
          theme: 'veto',
          lines: ['Loading renderer...'],
          footer: 'Keys: ↑/↓ navigate | Enter select | Tab next | Esc back | / palette | q quit',
        },
        onEvent: (event) => {
          this.pushEvent(event);
        },
        onReady: ({ setModel }) => {
          this.updater = setModel;
          this.resolveReady?.();
          this.resolveReady = null;
        },
      }),
      {
        exitOnCtrlC: false,
      }
    );

    await this.readyPromise;
    this.initialized = true;
  }

  async render(model: StudioRenderModel): Promise<void> {
    if (!this.initialized) {
      await this.init();
    }

    await this.readyPromise;
    this.updater?.(model);
  }

  async readEvent(): Promise<StudioEvent> {
    if (this.queue.length > 0) {
      const event = this.queue.shift();
      if (event) {
        return event;
      }
    }

    return await new Promise<StudioEvent>((resolveEvent) => {
      this.waiters.push(resolveEvent);
    });
  }

  async dispose(): Promise<void> {
    if (!this.initialized) {
      return;
    }

    this.inkApp?.unmount();
    this.inkApp = null;
    this.updater = null;
    this.initialized = false;

    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.({ type: 'quit', raw: 'dispose' });
    }

    this.queue.length = 0;
  }
}

export function createInkRenderer(): StudioRenderer {
  return new InkStudioRenderer();
}
