import * as crypto from 'node:crypto';

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parse as parseToml } from 'smol-toml';

import { getProviderConfig, setProviderConfig } from '../providers/providerConfig';
import type { ProviderId } from '../providers/types';

export interface CCSwitchSnapshot {
  providerId: ProviderId;
  model?: string;
  modelProvider?: string;
  baseUrl?: string;
  authSource?: string;
  accountId?: string;
  keyFingerprint?: string;
  sourcePaths?: string[];
  configHash?: string;
  syncedAt?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function fingerprint(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
}

function stableEntries(snapshot: CCSwitchSnapshot): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  for (const key of [
    'providerId',
    'model',
    'modelProvider',
    'baseUrl',
    'authSource',
    'accountId',
    'keyFingerprint',
  ] as const) {
    const value = snapshot[key];
    if (typeof value === 'string' && value) {
      entries.push([key, value]);
    }
  }
  for (const sourcePath of snapshot.sourcePaths ?? []) {
    entries.push(['sourcePath', sourcePath]);
  }
  return entries.sort(([aKey, aValue], [bKey, bValue]) =>
    `${aKey}=${aValue}`.localeCompare(`${bKey}=${bValue}`)
  );
}

export function getCCSwitchSnapshotHash(snapshot: CCSwitchSnapshot | null | undefined): string {
  if (!snapshot) {
    return '';
  }
  return stableEntries(snapshot)
    .map(([key, value]) => `${key}=${value}`)
    .join('|');
}

function withSnapshotHash(snapshot: CCSwitchSnapshot | null): CCSwitchSnapshot | null {
  if (!snapshot) {
    return null;
  }
  const next = {
    ...snapshot,
    syncedAt: snapshot.syncedAt ?? new Date().toISOString(),
  };
  next.configHash = getCCSwitchSnapshotHash(next);
  return next;
}

export function parseClaudeCCSwitchSnapshot(
  settingsJson: string,
  sourcePath: string,
): CCSwitchSnapshot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(settingsJson);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !isRecord(parsed.env)) {
    return null;
  }

  const env = parsed.env;
  const authToken = normalizeString(env.ANTHROPIC_AUTH_TOKEN);
  const apiKey = normalizeString(env.ANTHROPIC_API_KEY);
  const model = normalizeString(env.ANTHROPIC_MODEL)
    ?? normalizeString(env.ANTHROPIC_DEFAULT_SONNET_MODEL)
    ?? normalizeString(env.ANTHROPIC_DEFAULT_OPUS_MODEL)
    ?? normalizeString(env.ANTHROPIC_DEFAULT_HAIKU_MODEL);
  const baseUrl = normalizeString(env.ANTHROPIC_BASE_URL);
  const keyFingerprint = fingerprint(authToken ?? apiKey);

  if (!model && !baseUrl && !keyFingerprint) {
    return null;
  }

  return withSnapshotHash({
    providerId: 'claude',
    model,
    baseUrl,
    authSource: authToken ? 'ANTHROPIC_AUTH_TOKEN' : (apiKey ? 'ANTHROPIC_API_KEY' : undefined),
    keyFingerprint,
    sourcePaths: [sourcePath],
  });
}

