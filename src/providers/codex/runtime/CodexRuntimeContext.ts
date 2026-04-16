import * as path from 'path';

import type { InitializeResult } from './codexAppServerTypes';
import type { CodexLaunchSpec } from './codexLaunchTypes';

export interface CodexRuntimeContext {
  launchSpec: CodexLaunchSpec;
  initializeResult: InitializeResult;
  codexHomeTarget: string | null;
  codexHomeHost: string | null;
  sessionsDirTarget: string | null;
  sessionsDirHost: string | null;
  memoriesDirTarget: string | null;
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

function normalizeOptionalTargetPath(
  launchSpec: CodexLaunchSpec,
  value: string | null | undefined,
): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed ? normalizeTargetPath(launchSpec, trimmed) : null;
}

function resolveFallbackCodexHomeTarget(launchSpec: CodexLaunchSpec): string | null {
  const rawCodexHome = typeof launchSpec.env.CODEX_HOME === 'string'
    ? launchSpec.env.CODEX_HOME.trim()
    : '';
  const envCodexHome = launchSpec.target.method === 'wsl'
    ? normalizeOptionalTargetPath(
        launchSpec,
        rawCodexHome.startsWith('/') ? rawCodexHome : launchSpec.pathMapper.toTargetPath(rawCodexHome),
      )
    : normalizeOptionalTargetPath(launchSpec, rawCodexHome);
  if (envCodexHome) {
    return envCodexHome;
  }

  if (launchSpec.target.method === 'wsl') {
    return null;
  }

  const homeVar = launchSpec.target.platformFamily === 'windows'
    ? launchSpec.env.USERPROFILE
    : launchSpec.env.HOME;
  const homeDir = normalizeOptionalTargetPath(launchSpec, homeVar);
  return homeDir ? joinTargetPath(launchSpec, homeDir, '.codex') : null;
}

function resolveCodexHomeTarget(
  launchSpec: CodexLaunchSpec,
  initializeResult: InitializeResult,
): string | null {
  return normalizeOptionalTargetPath(launchSpec, initializeResult.codexHome)
    ?? resolveFallbackCodexHomeTarget(launchSpec);
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

  const codexHomeTarget = resolveCodexHomeTarget(launchSpec, initializeResult);
  const sessionsDirTarget = codexHomeTarget
    ? joinTargetPath(launchSpec, codexHomeTarget, 'sessions')
    : null;
  const memoriesDirTarget = codexHomeTarget
    ? joinTargetPath(launchSpec, codexHomeTarget, 'memories')
    : null;

  return {
    launchSpec,
    initializeResult,
    codexHomeTarget,
    codexHomeHost: codexHomeTarget ? launchSpec.pathMapper.toHostPath(codexHomeTarget) : null,
    sessionsDirTarget,
    sessionsDirHost: sessionsDirTarget ? launchSpec.pathMapper.toHostPath(sessionsDirTarget) : null,
    memoriesDirTarget,
  };
}
