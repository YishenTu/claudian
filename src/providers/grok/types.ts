import * as path from 'path';

import type { Conversation } from '@/core/types';

export interface GrokProviderState {
  /** The observed Linux store to which this native resume binding belongs. */
  sessionStoreKey?: string;
  historySessionId?: string;
  historyResumeAt?: string;
  forkSource?: GrokForkSource;
  forkSourceSessionDirectory?: string;
  nativeConversationContextEstablished?: boolean;
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
  const nativeConversationContextEstablished = typeof record.nativeConversationContextEstablished
    === 'boolean'
    ? record.nativeConversationContextEstablished
    : undefined;
  const sessionDirectory = parseAbsolutePath(record.sessionDirectory);
  return {
    ...(normalizeOpaqueString(record.sessionStoreKey) ? { sessionStoreKey: normalizeOpaqueString(record.sessionStoreKey) } : {}),
    ...(normalizeOpaqueString(record.historySessionId) ? { historySessionId: normalizeOpaqueString(record.historySessionId) } : {}),
    ...(normalizeOpaqueString(record.historyResumeAt) ? { historyResumeAt: normalizeOpaqueString(record.historyResumeAt) } : {}),
    ...(forkSource ? { forkSource } : {}),
    ...(forkSourceSessionDirectory ? { forkSourceSessionDirectory } : {}),
    ...(nativeConversationContextEstablished !== undefined
      ? { nativeConversationContextEstablished }
      : {}),
    ...(sessionDirectory ? { sessionDirectory } : {}),
  };
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

/** Preserve a recovery-only history locator; it must never become a resume seed. */
export function clearGrokResumeState(conversation: Pick<Conversation, 'sessionId' | 'providerState'>): boolean {
  const state = parseGrokProviderState(conversation.providerState);
  const sessionId = conversation.sessionId ?? state.forkSource?.sessionId;
  if (!sessionId) return false;
  const next: Record<string, unknown> = { ...conversation.providerState, historySessionId: sessionId, nativeConversationContextEstablished: false };
  if (state.forkSource) {
    Object.assign(next, { historyResumeAt: state.forkSource.resumeAt, sessionDirectory: state.forkSourceSessionDirectory });
  }
  delete next.sessionStoreKey;
  delete next.forkSource;
  delete next.forkSourceSessionDirectory;
  conversation.sessionId = null;
  conversation.providerState = next;
  return true;
}
