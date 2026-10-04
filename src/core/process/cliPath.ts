import * as fs from 'fs';
import * as path from 'path';

import { expandHomePath, translateMsysPath } from '@/utils/path';

export function stripSurroundingQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Normalizes a user-configured CLI path. Windows Explorer's "Copy as path" wraps the
 * path in double quotes exactly when it contains a space, so a configured path field
 * receives a quoted value far more often than a PATH segment does. Unquoting before
 * expansion mirrors `parsePathEntries`, so `"%APPDATA%\..."` still expands.
 *
 * Returns an empty string when nothing is configured; callers treat that as "unset".
 */
export function normalizeConfiguredCLIPath(rawPath: string | undefined): string {
  const trimmed = (rawPath ?? '').trim();
  if (!trimmed) return '';
  return expandHomePath(stripSurroundingQuotes(trimmed));
}

export function parsePathEntries(pathValue?: string): string[] {
  if (!pathValue) {
    return [];
  }

  const delimiter = process.platform === 'win32' ? ';' : ':';

  return pathValue
    .split(delimiter)
    .map(segment => stripSurroundingQuotes(segment.trim()))
    .filter(segment => {
      if (!segment) return false;
      const upper = segment.toUpperCase();
      return upper !== '$PATH' && upper !== '${PATH}' && upper !== '%PATH%';
    })
    .map(segment => translateMsysPath(expandHomePath(segment)));
}


const NVM_LATEST_INSTALLED_ALIASES = new Set(['node', 'stable']);

function isNvmBuiltInLatestAlias(alias: string): boolean {
  return NVM_LATEST_INSTALLED_ALIASES.has(alias);
}

function findMatchingNvmVersion(entries: string[], resolvedAlias: string): string | undefined {
  if (isNvmBuiltInLatestAlias(resolvedAlias)) {
    return entries[0];
  }

  const version = resolvedAlias.replace(/^v/, '');
  return entries.find(entry => {
    const entryVersion = entry.slice(1); // strip 'v'
    return entryVersion === version || entryVersion.startsWith(version + '.');
  });
}

function resolveNvmAlias(nvmDir: string, alias: string, depth = 0): string | null {
  if (depth > 5) return null;

  if (/^\d/.test(alias) || alias.startsWith('v')) return alias;
  if (isNvmBuiltInLatestAlias(alias)) return alias;

  try {
    const aliasFile = path.join(nvmDir, 'alias', ...alias.split('/'));
    const target = fs.readFileSync(aliasFile, 'utf8').trim();
    if (!target) return null;
    return resolveNvmAlias(nvmDir, target, depth + 1);
  } catch {
    return null;
  }
}

// GUI apps don't have NVM_BIN set, so we resolve nvm's default alias
// from the filesystem and match against installed versions.
export function resolveNvmDefaultBin(home: string): string | null {
  const nvmDir = process.env.NVM_DIR || path.join(home, '.nvm');

  try {
    const alias = fs.readFileSync(path.join(nvmDir, 'alias', 'default'), 'utf8').trim();
    if (!alias) return null;

    const resolved = resolveNvmAlias(nvmDir, alias);
    if (!resolved) return null;

    const versionsDir = path.join(nvmDir, 'versions', 'node');
    const entries = fs.readdirSync(versionsDir)
      .filter(entry => entry.startsWith('v'))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));

    const matched = findMatchingNvmVersion(entries, resolved);

    if (matched) {
      const binDir = path.join(versionsDir, matched, 'bin');
      if (fs.existsSync(binDir)) return binDir;
    }
  } catch {
    // nvm not installed
  }

  return null;
}
