#!/usr/bin/env node
/**
 * Fails when `npm ci` and `bun install` would install different package versions.
 * Hoisting layout differs between the tools, so only the resolved name@version sets are compared.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseBunLock } from './runtimeDependencyParity.mjs';

const nonRegistryBunResolution = /@(?:workspace|link|file):/;

function npmResolutions(packageLock) {
  const resolutions = new Set();
  for (const [location, entry] of Object.entries(packageLock.packages ?? {})) {
    if (!location || entry.link) continue;
    const name = entry.name ?? location.slice(location.lastIndexOf('node_modules/') + 'node_modules/'.length);
    resolutions.add(`${name}@${entry.version}`);
  }
  return resolutions;
}

function bunResolutions(bunLock) {
  const resolutions = new Set();
  for (const entry of Object.values(bunLock.packages ?? {})) {
    const id = entry?.[0];
    if (typeof id === 'string' && !nonRegistryBunResolution.test(id)) resolutions.add(id);
  }
  return resolutions;
}

export function inspectLockfileParity({ bunLock, packageLock }) {
  const npm = npmResolutions(packageLock);
  const bun = bunResolutions(bunLock);
  return {
    onlyBun: [...bun].filter(resolution => !npm.has(resolution)).sort(),
    onlyNpm: [...npm].filter(resolution => !bun.has(resolution)).sort(),
  };
}

function main(root) {
  const { onlyBun, onlyNpm } = inspectLockfileParity({
    bunLock: parseBunLock(readFileSync(path.join(root, 'bun.lock'), 'utf8')),
    packageLock: JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8')),
  });
  if (onlyBun.length === 0 && onlyNpm.length === 0) return;

  const lines = [
    'package-lock.json and bun.lock resolve different packages.',
    ...onlyNpm.map(resolution => `  only in package-lock.json: ${resolution}`),
    ...onlyBun.map(resolution => `  only in bun.lock: ${resolution}`),
    'Regenerate bun.lock from package-lock.json: rm bun.lock && bun install --lockfile-only',
  ];
  process.stderr.write(`${lines.join('\n')}\n`);
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.cwd());
}
