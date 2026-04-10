#!/usr/bin/env node

import { spawnNativeCli } from './native.js';

spawnNativeCli(process.argv.slice(2));
