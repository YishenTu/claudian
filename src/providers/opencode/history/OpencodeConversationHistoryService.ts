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
import { isSamePath } from '../../../core/storage/pathContainment';
import type { ChatMessage } from '../../../core/types';
import { isRecord } from '../http/OpencodeHTTPClient';
import { readOpencodeHTTPMessages } from '../http/OpencodeHTTPHistory';
import { type OpencodeServerLease, type OpencodeServerService, withOpencodeServerLease } from '../http/OpencodeServerService';
import { encodeOpencodeModelId } from '../models';
import { OpencodeCLIResolver } from '../runtime/OpencodeCLIResolver';
import { buildOpencodeRuntimeEnv } from '../runtime/OpencodeRuntimeEnvironment';
import {
  clearOpencodeResumeState,
  getOpencodeState,
  type OpencodePreviousSession,
  type OpencodeProviderState,
} from '../types';
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
  'previousSessions',
] as const;

export class OpencodeConversationHistoryService implements ProviderConversationHistoryService {
  constructor(private readonly getServerService?: (context?: ProviderHistoryPathContext) => Promise<OpencodeServerService | null | undefined>) {}

  hasConversationModelRecoverySource(conversation: ProviderHistoryInput): boolean {
    return !!this.#resolveModelRecoverySession(conversation);
  }

  async recoverConversationModelSelection(
    conversation: ProviderHistoryInput,
    vaultPath: string | null,
    pathContext?: ProviderHistoryPathContext,
  ): Promise<string | null> {
    const source = this.#resolveModelRecoverySession(conversation);
    if (!source) return null;
    const { sessionId, current, ...state } = source;
    const databasePath = current
      ? resolveHistoryDatabase(state, pathContext)
      : resolvePreviousSessionDatabase(state, pathContext);
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
    const databasePath = resolveHistoryDatabase(state, pathContext);
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
    // Retired sessions are history only; an unreadable one must not hide the rest.
    const previousMessages: ChatMessage[] = [];
    for (const previous of state.previousSessions ?? []) {
      const previousDatabase = resolvePreviousSessionDatabase(previous, pathContext);
      if (!previousDatabase) continue;
      const messages = await this.#readSessionMessages(
        previous.sessionId,
        previous.nativeVersion,
        previousDatabase,
        vaultPath,
        pathContext,
      );
      // Native checkpoints in retired sessions are unreachable, so they cannot fork or rewind.
      if (!isSessionHydrationFailure(messages)) previousMessages.push(...messages.map(withoutNativeCheckpoints));
    }
    const currentMessages = sessionId
      ? await this.#readSessionMessages(sessionId, state.nativeVersion, databasePath, vaultPath, pathContext)
      : [];
    const messages = [...previousMessages, ...currentMessages];
    if (messages.length === 0) {
      return conversation;
    }

    conversation.messages = messages;
    // Only the current session's own history proves its native context.
    if (currentMessages.length === 0 || isSessionHydrationFailure(currentMessages)) {
      return conversation;
    }
    // Record the trusted database that holds the binding so a later retirement keeps it.
    if (!state.databasePath && databasePath && databasePath !== ':memory:') {
      conversation.providerState = { ...conversation.providerState, databasePath };
    }

