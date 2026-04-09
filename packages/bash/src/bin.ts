#!/usr/bin/env node

import { fileURLToPath } from 'node:url';
import { runCliOrExit } from './runner.js';

void runCliOrExit({
  currentScriptPath: fileURLToPath(import.meta.url),
});
