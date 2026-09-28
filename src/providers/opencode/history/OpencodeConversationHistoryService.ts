import { copyProviderHistoryState } from '@/core/providers/providerHistory';

import { mergePersistedProviderState } from '../../../core/providers/providerState';
import type {
  ProviderConversationHistoryService,
  ProviderHistoryInput,
  ProviderHistoryPathContext,
  ProviderHistoryResult,
  ProviderHistoryState,
  ProviderHistoryUpdate,
} from '../../../core/providers/types';
import { isRecord } from '../http/OpencodeHTTPClient';
import { readOpencodeHTTPMessages } from '../http/OpencodeHTTPHistory';
import { type OpencodeServerLease, type OpencodeServerService, withOpencodeServerLease } from '../http/OpencodeServerService';
import { encodeOpencodeModelId } from '../models';
import { OpencodeCLIResolver } from '../runtime/OpencodeCLIResolver';
import { buildOpencodeRuntimeEnv } from '../runtime/OpencodeRuntimeEnvironment';
import { getOpencodeState, type OpencodeProviderState } from '../types';
import { resolveOpencodeDatabasePathHint } from './OpencodeHistoryPathResolver';
import {
  createOpencodeHydrationDiagnosticMessage,
  isOpencodeSessionHydrationDiagnosticMessage,
  loadOpencodeSessionMessages,
  loadOpencodeSessionModel,
  mapOpencodeV2NativeMessages,
} from './OpencodeHistoryStore';
import { forkOpencodeSession } from './OpencodeSessionFork';
import { hydrateOpencodeV2Subagents } from './OpencodeSubagentHistory';

const OPENCODE_PROVIDER_STATE_KEYS = [
  'databasePath',
  'nativeVersion',
  'sessionId',
  'nativeConversationContextEstablished',
] as const;

export class OpencodeConversationHistoryService implements ProviderConversationHistoryService {
  constructor(private readonly getServerService?: () => OpencodeServerService | null | undefined) {}

  hasConversationModelRecoverySource(conversation: ProviderHistoryInput): boolean {
    return !!this.resolveSessionIdForConversation(conversation);
  }

  async recoverConversationModelSelection(
    conversation: ProviderHistoryInput,
    vaultPath: string | null,
    pathContext?: ProviderHistoryPathContext,
  ): Promise<string | null> {
    const sessionId = this.resolveSessionIdForConversation(conversation);
    if (!sessionId) return null;
    const state = getOpencodeState(conversation.providerState);
    const databasePath = resolveOpencodeDatabasePathHint(state.databasePath, pathContext);
    if (!databasePath) return null;
    if (state.nativeVersion === 2) {
      return this.withHttp(databasePath, vaultPath, pathContext, async client => {
        const result = await client.request(`/api/session/${encodeURIComponent(sessionId)}`);
        const model = isRecord(result) && isRecord(result.data) && isRecord(result.data.model) ? result.data.model : null;
        return typeof model?.providerID === 'string' && typeof model.id === 'string'
          ? encodeOpencodeModelId(`${model.providerID}/${model.id}`) : null;
      }).catch(() => null);
    }
    return loadOpencodeSessionModel(sessionId, { databasePath, nativeVersion: state.nativeVersion }, pathContext?.environment);
  }

  async hydrateConversationHistory(
    input: ProviderHistoryInput,
    vaultPath: string | null,
    pathContext?: ProviderHistoryPathContext,
  ): Promise<ProviderHistoryUpdate> {
    const conversation = copyProviderHistoryState(input);
    const state = getOpencodeState(conversation.providerState);
    const databasePath = resolveOpencodeDatabasePathHint(state.databasePath, pathContext);
    if (state.databasePath && state.databasePath !== databasePath) {
      const providerState = { ...conversation.providerState };
      if (databasePath) {
        providerState.databasePath = databasePath;
      } else {
        delete providerState.databasePath;
      }
      conversation.providerState = Object.keys(providerState).length > 0
        ? providerState
        : undefined;
    }
    const sessionId = this.resolveSessionIdForConversation(conversation);
    if (!sessionId) {
      return conversation;
    }



    const messages = state.nativeVersion === 2
      ? await this.withHttp(databasePath, vaultPath, pathContext, async client => {
          const read = async (id: string) => mapOpencodeV2NativeMessages(
            await readOpencodeHTTPMessages(client, id), { sessionId: id, databasePath: databasePath ?? undefined },
          );
          const messages = await read(sessionId);
          await hydrateOpencodeV2Subagents(messages, read);
          return messages;
        }).catch(error => [createOpencodeHydrationDiagnosticMessage({ sessionId, databasePath: databasePath ?? undefined, reason: error instanceof Error ? error.message : String(error) })])
      : await loadOpencodeSessionMessages(
          sessionId,
          { databasePath: databasePath ?? undefined, nativeVersion: state.nativeVersion },
          pathContext?.environment,
        );
    if (messages.length === 0) {
      return conversation;
    }

    conversation.messages = messages;
    if (
      messages.length === 1
      && isOpencodeSessionHydrationDiagnosticMessage(messages[0])
    ) {
      return conversation;
    }

    this.#markNativeConversationContextEstablished(conversation);
    return conversation;
  }

