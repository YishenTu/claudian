import type { Component } from 'obsidian';

import { extractUserDisplayContent } from '@/core/prompt/promptContext';
import { DEFAULT_CHAT_PROVIDER_ID, type ProviderCapabilities, type ProviderSubagentLifecycleAdapter } from '@/core/providers/types';
import type { ChatMessage, ImageAttachment, ToolCallInfo } from '@/core/types';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import { renderCitationGroup } from '@/features/chat/rendering/CitationRenderer';
import { MarkdownContentRenderer, type RenderContentOptions } from '@/features/chat/rendering/markdown/MarkdownContentRenderer';
import { type MessageActionCallbacks, MessageActions } from '@/features/chat/rendering/MessageActions';
import { getResponseSegments } from '@/features/chat/rendering/NotificationBoundaries';
import { ResponseFinalizer } from '@/features/chat/rendering/ResponseFinalizer';
import { createResponseTextBlock } from '@/features/chat/rendering/ResponseLayout';
import { renderStoredThinkingBlock } from '@/features/chat/rendering/ThinkingBlockRenderer';
import { updateToolCallResult } from '@/features/chat/rendering/tools/ToolCallRenderer';
import { isSilentWriteStdinTool, renderToolCard } from '@/features/chat/rendering/tools/toolCardDispatch';
import { createWelcomeElement } from '@/features/chat/rendering/WelcomeRenderer';
import { resolveStoredTaskSubagent } from '@/features/chat/subagents/storedTaskSubagent';
import { resolveSubagentAdapter } from '@/features/chat/subagents/subagentAdapterResolution';
import { renderSubagentHistory } from '@/features/chat/subagents/SubagentHistoryRenderer';
import { renderStoredAsyncSubagent, renderStoredSubagent } from '@/features/chat/subagents/SubagentRenderer';
import { ImagePreviewModal } from '@/shared/modals/ImagePreviewModal';
import { registerFileLinkHandler } from '@/utils/fileLink';


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
  private readonly imagePreviewModal = new ImagePreviewModal();
  private readonly contentRemovalObserver?: MutationObserver;
  readonly #markdown: MarkdownContentRenderer;
  readonly #actions: MessageActions;
  readonly #finalizer: ResponseFinalizer;

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
  ) {
    this.app = plugin.app;
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
    );
    this.#actions = new MessageActions(plugin, messagesEl, this.getCapabilities, {
      rewind: rewindCallback,
      fork: forkCallback,
      branches: branchActions,
    });
    this.#finalizer = new ResponseFinalizer(
      id => this.findMessageEl(id),
      (el, markdown) => this.renderContent(el, markdown),
    );

    // Register delegated click handler for file links
    this.removeFileLinkHandler = registerFileLinkHandler(this.app, this.messagesEl);

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
          this.#markdown.releaseRemoved(el);
        };
        for (const record of records) {
          for (const node of record.removedNodes) {
            if (node.nodeType !== 1) continue;
            const el = node as HTMLElement;
            releaseRemoved(el);
            el.querySelectorAll<HTMLElement>('*').forEach(releaseRemoved);
          }
        }
      });
      this.contentRemovalObserver.observe(messagesEl, { childList: true, subtree: true });
    }
  }

  dispose(): void {
    if (this.#markdown.isDisposed) return;
    this.contentRemovalObserver?.disconnect();
    this.#markdown.dispose();
    this.imagePreviewModal.close();
    this.removeFileLinkHandler();
    this.removeFileLinkHandler = () => {};
    this.#actions.clear();
    this.messageEls.clear();
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
  addMessage(msg: ChatMessage): HTMLElement {
    if (msg.role === 'user' && msg.displayContent === '' && !msg.images?.length) {
      return this.messagesEl;
    }
    this.#actions.retireFullSessionForks();
    if (msg.role === 'user') {
      const msgEl = this.#renderUserMessage(msg, { live: true });
      this.scrollToBottom();
      return msgEl ?? (this.messagesEl.lastElementChild as HTMLElement | null) ?? this.messagesEl;
    }

    const { msgEl } = this.#createMessageEl(msg);
    this.#actions.appendTimestamp(msgEl, msg.completedAt);
    this.scrollToBottom();
    return msgEl;
  }

  removeMessage(messageId: string): void {
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
   * Renders all messages for conversation load/switch.
   * @param messages Array of messages to render
   * @param getGreeting Function to get greeting text
   * @returns The newly created welcome element
   */
  renderMessages(
    messages: ChatMessage[],
    getGreeting: () => string
  ): HTMLElement {
    this.#markdown.release();
    this.messagesEl.empty();
    this.#actions.clear();
    this.messageEls.clear();

    // Recreate welcome element after clearing
    const newWelcomeEl = createWelcomeElement(this.messagesEl, getGreeting());

    for (let i = 0; i < messages.length; i++) {
      this.renderStoredMessage(messages[i], messages, i);
    }

    this.scrollToBottom();
    return newWelcomeEl;
  }

  renderStoredMessage(msg: ChatMessage, allMessages?: ChatMessage[], index?: number): void {
    // Bare interrupt marker: user-role interrupts (Claude bracket markers) always render
    // as a standalone indicator. Assistant-role interrupts (Codex partial responses)
    // only use the bare marker when there's no content to preserve.
    if (msg.isInterrupt && (msg.role === 'user' || !this.#hasVisibleContent(msg))) {
      this.#renderInterruptMessage();
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
    if (msg.role === 'assistant' && !this.#hasVisibleContent(msg)) {
      // A pre-output notification can leave an empty first segment that still
      // anchors its continuation's work disclosure when the transcript rerenders.
      const anchorsContinuation = allMessages?.some(message => message !== msg
        && getResponseSegments(message, allMessages).includes(msg));
      if (!anchorsContinuation) return;
    }

    const { msgEl, contentEl } = this.#createMessageEl(msg);
    if (msg.role === 'assistant') {
      this.#renderAssistantContent(msg, contentEl);
      for (const card of contentEl.querySelectorAll<HTMLElement>('[data-subagent-id], [data-async-subagent-id]')) {
        const id = card.dataset.subagentId ?? card.dataset.asyncSubagentId;
        const info = msg.toolCalls?.find(tool => tool.id === id)?.subagent;
        if (info) renderSubagentHistory(card, info, allMessages ?? [msg]);
      }
      if (msg.isInterrupt) {
        this.appendInterruptIndicator(contentEl);
      }
    }

    this.#actions.appendTimestamp(msgEl, msg.completedAt);
    const next = index === undefined ? undefined : allMessages?.[index + 1];
    if (msg.role === 'assistant' && (msg.durationSeconds !== undefined || next?.role !== 'assistant'
      || msg.contentBlocks?.some(block => block.type === 'task_notification'))) {
      this.finalizeResponse(msg, allMessages ?? [msg], !next?.isInterrupt, index);
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
    const text = msg.displayContent ?? extractUserDisplayContent(msg.content) ?? msg.content;
    if (msg.images && msg.images.length > 0) {
      const imagesEl = this.#renderMessageImages(msg.images);
      if (!text) this.#actions.appendTimestamp(imagesEl, msg.timestamp);
    }
    if (!text && !this.#actions.branchesEnabled) return null;

    const { msgEl, contentEl } = this.#createMessageEl(msg);
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
    const copyText = this.#finalizer.finalize(msgEl, contentEl, msg, messages, collapse, index);
    if (copyText === null) return;
    this.#actions.decorateResponse(msgEl, contentEl, msg, messages, copyText);
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
    const textEl = createResponseTextBlock(contentEl);
    textEl.createSpan({ cls: 'claudian-interrupted', text: 'Interrupted' });
    textEl.appendText(' ');
    textEl.createSpan({
      cls: 'claudian-interrupted-hint',
      text: '\u00B7 What should Claudian do instead?',
    });
  }

  renderTaskNotification(contentEl: HTMLElement, content: string): void {
    this.#finalizer.renderTaskNotification(contentEl, content);
  }

  /**
   * Renders assistant message content (content blocks or fallback).
   */
  #renderAssistantContent(msg: ChatMessage, contentEl: HTMLElement): void {
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
          void this.renderContent(textEl, block.content);
          this.addTextCopyButton(textEl, block.content);
        } else if (block.type === 'citations') {
          renderCitationGroup(contentEl, block.citations);
        } else if (block.type === 'tool_use') {
          const toolCall = msg.toolCalls?.find(tc => tc.id === block.toolId);
          if (toolCall) {
            this.#renderToolCall(contentEl, toolCall, msg);
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

          this.#renderTaskSubagent(contentEl, taskToolCall, block.mode);
          renderedToolIds.add(taskToolCall.id);
        }
      }

      // Defensive fallback: preserve tool visibility when contentBlocks/toolCalls drift on reload.
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        for (const toolCall of msg.toolCalls) {
          if (renderedToolIds.has(toolCall.id)) continue;
          this.#renderToolCall(contentEl, toolCall, msg);
          renderedToolIds.add(toolCall.id);
        }
      }
    } else {
      // Fallback for old conversations without contentBlocks
      if (msg.content.trim()) {
        const textEl = createResponseTextBlock(contentEl);
        void this.renderContent(textEl, msg.content);
        this.addTextCopyButton(textEl, msg.content);
      }
      if (msg.toolCalls) {
        for (const toolCall of msg.toolCalls) {
          this.#renderToolCall(contentEl, toolCall, msg);
        }
      }
    }
  }

  /**
   * Renders a tool call with special handling for Write/Edit, Agent (subagent),
   * and Codex collab agent lifecycle tools.
   */
  #renderToolCall(contentEl: HTMLElement, toolCall: ToolCallInfo, msg?: ChatMessage): void {
    if (!this.#shouldRenderToolCall(toolCall, msg)) return;
    const subagentAdapter = this.#resolveSubagentAdapter(toolCall.name);

    if (
      subagentAdapter?.protocol === 'managed-agent'
      && subagentAdapter.isSpawnTool(toolCall.name)
    ) {
      this.#renderTaskSubagent(contentEl, toolCall);
    } else if (
      subagentAdapter?.protocol === 'lifecycle'
      && (subagentAdapter.isSpawnTool(toolCall.name) || toolCall.subagent?.lifecycleSource === 'session')
      && msg
    ) {
      this.#renderProviderLifecycleSubagent(contentEl, toolCall, msg);
    } else {
      renderToolCard(contentEl, toolCall, {
        mode: 'stored', expandFileEditsByDefault: this.plugin.settings?.expandFileEditsByDefault === true,
      });
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
    modeHint?: 'sync' | 'async'
  ): void {
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
  ): void {
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
        this.imagePreviewModal.open(this.messagesEl.ownerDocument ?? window.document, image);
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
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  /** Scrolls to bottom if already near bottom (within threshold). */
  scrollToBottomIfNeeded(threshold = 100): void {
    const { scrollTop, scrollHeight, clientHeight } = this.messagesEl;
    const isNearBottom = scrollHeight - scrollTop - clientHeight < threshold;
    if (isNearBottom) {
      window.requestAnimationFrame(() => {
        this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
      });
    }
  }
}
