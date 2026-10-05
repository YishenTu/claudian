import { Notice } from 'obsidian';

import type { ChatRewindConflict, ChatRewindMode } from '@/core/execution';
import { extractUserDisplayContent } from '@/core/prompt/promptContext';
import type { ChatMessage } from '@/core/types';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import type { ComposerDraftController } from '@/features/chat/composer/ComposerDraftController';
import { findRewindContext } from '@/features/chat/conversation/rewind';
import type { ChatExecutionCoordinator } from '@/features/chat/execution/ChatExecutionCoordinator';
import type { ChatState } from '@/features/chat/state/ChatState';
import { t } from '@/i18n/i18n';
import { confirm } from '@/shared/modals/ConfirmModal';

const MAX_REWIND_CONFLICT_PATHS = 5;

/** How a conversation save repositions the provider session. */
export type ConversationSaveOptions = {
  resumeAtMessageId?: string;
  resetProviderSession?: boolean;
};

export interface ConversationRewindDeps {
  plugin: Pick<ChatFeatureHost, 'app'>;
  state: ChatState;
  setRewinding(value: boolean): void;
  session: { readonly hasActiveTurn: boolean };
  drafts: Pick<ComposerDraftController, 'restore'>;
  getExecutionCoordinator: () => ChatExecutionCoordinator | null;
  ensureExecutionInitialized?: () => Promise<boolean>;
  isDisposed?: () => boolean;
  save: (updateLastActivity: boolean, options: ConversationSaveOptions) => Promise<void>;
  /** Re-renders the transcript and its welcome element after truncation. */
  renderTranscript: (messages: ChatMessage[]) => void;
}

function buildRewindConflictConfirmation(conflicts: readonly ChatRewindConflict[]): string {
  const visiblePaths = conflicts
    .slice(0, MAX_REWIND_CONFLICT_PATHS)
    .map(conflict => `- ${conflict.path}`);
  const omitted = conflicts.length - visiblePaths.length;
  if (omitted > 0) visiblePaths.push(`- +${omitted} more`);
  return t('chat.rewind.confirmMessageConflicts', {
    count: conflicts.length,
    files: visiblePaths.join('\n'),
  });
}

function failed(error: string): void {
  new Notice(t('chat.rewind.failed', { error }));
}

/**
 * Rewinds a conversation to before one of its user prompts, restoring that prompt to the
 * composer. The target is revalidated after every await, so a switch, edit, or execution
 * rebind during preview or confirmation abandons the rewind.
 */
export class ConversationRewind {
  constructor(private readonly deps: ConversationRewindDeps) {}

