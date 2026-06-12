import * as fs from 'fs';

import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import type { HostnameCliPaths } from '../../../core/types/settings';
import { getHostnameKey, parseEnvironmentVariables } from '../../../utils/env';
import { expandHomePath } from '../../../utils/path';
import { findClaudeCLIPath } from '../cli/findClaudeCLIPath';
import { getClaudeProviderSettings } from '../settings';
import { isClaudeWslInstallationMethod } from '../settings';

export class ClaudeCliResolver {
  private resolvedPath: string | null = null;
  private lastHostnamePath = '';
  private lastLegacyPath = '';
  private lastEnvText = '';
  private lastInstallationMethod = '';
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
    const installationMethod = claudeSettings.installationMethod;

    if (
      this.resolvedPath &&
      hostnamePath === this.lastHostnamePath &&
      normalizedLegacy === this.lastLegacyPath &&
      normalizedEnv === this.lastEnvText &&
      installationMethod === this.lastInstallationMethod
    ) {
      return this.resolvedPath;
    }

    this.lastHostnamePath = hostnamePath;
    this.lastLegacyPath = normalizedLegacy;
    this.lastEnvText = normalizedEnv;
    this.lastInstallationMethod = installationMethod;

    this.resolvedPath = resolveClaudeCliPath(hostnamePath, normalizedLegacy, normalizedEnv, {
      installationMethod,
    });
    return this.resolvedPath;
  }

  resolve(
    hostnamePaths: HostnameCliPaths | undefined,
    legacyPath: string | undefined,
    envText: string,
  ): string | null {
    return this.resolveFromSettings({
      sharedEnvironmentVariables: envText,
      providerConfigs: {
        claude: {
          cliPath: legacyPath ?? '',
          cliPathsByHost: hostnamePaths ?? {},
        },
      },
    });
  }

  reset(): void {
    this.resolvedPath = null;
    this.lastHostnamePath = '';
    this.lastLegacyPath = '';
    this.lastEnvText = '';
    this.lastInstallationMethod = '';
  }
}

function resolveConfiguredPath(rawPath: string | undefined): string | null {
  const trimmed = (rawPath ?? '').trim();
  if (!trimmed) return null;
  try {
    const expanded = expandHomePath(trimmed);
    if (fs.existsSync(expanded) && fs.statSync(expanded).isFile()) {
      return expanded;
    }
  } catch {
    // Fall through
  }
  return null;
}

export function resolveClaudeCliPath(
  hostnamePath: string | undefined,
  legacyPath: string | undefined,
  envText: string,
  options: {
    installationMethod?: ReturnType<typeof getClaudeProviderSettings>['installationMethod'];
    hostPlatform?: NodeJS.Platform;
  } = {},
): string | null {
  if (
    (options.hostPlatform ?? process.platform) === 'win32'
    && options.installationMethod
    && isClaudeWslInstallationMethod(options.installationMethod)
  ) {
    const configuredCommand = [hostnamePath, legacyPath]
      .map(value => (value ?? '').trim())
      .find(value => value && !/^[A-Za-z]:[\\/]|^\\\\|\.(?:exe|cmd|bat|ps1)$/i.test(value));
    return configuredCommand || 'claude';
  }
  return (
    resolveConfiguredPath(hostnamePath) ??
    resolveConfiguredPath(legacyPath) ??
    findClaudeCLIPath(parseEnvironmentVariables(envText || '').PATH)
  );
}
