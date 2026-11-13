import { createExecutionPathMapper } from '@/core/process/execution-target/WSLPathMapper';
import { copyProviderHistoryState } from '@/core/providers/providerHistory';

import { mergePersistedProviderState } from '../../../core/providers/providerState';
import type {
  ProviderConversationHistoryService,
  ProviderHistoryEnvironment,
  ProviderHistoryInput,
  ProviderHistoryPathContext,
  ProviderHistoryUpdate,
} from '../../../core/providers/types';
import {
  buildPersistedGrokProviderState,
  parseGrokProviderState,
} from '../types';
import { resolveGrokHistoryEnvironment } from './GrokHistoryEnvironment';
import { resolveGrokSessionDirectory } from './GrokHistoryPathResolver';
import { loadGrokHistory, readGrokHistoryRevision } from './GrokHistoryStore';

const GROK_PROVIDER_STATE_KEYS = [
  'sessionStoreKey',
  'historySessionId',
  'historyResumeAt',
  'forkSource',
  'forkSourceSessionDirectory',
  'nativeConversationContextEstablished',
  'sessionDirectory',
] as const;

export class GrokConversationHistoryService implements ProviderConversationHistoryService {

  async hydrateConversationHistory(
    input: ProviderHistoryInput,
    vaultPath: string | null,
    pathContext?: ProviderHistoryEnvironment & Partial<ProviderHistoryPathContext>,
  ): Promise<ProviderHistoryUpdate> {
    const historyContext = pathContext ? await resolveGrokHistoryEnvironment({ ...pathContext, vaultPath }) : undefined;
    const pathMapper = historyContext?.target ? createExecutionPathMapper(historyContext.target) : undefined;
    const conversation = copyProviderHistoryState(input);
    const state = parseGrokProviderState(conversation.providerState);
    if (this.isPendingForkConversation(conversation)) {
      if (!pathContext) {
        return conversation;
      }
      const forkSource = state.forkSource!;
      const sourceSessionDirectory = resolveGrokSessionDirectory(
        state.forkSourceSessionDirectory,
        forkSource.sessionId,
        vaultPath,
        historyContext!,
      );
      if (sourceSessionDirectory && sourceSessionDirectory !== state.forkSourceSessionDirectory) {
        conversation.providerState = mergePersistedProviderState(
          conversation.providerState,
          GROK_PROVIDER_STATE_KEYS,
          buildPersistedGrokProviderState({
            ...state,
            forkSourceSessionDirectory: sourceSessionDirectory,
          }) as Record<string, unknown> | undefined,
        );
      }
      if (conversation.messages.length > 0) return conversation;
      if (!sourceSessionDirectory) {
        return conversation;
      }
      const parsed = await loadGrokHistory(
        sourceSessionDirectory,
        forkSource.sessionId,
        forkSource.resumeAt,
        pathMapper,
      );
      if (parsed.messages.length === 0) {
        return conversation;
      }
      conversation.messages = parsed.messages;
      return conversation;
    }

    const sessionId = conversation.sessionId ?? state.historySessionId;
    if (!sessionId || !pathContext) {
      return conversation;
    }
    const sessionDirectory = resolveGrokSessionDirectory(
      state.sessionDirectory,
      sessionId,
      vaultPath,
      historyContext!,
    );
    // An unresolved locator stays recorded: history reads never change the binding.
    if (sessionDirectory && sessionDirectory !== state.sessionDirectory) {
      conversation.providerState = mergePersistedProviderState(
        conversation.providerState,
        GROK_PROVIDER_STATE_KEYS,
        buildPersistedGrokProviderState({
          ...state,
          sessionDirectory,
        }) as Record<string, unknown> | undefined,
      );
    }
    if (!sessionDirectory) {
      return conversation;
    }


    const parsed = await loadGrokHistory(sessionDirectory, sessionId, conversation.sessionId ? undefined : state.historyResumeAt, pathMapper);
    if (parsed.messages.length === 0) {
      return conversation;
    }
    conversation.messages = parsed.messages;
    const hydratedState = parseGrokProviderState(conversation.providerState);
    if (conversation.sessionId && hydratedState.nativeConversationContextEstablished === false) {
      conversation.providerState = mergePersistedProviderState(
        conversation.providerState,
        GROK_PROVIDER_STATE_KEYS,
        buildPersistedGrokProviderState({
          ...hydratedState,
          nativeConversationContextEstablished: true,
        }) as Record<string, unknown> | undefined,
      );
    }
    return conversation;
  }

  async readNativeHistoryRevision(
    conversation: ProviderHistoryInput,
    vaultPath: string | null,
    pathContext?: ProviderHistoryEnvironment & Partial<ProviderHistoryPathContext>,
  ): Promise<string | null> {
    // Only the live session is observed; retired locators and pending forks have frozen history.
    if (!conversation.sessionId || !pathContext) return null;
    try {
      const sessionDirectory = resolveGrokSessionDirectory(
        parseGrokProviderState(conversation.providerState).sessionDirectory,
        conversation.sessionId,
        vaultPath,
        await resolveGrokHistoryEnvironment({ ...pathContext, vaultPath }),
      );
      return sessionDirectory ? await readGrokHistoryRevision(sessionDirectory) : null;
    } catch {
      return null;
    }
  }

  resolveSessionIdForConversation(conversation: ProviderHistoryInput | null): string | null {
    const state = parseGrokProviderState(conversation?.providerState);
    return conversation?.sessionId ?? state.forkSource?.sessionId ?? null;
  }

  isPendingForkConversation(conversation: ProviderHistoryInput): boolean {
    const state = parseGrokProviderState(conversation.providerState);
    return Boolean(state.forkSource && !conversation.sessionId);
  }

  buildForkProviderState(
    sourceSessionId: string,
    resumeAt: string,
    sourceProviderState?: Record<string, unknown>,
  ): Record<string, unknown> {
    const sourceState = parseGrokProviderState(sourceProviderState);
    return (buildPersistedGrokProviderState({
      forkSource: { resumeAt, sessionId: sourceSessionId },
      ...(sourceState.sessionDirectory || sourceState.forkSourceSessionDirectory
        ? {
          forkSourceSessionDirectory: sourceState.sessionDirectory
            ?? sourceState.forkSourceSessionDirectory,
        }
        : {}),
    }) as Record<string, unknown> | undefined) ?? {};
  }

  buildPersistedProviderState(
    conversation: ProviderHistoryInput,
  ): Record<string, unknown> | undefined {
    return mergePersistedProviderState(
      conversation.providerState,
      GROK_PROVIDER_STATE_KEYS,
      buildPersistedGrokProviderState(
        parseGrokProviderState(conversation.providerState),
      ) as Record<string, unknown> | undefined,
    );
  }
}
