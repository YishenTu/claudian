import * as os from 'os';
import * as path from 'path';

let _dirName = '.claude';

export function setClaudeHomeDirName(dirName: string): void {
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
