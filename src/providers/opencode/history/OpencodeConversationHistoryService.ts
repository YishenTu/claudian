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
import type { ChatMessage } from '../../../core/types';
import { isRecord } from '../http/OpencodeHTTPClient';
import { readOpencodeHTTPMessages } from '../http/OpencodeHTTPHistory';
import { type OpencodeServerLease, type OpencodeServerService, withOpencodeServerLease } from '../http/OpencodeServerService';
import { encodeOpencodeModelId } from '../models';
import { type OpencodeBindingDatabase, resolveOpencodeBindingDatabase } from '../runtime/OpencodeBindingDatabase';
import { resolveOpencodeHistoryLaunch } from '../runtime/OpencodeCLILaunch';
import { OpencodeTargetEnvironment } from '../runtime/OpencodeExecutionTarget';
import {
  clearOpencodeResumeState,
  getOpencodeState,
  type OpencodePreviousSession,
  type OpencodeProviderState,
} from '../types';
import {
  createOpencodeHydrationDiagnosticMessage,
  isOpencodeSessionHydrationDiagnosticMessage,
  mapOpencodeNativeMessages,
} from './OpencodeHistoryStore';
import { forkOpencodeSession } from './OpencodeSessionFork';
import { hydrateOpencodeSubagents } from './OpencodeSubagentHistory';

export interface OpencodeConversationHistoryServiceOptions {
  readonly getServerService?: (context?: ProviderHistoryPathContext) => Promise<OpencodeServerService | null | undefined>;
}

const OPENCODE_PROVIDER_STATE_KEYS = [
  'databasePath',
  'sessionId',
  'nativeConversationContextEstablished',
  'previousSessions',
] as const;

