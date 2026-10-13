import type { ProviderSessionToolPort } from '@/core/execution';
import { findProviderModelOption, resolveNewConversationModel, resolveProviderDefaultModel } from '@/core/providers/conversationModel';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import type { SessionToolSendMessageArgs, SessionToolSendMessageResult, SessionToolSessionSummary } from '@/core/session-tools/sessionToolSpecs';
import type { ConversationMeta } from '@/core/types';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import { throwIfAborted } from '@/utils/abort';

export interface SessionToolBinding {
  readonly port: ProviderSessionToolPort;
  dispose(): void;
}

/** Owns caller-bound tool operations; recipient execution belongs to its session runtime. */
export class SessionMessagingService {
  private readonly shutdown = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();

  constructor(private readonly deps: {
    getHost(): ChatFeatureHost;
    getActiveConversationId(): string | null;
  }) {}

  bindSessionTools(conversationId: string): SessionToolBinding {
    const binding = new AbortController();
    const invoke = <T>(signal: AbortSignal, operation: (signal: AbortSignal) => Promise<T>): Promise<T> => {
      const combined = AbortSignal.any([signal, binding.signal, this.shutdown.signal]);
      const pending = Promise.resolve().then(() => {
        throwIfAborted(combined, 'Session tool call was cancelled');
        return operation(combined);
      });
      this.pending.add(pending);
      void pending.finally(() => this.pending.delete(pending)).catch(() => undefined);
      return pending;
    };
    return {
      port: {
        list: signal => invoke(signal, current => this.list(conversationId, current)),
        send: (args, signal) => invoke(signal, current => this.send(conversationId, args, current)),
      },
      dispose: () => binding.abort(new Error('The caller session binding was released')),
    };
  }

  beginShutdown(): void { this.shutdown.abort(new Error('Session messaging is shutting down')); }

  async dispose(): Promise<void> {
    this.beginShutdown();
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  private async resolve(id: string, signal: AbortSignal): Promise<ConversationMeta> {
    const host = this.deps.getHost();
    await host.ensureConversationMetadataLoaded([id]);
    throwIfAborted(signal, 'Session tool call was cancelled');
    const record = host.getConversationList().find(candidate => candidate.id === id && !candidate.isArchived);
    if (!record) throw new Error('The session does not exist or is archived');
    return record;
  }

  private async list(callerId: string, signal: AbortSignal): Promise<SessionToolSessionSummary[]> {
    await this.resolve(callerId, signal);
    const host = this.deps.getHost();
    const activeId = this.deps.getActiveConversationId();
    return host.getConversationList().filter(record => !record.isArchived).map(record => {
      const runtime = host.sessionRuntimes.get(record.id);
      return {
        sessionId: record.id,
        title: record.title,
        provider: record.providerId,
        status: runtime?.statusAttention?.kind === 'action-required' ? 'awaiting-user'
          : runtime?.isWorking ? 'running' : 'idle',
        active: record.id === activeId,
      };
    });
  }

  private async send(callerId: string, args: SessionToolSendMessageArgs, signal: AbortSignal): Promise<SessionToolSendMessageResult> {
    const caller = await this.resolve(callerId, signal);
    const host = this.deps.getHost();
    if (args.sessionId === callerId) throw new Error('A session cannot send a message to itself');
    let target: ConversationMeta;
    if (args.sessionId) {
      target = await this.resolve(args.sessionId, signal);
    } else {
      const settings = host.getCommittedSettings();
      const defaults = resolveNewConversationModel(settings);
      const providerId = args.provider ?? defaults?.providerId;
      if (!providerId || !ProviderRegistry.getRegisteredProviderIds().includes(providerId)
        || !ProviderRegistry.isEnabled(providerId, settings)) throw new Error('The requested provider is unavailable');
      const selectedModel = args.model
        ? findProviderModelOption(providerId, args.model, settings)
        : args.provider ? resolveProviderDefaultModel(providerId, settings) : defaults?.model;
      if (!selectedModel) throw new Error('The requested model is unavailable');
      throwIfAborted(signal, 'Session tool call was cancelled');
      // Creation publishes the shell. Cancellation after this point never rolls it back.
      const created = await host.createConversation({ providerId, selectedModel });
      throwIfAborted(signal, 'Session tool call was cancelled');
      target = await this.resolve(created.id, signal);
    }
    if (!host.sessionRuntimes.get(target.id)) {
      await host.sessionRuntimes.awaitConversationCreations();
      target = await this.resolve(target.id, signal);
    }
    throwIfAborted(signal, 'Session tool call was cancelled');
    const runtime = host.sessionRuntimes.ensure({ conversationId: target.id, providerId: target.providerId, draftModel: null });
    if (!runtime.mailbox) throw new Error('The target session cannot receive messages');
    const status = runtime.mailbox.admit({ from: caller.title, sessionId: caller.id, text: args.text });
    return { sessionId: target.id, status };
  }
}
