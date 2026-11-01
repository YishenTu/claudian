#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const numericIdentifier = '(?:0|[1-9][0-9]*)';
const prereleaseIdentifier = '(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)';
const releaseVersionPattern = new RegExp(
  `^${numericIdentifier}\\.${numericIdentifier}\\.${numericIdentifier}`
  + `(?:-${prereleaseIdentifier}(?:\\.${prereleaseIdentifier})*)?`
  + '(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?(?![\\s\\S])',
);

export function validateReleaseVersions({ tag, packageVersion, manifestVersion }) {
  if (typeof tag !== 'string' || !releaseVersionPattern.test(tag)) {
    throw new Error(`Invalid or missing release tag: ${JSON.stringify(tag)}`);
  }
  if (tag !== packageVersion || tag !== manifestVersion) {
    throw new Error(
      `Release version mismatch: tag=${tag}, package.json=${packageVersion}, manifest.json=${manifestVersion}`,
    );
  }
}

function run() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const rootDir = path.resolve(scriptDir, '..');
  const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  const manifestJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'manifest.json'), 'utf8'));
  validateReleaseVersions({
    tag: process.argv[2],
    packageVersion: packageJson.version,
    manifestVersion: manifestJson.version,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    run();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
