import * as fs from 'fs';

import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import { getHostnameKey, parseEnvironmentVariables } from '../../../utils/env';
import { normalizeConfiguredCLIPath } from '../../../utils/path';
import { findClaudeCLIPath } from '../cli/findClaudeCLIPath';
import { getClaudeProviderSettings } from '../settings';

export class ClaudeCLIResolver {
  private resolvedPath: string | null = null;
  private lastHostnamePath = '';
  private lastLegacyPath = '';
  private lastEnvText = '';
  private readonly cachedHostname = getHostnameKey();

  /**
   * Resolves CLI path with priority: device-specific -> legacy -> auto-detect.
   * @param settings Full app settings bag
   */
  resolveFromSettings(settings: Record<string, unknown>): string | null {
    const hostnameKey = this.cachedHostname;
    const claudeSettings = getClaudeProviderSettings(settings);

    const hostnamePath = (claudeSettings.cliPathsByHost[hostnameKey] ?? '').trim();
    const normalizedLegacy = claudeSettings.cliPath.trim();
    const normalizedEnv = getRuntimeEnvironmentText(settings, 'claude');

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

    this.resolvedPath = resolveClaudeCLIPath(hostnamePath, normalizedLegacy, normalizedEnv);
    return this.resolvedPath;
  }

  reset(): void {
    this.resolvedPath = null;
    this.lastHostnamePath = '';
    this.lastLegacyPath = '';
    this.lastEnvText = '';
  }
}

function resolveConfiguredPath(rawPath: string | undefined): string | null {
  try {
    const expanded = normalizeConfiguredCLIPath(rawPath);
    if (!expanded) return null;
    if (fs.existsSync(expanded) && fs.statSync(expanded).isFile()) {
      return expanded;
    }
  } catch {
    // Fall through
  }
  return null;
}

export function resolveClaudeCLIPath(
  hostnamePath: string | undefined,
  legacyPath: string | undefined,
  envText: string,
): string | null {
  return (
    resolveConfiguredPath(hostnamePath) ??
    resolveConfiguredPath(legacyPath) ??
    findClaudeCLIPath(parseEnvironmentVariables(envText || '').PATH)
  );
}
