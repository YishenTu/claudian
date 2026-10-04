import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { CachedProviderCLIResolver } from '@/core/providers/cli/CachedProviderCLIResolver';
import { getRuntimeEnvironmentText } from '@/core/providers/providerEnvironment';

import { getAntigravityProviderSettings } from '../settings';

const OFFICIAL_DOWNLOAD_URLS: Record<string, string> = {
  'darwin-arm64': 'https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.3.0-darwin-arm64.zip',
  'darwin-x64': 'https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.3.0-darwin-x86_64.zip',
  'linux-x64': 'https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.3.0-linux-x86_64.zip',
  'linux-arm64': 'https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.3.0-linux-arm64.zip',
  'win32-x64': 'https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.3.0-windows-x86_64.zip',
  'win32-arm64': 'https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.3.0-windows-arm64.zip',
};

export function getPlatformDownloadUrl(): string | null {
  const key = `${process.platform}-${process.arch}`;
  return OFFICIAL_DOWNLOAD_URLS[key] ?? null;
}

export function findKnownAntigravityServerPath(): string | null {
  const home = os.homedir();
  const binaryName = process.platform === 'win32' ? 'agy_acp_server.exe' : 'agy_acp_server.par';

  const candidateDirs: string[] = [
    // Standard user directories
    path.join(home, '.local', 'bin'),
    path.join(home, '.antigravity', 'bin'),
    path.join(home, 'bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
  ];

  if (process.platform === 'darwin') {
    candidateDirs.push(path.join(home, 'Library', 'Application Support', 'antigravity', 'bin'));
  } else if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    candidateDirs.push(
      path.join(localAppData, 'antigravity', 'bin'),
      path.join(appData, 'antigravity', 'bin'),
    );
  } else {
    // Linux / T3 tools directory check
    const t3ToolsDir = path.join(home, '.t3', 'tools', 'antigravity-acp');
    if (fs.existsSync(t3ToolsDir)) {
      try {
        const archDirs = fs.readdirSync(t3ToolsDir, { withFileTypes: true });
        for (const archDir of archDirs) {
          if (!archDir.isDirectory()) continue;
          const versionsDir = path.join(t3ToolsDir, archDir.name, 'versions');
          if (fs.existsSync(versionsDir)) {
            const verDirs = fs.readdirSync(versionsDir, { withFileTypes: true });
            for (const verDir of verDirs) {
              if (!verDir.isDirectory()) continue;
              const p = path.join(versionsDir, verDir.name, binaryName);
              if (fs.existsSync(p)) return p;
            }
          }
        }
      } catch {
        // ignore search error
      }
    }
  }

  for (const dir of candidateDirs) {
    const full = path.join(dir, binaryName);
    if (fs.existsSync(full)) {
      return full;
    }
  }

  return null;
}

export class AntigravityBinaryResolver {
  private readonly resolver = new CachedProviderCLIResolver({
    binaryName: process.platform === 'win32' ? 'agy_acp_server.exe' : 'agy_acp_server.par',
    findBinaryPath: () => findKnownAntigravityServerPath(),
    getSettingsProjection: (settings) => {
      const providerSettings = getAntigravityProviderSettings(settings);
      return {
        cliPathsByHost: providerSettings.cliPathsByHost,
        environmentText: getRuntimeEnvironmentText(settings, 'antigravity'),
        legacyCliPath: providerSettings.cliPath,
      };
    },
    providerId: 'antigravity',
  });

  resolveFromSettings(settings: Record<string, unknown>): string | null {
    return this.resolver.resolveFromSettings(settings);
  }

  reset(): void {
    this.resolver.reset();
  }
}
