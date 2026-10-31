import * as path from 'path';

import type { TargetLaunchSpec } from '@/core/process/execution-target/types';

import type { InitializeResult } from './codexAppServerTypes';

export interface CodexRuntimeContext {
  launchSpec: TargetLaunchSpec;
  initializeResult: InitializeResult;
  codexHomeTarget: string | null;
  codexHomeHost: string | null;
  sessionsDirTarget: string | null;
  sessionsDirHost: string | null;
}

function normalizeTargetPath(launchSpec: TargetLaunchSpec, value: string): string {
  return launchSpec.target.platformFamily === 'windows'
    ? path.win32.normalize(value)
    : path.posix.normalize(value.startsWith('/') ? value : value.replace(/\\/g, '/'));
}

function joinTargetPath(launchSpec: TargetLaunchSpec, ...parts: string[]): string {
  return launchSpec.target.platformFamily === 'windows'
    ? path.win32.join(...parts)
    : path.posix.join(...parts.map(part => part.startsWith('/') ? part : part.replace(/\\/g, '/')));
}

function normalizeOptionalTargetPath(
  launchSpec: TargetLaunchSpec,
  value: string | null | undefined,
): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed ? normalizeTargetPath(launchSpec, trimmed) : null;
}

function resolveFallbackCodexHomeTarget(launchSpec: TargetLaunchSpec): string | null {
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
  launchSpec: TargetLaunchSpec,
  initializeResult: InitializeResult,
): string | null {
  return normalizeOptionalTargetPath(launchSpec, initializeResult.codexHome)
    ?? resolveFallbackCodexHomeTarget(launchSpec);
}

function validateInitializeTarget(
  launchSpec: TargetLaunchSpec,
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
  launchSpec: TargetLaunchSpec,
  initializeResult: InitializeResult,
): CodexRuntimeContext {
  validateInitializeTarget(launchSpec, initializeResult);

  const codexHomeTarget = resolveCodexHomeTarget(launchSpec, initializeResult);
  const sessionsDirTarget = codexHomeTarget
    ? joinTargetPath(launchSpec, codexHomeTarget, 'sessions')
    : null;

  return {
    launchSpec,
    initializeResult,
    codexHomeTarget,
    codexHomeHost: codexHomeTarget ? launchSpec.pathMapper.toHostPath(codexHomeTarget) : null,
    sessionsDirTarget,
    sessionsDirHost: sessionsDirTarget ? launchSpec.pathMapper.toHostPath(sessionsDirTarget) : null,
  };
}
