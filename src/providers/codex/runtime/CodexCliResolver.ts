import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import type { HostnameCliPaths } from '../../../core/types/settings';
import { getHostnameKey } from '../../../utils/env';
import { getCodexProviderSettings } from '../settings';
import { resolveCodexCliPath } from './CodexBinaryLocator';

export class CodexCliResolver {
  private resolvedPath: string | null = null;
  private lastHostnamePath = '';
  private lastLegacyPath = '';
  private lastEnvText = '';
  private readonly cachedHostname = getHostnameKey();

  resolveFromSettings(settings: Record<string, unknown>): string | null {
    const codexSettings = getCodexProviderSettings(settings);
    const hostnamePath = (codexSettings.cliPathsByHost[this.cachedHostname] ?? '').trim();
    const legacyPath = codexSettings.cliPath.trim();
    const envText = getRuntimeEnvironmentText(settings, 'codex');

    if (
      this.resolvedPath &&
      hostnamePath === this.lastHostnamePath &&
      legacyPath === this.lastLegacyPath &&
      envText === this.lastEnvText
    ) {
      return this.resolvedPath;
    }

    this.lastHostnamePath = hostnamePath;
    this.lastLegacyPath = legacyPath;
    this.lastEnvText = envText;

    this.resolvedPath = resolveCodexCliPath(hostnamePath, legacyPath, envText);
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
        codex: {
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
  }
}
