import * as path from 'path';

export interface KimiProviderState {
  sessionDirectory?: string;
}

export function getKimiState(
  providerState?: Record<string, unknown>,
): KimiProviderState {
  return parseKimiProviderState(providerState);
}

export function parseKimiProviderState(value: unknown): KimiProviderState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const record = value as Record<string, unknown>;
  const sessionDirectory = parseAbsolutePath(record.sessionDirectory);
  return sessionDirectory ? { sessionDirectory } : {};
}

export function buildKimiProviderState(
  sessionDirectory?: string | null,
): KimiProviderState | undefined {
  return buildPersistedKimiProviderState({ sessionDirectory: sessionDirectory ?? undefined });
}

export function buildPersistedKimiProviderState(
  state: KimiProviderState,
): KimiProviderState | undefined {
  const persisted = parseKimiProviderState(state);
  return Object.keys(persisted).length > 0 ? persisted : undefined;
}

function parseAbsolutePath(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return isAbsolutePath(normalized) ? normalized : undefined;
}

function isAbsolutePath(value: string): boolean {
  return Boolean(value) && (path.posix.isAbsolute(value) || path.win32.isAbsolute(value));
}
