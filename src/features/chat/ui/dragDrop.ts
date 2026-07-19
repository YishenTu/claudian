import { type App,TFile, TFolder } from 'obsidian';

import { getVaultPath, normalizePathForVault } from '../../../utils/path';

export type DroppedVaultItem =
  | { kind: 'file'; path: string }
  | { kind: 'folder'; path: string };

/** Extracts paths from Obsidian, URI-list, JSON, and native file drags. */
export function extractDroppedPaths(dataTransfer: DataTransfer | null): string[] {
  if (!dataTransfer) return [];

  const values: string[] = [];
  for (const type of ['application/json', 'text/uri-list', 'text/plain']) {
    const value = dataTransfer.getData(type);
    if (value) values.push(value);
  }

  const files = dataTransfer.files;
  for (let index = 0; index < (files?.length ?? 0); index += 1) {
    const file = files[index] as File & { path?: string };
    if (file.path) values.push(file.path);
  }

  const paths: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        collectJsonPaths(JSON.parse(trimmed) as unknown, paths);
        continue;
      } catch {
        // Fall back to line parsing for malformed custom drag payloads.
      }
    }

    for (const line of trimmed.split(/\r?\n/)) {
      const path = normalizeDroppedValue(line);
      if (path) paths.push(path);
    }
  }

  return [...new Set(paths)];
}

export function resolveDroppedVaultItems(app: App, rawPaths: string[]): DroppedVaultItem[] {
  const vaultPath = getVaultPath(app);
  const items: DroppedVaultItem[] = [];

  for (const rawPath of rawPaths) {
    const vaultRelativePath = normalizePathForVault(rawPath, vaultPath);
    if (!vaultRelativePath) continue;

    const abstractFile = app.vault.getAbstractFileByPath(vaultRelativePath);
    if (abstractFile instanceof TFile) {
      items.push({ kind: 'file', path: vaultRelativePath });
    } else if (abstractFile instanceof TFolder) {
      items.push({ kind: 'folder', path: vaultRelativePath });
    }
  }

  return deduplicateItems(items);
}

export function buildDroppedMention(item: DroppedVaultItem): string {
  return item.kind === 'folder' ? `@${item.path}/ ` : `@${item.path} `;
}

function collectJsonPaths(value: unknown, paths: string[]): void {
  if (typeof value === 'string') {
    const normalized = normalizeDroppedValue(value);
    if (normalized) paths.push(normalized);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectJsonPaths(entry, paths);
    return;
  }
  if (!value || typeof value !== 'object') return;

  const record = value as Record<string, unknown>;
  for (const key of ['path', 'filePath', 'vaultPath', 'uri', 'url']) {
    if (typeof record[key] === 'string') {
      collectJsonPaths(record[key], paths);
    }
  }
  for (const key of ['files', 'items', 'paths']) {
    if (record[key] !== undefined) collectJsonPaths(record[key], paths);
  }
}

function normalizeDroppedValue(value: string): string | null {
  let normalized = value.trim();
  if (!normalized || normalized.startsWith('#')) return null;

  if (normalized.startsWith('obsidian://')) {
    try {
      const url = new URL(normalized);
      normalized = url.searchParams.get('file') ?? '';
    } catch {
      return null;
    }
  } else if (normalized.startsWith('file://')) {
    try {
      normalized = decodeURIComponent(new URL(normalized).pathname);
    } catch {
      normalized = normalized.slice('file://'.length);
    }
  }

  try {
    normalized = decodeURIComponent(normalized);
  } catch {
    // Keep already-decoded paths.
  }

  return normalized.replace(/^['"]|['"]$/g, '').trim() || null;
}

function deduplicateItems(items: DroppedVaultItem[]): DroppedVaultItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.kind}:${item.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