export class OpencodeConversationHistoryService implements ProviderConversationHistoryService {
  constructor(private readonly options: OpencodeConversationHistoryServiceOptions = {}) {}

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
    try {
      const { sessionId, databasePath: recordedPath } = source;
      const databasePath = (await this.resolveBindingDatabase(recordedPath, vaultPath, pathContext)).accessible;
      if (!databasePath) return null;
      return await this.withHttp(databasePath, vaultPath, pathContext, async client => {
        const result = await client.request(`/api/session/${encodeURIComponent(sessionId)}`);
        const model = isRecord(result) && isRecord(result.data) && isRecord(result.data.model) ? result.data.model : null;
        return typeof model?.providerID === 'string' && typeof model.id === 'string'
          ? encodeOpencodeModelId(`${model.providerID}/${model.id}`) : null;
      });
    } catch { return null; }
  }

  async hydrateConversationHistory(
    input: ProviderHistoryInput,
    vaultPath: string | null,
    pathContext?: ProviderHistoryPathContext,
  ): Promise<ProviderHistoryUpdate> {
    const conversation = copyProviderHistoryState(input);
    const state = getOpencodeState(conversation.providerState);
    const sessionId = this.resolveSessionIdForConversation(conversation);
    if (!sessionId && !state.previousSessions?.length) return conversation;
    const database = await this.resolveBindingDatabase(state.databasePath, vaultPath, pathContext);
    // Retired sessions are history only; an unreadable one must not hide the rest.
    const previousMessages: ChatMessage[] = [];
    for (const previous of state.previousSessions ?? []) {
      const previousDatabase = await this.resolveBindingDatabase(previous.databasePath, vaultPath, pathContext);
      if (!previousDatabase.accessible) continue;
      const messages = await this.#readSessionMessages(previous.sessionId, previousDatabase, vaultPath, pathContext);
      // Native checkpoints in retired sessions are unreachable, so they cannot fork or rewind.
      if (!isSessionHydrationFailure(messages)) previousMessages.push(...messages.map(withoutNativeCheckpoints));
    }
    const currentMessages = sessionId
      ? await this.#readSessionMessages(sessionId, database, vaultPath, pathContext)
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
    // Record the trusted database that holds the binding so a runtime change keeps it there.
    if (!database.recorded && database.accessible && database.accessible !== ':memory:') {
      conversation.providerState = { ...conversation.providerState, databasePath: database.accessible };
    }

    this.#markNativeConversationContextEstablished(conversation);
    return conversation;
  }

  async #readSessionMessages(
    sessionId: string,
    database: OpencodeBindingDatabase,
    vaultPath: string | null,
    pathContext: ProviderHistoryPathContext | undefined,
  ): Promise<ChatMessage[]> {
    const databasePath = database.recorded ?? database.accessible ?? undefined;
    if (!database.accessible) {
      return [createOpencodeHydrationDiagnosticMessage({ sessionId, databasePath, reason: 'The recorded OpenCode database is not accessible with the current settings.' })];
    }
    return this.withHttp(database.accessible, vaultPath, pathContext, async client => {
      const read = async (id: string) => mapOpencodeNativeMessages(await readOpencodeHTTPMessages(client, id), client.target);
      const messages = await read(sessionId);
      await hydrateOpencodeSubagents(messages, read);
      return messages;
    }).catch(error => [createOpencodeHydrationDiagnosticMessage({ sessionId, databasePath, reason: error instanceof Error ? error.message : String(error) })]);
  }

  /** The latest session is authoritative; an older segment never stands in for it. */
  #resolveModelRecoverySession(
    conversation: ProviderHistoryInput,
  ): OpencodePreviousSession | null {
    const state = getOpencodeState(conversation.providerState);
    const sessionId = this.resolveSessionIdForConversation(conversation);
    if (sessionId) return { sessionId, ...(state.databasePath ? { databasePath: state.databasePath } : {}) };
    return state.previousSessions?.at(-1) ?? null;
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
    const databasePath = (await this.resolveBindingDatabase(source.databasePath, vaultPath, pathContext)).accessible;
    if (!databasePath || databasePath === ':memory:') {
      throw new Error('OpenCode fork requires a persistent native database.');
    }
    // Earlier native sessions stay history-only in the fork; the fork source is always the live session.
    const previousSessions = source.previousSessions?.length
      ? { previousSessions: source.previousSessions.map(previous => ({ ...previous })) }
      : {};
    if (options?.lifecycle === 'ephemeral') {
      return { databasePath, forkSource: { sessionId: sourceSessionId, resumeAt }, nativeConversationContextEstablished: true, ...previousSessions };
    }
    const { cliPath, target, environment: baseEnvironment } = await this.resolveLaunch(cwd, pathContext);
    const environment = { ...baseEnvironment, OPENCODE_DB: databasePath };
    const sessionId = await forkOpencodeSession({
      cliPath,
      target,
      cwd,
      environment,
      sourceSessionId,
      resumeAt,
      resolveServerService: async () => this.options.getServerService?.(pathContext),
    });
    return { sessionId, databasePath, nativeConversationContextEstablished: true, ...previousSessions };
  }

  buildPersistedProviderState(
    conversation: ProviderHistoryInput,
  ): Record<string, unknown> | undefined {
    const state = getOpencodeState(conversation.providerState);
    const providerState: OpencodeProviderState = {
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
    const { cliPath, target, environment: baseEnvironment } = await this.resolveLaunch(cwd, pathContext);
    const environment = { ...baseEnvironment, OPENCODE_DB: databasePath };
    return withOpencodeServerLease(await this.options.getServerService?.(pathContext), cliPath, cwd, environment, read, target);
  }

  private async resolveLaunch(cwd: string, context?: ProviderHistoryPathContext) {
    const launch = await resolveOpencodeHistoryLaunch(context, cwd);
    const service = await this.options.getServerService?.(context);
    const environment = await (service?.targetEnvironment ?? new OpencodeTargetEnvironment())
      .resolve(launch.target, cwd, launch.environmentText, launch.cliPath, context?.environment);
    return { ...launch, environment };
  }

  private async resolveBindingDatabase(recordedPath: string | undefined, vaultPath: string | null | undefined, context?: ProviderHistoryPathContext): Promise<OpencodeBindingDatabase> {
    const launch = await this.resolveLaunch(vaultPath ?? context?.vaultPath ?? process.cwd(), context);
    return resolveOpencodeBindingDatabase(recordedPath, launch.environment, launch.target);
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
