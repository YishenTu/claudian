import type { ProviderSessionEvent } from '@/core/execution';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import type { ChatExecutionEventContext } from '@/features/chat/execution/ChatExecutionCoordinator';
import { SessionEvents } from '@/features/chat/sessions/SessionEvents';
import { updateTabPermissionMode } from '@/features/chat/tabs/tabProviderUI';
import type { AssembledTabRuntime } from '@/features/chat/tabs/types';

const eventsBySession = new WeakMap<object, SessionEvents>();

/** Controller-level fixture assembly; production constructs SessionEvents in SessionModel. */
export function enqueueTabSessionEvent(
  tab: AssembledTabRuntime,
  plugin: ChatFeatureHost,
  event: ProviderSessionEvent,
  context: ChatExecutionEventContext,
): Promise<void> | undefined {
  const session = tab.session.runtime;
  let events = eventsBySession.get(session);
  if (!events) {
    events = new SessionEvents({
    session,
    state: tab.state,
    renderer: tab.renderer,
    stream: tab.controllers.streamController,
    executionCoordinator: tab.executionCoordinator,
    persistence: tab.controllers.conversationController,
    createMessageId: createTabMessageId,
    captureReviewableSettlement: tab.captureReviewableSettlement,
    updatePermissionMode: mode => updateTabPermissionMode(tab, plugin, mode),
    receiveSuggestion: (turnId, suggestion) => {
      if (!tab.dom.contentEl.hasClass('claudian-hidden')) tab.ui.promptSuggestion.receive(turnId, suggestion);
    },
    discardSuggestion: () => tab.ui.promptSuggestion.discard(),
    canAcceptBackgroundWork: () => canAcceptTabBackgroundWork(tab),
    claimBackgroundUserMessage: (nativeUserMessageId, inputId) => tab.controllers.inputController?.claimBackgroundUserMessage(nativeUserMessageId, inputId),
  });
    eventsBySession.set(session, events);
  }
  return events.enqueue(event, context);
}

function canAcceptTabBackgroundWork(tab: AssembledTabRuntime): boolean {
  return tab.lifecycleState !== 'closing';
}

export function createTabMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}
