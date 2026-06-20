#!/usr/bin/env node
/**
 * Combined build script - runs CSS build then esbuild
 * Avoids npm echoing commands
 */

import { execSync, spawnSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Run CSS build silently
execSync('node scripts/build-css.mjs', { cwd: ROOT, stdio: 'inherit' });

// Run esbuild with args passed through
spawnSync('node', ['esbuild.config.mjs', ...process.argv.slice(2)], { cwd: ROOT, stdio: 'inherit' });
