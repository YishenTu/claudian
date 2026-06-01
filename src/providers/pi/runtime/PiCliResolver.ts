import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import { findCliBinaryPath, resolveConfiguredCliPath } from '../../../utils/cliBinaryLocator';
import { getHostnameKey, parseEnvironmentVariables } from '../../../utils/env';
import { getPiProviderSettings } from '../settings';

export class PiCliResolver {
  private readonly cachedHostname = getHostnameKey();
  private lastCliPath = '';
  private lastEnvText = '';
  private lastHostnamePath = '';
  private resolvedPath: string | null = null;

  resolveFromSettings(settings: Record<string, unknown>): string | null {
    const piSettings = getPiProviderSettings(settings);
    const cliPath = piSettings.cliPath.trim();
    const hostnamePath = (piSettings.cliPathsByHost[this.cachedHostname] ?? '').trim();
    const envText = getRuntimeEnvironmentText(settings, 'pi');

    if (
      this.resolvedPath !== null
      && cliPath === this.lastCliPath
      && hostnamePath === this.lastHostnamePath
      && envText === this.lastEnvText
    ) {
      return this.resolvedPath;
    }

    this.lastCliPath = cliPath;
    this.lastHostnamePath = hostnamePath;
    this.lastEnvText = envText;
    this.resolvedPath = this.resolve(piSettings.cliPathsByHost, cliPath, envText);
    return this.resolvedPath;
  }

  resolve(
    hostnamePaths: Record<string, string> | undefined,
    legacyPath: string,
    envText = '',
  ): string | null {
    const hostnamePath = (hostnamePaths?.[this.cachedHostname] ?? '').trim();
    const customEnv = parseEnvironmentVariables(envText || '');
    return resolveConfiguredCliPath(hostnamePath)
      ?? resolveConfiguredCliPath(legacyPath.trim())
      ?? findCliBinaryPath('pi', customEnv.PATH);
  }

  reset(): void {
    this.lastCliPath = '';
    this.lastHostnamePath = '';
    this.lastEnvText = '';
    this.resolvedPath = null;
  }
}
