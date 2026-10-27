import { type Component, Notice } from 'obsidian';

import { getUserDisplayText } from '@/core/prompt/promptContext';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { DEFAULT_CHAT_PROVIDER_ID, type ProviderCapabilities, type ProviderSubagentLifecycleAdapter } from '@/core/providers/types';
import type { ChatMessage, ImageAttachment, SubagentInfo, ToolCallInfo } from '@/core/types';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import { renderCitationGroup } from '@/features/chat/rendering/CitationRenderer';
import { MarkdownContentRenderer, type RenderContentOptions } from '@/features/chat/rendering/markdown/MarkdownContentRenderer';
import { type MessageActionCallbacks, MessageActions } from '@/features/chat/rendering/MessageActions';
import { getResponseSegments } from '@/features/chat/rendering/NotificationBoundaries';
import { ResponseFinalizer } from '@/features/chat/rendering/ResponseFinalizer';
import {
  appendInterruptLabel,
  createResponseTextBlock,
  isConsumedInterruptMarker,
  isFoldedByLaterInterrupt,
  isInterruptedResponse,
  isInterruptMarker,
  markResponseElement,
} from '@/features/chat/rendering/ResponseLayout';
import { createSessionLink, registerSessionLinkHandler } from '@/features/chat/rendering/sessionLinks';
import { renderStoredThinkingBlock } from '@/features/chat/rendering/ThinkingBlockRenderer';
import { updateToolCallResult } from '@/features/chat/rendering/tools/ToolCallRenderer';
import { isSilentWriteStdinTool, renderToolCard } from '@/features/chat/rendering/tools/toolCardDispatch';
import { createWelcomeElement } from '@/features/chat/rendering/WelcomeRenderer';
import { resolveStoredTaskSubagent } from '@/features/chat/subagents/storedTaskSubagent';
import { resolveSubagentAdapter } from '@/features/chat/subagents/subagentAdapterResolution';
import { renderSubagentHistory } from '@/features/chat/subagents/SubagentHistoryRenderer';
import { renderStoredAsyncSubagent, renderStoredSubagent } from '@/features/chat/subagents/SubagentRenderer';
import { cancelScheduledAnimationFrame, scheduleAnimationFrame, type ScheduledAnimationFrame } from '@/features/chat/utils/animationFrame';
import { type ConversationDirectoryEntry, formatConversationDirectoryTitle, getRenderedConversationDirectory } from '@/features/chat/utils/conversationDirectoryTitle';
import { t } from '@/i18n/i18n';
import { ImagePreviewModal } from '@/shared/modals/ImagePreviewModal';
import { registerFileLinkHandler } from '@/utils/fileLink';


/** Rendering hooks reconnect live tool cards to their session owners. */
export interface LiveTranscriptOptions {
  isResponseOpen(messageId: string): boolean;
  /** Settled messages reconnect only subagents whose owner still applies provider updates. */
  isSubagentTracked(toolId: string): boolean;
  onToolRendered(tool: ToolCallInfo, view: ReturnType<typeof renderToolCard>): void;
  renderSubagent(parent: HTMLElement, info: SubagentInfo): void;
  reservePendingSubagent(parent: HTMLElement, toolId: string): boolean;
}

/** Open response segments use live cards; settled messages keep the stored rendering. */
interface MessageLiveScope {
  options: LiveTranscriptOptions;
  open: boolean;
}

/** Messages a transcript renders at once, counted back from its end; earlier ones render on request. */
const RENDER_WINDOW = 40;

/** Where the reader is: the first message showing at the top, and its offset from the viewport top. */
export interface ReadingAnchor {
  readonly messageId: string;
  readonly offset: number;
}

/** Messages before `start` are not rendered yet; `messages` is the transcript the window was cut from. */
interface EarlierMessages {
  readonly messages: ChatMessage[];
  readonly live?: LiveTranscriptOptions;
  readonly control: HTMLElement;
  start: number;
}

/**
 * The window's first message at or before `index`: a prompt, so every response it renders is
 * whole. A bare interrupt marker belongs to the response before it and never starts a window.
 */
function findWindowStart(messages: ChatMessage[], index: number): number {
  for (let i = index; i > 0; i--) {
    if (messages[i].role === 'user' && !isInterruptMarker(messages[i])) return i;
  }
  return 0;
}

/**
 * Renders a tab's transcript: live and replayed messages, assistant content
 * blocks and stored tool/subagent cards. Markdown scopes, message actions and
 * response finalization each belong to their own collaborator; this class keeps
 * the message-id index and forwards removed DOM to those owners.
 */
