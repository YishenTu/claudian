import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveExecutionTarget } from '@/core/process/execution-target/ExecutionTargetResolver';
import type { ExecutionTarget } from '@/core/process/execution-target/types';

import type { ProviderHistoryEnvironment } from '../../../core/providers/types';
import { isPathWithinRoot } from '../../../core/storage/pathContainment';
import { decodePiConfig } from '../config';
import { piHostPath, piTargetPath } from '../runtime/piTargetPaths';
import { getPiWSLForwardedEnvironment } from '../runtime/piWSLEnvironment';
import { findPiSessionFile, findPiSessionFileInRoot } from './PiHistoryStore';

export interface PiHistoryPathContext extends ProviderHistoryEnvironment {
  config?: Readonly<Record<string, unknown>>;
  executionTarget?: ExecutionTarget;
  environmentText?: string;
}

export function resolvePiHistoryTarget(vaultPath: string | null, context: PiHistoryPathContext): ExecutionTarget {
  return context.executionTarget ?? resolveExecutionTarget({
    settings: decodePiConfig(context.config ?? {}, { referencedModelIds: [] }),
    hostPlatform: context.hostPlatform, hostVaultPath: vaultPath,
  });
}

function resolveWSLSessionFile(
  persistedPath: string | null | undefined,
  logicalSessionId: string | null | undefined,
  vaultPath: string | null,
  context: PiHistoryPathContext,
  target: ExecutionTarget,
): string | null {
  const reference = persistedPath?.trim() || (isPiSessionPathReference(logicalSessionId) ? logicalSessionId.trim() : null);
  const roots: string[] = [];
  const map = (value: string) => piTargetPath(value, target);
  try {
    // Reject foreign-distro locators before considering an ID-based fallback.
    const candidate = reference ? map(reference) : null;
    const homeForwarded = context.environmentText === undefined
      || getPiWSLForwardedEnvironment(context.environment, context.environmentText).some(variable => variable.key === 'HOME');
    const home = homeForwarded ? context.environment.HOME : undefined;
    const linuxHome = home?.startsWith('/') && !home.startsWith('//') ? home : null;
    // Pi normalizes directory environment values before accessing its store.
    const directory = (value: string): string => {
      if (value === '~' || value.startsWith('~/')) {
        if (!linuxHome) throw new Error('Pi directory requires the Linux home');
        return path.posix.join(linuxHome, value === '~' ? '' : value.slice(2));
      }
      if (value.startsWith('file://')) return fileURLToPath(value, { windows: false });
      if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) return map(value);
      const cwd = vaultPath ?? context.vaultPath;
      if (!cwd) throw new Error('Pi relative directory requires the working directory');
      return path.posix.resolve(map(cwd), value);
    };
    const sessionDir = context.environment.PI_CODING_AGENT_SESSION_DIR?.trim();
    const agentDir = context.environment.PI_CODING_AGENT_DIR?.trim();
    let configDir = '.pi';
    let configDirKnown = true;
    const packageDir = context.environment.PI_PACKAGE_DIR?.trim();
    if (!sessionDir && packageDir) {
      try {
        configDir = readPackageConfigDirectory(piHostPath(path.posix.join(directory(packageDir), 'package.json'), target));
      } catch (error) {
        // Unreadable package metadata hides only the project settings of an explicit agent store.
        if (!agentDir) throw error;
        configDirKnown = false;
      }
    }
    const agentRoot = agentDir ? directory(agentDir) : linuxHome ? path.posix.join(linuxHome, configDir, 'agent') : null;
    const cwd = vaultPath ?? context.vaultPath;
    // Like Pi: the session-directory variable, then project over user settings, then the agent store.
    const settingsSessionDir = sessionDir ? undefined
      : (cwd && configDirKnown ? readSettingsSessionDir(piHostPath(path.posix.join(map(cwd), configDir, 'settings.json'), target)) : undefined)
        ?? (agentRoot ? readSettingsSessionDir(piHostPath(path.posix.join(agentRoot, 'settings.json'), target)) : undefined);
    if (sessionDir) {
      roots.push(directory(sessionDir));
    } else if (settingsSessionDir) {
      roots.push(directory(settingsSessionDir));
    } else if (agentDir && agentRoot) {
      roots.push(path.posix.join(agentRoot, 'sessions'));
    } else {
      if (linuxHome) roots.push(path.posix.join(linuxHome, configDir, 'agent', 'sessions'));
      // Native state supplies the distro user's absolute locator. Never use Windows HOME.
      const hintedHome = candidate?.match(/^\/(home\/[^/]+|root)(?:\/|$)/u)?.[0];
      if (!linuxHome && hintedHome) roots.push(path.posix.join(hintedHome, configDir, 'agent', 'sessions'));
      if (vaultPath) roots.push(path.posix.join(map(vaultPath), configDir, 'agent', 'sessions'));
    }
    const within = (file: string, root: string) => {
      const relative = path.posix.relative(root, file);
      return (relative === '' || (relative !== '..' && !relative.startsWith('../') && !path.posix.isAbsolute(relative)))
        && isPathWithinRoot(piHostPath(file, target), piHostPath(root, target));
    };
    if (candidate && roots.some(root => within(candidate, root))) {
      const host = piHostPath(candidate, target);
      if (isFile(host)) return host;
    }
    // An explicit WSL locator is identity proof, not a hint for another store file.
    if (reference) return null;
    if (isLogicalSessionId(logicalSessionId)) {
      for (const root of roots) {
        const resolved = findPiSessionFileInRoot(logicalSessionId, piHostPath(root, target));
        if (resolved && within(map(resolved), root) && isFile(resolved)) return resolved;
      }
    }
  } catch {
    // Unmappable roots, foreign distros and unreadable package metadata cannot establish trust.
  }
  return null;
}

