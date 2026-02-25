export type StudioEventType =
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'enter'
  | 'tab'
  | 'escape'
  | 'quit'
  | 'palette'
  | 'backspace'
  | 'character'
  | 'unknown';

export interface StudioEvent {
  type: StudioEventType;
  value?: string;
  raw: string;
}

export function parseStudioInput(buffer: Buffer): StudioEvent {
  const raw = buffer.toString('utf-8');

  if (raw === '\u0003') {
    return { type: 'quit', raw };
  }

  if (raw === '\u001b[A') {
    return { type: 'up', raw };
  }

  if (raw === '\u001b[B') {
    return { type: 'down', raw };
  }

  if (raw === '\u001b[C') {
    return { type: 'right', raw };
  }

  if (raw === '\u001b[D') {
    return { type: 'left', raw };
  }

  if (raw === '\r' || raw === '\n') {
    return { type: 'enter', raw };
  }

  if (raw === '\t') {
    return { type: 'tab', raw };
  }

  if (raw === '\u001b') {
    return { type: 'escape', raw };
  }

  if (raw === '\u007f') {
    return { type: 'backspace', raw };
  }

  if (raw === '/') {
    return { type: 'palette', raw };
  }

  if (/^[\x20-\x7E]$/.test(raw)) {
    return {
      type: 'character',
      value: raw,
      raw,
    };
  }

  return { type: 'unknown', raw };
}