export class MessageRenderer {
  private readonly app: ChatFeatureHost['app'];
  private readonly plugin: ChatFeatureHost;
  private readonly messagesEl: HTMLElement;
  private readonly getCapabilities: () => ProviderCapabilities;
  private readonly messageEls = new Map<string, HTMLElement>();
  private removeFileLinkHandler: () => void;
  private removeSessionLinkHandler: () => void;
  readonly #openConversation: ((conversationId: string) => Promise<void>) | undefined;
  private readonly imagePreviewModal = new ImagePreviewModal();
  private readonly contentRemovalObserver?: MutationObserver;
  #pendingLayoutScroll: ResizeObserver | null = null;
  #pendingTailScroll: { frame?: ScheduledAnimationFrame; scrollTop: number } | null = null;
  readonly #markdown: MarkdownContentRenderer;
  readonly #actions: MessageActions;
  readonly #finalizer: ResponseFinalizer;
  #earlier: EarlierMessages | null = null;

  updateQuestionTool(tool: ToolCallInfo): void {
    for (const element of this.messagesEl.querySelectorAll<HTMLElement>('[data-tool-id]')) {
      if (element.dataset.toolId === tool.id) {
        updateToolCallResult(element, tool);
      }
    }
  }

  constructor(
    plugin: ChatFeatureHost,
    component: Component,
    messagesEl: HTMLElement,
    rewindCallback?: MessageActionCallbacks['rewind'],
    forkCallback?: MessageActionCallbacks['fork'],
    getCapabilities?: () => ProviderCapabilities,
    branchActions?: MessageActionCallbacks['branches'],
    /** Opens a session from a transcript link; omitted where the presentation cannot navigate. */
    openConversation?: (conversationId: string) => Promise<void>,
  ) {
    this.app = plugin.app;
    this.#openConversation = openConversation;
    this.plugin = plugin;
    this.messagesEl = messagesEl;
    this.getCapabilities = getCapabilities ?? (() => ({
      providerId: DEFAULT_CHAT_PROVIDER_ID,
      supportsNativeHistory: false,
      supportsEphemeralSessions: false,
      supportsRewind: false,
      supportsFork: false,
      supportsProviderCommands: false,
      supportsImageAttachments: false,
      supportsTurnSteer: false,
      reasoningControl: 'none' as const,
    }));
    this.#markdown = new MarkdownContentRenderer(
      this.app, component, messagesEl, () => this.plugin.settings.mediaFolder,
      () => this.plugin.settings.pluginRenderedFenceLanguages,
    );
    this.#actions = new MessageActions(plugin, messagesEl, this.getCapabilities, {
      rewind: rewindCallback,
      fork: forkCallback,
      branches: branchActions,
    }, () => this.#earlier !== null);
    this.#finalizer = new ResponseFinalizer(
      id => this.findMessageEl(id),
      (el, markdown) => this.renderContent(el, markdown),
    );

    // Register delegated click handler for file links
    this.removeFileLinkHandler = registerFileLinkHandler(this.app, this.messagesEl);
    // Live tool cards render into the same container, so one delegated handler covers both paths.
    this.removeSessionLinkHandler = registerSessionLinkHandler(this.messagesEl, id => { void this.#openSession(id); }, id => {
      const summary = this.plugin.getConversationSummary(id);
      return summary ? { title: summary.title || undefined, providerId: summary.providerId } : null;
    });

    // Controllers also clear message DOM directly. Inspect only removed subtrees,
    // rather than scanning every retained message on each streaming mutation.
    const Observer = messagesEl.ownerDocument?.defaultView?.MutationObserver;
    if (Observer) {
      this.contentRemovalObserver = new Observer(records => {
        const releaseRemoved = (el: HTMLElement) => {
          const id = el.dataset.messageId;
          if (id && this.messageEls.get(id) === el && !this.messagesEl.contains(el)) {
            this.messageEls.delete(id);
            this.#actions.forget(id);
          }
        };
        for (const record of records) {
          for (const node of record.removedNodes) {
            if (node.nodeType !== 1) continue;
            const el = node as HTMLElement;
            if (this.messagesEl.contains(el)) continue;
            releaseRemoved(el);
            el.querySelectorAll<HTMLElement>('[data-message-id]').forEach(releaseRemoved);
            this.#markdown.releaseRemoved(el);
          }
        }
      });
      this.contentRemovalObserver.observe(messagesEl, { childList: true, subtree: true });
    }
  }

  dispose(): void {
    if (this.#markdown.isDisposed) return;
    this.#cancelTailScroll();
    this.contentRemovalObserver?.disconnect();
    this.#cancelLayoutScroll();
    this.#markdown.dispose();
    this.imagePreviewModal.close();
    this.removeFileLinkHandler();
    this.removeFileLinkHandler = () => {};
    this.removeSessionLinkHandler();
    this.removeSessionLinkHandler = () => {};
    this.#actions.clear();
    this.messageEls.clear();
    this.#earlier = null;
  }

  /** Session links may outlive their session; a missing one is reported rather than opened. */
  async #openSession(conversationId: string): Promise<void> {
    try {
      const open = this.#openConversation;
      if (!open) {
        new Notice(t('chat.sessionTools.openUnavailable'));
        return;
      }
      await this.plugin.ensureConversationMetadataLoaded([conversationId]);
      if (!this.plugin.getConversationSummary(conversationId)) {
        new Notice(t('chat.sessionTools.sessionMissing'));
        return;
      }
      await open(conversationId);
    } catch (error) {
      new Notice(t('chat.sessionTools.openFailed', { message: error instanceof Error ? error.message : String(error) }));
    }
  }

  #resolveSubagentAdapter(toolName?: string) {
    return resolveSubagentAdapter(this.getCapabilities().providerId, toolName);
  }

  refreshMessageTimestamps(): void {
    this.#actions.refreshTimestamps();
  }

  // ============================================
  // Message Rendering
  // ============================================

  /**
   * Adds a new message to the chat during streaming.
   * Returns the message element for content updates.
   */
  addMessage(msg: ChatMessage, afterMessageId?: string): HTMLElement {
    if (msg.role === 'user' && msg.displayContent === '' && !msg.images?.length) {
      return this.messagesEl;
    }
    this.#actions.retireFullSessionForks();
    if (afterMessageId !== undefined) this.#revealThrough(afterMessageId);
    const previous = this.messagesEl.lastChild;
    let element: HTMLElement;
    if (msg.role === 'user') {
      const msgEl = this.#renderUserMessage(msg, { live: true });
      element = msgEl ?? (this.messagesEl.lastElementChild as HTMLElement | null) ?? this.messagesEl;
    } else {
      const { msgEl } = this.#createMessageEl(msg);
      this.#actions.appendTimestamp(msgEl, msg.completedAt);
      element = msgEl;
    }
    const anchor = afterMessageId === undefined ? null : this.findMessageEl(afterMessageId);
    if (anchor) {
      // A user message may render both an image group and a text bubble.
      const added: ChildNode[] = [];
      for (let node = previous ? previous.nextSibling : this.messagesEl.firstChild; node; node = node.nextSibling) added.push(node);
      anchor.after(...added);
    }
    this.scrollToBottom();
    return element;
  }

  getMessageContentEl(messageId: string): HTMLElement | null {
    return this.findMessageEl(messageId)?.querySelector<HTMLElement>('.claudian-message-content') ?? null;
  }

  removeMessage(messageId: string): void {
    this.#forgetEarlier(messageId);
    this.messagesEl.querySelector(`[data-user-message-id="${messageId}"]`)?.remove();
    const msgEl = this.findMessageEl(messageId);
    if (!msgEl) {
      return;
    }

    this.#markdown.release(msgEl);
    msgEl.remove();
    this.#actions.forget(messageId);
    this.messageEls.delete(messageId);
  }

  /**
   * Renders a transcript for conversation load/switch: its latest messages, below a control
   * that renders earlier ones on request.
   * @param messages Array of messages to render
   * @param getGreeting Function to get greeting text
   * @returns The newly created welcome element
   */
  renderMessages(
    messages: ChatMessage[],
    getGreeting: () => string,
    live?: LiveTranscriptOptions,
  ): HTMLElement {
    this.#markdown.release();
    this.messagesEl.empty();
    this.#actions.clear();
    this.messageEls.clear();
    this.#earlier = null;

    // Recreate welcome element after clearing
    const newWelcomeEl = createWelcomeElement(this.messagesEl, getGreeting());
    const start = findWindowStart(messages, messages.length - RENDER_WINDOW);
    if (start > 0) {
      // A copy, so later appends cannot shift the window; `removeMessage` keeps it in sync.
      this.#earlier = { messages: messages.slice(), live, control: this.#createEarlierControl(), start };
    }
    this.#renderRange(messages, start, messages.length, live);

    this.#scrollToBottomOnceLaidOut();
    return newWelcomeEl;
  }

  /** Renders the window's earlier messages above it, the next block or all, keeping the reading position. */
  revealEarlierMessages(all = false): void {
    const earlier = this.#earlier;
    if (earlier) this.#revealFrom(all ? 0 : findWindowStart(earlier.messages, earlier.start - RENDER_WINDOW));
  }

  /** Lists the transcript's prompts without materializing the earlier message bodies. */
  getDirectoryEntries(): ConversationDirectoryEntry[] {
    const entries: ConversationDirectoryEntry[] = [];
    const earlier = this.#earlier;
    if (earlier) {
      for (let index = 0; index < earlier.start; index += 1) {
        const message = earlier.messages[index];
        if (message.role !== 'user' || message.isRebuiltContext || isInterruptMarker(message)) continue;
        const title = formatConversationDirectoryTitle(getUserDisplayText(message));
        if (title) entries.push({ title, reveal: () => {
          this.#revealThrough(message.id);
          return this.findMessageEl(message.id);
        } });
      }
    }
    return entries.concat(getRenderedConversationDirectory(this.messagesEl));
  }

  #revealFrom(start: number): void {
    const earlier = this.#earlier;
    if (!earlier || start >= earlier.start || this.#markdown.isDisposed) return;
    const { messages, live, control } = earlier;
    const end = earlier.start;
    const firstPromptId = this.messagesEl.querySelector<HTMLElement>('[data-role="user"]')?.dataset.messageId;
    const fromBottom = this.messagesEl.scrollHeight - this.messagesEl.scrollTop;
    const last = this.messagesEl.lastChild;
    this.#renderRange(messages, start, end, live);
    const added: ChildNode[] = [];
    for (let node = last ? last.nextSibling : null; node; node = node.nextSibling) added.push(node);
    control.after(...added);
    earlier.start = start;
    if (start === 0) {
      this.#earlier = null;
      // Keep keyboard focus in the transcript when its focused control goes away.
      if (control.contains(control.ownerDocument.activeElement)) {
        if (!this.messagesEl.hasAttribute('tabindex')) this.messagesEl.tabIndex = -1;
        this.messagesEl.focus({ preventScroll: true });
      }
      control.remove();
    }
    // Only the transcript's first prompt lacks branch controls; the old and new first prompts change role.
    const newFirstPromptId = this.messagesEl.querySelector<HTMLElement>('[data-role="user"]')?.dataset.messageId;
    this.#actions.refreshBranchButtons(messages.filter(message => message.id === firstPromptId || message.id === newFirstPromptId));
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight - fromBottom;
  }

  /** The reading position by message, which survives rerendering and messages added below it. */
  captureReadingAnchor(): ReadingAnchor | null {
    if (this.messagesEl.clientHeight === 0) return null;
    const top = this.messagesEl.getBoundingClientRect().top;
    for (const child of Array.from(this.messagesEl.children) as HTMLElement[]) {
      const messageId = child.dataset.messageId;
      if (!messageId) continue;
      const rect = child.getBoundingClientRect();
      if (rect.bottom > top) return { messageId, offset: rect.top - top };
    }
    return null;
  }

  /** Renders the window down to the anchor's message if needed, then shows it where the reader left it. */
  restoreReadingAnchor(anchor: ReadingAnchor): void {
    if (this.messagesEl.clientHeight === 0) return;
    this.#revealThrough(anchor.messageId);
    const el = this.findMessageEl(anchor.messageId);
    if (!el) return;
    const offset = el.getBoundingClientRect().top - this.messagesEl.getBoundingClientRect().top;
    this.messagesEl.scrollTop += offset - anchor.offset;
  }

  /** A removed message must not come back when its earlier block is revealed. */
  #forgetEarlier(messageId: string): void {
    const earlier = this.#earlier;
    const index = earlier?.messages.findIndex(message => message.id === messageId) ?? -1;
    if (!earlier || index < 0) return;
    earlier.messages.splice(index, 1);
    if (index < earlier.start) earlier.start--;
  }

  /** Renders the window down to an unrendered earlier message, e.g. before inserting beside it. */
  #revealThrough(messageId: string): void {
    const earlier = this.#earlier;
    const index = earlier?.messages.findIndex(message => message.id === messageId) ?? -1;
    if (earlier && index >= 0) this.#revealFrom(findWindowStart(earlier.messages, index));
  }

  #createEarlierControl(): HTMLElement {
    const control = this.messagesEl.createDiv({ cls: 'claudian-earlier-messages' });
    const button = control.createEl('button', {
      cls: 'claudian-earlier-messages-btn', text: t('chat.showEarlierMessages'), attr: { type: 'button' },
    });
    button.addEventListener('click', () => this.revealEarlierMessages());
    return control;
  }

  #renderRange(messages: ChatMessage[], start: number, end: number, live?: LiveTranscriptOptions): void {
    const openIds = live ? new Set(messages.filter(message => live.isResponseOpen(message.id))
      .flatMap(message => getResponseSegments(message, messages).map(segment => segment.id))) : undefined;
    for (let i = start; i < end; i++) {
      this.renderStoredMessage(messages[i], messages, i, live && { options: live, open: openIds?.has(messages[i].id) === true });
    }
  }

  renderStoredMessage(msg: ChatMessage, allMessages?: ChatMessage[], index?: number, scope?: MessageLiveScope): void {
    const open = !!scope && (scope.options.isResponseOpen(msg.id)
      || (msg.isAutomaticResponse === true && msg.completedAt === undefined && !this.#hasVisibleContent(msg)));
    const live = scope && { options: scope.options, open: scope.open || open };
    // Bare interrupt marker: user-role interrupts (Claude bracket markers) and
    // assistant-role interrupts without content (Codex aborted turns). The
    // interrupted response it ends already shows it inside its disclosure.
    if (isInterruptMarker(msg)) {
      const previous = allMessages?.[(index ?? 0) - 1];
      if (!previous || !isConsumedInterruptMarker(msg, allMessages ?? [], index)
        || !this.messageEls.get(previous.id)?.isConnected) this.#renderInterruptMessage();
      return;
    }

    // Skip rebuilt context messages (history sent to SDK on session reset)
    // These are internal context for the AI, not actual user messages to display
    if (msg.isRebuiltContext || (msg.role === 'user' && msg.displayContent === '' && !msg.images?.length)) {
      return;
    }

    if (msg.role === 'user') {
      this.#renderUserMessage(msg, { live: false, allMessages, index });
      return;
    }
    const interrupted = isInterruptedResponse(msg, allMessages ?? [msg], index);
    // An interrupted reply whose output is all hidden still ends its turn's fold.
    if (msg.role === 'assistant' && !this.#hasVisibleContent(msg) && !open && !interrupted) {
      // A pre-output notification can leave an empty first segment that still
      // anchors its continuation's work disclosure when the transcript rerenders.
      const anchorsContinuation = allMessages?.some(message => message !== msg
        && getResponseSegments(message, allMessages).includes(msg));
      if (!anchorsContinuation) return;
    }

    const { msgEl, contentEl } = this.#createMessageEl(msg);
    if (msg.role === 'assistant') {
      this.#renderAssistantContent(msg, contentEl, live);
      for (const card of contentEl.querySelectorAll<HTMLElement>('[data-subagent-id], [data-async-subagent-id]')) {
        const id = card.dataset.subagentId ?? card.dataset.asyncSubagentId;
        const info = msg.toolCalls?.find(tool => tool.id === id)?.subagent;
        if (info) renderSubagentHistory(card, info, allMessages ?? [msg]);
      }
      if (msg.isInterrupt || interrupted) {
        this.appendInterruptIndicator(contentEl);
      }
    }

    this.#actions.appendTimestamp(msgEl, msg.completedAt);
    const next = index === undefined ? undefined : allMessages?.[index + 1];
    if (msg.role === 'assistant' && !open && !isFoldedByLaterInterrupt(msg, allMessages ?? [msg], index)
      && (msg.durationSeconds !== undefined || next?.role !== 'assistant'
      || interrupted || msg.contentBlocks?.some(block => block.type === 'task_notification'))) {
      this.finalizeResponse(msg, allMessages ?? [msg], true, index);
    }
  }

  /**
   * Renders a prompt's images above its bubble, then the bubble unless it would
   * be empty and carry no branch controls. Returns the bubble when rendered.
   */
  #renderUserMessage(
    msg: ChatMessage,
    context: { live: true } | { live: false; allMessages?: ChatMessage[]; index?: number },
  ): HTMLElement | null {
    const text = getUserDisplayText(msg);
    if (msg.images && msg.images.length > 0) {
      const imagesEl = this.#renderMessageImages(msg.images);
      imagesEl.dataset.userMessageId = msg.id;
      if (!text) this.#actions.appendTimestamp(imagesEl, msg.timestamp);
    }
    if (!text && !this.#actions.branchesEnabled) return null;

    const { msgEl, contentEl } = this.#createMessageEl(msg);
    if (msg.sessionMessage) {
      const { from, sessionId } = msg.sessionMessage;
      // Only the session name is the link; the label stays plain text beside it.
      const senderEl = contentEl.createDiv({ cls: 'claudian-session-message-sender' });
      senderEl.createSpan({ text: t('chat.sessionMessage.fromLabel') });
      createSessionLink(senderEl, { sessionId, text: from });
    }
    if (text) void this.renderContent(createResponseTextBlock(contentEl), text);
    this.#actions.decorateUserMessage(msgEl, msg, text, context.live ? undefined : context);
    return msgEl;
  }

  #createMessageEl(msg: ChatMessage): { msgEl: HTMLElement; contentEl: HTMLElement } {
    const msgEl = this.messagesEl.createDiv({
      cls: `claudian-message claudian-message-${msg.role}`,
      attr: {
        'data-message-id': msg.id,
        'data-role': msg.role,
      },
    });
    this.messageEls.set(msg.id, msgEl);
    const contentEl = msgEl.createDiv({ cls: 'claudian-message-content', attr: { dir: 'auto' } });
    return { msgEl, contentEl };
  }

  /** Reparents completed output without replacing live tool or Markdown elements. */
  finalizeResponse(msg: ChatMessage, messages: ChatMessage[], collapse = true, index?: number): void {
    const msgEl = this.findMessageEl(msg.id);
    const contentEl = msgEl?.querySelector<HTMLElement>('.claudian-message-content');
    if (!msgEl || !contentEl) return;
    const finalized = this.#finalizer.finalize(msgEl, contentEl, msg, messages, collapse, index);
    if (finalized === null) return;
    this.#actions.decorateResponse(msgEl, contentEl, msg, messages, finalized.answer);
  }

  #hasVisibleContent(msg: ChatMessage): boolean {
    if (msg.content && msg.content.trim().length > 0) return true;
    if (msg.contentBlocks && msg.contentBlocks.length > 0) {
      for (const block of msg.contentBlocks) {
        if (block.type === 'thinking' && block.content.trim().length > 0) return true;
        if (block.type === 'text' && block.content.trim().length > 0) return true;
        if (block.type === 'citations' && block.citations.entries.length > 0) return true;
        if (block.type === 'context_compacted') return true;
        if (block.type === 'task_notification') return true;
        if (block.type === 'subagent') return true;
        if (block.type === 'tool_use') {
          const toolCall = msg.toolCalls?.find(tc => tc.id === block.toolId);
          if (toolCall && this.#shouldRenderToolCall(toolCall, msg)) return true;
        }
      }
    }
    if (msg.toolCalls?.some(toolCall => this.#shouldRenderToolCall(toolCall, msg))) return true;
    return false;
  }

  #renderInterruptMessage(): void {
    const msgEl = this.messagesEl.createDiv({ cls: 'claudian-message claudian-message-assistant' });
    const contentEl = msgEl.createDiv({ cls: 'claudian-message-content', attr: { dir: 'auto' } });
    this.appendInterruptIndicator(contentEl);
  }

  appendInterruptIndicator(contentEl: HTMLElement): void {
    appendInterruptLabel(markResponseElement(contentEl.createDiv({ cls: 'claudian-text-block' }), 'interrupt'));
  }

  renderTaskNotification(contentEl: HTMLElement, content: string): void {
    this.#finalizer.renderTaskNotification(contentEl, content);
  }

  /**
   * Renders assistant message content (content blocks or fallback).
   */
  #renderAssistantContent(msg: ChatMessage, contentEl: HTMLElement, live?: MessageLiveScope): void {
    if (msg.contentBlocks && msg.contentBlocks.length > 0) {
      const renderedToolIds = new Set<string>();
      for (const block of msg.contentBlocks) {
        if (block.type === 'thinking') {
          renderStoredThinkingBlock(
            contentEl,
            block.content,
            block.durationSeconds,
            (el, md) => this.renderContent(el, md)
          );
        } else if (block.type === 'text') {
          // Skip empty or whitespace-only text blocks to avoid extra gaps
          if (!block.content.trim()) {
            continue;
          }
          const textEl = createResponseTextBlock(contentEl);
          void this.renderContent(textEl, ProviderRegistry.prepareAssistantMarkdown(this.getCapabilities().providerId, block.content));
          this.addTextCopyButton(textEl, block.content);
        } else if (block.type === 'citations') {
          renderCitationGroup(contentEl, block.citations);
        } else if (block.type === 'tool_use') {
          const toolCall = msg.toolCalls?.find(tc => tc.id === block.toolId);
          if (toolCall) {
            this.#renderToolCall(contentEl, toolCall, msg, live);
            renderedToolIds.add(toolCall.id);
          }
        } else if (block.type === 'task_notification') {
          this.#finalizer.renderTaskNotification(contentEl, block.content);
        } else if (block.type === 'context_compacted') {
          const boundaryEl = contentEl.createDiv({ cls: 'claudian-compact-boundary' });
          boundaryEl.createSpan({ cls: 'claudian-compact-boundary-label', text: 'Conversation compacted' });
        } else if (block.type === 'subagent') {
          const taskToolCall = msg.toolCalls?.find((toolCall) => {
            if (toolCall.id !== block.subagentId) return false;
            const adapter = this.#resolveSubagentAdapter(toolCall.name);
            return adapter?.protocol === 'managed-agent'
              && adapter.isSpawnTool(toolCall.name);
          });
          if (!taskToolCall) continue;

          this.#renderTaskSubagent(contentEl, taskToolCall, block.mode, live);
          renderedToolIds.add(taskToolCall.id);
        }
      }

      // Defensive fallback: preserve tool visibility when contentBlocks/toolCalls drift on reload.
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        for (const toolCall of msg.toolCalls) {
          if (renderedToolIds.has(toolCall.id)) continue;
          this.#renderToolCall(contentEl, toolCall, msg, live);
          renderedToolIds.add(toolCall.id);
        }
      }
    } else {
      // Fallback for old conversations without contentBlocks
      if (msg.content.trim() && !live?.options.isResponseOpen(msg.id)) {
        const textEl = createResponseTextBlock(contentEl);
        void this.renderContent(textEl, ProviderRegistry.prepareAssistantMarkdown(this.getCapabilities().providerId, msg.content));
        this.addTextCopyButton(textEl, msg.content);
      }
      if (msg.toolCalls) {
        for (const toolCall of msg.toolCalls) {
          this.#renderToolCall(contentEl, toolCall, msg, live);
        }
      }
    }
  }

  /**
   * Renders a tool call with special handling for Write/Edit, Agent (subagent),
   * and Codex collab agent lifecycle tools.
   */
  #renderToolCall(contentEl: HTMLElement, toolCall: ToolCallInfo, msg?: ChatMessage, live?: MessageLiveScope): void {
    if (!this.#shouldRenderToolCall(toolCall, msg)) return;
    const subagentAdapter = this.#resolveSubagentAdapter(toolCall.name);

    if (
      subagentAdapter?.protocol === 'managed-agent'
      && subagentAdapter.isSpawnTool(toolCall.name)
    ) {
      this.#renderTaskSubagent(contentEl, toolCall, undefined, live);
    } else if (
      subagentAdapter?.protocol === 'lifecycle'
      && (subagentAdapter.isSpawnTool(toolCall.name) || toolCall.subagent?.lifecycleSource === 'session')
      && msg
    ) {
      this.#renderProviderLifecycleSubagent(contentEl, toolCall, msg, live);
    } else {
      const view = renderToolCard(contentEl, toolCall, {
        mode: live?.open ? 'live' : 'stored', expandFileEditsByDefault: this.plugin.settings?.expandFileEditsByDefault === true,
      });
      if (live?.open) live.options.onToolRendered(toolCall, view);
    }
  }

  #shouldRenderToolCall(toolCall: ToolCallInfo, msg?: ChatMessage): boolean {
    if (isSilentWriteStdinTool(toolCall)) return false;
    if (toolCall.name === 'custom_tool_call_output') return false;

    const subagentAdapter = this.#resolveSubagentAdapter(toolCall.name);
    if (
      subagentAdapter?.protocol === 'managed-agent'
      && subagentAdapter.isOutputTool(toolCall.name)
    ) return false;
    if (
      subagentAdapter?.protocol === 'lifecycle'
      && subagentAdapter.isHiddenTool(toolCall.name)
      && msg
      && this.#isFullyOwnedProviderSubagentTool(toolCall, msg, subagentAdapter)
    ) return false;

    return true;
  }

  #isFullyOwnedProviderSubagentTool(
    toolCall: ToolCallInfo,
    msg: ChatMessage,
    adapter: ProviderSubagentLifecycleAdapter,
  ): boolean {
    const agentIdToSpawnId = new Map<string, string>();
    for (const sibling of msg.toolCalls ?? []) {
      if (!adapter.isSpawnTool(sibling.name) && sibling.subagent?.lifecycleSource !== 'session') continue;
      const spawnResult = adapter.extractSpawnResult(sibling.result, sibling);
      const agentId = spawnResult.agentId
        ?? adapter.buildSubagentInfo(sibling, msg.toolCalls ?? []).agentId;
      if (agentId) agentIdToSpawnId.set(agentId, sibling.id);
      for (const alias of spawnResult.aliases ?? []) agentIdToSpawnId.set(alias, sibling.id);
    }
    return adapter.isToolCallFullyOwned(toolCall, agentIdToSpawnId);
  }

  #renderTaskSubagent(
    contentEl: HTMLElement,
    toolCall: ToolCallInfo,
    modeHint?: 'sync' | 'async',
    live?: MessageLiveScope,
  ): void {
    if (live && (live.open || live.options.isSubagentTracked(toolCall.id))) {
      if (toolCall.subagent) {
        live.options.renderSubagent(contentEl, toolCall.subagent);
        return;
      }
      if (live.options.reservePendingSubagent(contentEl, toolCall.id)) return;
    }
    const subagentInfo = resolveStoredTaskSubagent(toolCall, modeHint);
    if (subagentInfo.mode === 'async') {
      renderStoredAsyncSubagent(contentEl, subagentInfo);
      return;
    }
    renderStoredSubagent(contentEl, subagentInfo);
  }

  /**
   * Consolidates provider lifecycle tools (spawn + wait/close)
   * into a single subagent block with prompt and result.
   */
  #renderProviderLifecycleSubagent(
    contentEl: HTMLElement,
    spawnToolCall: ToolCallInfo,
    msg: ChatMessage,
    live?: MessageLiveScope,
  ): void {
    if (live && spawnToolCall.subagent && (live.open || live.options.isSubagentTracked(spawnToolCall.id))) {
      live.options.renderSubagent(contentEl, spawnToolCall.subagent);
      return;
    }
    const subagentAdapter = this.#resolveSubagentAdapter(spawnToolCall.name);
    if (!subagentAdapter || subagentAdapter.protocol !== 'lifecycle') {
      renderToolCard(contentEl, spawnToolCall, { mode: 'stored', expandFileEditsByDefault: this.plugin.settings?.expandFileEditsByDefault === true });
      return;
    }

    const subagentInfo = subagentAdapter.buildSubagentInfo(
      spawnToolCall,
      msg.toolCalls ?? [],
    );
    if (subagentInfo.mode === 'async') {
      renderStoredAsyncSubagent(contentEl, subagentInfo);
      return;
    }
    renderStoredSubagent(contentEl, subagentInfo);
  }

  // ============================================
  // Image Rendering
  // ============================================

  /** Renders image attachments above a message; each opens a full-size preview. */
  #renderMessageImages(images: ImageAttachment[]): HTMLElement {
    const imagesEl = this.messagesEl.createDiv({ cls: 'claudian-message-images' });

    for (const image of images) {
      const imageWrapper = imagesEl.createEl('button', {
        cls: 'claudian-message-image',
        attr: {
          'aria-label': `Preview ${image.name}`,
          type: 'button',
        },
      });
      imageWrapper.createEl('img', {
        attr: {
          alt: image.name,
          src: `data:${image.mediaType};base64,${image.data}`,
        },
      });

      imageWrapper.addEventListener('click', () => {
        if (this.#markdown.isDisposed) return;
        this.imagePreviewModal.open(this.messagesEl.ownerDocument ?? window.document, image, this.app.keymap);
      });
    }
    return imagesEl;
  }

  // ============================================
  // Content Rendering
  // ============================================

  /** Renders markdown content with code block enhancements. */
  renderContent(
    el: HTMLElement,
    markdown: string,
    options?: RenderContentOptions
  ): Promise<void> {
    return this.#markdown.render(el, markdown, options);
  }

  private findMessageEl(id: string): HTMLElement | null {
    const cached = this.messageEls.get(id);
    if (cached && this.messagesEl.contains(cached)) return cached;
    this.messageEls.delete(id);
    return this.messagesEl.querySelector<HTMLElement>(`[data-message-id="${id}"]`);
  }

  // ============================================
  // Message Actions
  // ============================================

  addTextCopyButton(textEl: HTMLElement, markdown: string): void {
    this.#actions.addTextCopyButton(textEl, markdown);
  }

  refreshActionButtons(msg: ChatMessage, allMessages?: ChatMessage[], index?: number): void {
    this.#actions.refreshActionButtons(msg, allMessages, index);
  }

  refreshBranchButtons(messages: readonly ChatMessage[]): void {
    this.#actions.refreshBranchButtons(messages);
  }

  refreshBranchButtonState(): void {
    this.#actions.refreshBranchButtonState();
  }

  // ============================================
  // Utilities
  // ============================================

  /** Scrolls messages container to bottom. */
  scrollToBottom(): void {
    this.#cancelTailScroll();
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  #cancelTailScroll(): void {
    const pending = this.#pendingTailScroll;
    this.#pendingTailScroll = null;
    if (pending?.frame) cancelScheduledAnimationFrame(pending.frame);
  }

  /** A transcript rendered into a hidden presentation ignores scroll writes until it gets a box. */
  #scrollToBottomOnceLaidOut(): void {
    this.#cancelLayoutScroll();
    this.scrollToBottom();
    if (this.messagesEl.clientHeight > 0) return;
    const Observer = this.messagesEl.ownerDocument?.defaultView?.ResizeObserver;
    if (!Observer) return;
    const observer = new Observer(() => {
      if (this.messagesEl.clientHeight === 0) return;
      this.#cancelLayoutScroll();
      this.scrollToBottom();
    });
    this.#pendingLayoutScroll = observer;
    observer.observe(this.messagesEl);
  }

  #cancelLayoutScroll(): void {
    this.#pendingLayoutScroll?.disconnect();
    this.#pendingLayoutScroll = null;
  }

  /** Scrolls to bottom if already near bottom (within threshold). */
  scrollToBottomIfNeeded(threshold = 100): void {
    this.#cancelTailScroll();
    if (this.#markdown.isDisposed) return;
    const { scrollTop, scrollHeight, clientHeight } = this.messagesEl;
    const isNearBottom = scrollHeight - scrollTop - clientHeight < threshold;
    if (isNearBottom) {
      const pending = { scrollTop } as { frame?: ScheduledAnimationFrame; scrollTop: number };
      this.#pendingTailScroll = pending;
      pending.frame = scheduleAnimationFrame(() => {
        if (this.#pendingTailScroll !== pending) return;
        this.#pendingTailScroll = null;
        if (this.messagesEl.scrollTop === pending.scrollTop) {
          this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
        }
      }, this.messagesEl.ownerDocument.defaultView);
    }
  }
}