    this.#markNativeConversationContextEstablished(conversation);
    return conversation;
  }

  async #readSessionMessages(
    sessionId: string,
    nativeVersion: 1 | 2 | undefined,
    databasePath: string | null,
    vaultPath: string | null,
    pathContext: ProviderHistoryPathContext | undefined,
  ): Promise<ChatMessage[]> {
    if (nativeVersion !== 2) {
      return loadOpencodeSessionMessages(
        sessionId,
        { databasePath: databasePath ?? undefined, nativeVersion },
        pathContext?.environment,
      );
    }
    return this.withHttp(databasePath, vaultPath, pathContext, async client => {
      const read = async (id: string) => mapOpencodeV2NativeMessages(
        await readOpencodeHTTPMessages(client, id), { sessionId: id, databasePath: databasePath ?? undefined },
      );
      const messages = await read(sessionId);
      await hydrateOpencodeV2Subagents(messages, read);
      return messages;
    }).catch(error => [createOpencodeHydrationDiagnosticMessage({ sessionId, databasePath: databasePath ?? undefined, reason: error instanceof Error ? error.message : String(error) })]);
  }

  /** The latest session is authoritative; an older segment never stands in for it. */
  #resolveModelRecoverySession(
    conversation: ProviderHistoryInput,
  ): (OpencodePreviousSession & { current: boolean }) | null {
    const state = getOpencodeState(conversation.providerState);
    const sessionId = this.resolveSessionIdForConversation(conversation);
    if (sessionId) {
      return {
        current: true,
        sessionId,
        ...(state.databasePath ? { databasePath: state.databasePath } : {}),
        ...(state.nativeVersion ? { nativeVersion: state.nativeVersion } : {}),
      };
    }
    const previous = state.previousSessions?.at(-1);
    return previous ? { ...previous, current: false } : null;
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

    clearOpencodeResumeState(conversation, { releaseDatabase: false });
    return { outcome: 'reset', changes: conversation };
  }

  /** Only the live binding; `previousSessions` are recovery-only and never resume or fork. */
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
    options?: { lifecycle: 'persistent' | 'ephemeral' },
  ): Promise<Record<string, unknown>> {
    const cwd = vaultPath ?? pathContext?.vaultPath;
    if (!cwd) throw new Error('OpenCode fork requires a workspace directory.');
    const source = getOpencodeState(sourceProviderState);
    const databasePath = resolveHistoryDatabase(source, pathContext);
    if (!databasePath || databasePath === ':memory:') {
      throw new Error('OpenCode fork requires a persistent native database.');
    }
    // Earlier native sessions stay history-only in the fork; the fork source is always the live session.
    const previousSessions = source.previousSessions?.length
      ? { previousSessions: source.previousSessions.map(previous => ({ ...previous })) }
      : {};
    if (options?.lifecycle === 'ephemeral' && source.nativeVersion === 2) {
      return { databasePath, nativeVersion: 2, forkSource: { sessionId: sourceSessionId, resumeAt }, nativeConversationContextEstablished: true, ...previousSessions };
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
      resolveServerService: async () => this.getServerService?.(pathContext),
    });
    return { sessionId, databasePath, ...(nativeVersion ? { nativeVersion } : {}), nativeConversationContextEstablished: true, ...previousSessions };
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
      ...(state.previousSessions ? { previousSessions: state.previousSessions } : {}),
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
    return withOpencodeServerLease(await this.getServerService?.(pathContext), cliPath, cwd, environment, read);
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

function isSessionHydrationFailure(messages: readonly ChatMessage[]): boolean {
  return messages.length === 1 && isOpencodeSessionHydrationDiagnosticMessage(messages[0]);
}

function withoutNativeCheckpoints(message: ChatMessage): ChatMessage {
  const { assistantMessageId: _assistant, userMessageId: _user, ...rest } = message;
  return rest;
}

/**
 * A retired session with a recorded database is read only from that database,
 * never redirected. Without one, the current database is read; native session
 * ids are unique, so a session missing there reads as empty and is skipped.
 */
function resolvePreviousSessionDatabase(
  previous: Pick<OpencodePreviousSession, 'databasePath' | 'nativeVersion'>,
  context?: ProviderHistoryPathContext,
): string | null {
  const resolved = resolveHistoryDatabase(previous, context);
  if (!resolved || resolved === ':memory:') return null;
  return !previous.databasePath || isSamePath(resolved, previous.databasePath) ? resolved : null;
}

function resolveHistoryDatabase(
  state: Pick<OpencodeProviderState, 'databasePath' | 'nativeVersion'>,
  context?: ProviderHistoryPathContext,
): string | null {
  // A v2 database is part of the native binding, not a relocatable history hint.
  if (state.nativeVersion === 2 && state.databasePath) return state.databasePath;
  return resolveOpencodeDatabasePathHint(state.databasePath, context);
}
