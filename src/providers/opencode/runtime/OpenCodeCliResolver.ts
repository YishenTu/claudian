import { spawnSync } from 'child_process';
import { existsSync } from 'fs';

import type { ProviderCliResolver } from '../../../core/providers/types';

export class OpenCodeCliResolver implements ProviderCliResolver {
  private cachedPath: string | null = null;

  resolveFromSettings(settings: Record<string, unknown>): string | null {
    if (this.cachedPath) return this.cachedPath;

    // Check for explicit path in settings
    const explicitPath = settings['opencodeCliPath'] as string | undefined;
    if (explicitPath && existsSync(explicitPath)) {
      this.cachedPath = explicitPath;
      return explicitPath;
    }

    // Try to find opencode in PATH
    const cliPath = this.findInPath();
    if (cliPath) {
      this.cachedPath = cliPath;
      return cliPath;
    }

    return null;
  }

  private findInPath(): string | null {
    const isWindows = process.platform === 'win32';
    
    // Try 'where' on Windows or 'which' on Unix
    const command = isWindows ? 'where.exe' : 'which';
    try {
      const result = spawnSync(command, ['opencode'], { 
        encoding: 'utf-8',
        timeout: 5000,
      });
      
      if (result.status === 0 && result.stdout) {
        const path = result.stdout.trim().split('\n')[0].trim();
        if (path && existsSync(path)) {
          return path;
        }
      }
    } catch {
      // where/which not available
    }

    // Fallback: search PATH directories
    const envPath = process.env.PATH || '';
    const paths = envPath.split(isWindows ? ';' : ':');
    const extensions = isWindows ? ['.exe', '.cmd', '.bat', ''] : [''];
    
    for (const dir of paths) {
      for (const ext of extensions) {
        const fullPath = `${dir}\\opencode${ext}`;
        if (existsSync(fullPath)) {
          return fullPath;
        }
      }
    }

    return null;
  }

  reset(): void {
    this.cachedPath = null;
  }
}
