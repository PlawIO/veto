/**
 * Terminal color utilities using picocolors.
 * Cross-platform colored output for CLI.
 *
 * @module cli/colors
 */

import pc from 'picocolors';

export const colors = {
  // Primary colors
  cyan: pc.cyan,
  green: pc.green,
  yellow: pc.yellow,
  red: pc.red,
  magenta: pc.magenta,
  blue: pc.blue,
  white: pc.white,
  gray: pc.gray,

  // Styling
  bold: pc.bold,
  dim: pc.dim,
  italic: pc.italic,
  underline: pc.underline,
  strikethrough: pc.strikethrough,

  // Reset
  reset: pc.reset,

  // Status indicators
  ok: pc.green('[OK]'),
  denied: pc.red('[DENIED]'),
  warn: pc.yellow('[WARN]'),
  info: pc.cyan('[INFO]'),

  // Helper functions
  success: (msg: string) => pc.green(msg),
  error: (msg: string) => pc.red(msg),
  warning: (msg: string) => pc.yellow(msg),
  highlightInfo: (msg: string) => pc.cyan(msg),

  // Prompts
  prompt: (msg: string) => pc.bold(pc.cyan(msg)),
  choice: (msg: string) => pc.white(msg),

  // Code/paths
  path: (msg: string) => pc.dim(pc.white(msg)),
  code: (msg: string) => pc.gray(msg),

  // Highlight
  highlight: (msg: string) => pc.bold(pc.white(msg)),
  tool: (msg: string) => pc.magenta(msg),
  rule: (msg: string) => pc.blue(msg),

  // Coverage status
  covered: (msg: string) => pc.green(msg),
  uncovered: (msg: string) => pc.yellow(msg),
  coveredBadge: pc.green('[COVERED]'),
  uncoveredBadge: pc.yellow('[UNCOVERED]'),
};

export function colorize(status: 'ok' | 'denied' | 'warn' | 'info', text: string): string {
  switch (status) {
    case 'ok':
      return pc.green(text);
    case 'denied':
      return pc.red(text);
    case 'warn':
      return pc.yellow(text);
    case 'info':
      return pc.cyan(text);
  }
}

export const symbols = {
  check: pc.green('*'),
  cross: pc.red('x'),
  arrow: pc.cyan('>'),
  bullet: pc.green('-'),
  pipe: pc.gray('|'),
};