function getTomlRecord(content: string): Record<string, unknown> | null {
  try {
    const parsed = parseToml(content);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function getCodexProviderBaseUrl(
  parsedConfig: Record<string, unknown>,
  modelProvider: string | undefined,
): string | undefined {
  if (!modelProvider || !isRecord(parsedConfig.model_providers)) {
    return undefined;
  }
  const providerConfig = parsedConfig.model_providers[modelProvider];
  return isRecord(providerConfig) ? normalizeString(providerConfig.base_url) : undefined;
}

export function parseCodexCCSwitchSnapshot(options: {
  configToml: string;
  authJson?: string;
  configPath: string;
  authPath?: string;
}): CCSwitchSnapshot | null {
  const parsedConfig = getTomlRecord(options.configToml);
  if (!parsedConfig) {
    return null;
  }

  const model = normalizeString(parsedConfig.model);
  const modelProvider = normalizeString(parsedConfig.model_provider);
  const baseUrl = getCodexProviderBaseUrl(parsedConfig, modelProvider);
  let authSource: string | undefined;
  let accountId: string | undefined;
  let keyFingerprint: string | undefined;

  if (options.authJson) {
    try {
      const parsedAuth = JSON.parse(options.authJson);
      if (isRecord(parsedAuth)) {
        const apiKey = normalizeString(parsedAuth.OPENAI_API_KEY);
        authSource = apiKey ? 'OPENAI_API_KEY' : undefined;
        accountId = normalizeString(parsedAuth.account_id);
        keyFingerprint = fingerprint(apiKey)
          ?? fingerprint(normalizeString(parsedAuth.access_token))
          ?? fingerprint(normalizeString(parsedAuth.id_token));
      }
    } catch {
      // Ignore malformed auth; config still carries useful switch state.
    }
  }

  if (!model && !modelProvider && !baseUrl && !keyFingerprint && !accountId) {
    return null;
  }

  return withSnapshotHash({
    providerId: 'codex',
    model,
    modelProvider,
    baseUrl,
    authSource,
    accountId,
    keyFingerprint,
    sourcePaths: [options.configPath, ...(options.authPath ? [options.authPath] : [])],
  });
}

function readFileIfExists(filePath: string): string | undefined {
  try {
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : undefined;
  } catch {
    return undefined;
  }
}

export function readCCSwitchSnapshot(providerId: ProviderId, homeDir = os.homedir()): CCSwitchSnapshot | null {
  if (providerId === 'claude') {
    const settingsPath = path.join(homeDir, '.claude', 'settings.json');
    const content = readFileIfExists(settingsPath);
    return content ? parseClaudeCCSwitchSnapshot(content, settingsPath) : null;
  }

  if (providerId === 'codex') {
    const configPath = path.join(homeDir, '.codex', 'config.toml');
    const authPath = path.join(homeDir, '.codex', 'auth.json');
    const configToml = readFileIfExists(configPath);
    if (!configToml) {
      return null;
    }
    return parseCodexCCSwitchSnapshot({
      configToml,
      authJson: readFileIfExists(authPath),
      configPath,
      authPath: fs.existsSync(authPath) ? authPath : undefined,
    });
  }

  return null;
}

export function getStoredCCSwitchSnapshot(
  settings: Record<string, unknown>,
  providerId: ProviderId,
): CCSwitchSnapshot | null {
  const config = getProviderConfig(settings, providerId);
  return isRecord(config.ccSwitchSnapshot)
    ? config.ccSwitchSnapshot as unknown as CCSwitchSnapshot
    : null;
}

export function isFollowingCCSwitch(
  settings: Record<string, unknown>,
  providerId: ProviderId,
): boolean {
  const config = getProviderConfig(settings, providerId);
  return config.followCCSwitch === true;
}

export function getActiveCCSwitchSnapshot(
  settings: Record<string, unknown>,
  providerId: ProviderId,
): CCSwitchSnapshot | null {
  if (!isFollowingCCSwitch(settings, providerId)) {
    return null;
  }
  return getStoredCCSwitchSnapshot(settings, providerId);
}

export function syncProviderCCSwitchSnapshot(
  settings: Record<string, unknown>,
  providerId: ProviderId,
  homeDir?: string,
): { changed: boolean; snapshot: CCSwitchSnapshot | null } {
  if (!isFollowingCCSwitch(settings, providerId)) {
    return { changed: false, snapshot: null };
  }

  const current = getStoredCCSwitchSnapshot(settings, providerId);
  if (current && (!current.sourcePaths || current.sourcePaths.length === 0)) {
    return { changed: false, snapshot: current };
  }
  const next = readCCSwitchSnapshot(providerId, homeDir);
  const currentHash = current?.configHash ?? getCCSwitchSnapshotHash(current);
  const nextHash = next?.configHash ?? getCCSwitchSnapshotHash(next);
  if (currentHash === nextHash) {
    return { changed: false, snapshot: current };
  }

  setProviderConfig(settings, providerId, {
    ...getProviderConfig(settings, providerId),
    ccSwitchSnapshot: next ?? undefined,
  });
  return { changed: true, snapshot: next };
}
