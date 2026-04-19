import * as fs from 'node:fs';

import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import { expandHomePath } from '../../../utils/path';
import { getOpencodeProviderSettings } from '../settings';

export class OpencodeCliResolver {
  private lastCliPath = '';
  private lastEnvText = '';
  private resolvedPath: string | null = null;

  resolveFromSettings(settings: Record<string, unknown>): string | null {
    const opencodeSettings = getOpencodeProviderSettings(settings);
    const cliPath = opencodeSettings.cliPath.trim();
    const envText = getRuntimeEnvironmentText(settings, 'opencode');

    if (
      this.resolvedPath !== null
      && cliPath === this.lastCliPath
      && envText === this.lastEnvText
    ) {
      return this.resolvedPath;
    }

    this.lastCliPath = cliPath;
    this.lastEnvText = envText;
    this.resolvedPath = resolveConfiguredCliPath(cliPath);
    return this.resolvedPath;
  }

  reset(): void {
    this.lastCliPath = '';
    this.lastEnvText = '';
    this.resolvedPath = null;
  }
}

function resolveConfiguredCliPath(cliPath: string): string | null {
  if (!cliPath) {
    return null;
  }

  try {
    const expanded = expandHomePath(cliPath);
    if (fs.existsSync(expanded) && fs.statSync(expanded).isFile()) {
      return expanded;
    }
  } catch {
    return null;
  }

  return null;
}
