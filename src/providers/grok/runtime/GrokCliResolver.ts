import * as os from 'os';
import * as path from 'path';

import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import { findCliBinaryPath, isExistingFile, resolveConfiguredCliPath } from '../../../utils/cliBinaryLocator';
import { getHostnameKey, parseEnvironmentVariables } from '../../../utils/env';
import { getGrokProviderSettings } from '../settings';

/**
 * Resolve the Grok Build CLI path.
 *
 * Order: host-scoped path → legacy cliPath → PATH / common install dirs including
 * `~/.grok/bin` and `~/.local/bin`.
 */
export class GrokCliResolver {
  private readonly cachedHostname = getHostnameKey();
  private lastCliPath = '';
  private lastHostnamePath = '';
  private lastEnvText = '';
  private resolvedPath: string | null = null;

  resolveFromSettings(settings: Record<string, unknown>): string | null {
    const grokSettings = getGrokProviderSettings(settings);
    const cliPath = grokSettings.cliPath.trim();
    const hostnamePath = (grokSettings.cliPathsByHost[this.cachedHostname] ?? '').trim();
    const envText = getRuntimeEnvironmentText(settings, 'grok');

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
    this.resolvedPath = this.resolve(
      grokSettings.cliPathsByHost,
      cliPath,
      envText,
    );
    return this.resolvedPath;
  }

  resolve(
    hostnamePaths: Record<string, string> | undefined,
    legacyPath: string,
    envText: string,
  ): string | null {
    const hostnamePath = (hostnamePaths?.[this.cachedHostname] ?? '').trim();
    const customEnv = parseEnvironmentVariables(envText || '');
    return resolveConfiguredCliPath(hostnamePath)
      ?? resolveConfiguredCliPath(legacyPath.trim())
      ?? findGrokBinaryPath(customEnv.PATH);
  }

  reset(): void {
    this.lastCliPath = '';
    this.lastHostnamePath = '';
    this.lastEnvText = '';
    this.resolvedPath = null;
  }
}

function findGrokBinaryPath(additionalPath?: string): string | null {
  const fromShared = findCliBinaryPath('grok', additionalPath);
  if (fromShared) {
    return fromShared;
  }

  // Explicit Grok install roots (also mirrored in getEnhancedPath for PATH inheritance).
  const home = os.homedir();
  const candidates = [
    path.join(home, '.grok', 'bin', 'grok'),
    path.join(home, '.local', 'bin', 'grok'),
    path.join(home, 'bin', 'grok'),
  ];
  if (process.platform === 'win32') {
    candidates.push(
      path.join(home, '.grok', 'bin', 'grok.exe'),
      path.join(home, '.local', 'bin', 'grok.exe'),
    );
  }

  for (const candidate of candidates) {
    if (isExistingFile(candidate)) {
      return candidate;
    }
  }

  return null;
}
