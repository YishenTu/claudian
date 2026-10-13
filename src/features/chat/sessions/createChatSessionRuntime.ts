import { Notice } from 'obsidian';

import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import { ChatExecutionCoordinator } from '@/features/chat/execution/ChatExecutionCoordinator';
import { createInteractionPromptPort } from '@/features/chat/interactions/interactionPromptPort';
import { SessionMailbox } from '@/features/chat/session-messaging/SessionMailbox';
import { ChatSessionRuntime, type SessionIdentity } from '@/features/chat/sessions/ChatSessionRuntime';
import { createSessionMessageId, createSessionSideChat, SessionModel } from '@/features/chat/sessions/SessionModel';
import { t } from '@/i18n/i18n';
import { getVaultPath } from '@/utils/path';

/** Assembles a session without any tab, component, document, or window. */
export function createChatSessionRuntime(plugin: ChatFeatureHost, identity: SessionIdentity): ChatSessionRuntime {
  const coordinator = new ChatExecutionCoordinator({
    lifecycleRegistry: plugin.providerHost.executionLifecycleRegistry,
    resolveBackend: providerId => ProviderRegistry.createExecutionBackend(plugin.providerHost, providerId),
    persistence: plugin.executionPersistence,
    bindSessionTools: id => plugin.bindSessionTools?.(id),
    interactionPort: createInteractionPromptPort(() => runtime.model.inlinePrompts),
    vaultWorkingDirectory: getVaultPath(plugin.app) ?? '.',
    createId: createSessionMessageId,
    onRequestedEvent: (event, context) => {
      const model = runtime.model;
      if (event.type === 'turn_started') model.bindSuggestion(event.scope.turnId, () => coordinator.isEventContextCurrent(context));
      return model.inputController.handleExecutionEvent(event);
    },
    onSessionEvent: async (event, context) => {
      if (runtime.isDisposed || !coordinator.isEventContextCurrent(context)) return;
      const current = runtime.peekModel;
      if (current?.hydrationState === 'ready') {
        if (event.type === 'commands_changed') current.publish('commands');
        else await current.events.enqueue(event, context);
        return;
      }
      await runtime.withModel(async model => {
        if (runtime.isDisposed || !coordinator.isEventContextCurrent(context)) return;
        if (event.type === 'commands_changed') model.publish('commands');
        else await model.events.enqueue(event, context);
      });
    },
    onBackgroundWorkChanged: () => runtime.publish('work'),
    resolveMissingProviderSession: (id, nativeId) => plugin.handleMissingProviderSession(id, nativeId),
    onError: error => { new Notice(error instanceof Error ? error.message : 'Provider execution failed.'); },
    idleReleaseMs: 30 * 60_000,
    isOwnerIdle: () => runtime.isIdle,
    onIdleRelease: () => runtime.publish('commands'),
  });
  const runtime: ChatSessionRuntime = new ChatSessionRuntime(
    { ...identity }, coordinator, session => new SessionModel(session, plugin),
  );
  runtime.installMailbox(new SessionMailbox({
    runtime,
    isTargetAvailable: () => !!runtime.conversationId && plugin.getConversationList().some(
      record => record.id === runtime.conversationId && !record.isArchived,
    ),
    onDiscard: messages => {
      const senders = [...new Set(messages.map(message => message.from))].join(', ');
      new Notice(t('chat.sessionMessage.undelivered', { senders }));
    },
  }));
  runtime.installSideChat(createSessionSideChat(runtime, plugin));
  return runtime;
}
