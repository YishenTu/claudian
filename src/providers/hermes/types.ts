export interface HermesProviderState {
  sessionId?: string;
  sessionFile?: string;
  forkSource?: {
    resumeAt: string;
    sessionId: string;
  };
}

export function getHermesProviderState(
  providerState?: Record<string, unknown>,
): HermesProviderState {
  if (!providerState || typeof providerState !== 'object') {
    return {};
  }

  const sessionId = typeof providerState.sessionId === 'string'
    ? providerState.sessionId
    : undefined;
  const sessionFile = typeof providerState.sessionFile === 'string'
    ? providerState.sessionFile
    : undefined;
  const forkSource = extractForkSource(providerState.forkSource);

  const result: HermesProviderState = {};
  if (sessionId) {
    result.sessionId = sessionId;
  }
  if (sessionFile) {
    result.sessionFile = sessionFile;
  }
  if (forkSource) {
    result.forkSource = forkSource;
  }

  return result;
}

export function setHermesProviderState(
  state: HermesProviderState,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (state.sessionId !== undefined) {
    result.sessionId = state.sessionId;
  }
  if (state.sessionFile !== undefined) {
    result.sessionFile = state.sessionFile;
  }
  if (state.forkSource !== undefined) {
    result.forkSource = state.forkSource;
  }
  return result;
}

function extractForkSource(
  value: unknown,
): HermesProviderState['forkSource'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const sessionId = typeof record.sessionId === 'string' ? record.sessionId : '';
  const resumeAt = typeof record.resumeAt === 'string' ? record.resumeAt : '';

  return sessionId && resumeAt ? { resumeAt, sessionId } : undefined;
}
