import { createScanner, SyntaxKind } from 'jsonc-parser';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const bundleCriticalRuntimeDependencies = Object.freeze([
  '@anthropic-ai/claude-agent-sdk',
]);

const exactVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function bunResolutionVersion(resolution) {
  if (!Array.isArray(resolution) || typeof resolution[0] !== 'string') return undefined;
  const separator = resolution[0].lastIndexOf('@');
  return separator < 0 ? undefined : resolution[0].slice(separator + 1);
}

export function parseBunLock(source) {
  const scanner = createScanner(source, true);
  const trailingCommas = [];
  let previousToken;
  let commaOffset = 0;
  for (let token = scanner.scan(); token !== SyntaxKind.EOF; token = scanner.scan()) {
    if (previousToken === SyntaxKind.CommaToken
      && (token === SyntaxKind.CloseBraceToken || token === SyntaxKind.CloseBracketToken)) {
      trailingCommas.push(commaOffset);
    }
    if (token === SyntaxKind.CommaToken) commaOffset = scanner.getTokenOffset();
    previousToken = token;
  }
  for (const offset of trailingCommas.reverse()) {
    source = source.slice(0, offset) + source.slice(offset + 1);
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error('bun.lock is not valid JSONC.', { cause: error });
  }
}

export function inspectRuntimeDependencyParity({ bunLock, packageJson, packageLock }) {
  const violations = [];
  const sources = [
    {
      dependencies: packageLock.packages?.['']?.dependencies,
      source: 'package-lock.json manifest',
    },
    {
      dependencies: bunLock.workspaces?.['']?.dependencies,
      source: 'bun.lock manifest',
    },
  ];

  for (const dependency of bundleCriticalRuntimeDependencies) {
    const expected = packageJson.dependencies?.[dependency];
    if (typeof expected !== 'string' || !exactVersionPattern.test(expected)) {
      violations.push({
        actual: expected,
        dependency,
        expected: 'an exact version',
        source: 'package.json',
      });
      continue;
    }
    for (const source of sources) {
      const actual = source.dependencies?.[dependency];
      if (actual !== expected) {
        violations.push({ actual, dependency, expected, source: source.source });
      }
    }

    const npmActual = packageLock.packages?.[`node_modules/${dependency}`]?.version;
    if (npmActual !== expected) {
      violations.push({
        actual: npmActual,
        dependency,
        expected,
        source: 'package-lock.json resolution',
      });
    }

    const bunActual = bunResolutionVersion(bunLock.packages?.[dependency]);
    if (bunActual !== expected) {
      violations.push({
        actual: bunActual,
        dependency,
        expected,
        source: 'bun.lock resolution',
      });
    }
  }

  return violations;
}

export function assertRuntimeDependencyParity(root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
)) {
  const violations = inspectRuntimeDependencyParity({
    bunLock: parseBunLock(readFileSync(path.join(root, 'bun.lock'), 'utf8')),
    packageJson: readJson(path.join(root, 'package.json')),
    packageLock: readJson(path.join(root, 'package-lock.json')),
  });
  if (violations.length === 0) return;

  const details = violations.map(violation => (
    `${violation.source}: ${violation.dependency} expected ${violation.expected}, `
    + `found ${violation.actual ?? 'missing'}`
  ));
  throw new Error(`Bundle-critical runtime dependency parity failed:\n- ${details.join('\n- ')}`);
}
