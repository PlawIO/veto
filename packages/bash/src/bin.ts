#!/usr/bin/env node

import { resolveNativeBinaryPath, spawnNativeCli } from './native.js';

const argv = process.argv.slice(2);

if (argv.length === 1 && (argv[0] === 'native-path' || argv[0] === 'bin-path')) {
  process.stdout.write(`${resolveNativeBinaryPath()}\n`);
  process.exit(0);
}

spawnNativeCli(argv);
