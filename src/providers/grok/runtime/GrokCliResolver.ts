import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import { findCliBinaryPath, resolveConfiguredCliPath } from '../../../utils/cliBinaryLocator';
import { getHostnameKey, parseEnvironmentVariables } from '../../../utils/env';
import { getGrokProviderSettings } from '../settings';

export class GrokCliResolver {
  private readonly cachedHostname = getHostnameKey();
  private hasCachedResolution = false;
  private lastCliPath = '';
  private lastEnvironmentText = '';
  private lastHostnamePath = '';
  private resolvedPath: string | null = null;

  resolveFromSettings(settings: Record<string, unknown>): string | null {
    const grokSettings = getGrokProviderSettings(settings);
    const cliPath = grokSettings.cliPath.trim();
    const hostnamePath = (grokSettings.cliPathsByHost[this.cachedHostname] ?? '').trim();
    const environmentText = getRuntimeEnvironmentText(settings, 'grok');

    if (
      this.hasCachedResolution
      && cliPath === this.lastCliPath
      && hostnamePath === this.lastHostnamePath
      && environmentText === this.lastEnvironmentText
    ) {
      return this.resolvedPath;
    }

    this.lastCliPath = cliPath;
    this.lastHostnamePath = hostnamePath;
    this.lastEnvironmentText = environmentText;
    this.resolvedPath = this.resolve(
      grokSettings.cliPathsByHost,
      cliPath,
      environmentText,
    );
    this.hasCachedResolution = true;
    return this.resolvedPath;
  }

  resolve(
    hostnamePaths: Record<string, string> | undefined,
    legacyPath: string,
    environmentText: string,
  ): string | null {
    const hostnamePath = (hostnamePaths?.[this.cachedHostname] ?? '').trim();
    const customEnvironment = parseEnvironmentVariables(environmentText || '');
    return resolveConfiguredCliPath(hostnamePath)
      ?? resolveConfiguredCliPath(legacyPath.trim())
      ?? findCliBinaryPath('grok', customEnvironment.PATH);
  }

  reset(): void {
    this.hasCachedResolution = false;
    this.lastCliPath = '';
    this.lastEnvironmentText = '';
    this.lastHostnamePath = '';
    this.resolvedPath = null;
  }
}
