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
  return launchSpec.target.platformFamily === 'windows'
    ? path.win32.normalize(value)
    : path.posix.normalize(value.replace(/\\/g, '/'));
}

function joinTargetPath(launchSpec: CodexLaunchSpec, ...parts: string[]): string {
  return launchSpec.target.platformFamily === 'windows'
    ? path.win32.join(...parts)
    : path.posix.join(...parts.map(part => part.replace(/\\/g, '/')));
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

  const codexHomeTarget = normalizeTargetPath(launchSpec, initializeResult.codexHome);
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
