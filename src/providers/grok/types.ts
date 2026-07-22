import * as path from 'path';

export interface GrokProviderState {
  forkSource?: GrokForkSource;
  forkSourceSessionDirectory?: string;
  sessionDirectory?: string;
}

export interface GrokForkSource {
  resumeAt: string;
  sessionId: string;
}

export function parseGrokProviderState(value: unknown): GrokProviderState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const record = value as Record<string, unknown>;
  const forkSource = parseForkSource(record.forkSource);
  const forkSourceSessionDirectory = parseAbsolutePath(record.forkSourceSessionDirectory);
  const sessionDirectory = parseAbsolutePath(record.sessionDirectory);
  return {
    ...(forkSource ? { forkSource } : {}),
    ...(forkSourceSessionDirectory ? { forkSourceSessionDirectory } : {}),
    ...(sessionDirectory ? { sessionDirectory } : {}),
  };
}

export function buildGrokProviderState(
  sessionDirectory?: string | null,
): GrokProviderState | undefined {
  return buildPersistedGrokProviderState({ sessionDirectory: sessionDirectory ?? undefined });
}

export function buildPersistedGrokProviderState(
  state: GrokProviderState,
): GrokProviderState | undefined {
  const persisted = parseGrokProviderState(state);
  return Object.keys(persisted).length > 0 ? persisted : undefined;
}

function parseForkSource(value: unknown): GrokForkSource | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const sessionId = normalizeOpaqueString(record.sessionId);
  const resumeAt = normalizeOpaqueString(record.resumeAt);
  return sessionId && resumeAt ? { resumeAt, sessionId } : undefined;
}

function parseAbsolutePath(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return isAbsolutePath(normalized) ? normalized : undefined;
}

function normalizeOpaqueString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isAbsolutePath(value: string): boolean {
  return Boolean(value) && (path.posix.isAbsolute(value) || path.win32.isAbsolute(value));
}
