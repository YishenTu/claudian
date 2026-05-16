import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import type { ProviderCliResolver } from '../../../core/providers/types';
import { getHostnameKey } from '../../../utils/env';
import { getCursorProviderSettings } from '../settings';
import { resolveCursorCliPath } from './CursorBinaryLocator';

/**
 * Resolves the `cursor-agent` CLI path from settings, with caching keyed by
 * the inputs that affect resolution. Falls back to PATH probe when no
 * configured path exists.
 */
export class CursorCliResolver implements ProviderCliResolver {
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
      this.resolvedPath !== null &&
      hostnamePath === this.lastHostnamePath &&
      legacyPath === this.lastLegacyPath &&
      envText === this.lastEnvText
    ) {
      return this.resolvedPath;
    }

    this.lastHostnamePath = hostnamePath;
    this.lastLegacyPath = legacyPath;
    this.lastEnvText = envText;

    this.resolvedPath = resolveCursorCliPath(hostnamePath, legacyPath, envText);
    return this.resolvedPath;
  }

  reset(): void {
    this.resolvedPath = null;
    this.lastHostnamePath = '';
    this.lastLegacyPath = '';
    this.lastEnvText = '';
  }
}
