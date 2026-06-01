import { findCliBinaryPath, resolveConfiguredCliPath } from '../../../utils/cliBinaryLocator';
import { parseEnvironmentVariables } from '../../../utils/env';
import type { CodexInstallationMethod } from '../settings';

export function isWindowsStyleCliReference(value: string | null | undefined): boolean {
  const trimmed = (value ?? '').trim();
  if (!trimmed) {
    return false;
  }

  return /^[A-Za-z]:[\\/]/.test(trimmed)
    || trimmed.startsWith('\\\\')
    || /\.(?:exe|cmd|bat|ps1)$/i.test(trimmed);
}

export function findCodexBinaryPath(
  additionalPath?: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  return findCliBinaryPath('codex', additionalPath, platform);
}

export function resolveCodexCliPath(
  hostnamePath: string | undefined,
  legacyPath: string | undefined,
  envText: string,
  options: { installationMethod?: CodexInstallationMethod; hostPlatform?: NodeJS.Platform } = {},
): string | null {
  const hostPlatform = options.hostPlatform ?? process.platform;
  if (hostPlatform === 'win32' && options.installationMethod === 'wsl') {
    const configuredCommand = [hostnamePath, legacyPath]
      .map(value => (value ?? '').trim())
      .find(value => value.length > 0 && !isWindowsStyleCliReference(value));
    return configuredCommand || 'codex';
  }

  const configuredHostnamePath = resolveConfiguredCliPath(hostnamePath);
  if (configuredHostnamePath) {
    return configuredHostnamePath;
  }

  const configuredLegacyPath = resolveConfiguredCliPath(legacyPath);
  if (configuredLegacyPath) {
    return configuredLegacyPath;
  }

  const customEnv = parseEnvironmentVariables(envText || '');
  return findCodexBinaryPath(customEnv.PATH, hostPlatform);
}