  async run(
    userMessageId: string,
    mode: ChatRewindMode = 'code-and-conversation',
  ): Promise<void> {
    const { plugin, state } = this.deps;

    if (state.isRewinding) {
      new Notice(t('chat.rewind.inProgress'));
      return;
    }
    if (this.deps.session.hasActiveTurn) {
      new Notice(t('chat.rewind.unavailableStreaming'));
      return;
    }

    const msgs = state.messages;
    const userIdx = msgs.findIndex(m => m.id === userMessageId);
    if (userIdx === -1) {
      failed('Message not found');
      return;
    }
    const userMsg = msgs[userIdx];
    const nativeUserMessageId = userMsg.userMessageId;
    if (!nativeUserMessageId) {
      new Notice(t('chat.rewind.unavailableNoUuid'));
      return;
    }

    const rewindCtx = findRewindContext(msgs, userIdx);
    if (!rewindCtx.hasResponse) {
      new Notice(t('chat.rewind.unavailableNoUuid'));
      return;
    }
    const prevAssistantUuid = rewindCtx.prevAssistantUuid;

    const conversationId = state.currentConversationId;
    const isTargetCurrent = (): boolean => {
      if (state.currentConversationId !== conversationId) return false;
      const currentMessages = state.messages;
      const currentUserIdx = currentMessages.findIndex(message => message.id === userMessageId);
      if (currentUserIdx < 0) return false;
      const currentUser = currentMessages[currentUserIdx];
      if (currentUser.userMessageId !== nativeUserMessageId) return false;
      const currentContext = findRewindContext(currentMessages, currentUserIdx);
      return currentContext.hasResponse
        && currentContext.prevAssistantUuid === prevAssistantUuid;
    };

    this.deps.setRewinding(true);
    try {
      if (this.deps.ensureExecutionInitialized) {
        let initialized = false;
        try {
          initialized = await this.deps.ensureExecutionInitialized();
        } catch (e) {
          failed(e instanceof Error ? e.message : 'Failed to initialize agent service');
          return;
        }
        if (this.deps.isDisposed?.()) return;
        if (!initialized) {
          failed('Agent service not available');
          return;
        }
      }

      const coordinator = this.deps.getExecutionCoordinator();
      if (!coordinator) {
        failed('Agent execution not available');
        return;
      }
      if (!isTargetCurrent()) {
        failed('Conversation changed while rewinding.');
        return;
      }
      /** True while the tab is idle and both the target and its execution are unchanged. */
      const canProceed = (): boolean => {
        if (this.deps.session.hasActiveTurn) {
          new Notice(t('chat.rewind.unavailableStreaming'));
          return false;
        }
        if (!isTargetCurrent() || this.deps.getExecutionCoordinator() !== coordinator) {
          failed('Conversation changed while rewinding.');
          return false;
        }
        return true;
      };

      let confirmationMessage = mode === 'conversation'
        ? t('chat.rewind.confirmMessageConversationOnly')
        : t('chat.rewind.confirmMessage');
      if (mode === 'code-and-conversation') {
        let preview;
        try {
          preview = await coordinator.previewRewind(nativeUserMessageId, prevAssistantUuid, mode);
        } catch (e) {
          failed(e instanceof Error ? e.message : 'Unknown error');
          return;
        }
        if (!preview.canRewind) {
          new Notice(t('chat.rewind.cannot', { error: preview.error ?? 'Unknown error' }));
          return;
        }
        if (preview.conflicts && preview.conflicts.length > 0) {
          confirmationMessage = buildRewindConflictConfirmation(preview.conflicts);
        }
        if (!canProceed()) return;
      }

      const confirmed = await confirm(
        plugin.app,
        confirmationMessage,
        t('chat.rewind.confirmButton')
      );
      if (!confirmed) return;
      if (!canProceed()) return;

      let result;
      try {
        result = await coordinator.rewind(nativeUserMessageId, prevAssistantUuid, mode);
      } catch (e) {
        failed(e instanceof Error ? e.message : 'Unknown error');
        return;
      }
      if (!result.canRewind) {
        new Notice(t('chat.rewind.cannot', { error: result.error ?? 'Unknown error' }));
        return;
      }
      if (!isTargetCurrent() || this.deps.getExecutionCoordinator() !== coordinator) {
        failed('Conversation changed while rewinding.');
        return;
      }

      state.truncateAt(userMessageId);
      state.usage = null;

      const restoredContent = userMsg.displayContent
        ?? extractUserDisplayContent(userMsg.content)
        ?? userMsg.content;
      this.deps.drafts.restore('main', { content: restoredContent, images: userMsg.images }, { focus: true, notify: true });

      this.deps.renderTranscript(state.messages);

      const filesChanged = result.filesChanged?.length ?? 0;
      let saveError: string | null = null;
      try {
        await this.deps.save(
          true,
          result.sessionStrategy === 'preserve-provider-session'
            ? { resumeAtMessageId: undefined }
            : {
              resumeAtMessageId: prevAssistantUuid,
              resetProviderSession: !prevAssistantUuid,
            },
        );
      } catch (e) {
        saveError = e instanceof Error ? e.message : 'Failed to save';
      }

      if (saveError) {
        new Notice(
          mode === 'conversation'
            ? t('chat.rewind.noticeConversationOnlySaveFailed', { error: saveError })
            : t('chat.rewind.noticeSaveFailed', { count: String(filesChanged), error: saveError })
        );
        return;
      }

      new Notice(
        mode === 'conversation'
          ? t('chat.rewind.noticeConversationOnly')
          : t('chat.rewind.notice', { count: String(filesChanged) })
      );
    } finally {
      this.deps.setRewinding(false);
    }
  }
}