function resolveLocalDirectory(value: string | undefined, home: string, cwd: string): string | null {
  let directory = value?.trim();
  if (!directory) return null;
  try {
    if (directory === '~') directory = home;
    else if (directory.startsWith('~/') || (process.platform === 'win32' && directory.startsWith('~\\'))) {
      directory = path.join(home, directory.slice(2));
    } else if (directory.startsWith('file://')) {
      directory = fileURLToPath(directory);
    }
    return path.resolve(cwd, directory);
  } catch {
    // Invalid native file URLs cannot establish a configured history root.
    return null;
  }
}

/** The `sessionDir` of a Pi settings file; a missing or unreadable file sets none. */
function readSettingsSessionDir(settingsFile: string): string | undefined {
  try {
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8').replace(/^\uFEFF/u, '')) as { sessionDir?: unknown };
    return typeof settings.sessionDir === 'string' && settings.sessionDir.trim() ? settings.sessionDir : undefined;
  } catch {
    return undefined;
  }
}

function readPackageConfigDirectory(packageFile: string): string {
  const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8')) as { piConfig?: { configDir?: unknown } };
  return typeof pkg.piConfig?.configDir === 'string' && pkg.piConfig.configDir ? pkg.piConfig.configDir : '.pi';
}

function getTrustedRoots(
  vaultPath: string | null,
  context: ProviderHistoryEnvironment,
): string[] {
  const roots: string[] = [];
  const windows = (context.hostPlatform ?? process.platform) === 'win32';
  const home = (windows
    ? context.environment.USERPROFILE?.trim() || context.environment.HOME?.trim()
    : context.environment.HOME?.trim() || context.environment.USERPROFILE?.trim()) || os.homedir();
  const cwd = vaultPath ?? context.vaultPath ?? process.cwd();
  const configuredSessionDir = resolveLocalDirectory(context.environment.PI_CODING_AGENT_SESSION_DIR, home, cwd);
  if (configuredSessionDir) {
    roots.push(configuredSessionDir);
  }

  const configuredAgentDir = resolveLocalDirectory(context.environment.PI_CODING_AGENT_DIR, home, cwd);
  if (configuredAgentDir) {
    roots.push(path.join(configuredAgentDir, 'sessions'));
  }
  if (vaultPath) {
    const vaultSessionRoot = path.join(vaultPath, '.pi', 'agent', 'sessions');
    if (isPathWithinRoot(vaultSessionRoot, vaultPath)) {
      roots.push(vaultSessionRoot);
    }
  }
  let configDir = '.pi';
  const packageDir = resolveLocalDirectory(context.environment.PI_PACKAGE_DIR, home, cwd);
  if (packageDir) {
    try { configDir = readPackageConfigDirectory(path.join(packageDir, 'package.json')); }
    catch { /* Unreadable package metadata cannot establish a custom history root. */ }
  }
  const defaultAgentDir = path.join(home, configDir, 'agent');
  roots.push(path.join(defaultAgentDir, 'sessions'));
  // Pi also reads `sessionDir` from the project settings before project trust, so both scopes locate its store.
  const projectCwd = vaultPath ?? context.vaultPath;
  const settingsFiles = [
    ...(projectCwd ? [path.join(projectCwd, configDir, 'settings.json')] : []),
    path.join(configuredAgentDir ?? defaultAgentDir, 'settings.json'),
  ];
  for (const settingsFile of settingsFiles) {
    const sessionDir = resolveLocalDirectory(readSettingsSessionDir(settingsFile), home, cwd);
    if (sessionDir) roots.push(sessionDir);
  }
  return [...new Set(roots)];
}

function isLogicalSessionId(value: string | null | undefined): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && !isPiSessionPathReference(value);
}

export function isPiSessionPathReference(
  value: string | null | undefined,
): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return trimmed.length > 0 && (
    trimmed.includes('/')
    || trimmed.includes('\\')
    || trimmed.endsWith('.jsonl')
  );
}

export function resolvePiSessionFileHint(
  persistedPath: string | null | undefined,
  logicalSessionId: string | null | undefined,
  vaultPath: string | null,
  context?: PiHistoryPathContext,
): string | null {
  if (!context) {
    const target = persistedPath ?? logicalSessionId;
    return target ? findPiSessionFile(target, vaultPath) : null;
  }

  const target = resolvePiHistoryTarget(vaultPath, context);
  if (target.method === 'wsl') return resolveWSLSessionFile(persistedPath, logicalSessionId, vaultPath, context, target);

  const roots = getTrustedRoots(vaultPath, context);
  const pathReference = persistedPath?.trim()
    || (isPiSessionPathReference(logicalSessionId)
      ? logicalSessionId.trim()
      : null);
  const resolvedPathReference = pathReference
    ? path.resolve(vaultPath ?? process.cwd(), pathReference)
    : null;
  if (
    resolvedPathReference
    && roots.some(root => isPathWithinRoot(resolvedPathReference, root))
    && isFile(resolvedPathReference)
  ) {
    return resolvedPathReference;
  }
  if (!isLogicalSessionId(logicalSessionId)) {
    return null;
  }

  for (const root of roots) {
    const resolved = findPiSessionFileInRoot(logicalSessionId, root);
    if (resolved && isPathWithinRoot(resolved, root) && isFile(resolved)) {
      return resolved;
    }
  }
  return null;
}

function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}
