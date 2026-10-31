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
    if (sessionDir) {
      roots.push(directory(sessionDir));
    } else if (agentDir) {
      roots.push(path.posix.join(directory(agentDir), 'sessions'));
    } else {
      let configDir = '.pi';
      const packageDir = context.environment.PI_PACKAGE_DIR?.trim();
      if (packageDir) {
        const packageFile = piHostPath(path.posix.join(directory(packageDir), 'package.json'), target);
        const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8')) as { piConfig?: { configDir?: unknown } };
        if (typeof pkg.piConfig?.configDir === 'string' && pkg.piConfig.configDir) configDir = pkg.piConfig.configDir;
      }
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

function getConfiguredSessionDir(context: ProviderHistoryEnvironment): string | null {
  const configured = context.environment.PI_CODING_AGENT_SESSION_DIR?.trim();
  return configured && path.isAbsolute(configured) ? configured : null;
}

function getTrustedRoots(
  vaultPath: string | null,
  context: ProviderHistoryEnvironment,
): string[] {
  const roots: string[] = [];
  const configuredSessionDir = getConfiguredSessionDir(context);
  if (configuredSessionDir) {
    roots.push(configuredSessionDir);
  }

  const configuredAgentDir = context.environment.PI_CODING_AGENT_DIR?.trim();
  if (configuredAgentDir && path.isAbsolute(configuredAgentDir)) {
    roots.push(path.join(configuredAgentDir, 'sessions'));
  }
  if (vaultPath) {
    const vaultSessionRoot = path.join(vaultPath, '.pi', 'agent', 'sessions');
    if (isPathWithinRoot(vaultSessionRoot, vaultPath)) {
      roots.push(vaultSessionRoot);
    }
  }
  const windows = (context.hostPlatform ?? process.platform) === 'win32';
  const home = (windows
    ? context.environment.USERPROFILE?.trim() || context.environment.HOME?.trim()
    : context.environment.HOME?.trim() || context.environment.USERPROFILE?.trim()) || os.homedir();
  roots.push(path.join(home, '.pi', 'agent', 'sessions'));
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
