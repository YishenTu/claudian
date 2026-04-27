import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import type { HostnameCliPaths } from '../../../core/types/settings';
import { getHostnameKey } from '../../../utils/env';
import { getCursorProviderSettings } from '../settings';
import { resolveCursorCliPath } from './CursorBinaryLocator';

export class CursorCliResolver {
  private resolvedPath: string | null = null;
  private lastHostnamePath = '';
  private lastLegacyPath = '';
  private lastEnvText = '';
  private readonly cachedHostname = getHostnameKey();

  resolveFromSettings(settings: Record<string, unknown>): string | null {
    const cursorSettings = getCursorProviderSettings(settings);
    const hostnamePath = (cursorSettings.cliPathsByHost[this.cachedHostname] ?? '').trim();
    const legacyPath = cursorSettings.cliPath.trim();
    const envText = getRuntimeEnvironmentText(settings, 'cursor');

    if (
      this.resolvedPath
      && hostnamePath === this.lastHostnamePath
      && legacyPath === this.lastLegacyPath
      && envText === this.lastEnvText
    ) {
      return this.resolvedPath;
    }

    this.lastHostnamePath = hostnamePath;
    this.lastLegacyPath = legacyPath;
    this.lastEnvText = envText;

    this.resolvedPath = resolveCursorCliPath(hostnamePath, legacyPath, envText);
    return this.resolvedPath;
  }

  resolve(
    hostnamePaths: HostnameCliPaths | undefined,
    legacyPath: string | undefined,
    envText: string,
  ): string | null {
    const hostnamePath = (hostnamePaths?.[this.cachedHostname] ?? '').trim();
    const normalizedLegacyPath = (legacyPath ?? '').trim();
    return resolveCursorCliPath(hostnamePath, normalizedLegacyPath, envText);
  }

  reset(): void {
    this.resolvedPath = null;
    this.lastHostnamePath = '';
    this.lastLegacyPath = '';
    this.lastEnvText = '';
  }
}
