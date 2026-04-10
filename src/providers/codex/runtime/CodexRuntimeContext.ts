import * as path from 'path';

import type { InitializeResult } from './codexAppServerTypes';
import type { CodexLaunchSpec } from './codexLaunchTypes';

export interface CodexRuntimeContext {
  launchSpec: CodexLaunchSpec;
  initializeResult: InitializeResult;
  codexHomeTarget: string;
  codexHomeHost: string | null;
  sessionsDirTarget: string;
  sessionsDirHost: string | null;
  memoriesDirTarget: string;
}

function normalizeTargetPath(launchSpec: CodexLaunchSpec, value: string): string {
  const rawValue = typeof value === 'string' ? value : String(value ?? '');
  return launchSpec.target.platformFamily === 'windows'
    ? path.win32.normalize(rawValue)
    : path.posix.normalize(rawValue.replace(/\\/g, '/'));
}

function joinTargetPath(launchSpec: CodexLaunchSpec, ...parts: string[]): string {
  const normalizedParts = parts
    .filter(part => part != null && part !== '')
    .map(part => (typeof part === 'string' ? part : String(part)));
  return launchSpec.target.platformFamily === 'windows'
    ? path.win32.join(...normalizedParts)
    : path.posix.join(...normalizedParts.map(part => part.replace(/\\/g, '/')));
}

function validateInitializeTarget(
  launchSpec: CodexLaunchSpec,
  initializeResult: InitializeResult,
): void {
  if (initializeResult.platformOs !== launchSpec.target.platformOs) {
    throw new Error(
      `Codex target mismatch: expected ${launchSpec.target.platformOs}, received ${initializeResult.platformOs}`,
    );
  }

  if (initializeResult.platformFamily !== launchSpec.target.platformFamily) {
    throw new Error(
      `Codex target mismatch: expected ${launchSpec.target.platformFamily}, received ${initializeResult.platformFamily}`,
    );
  }
}

export function createCodexRuntimeContext(
  launchSpec: CodexLaunchSpec,
  initializeResult: InitializeResult,
): CodexRuntimeContext {
  validateInitializeTarget(launchSpec, initializeResult);

  const fallbackHomeBase = launchSpec.target.platformFamily === 'windows'
    ? process.env.USERPROFILE || process.env.HOME || ''
    : process.env.HOME || '';
  const fallbackCodexHome = fallbackHomeBase
    ? joinTargetPath(launchSpec, fallbackHomeBase, '.codex')
    : '.codex';
  const codexHomeTarget = normalizeTargetPath(
    launchSpec,
    typeof initializeResult.codexHome === 'string' && initializeResult.codexHome.trim()
      ? initializeResult.codexHome
      : fallbackCodexHome,
  );
  const sessionsDirTarget = joinTargetPath(launchSpec, codexHomeTarget, 'sessions');
  const memoriesDirTarget = joinTargetPath(launchSpec, codexHomeTarget, 'memories');

  return {
    launchSpec,
    initializeResult,
    codexHomeTarget,
    codexHomeHost: launchSpec.pathMapper.toHostPath(codexHomeTarget),
    sessionsDirTarget,
    sessionsDirHost: launchSpec.pathMapper.toHostPath(sessionsDirTarget),
    memoriesDirTarget,
  };
}
