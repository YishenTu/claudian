import { Notice } from 'obsidian';

import type {
  ProviderSessionEvent,
} from '@/core/execution';
import type { ChatMessage, SubagentInfo } from '@/core/types';
import type { ConversationController } from '@/features/chat/conversation/ConversationController';
import type { ChatExecutionCoordinator, ChatExecutionEventContext } from '@/features/chat/execution/ChatExecutionCoordinator';
import type { ChatSessionRuntime } from '@/features/chat/sessions/ChatSessionRuntime';
import type { TabReviewOutcome } from '@/features/chat/state/types';
import { BackgroundResponses } from '@/features/chat/turns/BackgroundResponses';
import type { BackgroundTurnRenderHost } from '@/features/chat/turns/BackgroundTurnRenderer';
import { renderSessionTaskNotification } from '@/features/chat/turns/BackgroundTurnRenderer';
import type { ProviderEchoClaim } from '@/features/chat/turns/TurnSteering';
import { toError } from '@/utils/error';

export interface SessionEventsHost extends BackgroundTurnRenderHost {
  readonly session: ChatSessionRuntime;
  readonly executionCoordinator: ChatExecutionCoordinator;
  readonly persistence: Pick<ConversationController, 'save' | 'scheduleProgressSave'>;
  captureReviewableSettlement?: ((outcome: TabReviewOutcome) => () => void) | null;
  updatePermissionMode(mode: string): Promise<void>;
  receiveSuggestion(turnId: string, suggestion: string): void;
  discardSuggestion(): void;
  canAcceptBackgroundWork(): boolean;
  /** Captures submitted display input before a late steering acknowledgement releases its correlation. */
  claimBackgroundUserMessage?(nativeUserMessageId: string | undefined, inputId?: string): ProviderEchoClaim | undefined;
}

/** Session event ordering and background response ownership, independent of tab membership. */
export class SessionEvents {
  private readonly responses: BackgroundResponses;

  constructor(private readonly host: SessionEventsHost) {
    this.responses = new BackgroundResponses(host);
  }

  private async handle(
    event: ProviderSessionEvent,
    context: ChatExecutionEventContext,
    isCurrent: () => boolean,
  ): Promise<void> {
    const host = this.host;
    if (!isCurrent()) return;
    if (event.type === 'task_notification' && event.scope.kind === 'session') {
      renderSessionTaskNotification({
        state: host.state, renderer: host.renderer,
        createMessageId: () => host.createMessageId(),
      }, event.content, event.afterRequestedEvent, event.afterBackgroundEvent);
      await host.persistence.save(false);
      return;
    }
    if (event.type === 'permission_mode_changed') {
      await host.updatePermissionMode(event.permissionMode);
      return;
    }
    if (event.type === 'subagent_updated') {
      await host.persistence.save(true);
      return;
    }
    if (event.type === 'async_subagent_completed') {
      const providerSessionId = event.providerSessionId
        ?? host.executionCoordinator.snapshot?.providerSessionId;
      if (!providerSessionId) return;
      const applied = await host.stream.subagents.handleAsyncSubagentCompletion({
        type: 'async_subagent_completion',
        providerSessionId,
        taskId: event.subagentId,
        status: event.status,
        ...(event.result !== undefined ? { result: event.result } : {}),
      });
      if (applied && isCurrent()) {
        const reportReviewableSettlement = host.captureReviewableSettlement?.(event.status);
        try {
          await host.persistence.save(true);
        } finally {
          if (isCurrent()) reportReviewableSettlement?.();
        }
      }
      return;
    }
    if (event.type === 'session_error') {
      new Notice(event.message);
      return;
    }
    const hasVisibleOutput = await this.responses.handle(context.bindingId, event, isCurrent);
    if (hasVisibleOutput !== undefined && isCurrent()) {
      const reportReviewableSettlement = hasVisibleOutput ? host.captureReviewableSettlement?.('completed') : null;
      try {
        await host.persistence.save(true);
      } finally {
        if (isCurrent()) reportReviewableSettlement?.();
      }
    }
  }

  enqueue(
    event: ProviderSessionEvent,
    context: ChatExecutionEventContext,
  ): Promise<void> | undefined {
    const host = this.host;
    const coordinator = host.executionCoordinator;
    const isCurrent = () => (
      host.executionCoordinator === coordinator
      && coordinator.isEventContextCurrent(context)
    );
    if (!isCurrent()) {
      this.responses.discard(context.bindingId);
      return undefined;
    }

    if (!host.canAcceptBackgroundWork()) {
      this.responses.discard(context.bindingId);
      return undefined;
    }
    if (event.type === 'prompt_suggestion') {
      // Transient composer presentation never enters transcript rendering or persistence. A queued
      // turn can start after deactivation discarded, so arrival into a hidden tab is dropped here.
      host.receiveSuggestion(event.originatingTurnId, event.suggestion);
      return undefined;
    }
    // Display-only progress must not wait behind queued background rendering.
    if (event.type === 'subagent_updated') {
      const previousStatus = findSubagentStatus(host.state.messages, event.subagent.id);
      if (!host.stream.subagents.handleSubagentUpdate(event.subagent)) return undefined;
      // Lifecycle transitions persist in order below; same-status progress shares one trailing save.
      if (previousStatus === event.subagent.status) {
        return host.persistence.scheduleProgressSave(() => host.session.enqueueBackgroundWork(async () => {
          if (!isCurrent()) return;
          await host.persistence.save(true);
        }));
      }
    }
    if (event.type === 'subagent_progress') {
      host.stream.subagents.handleSubagentProgress(event.progress);
      return undefined;
    }
    if (event.type === 'background_turn_started') {
      host.discardSuggestion();
      this.responses.reserve(context.bindingId, event.scope.turnId);
    }
    // Claim synchronously: the provider can acknowledge the steer immediately after emitting its user event.
    const user = event.type === 'user_message_started' && event.scope.kind === 'background' ? event : undefined;
    const claim = user ? host.claimBackgroundUserMessage?.(user.nativeUserMessageId, user.inputId) : undefined;
    if (user) this.responses.userMessage(context.bindingId, user, claim?.expected);
    const pending = host.session.enqueueBackgroundWork(async () => {
      if (!isCurrent()) {
        this.responses.discard(context.bindingId);
        return;
      }
      const acceptanceError = claim ? await claim.acceptance : undefined;
      try { await this.handle(event, context, isCurrent); }
      finally { claim?.settle(); }
      if (acceptanceError) throw toError(acceptanceError, 'Provider user message failed');
    }, event.type === 'task_notification' && event.scope.kind === 'session');
    if (!pending) {
      this.responses.discard(context.bindingId);
    }
    return pending ?? undefined;
  }
}

function findSubagentStatus(
  messages: readonly ChatMessage[],
  id: string,
): SubagentInfo['status'] | undefined {
  for (const message of messages) {
    const tool = message.toolCalls?.find(candidate => candidate.id === id);
    if (tool) return tool.subagent?.status;
  }
  return undefined;
}
