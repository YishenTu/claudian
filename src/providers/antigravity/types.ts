import type { ForkSource } from '@/core/types';

export type AntigravityAuthMethod =
  | 'oauth-personal'
  | 'gemini-api-key'
  | 'oauth-business'
  | 'agent-platform';

export type AntigravityPermissionMode = 'default' | 'auto_edit' | 'yolo';

export interface AntigravityDiscoveredModel {
  description?: string;
  label: string;
  rawId: string;
}

export interface AntigravityProviderSettings {
  enabled: boolean;
  cliPath: string;
  environmentHash: string;
  environmentVariables: string;
  cliPathsByHost: Record<string, string>;
  authMethod: AntigravityAuthMethod;
  geminiApiKey: string;
  selectedModel: string;
  visibleModels: string[];
  discoveredModels: AntigravityDiscoveredModel[];
  permissionMode: AntigravityPermissionMode;
  serverArguments: string;
  debugLogging: boolean;
  autoDownload: boolean;
}

export interface AntigravityProviderState extends Record<string, unknown> {
  sessionId?: string;
  forkSource?: ForkSource;
  nativeConversationContextEstablished?: boolean;
  currentModeId?: string;
  currentModelId?: string;
}

export function getAntigravityState(
  providerState?: unknown,
): AntigravityProviderState {
  if (
    providerState === null
    || typeof providerState !== 'object'
    || Array.isArray(providerState)
  ) {
    return {};
  }

  const record = providerState as Record<string, unknown>;
  const parsed: AntigravityProviderState = {};

  if (typeof record.sessionId === 'string' && record.sessionId.trim()) {
    parsed.sessionId = record.sessionId.trim();
  }
  if (typeof record.nativeConversationContextEstablished === 'boolean') {
    parsed.nativeConversationContextEstablished =
      record.nativeConversationContextEstablished;
  }
  if (typeof record.currentModeId === 'string' && record.currentModeId.trim()) {
    parsed.currentModeId = record.currentModeId.trim();
  }
  if (typeof record.currentModelId === 'string' && record.currentModelId.trim()) {
    parsed.currentModelId = record.currentModelId.trim();
  }
  const fork = record.forkSource;
  if (fork && typeof fork === 'object' && !Array.isArray(fork)) {
    const { sessionId, resumeAt } = fork as Record<string, unknown>;
    if (typeof sessionId === 'string' && sessionId.trim() && typeof resumeAt === 'string' && resumeAt.trim()) {
      parsed.forkSource = { sessionId, resumeAt };
    }
  }

  return parsed;
}
