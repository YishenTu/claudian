/**
 * Claudian - Claude CLI resolver
 *
 * Shared resolver for Claude CLI path detection across services.
 */

import * as fs from 'fs';

import { parseEnvironmentVariables } from './env';
import { expandHomePath, findClaudeCLIPath } from './path';

export class ClaudeCliResolver {
  private resolvedPath: string | null = null;
  private lastCustomPath = '';
  private lastEnvText = '';

  resolve(customPath: string | undefined, envText: string): string | null {
    const normalizedCustom = (customPath ?? '').trim();
    const normalizedEnv = envText ?? '';

    if (
      this.resolvedPath &&
      normalizedCustom === this.lastCustomPath &&
      normalizedEnv === this.lastEnvText
    ) {
      return this.resolvedPath;
    }

    this.lastCustomPath = normalizedCustom;
    this.lastEnvText = normalizedEnv;
    this.resolvedPath = resolveClaudeCliPath(normalizedCustom, normalizedEnv);
    return this.resolvedPath;
  }

  reset(): void {
    this.resolvedPath = null;
    this.lastCustomPath = '';
    this.lastEnvText = '';
  }
}

export function resolveClaudeCliPath(customPath: string | undefined, envText: string): string | null {
  const trimmed = (customPath ?? '').trim();
  if (trimmed) {
    const expandedPath = expandHomePath(trimmed);
    if (fs.existsSync(expandedPath)) {
      try {
        const stat = fs.statSync(expandedPath);
        if (stat.isFile()) {
          return expandedPath;
        }
        console.warn(`Claudian: Custom CLI path is a directory, not a file: ${expandedPath}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`Claudian: Custom CLI path not accessible: ${expandedPath} (${message})`);
      }
    } else {
      console.warn(`Claudian: Custom CLI path not found: ${expandedPath}`);
    }
  }

  const customEnv = parseEnvironmentVariables(envText || '');
  return findClaudeCLIPath(customEnv.PATH);
}
