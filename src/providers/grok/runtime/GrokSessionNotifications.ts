import type { AcpSessionNotification } from '../../acp';

export const GROK_SESSION_UPDATE_NOTIFICATION_METHODS = [
  'x.ai/session/update',
  '_x.ai/session/update',
] as const;

export const GROK_WRAPPED_SESSION_NOTIFICATION_METHOD = '_x.ai/session_notification';

const GROK_WRAPPED_SESSION_NOTIFICATION_NAME = 'x.ai/session_notification';

export function parseGrokSessionNotification(
  method: string,
  params: unknown,
): AcpSessionNotification | null {
  if (GROK_SESSION_UPDATE_NOTIFICATION_METHODS.some(candidate => candidate === method)) {
    return parseSessionNotification(params);
  }
  if (method !== GROK_WRAPPED_SESSION_NOTIFICATION_METHOD || !isRecord(params)) {
    return null;
  }
  if (params.method !== GROK_WRAPPED_SESSION_NOTIFICATION_NAME) {
    return null;
  }
  return parseSessionNotification(params.params);
}

function parseSessionNotification(value: unknown): AcpSessionNotification | null {
  if (!isRecord(value) || !isRecord(value.update)) {
    return null;
  }
  if (typeof value.sessionId !== 'string' || !value.sessionId.trim()) {
    return null;
  }
  return value as unknown as AcpSessionNotification;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
