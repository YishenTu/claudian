import * as os from 'os';
import * as path from 'path';

let _dirName = '.claude';

/** Returns true if the given directory name is valid for use as a Claude home directory. */
export function isValidClaudeHomeDirName(dirName: string): boolean {
  if (!dirName || dirName === '.' || dirName === '..') return false;
  if (!dirName.startsWith('.')) return false;
  if (dirName.includes('/') || dirName.includes('\\')) return false;
  return true;
}

export function setClaudeHomeDirName(dirName: string): void {
  if (!isValidClaudeHomeDirName(dirName)) return;
  _dirName = dirName;
}

export function getClaudeHomeDirName(): string {
  return _dirName;
}

/** Global Claude home directory, e.g. ~/.claude/ or ~/.claude-internal/ */
export function getGlobalClaudeHome(): string {
  return path.join(os.homedir(), _dirName);
}

/** Path under the global Claude home, e.g. ~/.claude/agents */
export function getGlobalClaudePath(...segments: string[]): string {
  return path.join(os.homedir(), _dirName, ...segments);
}

/** Vault-relative Claude directory name, e.g. '.claude' or '.claude-internal' */
export function getVaultClaudeDir(): string {
  return _dirName;
}

/** Vault-relative path under the Claude directory, e.g. '.claude/settings.json' */
export function getVaultClaudePath(...segments: string[]): string {
  return [_dirName, ...segments].join('/');
}
