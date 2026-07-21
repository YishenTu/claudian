import * as path from 'path';

export interface GrokProviderState {
  sessionDirectory?: string;
}

export function parseGrokProviderState(value: unknown): GrokProviderState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const sessionDirectory = (value as Record<string, unknown>).sessionDirectory;
  if (typeof sessionDirectory !== 'string') {
    return {};
  }

  const normalized = sessionDirectory.trim();
  return isAbsolutePath(normalized) ? { sessionDirectory: normalized } : {};
}

export function buildGrokProviderState(
  sessionDirectory?: string | null,
): GrokProviderState | undefined {
  const state = parseGrokProviderState({ sessionDirectory });
  return state.sessionDirectory ? state : undefined;
}

function isAbsolutePath(value: string): boolean {
  return Boolean(value) && (path.posix.isAbsolute(value) || path.win32.isAbsolute(value));
}
