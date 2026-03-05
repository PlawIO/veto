import { stdout, stdin } from 'node:process';
import { parseStudioInput, type StudioEvent } from '../events.js';
import type { StudioRenderModel, StudioRenderer } from '../state.js';

function moveCursorTopLeft(): string {
  return '\u001b[H';
}

function clearScreen(): string {
  return '\u001b[2J';
}

function hideCursor(): string {
  return '\u001b[?25l';
}

function showCursor(): string {
  return '\u001b[?25h';
}

function enterAltScreen(): string {
  return '\u001b[?1049h';
}

function leaveAltScreen(): string {
  return '\u001b[?1049l';
}

function frameModel(model: StudioRenderModel): string {
  const lines: string[] = [];
  lines.push(`${model.title}`);

  if (model.subtitle) {
    lines.push(`${model.subtitle}`);
  }

  lines.push('');
  lines.push(...model.lines);

  if (model.footer) {
    lines.push('');
    lines.push(model.footer);
  }

  return `${lines.join('\n')}\n`;
}

export class AnsiStudioRenderer implements StudioRenderer {
  readonly mode = 'ansi' as const;
  private initialized = false;
  private rawModeEnabled = false;
  private inAltScreen = false;

  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }

    if (stdout.isTTY) {
      stdout.write(enterAltScreen());
      this.inAltScreen = true;
      stdout.write(hideCursor());
    }

    if (stdin.isTTY) {
      stdin.setRawMode(true);
      this.rawModeEnabled = true;
    }

    stdin.resume();
    stdin.setEncoding('utf8');
    this.initialized = true;
  }

  async render(model: StudioRenderModel): Promise<void> {
    if (!this.initialized) {
      await this.init();
    }

    stdout.write(`${moveCursorTopLeft()}${clearScreen()}${frameModel(model)}`);
  }

  async readEvent(): Promise<StudioEvent> {
    return await new Promise<StudioEvent>((resolve) => {
      const onData = (chunk: string | Buffer): void => {
        stdin.off('data', onData);

        const buffer = Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(chunk, 'utf-8');

        resolve(parseStudioInput(buffer));
      };

      stdin.on('data', onData);
    });
  }

  async dispose(): Promise<void> {
    if (!this.initialized) {
      return;
    }

    if (this.rawModeEnabled && stdin.isTTY) {
      stdin.setRawMode(false);
      this.rawModeEnabled = false;
    }

    stdin.pause();

    if (stdout.isTTY) {
      stdout.write(showCursor());
      if (this.inAltScreen) {
        stdout.write(leaveAltScreen());
        this.inAltScreen = false;
      }
    }

    this.initialized = false;
  }
}

export function createAnsiRenderer(): StudioRenderer {
  return new AnsiStudioRenderer();
}
