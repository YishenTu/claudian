import * as fs from 'node:fs';
import * as path from 'node:path';

import { parse as parseToml } from 'smol-toml';

import { getRuntimeEnvironmentVariables } from '../../../core/providers/providerEnvironment';
import { resolveKimiHome } from '../history/KimiHistoryPathResolver';

// Read-only view over `<kimi home>/config.toml` `[models."<alias>"]` entries.
// Kimi owns the file; Claudian never writes it.
export interface KimiModelMetadata {
  capabilities: string[];
  displayName?: string;
  maxContextSize?: number;
}

interface MetadataCacheEntry {
  metadata: Record<string, KimiModelMetadata>;
  mtimeMs: number;
  path: string;
}

let cache: MetadataCacheEntry | null = null;

export function getKimiModelMetadata(
  settings: Record<string, unknown>,
): Record<string, KimiModelMetadata> {
  const configPath = resolveKimiConfigPath(settings);
  const mtimeMs = statMtimeMs(configPath);
  if (cache && cache.path === configPath && cache.mtimeMs === mtimeMs) {
    return cache.metadata;
  }
  return loadIntoCache(configPath, mtimeMs);
}

export function refreshKimiModelMetadata(
  settings: Record<string, unknown>,
): Record<string, KimiModelMetadata> {
  const configPath = resolveKimiConfigPath(settings);
  return loadIntoCache(configPath, statMtimeMs(configPath));
}

export function resetKimiModelMetadataCache(): void {
  cache = null;
}

function resolveKimiConfigPath(settings: Record<string, unknown>): string {
  const environment = {
    ...process.env,
    ...getRuntimeEnvironmentVariables(settings, 'kimi'),
  };
  return path.join(
    resolveKimiHome({ environment, hostPlatform: process.platform }),
    'config.toml',
  );
}

function statMtimeMs(configPath: string): number {
  try {
    return fs.statSync(configPath).mtimeMs;
  } catch {
    return 0;
  }
}

function loadIntoCache(
  configPath: string,
  mtimeMs: number,
): Record<string, KimiModelMetadata> {
  const metadata = mtimeMs > 0 ? readKimiModelMetadata(configPath) : {};
  cache = { metadata, mtimeMs, path: configPath };
  return metadata;
}

function readKimiModelMetadata(configPath: string): Record<string, KimiModelMetadata> {
  try {
    const parsed = parseToml(fs.readFileSync(configPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    const models = (parsed as Record<string, unknown>).models;
    if (!models || typeof models !== 'object' || Array.isArray(models)) {
      return {};
    }

    const metadata: Record<string, KimiModelMetadata> = {};
    for (const [rawId, entry] of Object.entries(models)) {
      const normalized = normalizeModelEntry(entry);
      if (normalized) {
        metadata[rawId] = normalized;
      }
    }
    return metadata;
  } catch {
    return {};
  }
}

function normalizeModelEntry(entry: unknown): KimiModelMetadata | null {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return null;
  }
  const record = entry as Record<string, unknown>;

  const displayName = typeof record.display_name === 'string' && record.display_name.trim()
    ? record.display_name.trim()
    : undefined;
  const maxContextSize = typeof record.max_context_size === 'number'
    && Number.isFinite(record.max_context_size)
    && record.max_context_size > 0
    ? Math.floor(record.max_context_size)
    : undefined;
  const hasCapabilities = Array.isArray(record.capabilities);
  const capabilities = hasCapabilities
    ? (record.capabilities as unknown[]).filter(
      (value): value is string => typeof value === 'string' && Boolean(value.trim()),
    ).map((value) => value.trim())
    : [];

  if (displayName === undefined && maxContextSize === undefined && !hasCapabilities) {
    return null;
  }
  return {
    capabilities,
    ...(displayName !== undefined ? { displayName } : {}),
    ...(maxContextSize !== undefined ? { maxContextSize } : {}),
  };
}
