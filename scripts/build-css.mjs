#!/usr/bin/env node
/**
 * CSS Build Script
 * Concatenates modular CSS files from src/style/ into root styles.css
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname, resolve, relative } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const STYLE_DIR = join(ROOT, 'src', 'style');
const OUTPUT = join(ROOT, 'styles.css');
const INDEX_FILE = join(STYLE_DIR, 'index.css');

const IMPORT_PATTERN = /^\s*@import\s+(?:url\()?['"]([^'"]+)['"]\)?\s*;/gm;

function getModuleOrder() {
  if (!existsSync(INDEX_FILE)) {
    console.error('Missing src/style/index.css');
    process.exit(1);
  }

  const content = readFileSync(INDEX_FILE, 'utf-8');
  const matches = [...content.matchAll(IMPORT_PATTERN)];

  if (matches.length === 0) {
    console.error('No @import entries found in src/style/index.css');
    process.exit(1);
  }

  return matches.map((match) => match[1]);
}

function listCssFiles(dir, baseDir = dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...listCssFiles(entryPath, baseDir));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith('.css')) {
      const relativePath = relative(baseDir, entryPath).split('\\').join('/');
      files.push(relativePath);
    }
  }

  return files;
}

function build() {
  const moduleOrder = getModuleOrder();
  const parts = ['/* Claudian Plugin Styles */\n/* Built from src/style/ modules */\n'];
  const missingFiles = [];
  const invalidImports = [];
  const normalizedImports = [];

  for (const modulePath of moduleOrder) {
    const resolvedPath = resolve(STYLE_DIR, modulePath);
    const relativePath = relative(STYLE_DIR, resolvedPath);

    if (relativePath.startsWith('..') || !relativePath.endsWith('.css')) {
      invalidImports.push(modulePath);
      continue;
    }

    const normalizedPath = relativePath.split('\\').join('/');
    normalizedImports.push(normalizedPath);

    if (!existsSync(resolvedPath)) {
      missingFiles.push(normalizedPath);
      continue;
    }

    const content = readFileSync(resolvedPath, 'utf-8');
    const header = `\n/* ============================================\n   ${normalizedPath}\n   ============================================ */\n`;
    parts.push(header + content);
  }

  let hasErrors = false;

  if (invalidImports.length > 0) {
    console.error('Invalid @import entries in src/style/index.css:');
    invalidImports.forEach((modulePath) => console.error(`  - ${modulePath}`));
    hasErrors = true;
  }

  if (missingFiles.length > 0) {
    console.error('Missing CSS files:');
    missingFiles.forEach((f) => console.error(`  - ${f}`));
    hasErrors = true;
  }

  const allCssFiles = listCssFiles(STYLE_DIR).filter((file) => file !== 'index.css');
  const importedSet = new Set(normalizedImports);
  const unlistedFiles = allCssFiles.filter((file) => !importedSet.has(file));

  if (unlistedFiles.length > 0) {
    console.error('Unlisted CSS files (not imported in src/style/index.css):');
    unlistedFiles.forEach((file) => console.error(`  - ${file}`));
    hasErrors = true;
  }

  if (hasErrors) {
    process.exit(1);
  }

  const output = parts.join('\n');
  writeFileSync(OUTPUT, output);
  console.log(`Built styles.css (${(output.length / 1024).toFixed(1)} KB)`);
}

build();
