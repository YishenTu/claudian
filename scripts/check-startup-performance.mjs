#!/usr/bin/env node

import { existsSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mainPath = path.join(root, 'main.js');
const requiredArtifacts = ['main.js', 'manifest.json', 'styles.css'];
export const preCollabReferenceMainBytes = 3_739_584;
export const privateCloudBootstrapAllowanceBytes = 100_000;
export const cloudAuthorityBindingAllowanceBytes = 50_000;
export const standaloneProtocolPackagingAllowanceBytes = 20_000;
export const mainBudgetBytes = 5_000_000
  + privateCloudBootstrapAllowanceBytes
  + cloudAuthorityBindingAllowanceBytes
  + standaloneProtocolPackagingAllowanceBytes;
export const evaluationIndicatorMs = 50;
export const evaluationReviewThresholdMs = 150;
const pluginArtifactNames = ['main.js', 'manifest.json'];

export function inspectArtifactSize(mainBytes) {
  return {
    budgetExceeded: mainBytes > mainBudgetBytes,
    referenceDeltaBytes: mainBytes - preCollabReferenceMainBytes,
  };
}

export function inspectEvaluationDuration(medianMs) {
  return medianMs > evaluationReviewThresholdMs
    ? 'review-required'
    : medianMs > evaluationIndicatorMs
      ? 'warning'
      : 'within-indicator';
}

export function inspectPluginArtifactReferences(mainContents) {
  return pluginArtifactNames.filter(artifactName => mainContents.includes(artifactName));
}

function signed(value) {
  return value >= 0 ? `+${value}` : String(value);
}

function run() {
  for (const relativePath of requiredArtifacts) {
    const artifactPath = path.join(root, relativePath);
    if (!existsSync(artifactPath)) {
      throw new Error(`Missing production artifact: ${relativePath}`);
    }
    if (relativePath.endsWith('.js')) {
      const syntaxCheck = spawnSync(process.execPath, ['--check', artifactPath], {
        cwd: root,
        encoding: 'utf8',
      });
      if (syntaxCheck.status !== 0) {
        throw new Error(`Invalid production artifact ${relativePath}: ${syntaxCheck.stderr}`);
      }
    }
  }

  const mainContents = readFileSync(mainPath, 'utf8');
  if (mainContents.includes('ws does not work in the browser')) {
    throw new Error('main.js resolved the browser-only ws stub instead of the desktop runtime');
  }
  const pluginArtifactReferences = inspectPluginArtifactReferences(mainContents);
  if (pluginArtifactReferences.length > 0) {
    throw new Error(
      `main.js contains plugin artifact filename references that can be mistaken for a self-update mechanism: ${pluginArtifactReferences.join(', ')}`,
    );
  }
  const unsupportedChunkReferences = [
    './chunks/providers/',
    './chunks/locales/',
    './chunks/optional/',
  ].filter(reference => mainContents.includes(reference));
  if (unsupportedChunkReferences.length > 0) {
    throw new Error(
      `main.js depends on files the Obsidian Community Plugin installer does not fetch: ${unsupportedChunkReferences.join(', ')}`,
    );
  }

  const mainBytes = statSync(mainPath).size;
  const artifact = inspectArtifactSize(mainBytes);
  if (artifact.budgetExceeded) {
    throw new Error(
      `main.js is ${mainBytes} bytes; the production bundle budget is ${mainBudgetBytes} bytes.`,
    );
  }

  const childScript = String.raw`
const Module = require('node:module');
const childProcess = require('node:child_process');
const net = require('node:net');
const { performance } = require('node:perf_hooks');
const mainPath = process.argv[1];
let childProcessStarts = 0;
let networkListens = 0;
let wasmInitializations = 0;
for (const method of ['exec', 'execFile', 'fork', 'spawn', 'spawnSync']) {
  childProcess[method] = function () {
    childProcessStarts += 1;
    throw new Error('Eager child process during module evaluation: ' + method);
  };
}
net.Server.prototype.listen = function () {
  networkListens += 1;
  throw new Error('Eager network listener during module evaluation');
};
WebAssembly.instantiate = function () {
  wasmInitializations += 1;
  throw new Error('Eager WebAssembly initialization during module evaluation');
};
if (typeof WebAssembly.instantiateStreaming === 'function') {
  WebAssembly.instantiateStreaming = function () {
    wasmInitializations += 1;
    throw new Error('Eager WebAssembly initialization during module evaluation');
  };
}
let universal;
universal = new Proxy(function () { return universal; }, {
  construct() { return {}; },
  get(_target, property) {
    if (property === 'isWin' || property === 'isMacOS' || property === 'isLinux') return false;
    if (property === 'then') return undefined;
    return universal;
  },
});
const obsidian = new Proxy({}, {
  get(_target, property) {
    if (property === 'Platform') return { isWin: false, isMacOS: true, isLinux: false };
    if (property === 'normalizePath') return value => value;
    if (property === 'setIcon') return () => {};
    return universal;
  },
});
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'obsidian') return obsidian;
  if (request === 'electron') return { shell: universal };
  return originalLoad.call(this, request, parent, isMain);
};
const startedAt = performance.now();
try {
  require(mainPath);
} catch (error) {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write('Module evaluation failed: ' + message);
  process.exit(1);
}
process.stdout.write(JSON.stringify({
  childProcessStarts,
  durationMs: performance.now() - startedAt,
  networkListens,
  wasmInitializations,
}));
`;

  const childNodePath = [
    path.join(root, 'node_modules', '.bun', 'node_modules'),
    process.env.NODE_PATH,
  ].filter(candidate => candidate && existsSync(candidate)).join(path.delimiter);
  const samples = [];
  for (let index = 0; index < 7; index += 1) {
    const result = spawnSync(process.execPath, ['-e', childScript, mainPath], {
      cwd: root,
      encoding: 'utf8',
      env: childNodePath
        ? { ...process.env, NODE_PATH: childNodePath }
        : process.env,
    });
    if (result.status !== 0) {
      throw new Error(`Module evaluation harness failed: ${result.stderr || result.stdout}`);
    }
    let sample;
    try {
      sample = JSON.parse(result.stdout.trim());
    } catch {
      throw new Error(`Module evaluation harness returned an invalid duration: ${JSON.stringify(result.stdout)}`);
    }
    if (
      !Number.isFinite(sample.durationMs)
      || sample.childProcessStarts !== 0
      || sample.networkListens !== 0
      || sample.wasmInitializations !== 0
    ) {
      throw new Error(
        `Module evaluation eagerly initialized a deferred runtime: ${JSON.stringify(sample)}`,
      );
    }
    samples.push(sample.durationMs);
  }
  samples.sort((left, right) => left - right);
  const medianMs = samples[Math.floor(samples.length / 2)];
  const deltaMiB = artifact.referenceDeltaBytes / 1024 / 1024;

  console.log(
    `main.js ${(mainBytes / 1024 / 1024).toFixed(2)} MiB (${mainBytes} bytes); `
    + `pre-Collab reference delta ${signed(artifact.referenceDeltaBytes)} bytes `
    + `(${signed(deltaMiB.toFixed(2))} MiB); `
    + `median cold evaluation ${medianMs.toFixed(1)} ms`,
  );
  const evaluation = inspectEvaluationDuration(medianMs);
  if (evaluation === 'review-required') {
    console.warn(
      `Performance review required: median cold module evaluation is ${medianMs.toFixed(1)} ms; review threshold is ${evaluationReviewThresholdMs} ms.`,
    );
  } else if (evaluation === 'warning') {
    console.warn(
      `Performance warning: median cold module evaluation is ${medianMs.toFixed(1)} ms; indicator is ${evaluationIndicatorMs} ms.`,
    );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run();
}
