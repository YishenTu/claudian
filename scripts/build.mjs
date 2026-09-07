#!/usr/bin/env node
/**
 * Combined build script - runs CSS build then esbuild
 * Avoids npm echoing commands
 */

import { execFileSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Run CSS build silently
execFileSync(process.execPath, [join(ROOT, 'scripts/build-css.mjs')], {
  cwd: ROOT,
  stdio: 'inherit',
});

// Run esbuild with args passed through
execFileSync(process.execPath, [join(ROOT, 'esbuild.config.mjs'), ...process.argv.slice(2)], {
  cwd: ROOT,
  stdio: 'inherit',
});
