import * as os from 'os';
import * as path from 'path';

import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import { findCliBinaryPath, isExistingFile, resolveConfiguredCliPath } from '../../../utils/cliBinaryLocator';
import { getHostnameKey, parseEnvironmentVariables } from '../../../utils/env';
import { getKimiProviderSettings } from '../settings';

/**
 * Resolve the Kimi Code CLI path.
 *
 * Order: host-scoped path → legacy cliPath → PATH / common install dirs.
 * Finds `kimi`, `kimi.exe`, and `kimi.cmd` via shared binary helpers.
 */
export class KimiCliResolver {
  private readonly cachedHostname = getHostnameKey();
  private lastCliPath = '';
  private lastHostnamePath = '';
  private lastEnvText = '';
  private resolvedPath: string | null = null;

  resolveFromSettings(settings: Record<string, unknown>): string | null {
    const kimiSettings = getKimiProviderSettings(settings);
    const cliPath = kimiSettings.cliPath.trim();
    const hostnamePath = (kimiSettings.cliPathsByHost[this.cachedHostname] ?? '').trim();
    const envText = getRuntimeEnvironmentText(settings, 'kimi');

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
      kimiSettings.cliPathsByHost,
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
      ?? findKimiBinaryPath(customEnv.PATH);
  }

  reset(): void {
    this.lastCliPath = '';
    this.lastHostnamePath = '';
    this.lastEnvText = '';
    this.resolvedPath = null;
  }
}

function findKimiBinaryPath(additionalPath?: string): string | null {
  const fromShared = findCliBinaryPath('kimi', additionalPath);
  if (fromShared) {
    return fromShared;
  }

  const home = os.homedir();
  const candidates = [
    path.join(home, '.kimi-code', 'bin', 'kimi'),
    path.join(home, '.local', 'bin', 'kimi'),
    path.join(home, 'bin', 'kimi'),
  ];
  if (process.platform === 'win32') {
    candidates.push(
      path.join(home, '.kimi-code', 'bin', 'kimi.exe'),
      path.join(home, '.kimi-code', 'bin', 'kimi.cmd'),
      path.join(home, '.local', 'bin', 'kimi.exe'),
      path.join(home, '.local', 'bin', 'kimi.cmd'),
    );
  }

  for (const candidate of candidates) {
    if (isExistingFile(candidate)) {
      return candidate;
    }
  }

  return null;
}