  async resolveMissingConversationSession(
    input: ProviderHistoryInput,
    _vaultPath: string | null,
    missingProviderSessionId?: string,
  ): Promise<ProviderHistoryResult<'delete' | 'reset' | 'preserve'>> {
    const conversation = copyProviderHistoryState(input);
    if (
      !this.resolveSessionIdForConversation(conversation)
      || !missingProviderSessionId
      || this.resolveSessionIdForConversation(conversation) !== missingProviderSessionId
    ) {
      return { outcome: 'preserve' };
    }

    conversation.sessionId = null;
    conversation.providerState = {
      ...conversation.providerState,
      nativeConversationContextEstablished: false,
    };
    delete conversation.providerState.sessionId;
    return { outcome: 'reset', changes: conversation };
  }

  resolveSessionIdForConversation(conversation: ProviderHistoryInput | null): string | null {
    return conversation?.sessionId ?? getOpencodeState(conversation?.providerState).sessionId ?? null;
  }

  isPendingForkConversation(_conversation: ProviderHistoryInput): boolean {
    return false;
  }

  async buildForkProviderState(
    sourceSessionId: string,
    resumeAt: string,
    sourceProviderState?: Record<string, unknown>,
    vaultPath?: string | null,
    pathContext?: ProviderHistoryPathContext,
  ): Promise<Record<string, unknown>> {
    const cwd = vaultPath ?? pathContext?.vaultPath;
    if (!cwd) throw new Error('OpenCode fork requires a workspace directory.');
    const source = getOpencodeState(sourceProviderState);
    const databasePath = resolveOpencodeDatabasePathHint(source.databasePath, pathContext);
    if (!databasePath || databasePath === ':memory:') {
      throw new Error('OpenCode fork requires a persistent native database.');
    }
    const settings = pathContext?.settings ?? {};
    const cliPath = new OpencodeCLIResolver().resolveFromSettings(settings) ?? 'opencode';
    const environment = buildOpencodeRuntimeEnv(settings, cliPath, databasePath, pathContext?.environment);
    let nativeVersion = source.nativeVersion;
    const sessionId = await forkOpencodeSession({
      nativeVersion,
      onNativeVersion: (version) => { nativeVersion = version ?? nativeVersion; },
      cliPath,
      cwd,
      environment,
      sourceSessionId,
      resumeAt,
      serverService: this.getServerService?.(),
    });
    return { sessionId, databasePath, ...(nativeVersion ? { nativeVersion } : {}), nativeConversationContextEstablished: true };
  }

  buildPersistedProviderState(
    conversation: ProviderHistoryInput,
  ): Record<string, unknown> | undefined {
    const state = getOpencodeState(conversation.providerState);
    const providerState: OpencodeProviderState = {
      ...(state.nativeVersion ? { nativeVersion: state.nativeVersion } : {}),
      ...(state.sessionId ? { sessionId: state.sessionId } : {}),
      ...(state.databasePath ? { databasePath: state.databasePath } : {}),
      ...(typeof state.nativeConversationContextEstablished === 'boolean'
        ? {
            nativeConversationContextEstablished:
              state.nativeConversationContextEstablished,
          }
        : {}),
    };

    return mergePersistedProviderState(
      conversation.providerState,
      OPENCODE_PROVIDER_STATE_KEYS,
      providerState,
    );
  }

  private async withHttp<T>(databasePath: string | null, vaultPath: string | null, pathContext: ProviderHistoryPathContext | undefined, read: (client: OpencodeServerLease) => Promise<T>): Promise<T> {
    const cwd = vaultPath ?? pathContext?.vaultPath;
    if (!cwd || !databasePath || databasePath === ':memory:') throw new Error('OpenCode history requires a workspace and persistent native database.');
    const settings = pathContext?.settings ?? {};
    const cliPath = new OpencodeCLIResolver().resolveFromSettings(settings) ?? 'opencode';
    const environment = buildOpencodeRuntimeEnv(settings, cliPath, databasePath, pathContext?.environment);
    return withOpencodeServerLease(this.getServerService?.(), cliPath, cwd, environment, read);
  }

  #markNativeConversationContextEstablished(
    conversation: ProviderHistoryState,
  ): void {
    const state = getOpencodeState(conversation.providerState);
    if (state.nativeConversationContextEstablished !== false) return;
    conversation.providerState = {
      ...conversation.providerState,
      nativeConversationContextEstablished: true,
    };
  }
}
