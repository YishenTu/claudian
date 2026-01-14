/**
 * Claudian - Claude CLI resolver
 *
 * Shared resolver for Claude CLI path detection across services.
 */

import * as fs from 'fs';

import { type HostnameCliPaths } from '../core/types/settings';
import { getHostnameKey, parseEnvironmentVariables } from './env';
import { expandHomePath, findClaudeCLIPath } from './path';

export class ClaudeCliResolver {
  private resolvedPath: string | null = null;
  private lastHostnamePath = '';
  private lastLegacyPath = '';
  private lastEnvText = '';
  // Cache hostname since it doesn't change during a session
  private readonly cachedHostname = getHostnameKey();

  /**
   * Resolves CLI path with priority: hostname-specific -> legacy -> auto-detect.
   * @param hostnamePaths Per-device CLI paths keyed by hostname (preferred)
   * @param legacyPath Legacy claudeCliPath (for backwards compatibility)
   * @param envText Environment variables text
   */
  resolve(
    hostnamePaths: HostnameCliPaths | undefined,
    legacyPath: string | undefined,
    envText: string
  ): string | null {
    const hostnameKey = this.cachedHostname;

    const hostnamePath = (hostnamePaths?.[hostnameKey] ?? '').trim();
    const normalizedLegacy = (legacyPath ?? '').trim();
    const normalizedEnv = envText ?? '';

    // Cache check
    if (
      this.resolvedPath &&
      hostnamePath === this.lastHostnamePath &&
      normalizedLegacy === this.lastLegacyPath &&
      normalizedEnv === this.lastEnvText
    ) {
      return this.resolvedPath;
    }

    this.lastHostnamePath = hostnamePath;
    this.lastLegacyPath = normalizedLegacy;
    this.lastEnvText = normalizedEnv;

    // Resolution priority: hostname-specific -> legacy -> auto-detect
    this.resolvedPath = resolveClaudeCliPath(hostnamePath, normalizedLegacy, normalizedEnv);
    return this.resolvedPath;
  }

  reset(): void {
    this.resolvedPath = null;
    this.lastHostnamePath = '';
    this.lastLegacyPath = '';
    this.lastEnvText = '';
  }
}

/**
 * Resolves CLI path with fallback chain.
 * @param hostnamePath Hostname-specific path for this device (preferred)
 * @param legacyPath Legacy claudeCliPath (backwards compatibility)
 * @param envText Environment variables text
 */
export function resolveClaudeCliPath(
  hostnamePath: string | undefined,
  legacyPath: string | undefined,
  envText: string
): string | null {
  // Try hostname-specific path first (highest priority)
  const trimmedHostname = (hostnamePath ?? '').trim();
  if (trimmedHostname) {
    try {
      const expandedPath = expandHomePath(trimmedHostname);
      if (fs.existsSync(expandedPath)) {
        const stat = fs.statSync(expandedPath);
        if (stat.isFile()) {
          return expandedPath;
        }
      }
    } catch {
      // Silently fall through to next resolution method
    }
  }

  // Fall back to legacy path
  const trimmedLegacy = (legacyPath ?? '').trim();
  if (trimmedLegacy) {
    try {
      const expandedPath = expandHomePath(trimmedLegacy);
      if (fs.existsSync(expandedPath)) {
        const stat = fs.statSync(expandedPath);
        if (stat.isFile()) {
          return expandedPath;
        }
      }
    } catch {
      // Silently fall through to auto-detect
    }
  }

  // Auto-detect
  const customEnv = parseEnvironmentVariables(envText || '');
  return findClaudeCLIPath(customEnv.PATH);
}
