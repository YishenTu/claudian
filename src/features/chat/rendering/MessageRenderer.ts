import type { App, Component } from 'obsidian';
import { MarkdownRenderer, Menu, Notice, setIcon } from 'obsidian';

import type { ChatRewindMode } from '../../../core/execution';
import {
  DEFAULT_CHAT_PROVIDER_ID,
  type ProviderCapabilities,
  type ProviderSubagentLifecycleAdapter,
} from '../../../core/providers/types';
import {
  isWriteEditTool,
  TOOL_APPLY_PATCH,
  TOOL_WRITE_STDIN,
} from '../../../core/tools/toolNames';
import { extractToolResultContent } from '../../../core/tools/toolResultContent';
import type {
  ChatMessage,
  CitationGroup,
  ImageAttachment,
  SubagentInfo,
  ToolCallInfo,
} from '../../../core/types';
import { t } from '../../../i18n/i18n';
import { enhanceRenderedCodeFence } from '../../../shared/components/CopyableCodeFence';
import { extractUserDisplayContent } from '../../../utils/context';
import { processFileLinks, registerFileLinkHandler } from '../../../utils/fileLink';
import { replaceImageEmbedsWithHTML } from '../../../utils/imageEmbed';
import { escapeRawHTMLTags } from '../../../utils/markdownHTML';
import {
  escapeMathDelimitersForStreaming,
  normalizeLatexMathDelimiters,
} from '../../../utils/markdownMath';
import type { ChatFeatureHost } from '../ChatFeatureHost';
import { findRewindContext } from '../rewind';
import { ImagePreviewModal } from '../ui/ImagePreviewModal';
import { formatConversationDirectoryTitle } from '../utils/conversationDirectoryTitle';
import { renderCitationGroup as renderCitationBlock } from './CitationRenderer';
import {
  prepareDisplayOnlyCodeFences,
  restoreDisplayOnlyCodeFences,
} from './DisplayOnlyCodeFences';
import { MarkdownRenderScope } from './MarkdownRenderScope';
import { renderMermaidDiagrams } from './MermaidRenderer';
import { getResponseSegments } from './NotificationBoundaries';
import {
  createResponseTextBlock,
  formatWorkDuration,
  getResponseElementKind,
  getResponseLayout,
  markResponseElement,
} from './ResponseLayout';
import { resolveSubagentAdapter } from './subagentAdapterResolution';
import { renderSubagentHistory } from './SubagentHistoryRenderer';
import {
  renderStoredAsyncSubagent,
  renderStoredSubagent,
} from './SubagentRenderer';
import { renderStoredThinkingBlock } from './ThinkingBlockRenderer';
import { renderStoredToolCall, updateToolCallResult } from './ToolCallRenderer';
import { createWelcomeElement } from './WelcomeRenderer';
import { renderStoredWriteEdit } from './WriteEditRenderer';

export { isStandaloneTaskNotification } from './ResponseLayout';

export interface RenderContentOptions {
  deferMath?: boolean;
  deferDiagrams?: boolean;
}

export type RenderContentFn = (
  el: HTMLElement,
  markdown: string,
  options?: RenderContentOptions
) => Promise<void>;

function runRendererAction(action: () => Promise<void>): void {
  void action().catch(() => {
    // UI actions already surface expected failures locally.
  });
}

export class MessageRenderer {
  private static nextHistoryId = 0;
  private app: App;
  private plugin: ChatFeatureHost;
  private component: Component;
  private messagesEl: HTMLElement;
  private rewindCallback?: (messageId: string, mode?: ChatRewindMode) => Promise<void>;
  private getCapabilities: () => ProviderCapabilities;
  private forkCallback?: (messageId: string) => Promise<void>;
  private readonly messageEls = new Map<string, HTMLElement>();
  private readonly collapsedResponses = new WeakSet<HTMLElement>();
  private liveMessageEls = new Map<string, HTMLElement>();
  private removeFileLinkHandler: () => void;
  private readonly imagePreviewModal = new ImagePreviewModal();
  private isDisposed = false;
  private readonly contentRenders = new Map<HTMLElement, MarkdownRenderScope>();
  private readonly contentRemovalObserver?: MutationObserver;

  updateQuestionTool(tool: ToolCallInfo): void {
    for (const element of this.messagesEl.querySelectorAll<HTMLElement>('[data-tool-id]')) {
      if (element.dataset.toolId === tool.id) {
        updateToolCallResult(tool.id, tool, new Map([[tool.id, element]]));
      }
    }
  }

  constructor(
    plugin: ChatFeatureHost,
    component: Component,
    messagesEl: HTMLElement,
    rewindCallback?: (messageId: string, mode?: ChatRewindMode) => Promise<void>,
    forkCallback?: (messageId: string) => Promise<void>,
    getCapabilities?: () => ProviderCapabilities,
    private readonly branchActions?: {
      navigate(messageId: string, branchMessageId?: string): Promise<void>;
      isBusy(): boolean;
    },
  ) {
    this.app = plugin.app;
    this.plugin = plugin;
    this.component = component;
    this.messagesEl = messagesEl;
    this.rewindCallback = rewindCallback;
    this.forkCallback = forkCallback;
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
            this.liveMessageEls.delete(id);
          }
          if (this.contentRenders.has(el) && !this.messagesEl.contains(el)) {
            this.releaseContentRender(el);
          }
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
    if (this.isDisposed) return;
    this.isDisposed = true;
    this.contentRemovalObserver?.disconnect();
    this.releaseContentRenders();
    this.imagePreviewModal.close();
    this.removeFileLinkHandler();
    this.removeFileLinkHandler = () => {};
    this.liveMessageEls.clear();
    this.messageEls.clear();
  }

  private getSubagentAdapter(toolName?: string) {
    return resolveSubagentAdapter(this.getCapabilities().providerId, toolName);
  }

  #shouldExpandFileEditsByDefault(): boolean {
    return this.plugin.settings?.expandFileEditsByDefault === true;
  }

  #getUserMessageTextToShow(msg: ChatMessage): string {
    return msg.displayContent ?? extractUserDisplayContent(msg.content) ?? msg.content;
  }

  refreshMessageTimestamps(): void {
    for (const msgEl of this.messagesEl.querySelectorAll<HTMLElement>('[data-message-timestamp]')) {
      this.#appendMessageTimestamp(msgEl, Number(msgEl.getAttribute('data-message-timestamp')));
    }
  }

  #appendMessageTimestamp(msgEl: HTMLElement, timestampMs: number | undefined): void {
    if (timestampMs === undefined) return;
    msgEl.setAttribute('data-message-timestamp', String(timestampMs));
    const toolbar = this.#getOrCreateActionsToolbar(msgEl);
    toolbar.querySelector<HTMLElement>('.claudian-message-timestamp')?.remove();
    if (this.plugin.settings?.showMessageTimestamps !== true) {
      return;
    }

    const timestampEl = toolbar.createDiv({ cls: 'claudian-message-timestamp' });
    const timestamp = new Date(timestampMs);
    const label = timestamp.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    timestampEl.setText(label);
    timestampEl.setAttribute('aria-label', timestamp.toLocaleString(undefined, { hourCycle: 'h23' }));
  }

  #applyTocTitle(msgEl: HTMLElement, text: string): void {
    const tocTitle = formatConversationDirectoryTitle(text);
    if (tocTitle) {
      msgEl.setAttribute('data-toc-title', tocTitle);
    } else {
      msgEl.removeAttribute('data-toc-title');
    }
  }

  // ============================================
  // Streaming Message Rendering
  // ============================================

  /**
   * Adds a new message to the chat during streaming.
   * Returns the message element for content updates.
   */
  addMessage(msg: ChatMessage): HTMLElement {
    if (msg.role === 'user' && msg.displayContent === '' && !msg.images?.length) {
      return this.messagesEl;
    }
    if (this.getCapabilities().forkMode === 'full-session') {
      this.messagesEl.querySelectorAll('.claudian-message-fork-btn').forEach(button => button.remove());
    }
    // Render images above message bubble for user messages
    if (msg.role === 'user' && msg.images && msg.images.length > 0) {
      const imagesEl = this.renderMessageImages(this.messagesEl, msg.images);
      if (!this.#getUserMessageTextToShow(msg)) {
        this.#appendMessageTimestamp(imagesEl, msg.timestamp);
      }
    }

    // Skip empty bubble for image-only messages
    if (msg.role === 'user') {
      const textToShow = this.#getUserMessageTextToShow(msg);
      if (!textToShow && !(this.branchActions && this.getCapabilities().supportsConversationBranches)) {
        this.scrollToBottom();
        const lastChild = this.messagesEl.lastElementChild as HTMLElement;
        return lastChild ?? this.messagesEl;
      }
    }

    const msgEl = this.messagesEl.createDiv({
      cls: `claudian-message claudian-message-${msg.role}`,
      attr: {
        'data-message-id': msg.id,
        'data-role': msg.role,
      },
    });

    this.messageEls.set(msg.id, msgEl);
    const contentEl = msgEl.createDiv({ cls: 'claudian-message-content', attr: { dir: 'auto' } });

    if (msg.role === 'user') {
      const textToShow = this.#getUserMessageTextToShow(msg);
      if (textToShow) {
        const textEl = createResponseTextBlock(contentEl);
        void this.renderContent(textEl, textToShow);
        this.#addUserCopyButton(msgEl, textToShow);
        this.#applyTocTitle(msgEl, textToShow);
      }
      if (this.rewindCallback || this.forkCallback || this.branchActions) {
        this.liveMessageEls.set(msg.id, msgEl);
      }
    }

    if (msg.role === 'user') this.#addBranchButtons(msgEl, msg, true);
    this.#appendMessageTimestamp(msgEl, msg.role === 'user' ? msg.timestamp : msg.completedAt);
    this.scrollToBottom();
    return msgEl;
  }

  removeMessage(messageId: string): void {
    const msgEl = this.findMessageEl(messageId);
    if (!msgEl) {
      return;
    }

    this.releaseContentRenders(msgEl);
    msgEl.remove();
    this.liveMessageEls.delete(messageId);
    this.messageEls.delete(messageId);
  }

  // ============================================
  // Stored Message Rendering (Batch/Replay)
  // ============================================

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
    this.releaseContentRenders();
    this.messagesEl.empty();
    this.liveMessageEls.clear();
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

    // Render images above bubble for user messages
    if (msg.role === 'user' && msg.images && msg.images.length > 0) {
      const imagesEl = this.renderMessageImages(this.messagesEl, msg.images);
      if (!this.#getUserMessageTextToShow(msg)) {
        this.#appendMessageTimestamp(imagesEl, msg.timestamp);
      }
    }

    // Skip empty bubble for image-only messages
    if (msg.role === 'user') {
      const textToShow = this.#getUserMessageTextToShow(msg);
      if (!textToShow && !(this.branchActions && this.getCapabilities().supportsConversationBranches)) {
        return;
      }
    }
    if (msg.role === 'assistant' && !this.#hasVisibleContent(msg)) {
      // A pre-output notification can leave an empty first segment that still
      // anchors its continuation's work disclosure when the transcript rerenders.
      const anchorsContinuation = allMessages?.some(message => message !== msg
        && getResponseSegments(message, allMessages).includes(msg));
      if (!anchorsContinuation) return;
    }

    const msgEl = this.messagesEl.createDiv({
      cls: `claudian-message claudian-message-${msg.role}`,
      attr: {
        'data-message-id': msg.id,
        'data-role': msg.role,
      },
    });

    this.messageEls.set(msg.id, msgEl);
    const contentEl = msgEl.createDiv({ cls: 'claudian-message-content', attr: { dir: 'auto' } });

    if (msg.role === 'user') {
      const textToShow = this.#getUserMessageTextToShow(msg);
      if (textToShow) {
        const textEl = createResponseTextBlock(contentEl);
        void this.renderContent(textEl, textToShow);
        this.#addUserCopyButton(msgEl, textToShow);
        this.#applyTocTitle(msgEl, textToShow);
      }
      this.#addBranchButtons(msgEl, msg);
      if (msg.userMessageId) {
        if (this.rewindCallback && this.#isRewindEligible(allMessages, index)) {
          this.#addRewindButton(msgEl, msg.id);
        }
      }
    } else if (msg.role === 'assistant') {
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

    this.#appendMessageTimestamp(msgEl, msg.role === 'user' ? msg.timestamp : msg.completedAt);
    const next = index === undefined ? undefined : allMessages?.[index + 1];
    if (msg.role === 'assistant' && (msg.durationSeconds !== undefined || next?.role !== 'assistant'
      || msg.contentBlocks?.some(block => block.type === 'task_notification'))) {
      this.finalizeResponse(msg, allMessages ?? [msg], !next?.isInterrupt, index);
    }
  }

  /** Reparents completed output without replacing live tool or Markdown elements. */
  finalizeResponse(msg: ChatMessage, messages: ChatMessage[], collapse = true, index?: number): void {
    const msgEl = this.findMessageEl(msg.id);
    const contentEl = msgEl?.querySelector<HTMLElement>('.claudian-message-content');
    if (!msgEl || !contentEl
      || this.collapsedResponses.has(msgEl)) return;

    const { blocks, finalText, canCollapse, notificationPredecessor,
      automaticNotification, earlierMessages, hasContinuation, finalBlockCount } = getResponseLayout(msg, messages, collapse, index);
    const precedingNotificationHistory = notificationPredecessor
      ? this.findMessageEl(notificationPredecessor.id)?.querySelector<HTMLElement>(
        '.claudian-task-notification .claudian-work-history',
      ) ?? null : null;
    if (automaticNotification && canCollapse) {
      let history: HTMLElement | null = precedingNotificationHistory;
      for (const child of Array.from(contentEl.children) as HTMLElement[]) {
        if (getResponseElementKind(child) === 'notification') {
          history = child.querySelector<HTMLElement>('.claudian-work-history');
        } else if (history && getResponseElementKind(child) !== 'text'
          && getResponseElementKind(child) !== 'citations') {
          history.appendChild(child);
        }
      }
    }
    if (canCollapse && !automaticNotification) {
      // Keep the disclosure at the start of its response and fold consumed
      // notifications with the work around them, preserving transcript order.
      const workContentEl = hasContinuation && earlierMessages.length
        ? this.findMessageEl(earlierMessages[0].id)?.querySelector<HTMLElement>('.claudian-message-content') ?? contentEl : contentEl;
      const earlierEls = earlierMessages.flatMap(message => {
        const el = this.findMessageEl(message.id);
        if (!el) return [];
        const previousContent = el.querySelector<HTMLElement>('.claudian-message-content');
        return previousContent === workContentEl ? Array.from(previousContent.children) as HTMLElement[] : [el];
      });
      const children = Array.from(contentEl.children) as HTMLElement[];
      const textEls = children.filter(child => getResponseElementKind(child) === 'text'
        || getResponseElementKind(child) === 'citations');
      const answerEls = new Set(textEls.slice(-finalBlockCount));
      // Fallback tool calls can follow the answer in the DOM without belonging to the answer.
      const workEls = children.filter(child => !answerEls.has(child));
      if (earlierEls.length || workEls.length || msg.durationSeconds !== undefined) {
        this.collapsedResponses.add(msgEl);
        const wrapper = workContentEl.createDiv({
          cls: 'claudian-work', attr: { 'data-work-message-id': msg.id },
        });
        workContentEl.insertBefore(wrapper, workContentEl.firstChild);
        const historyId = `claudian-work-history-${MessageRenderer.nextHistoryId++}`;
        const label = msg.durationSeconds === undefined ? 'Worked' : `Worked for ${formatWorkDuration(msg.durationSeconds)}`;
        const header = wrapper.createEl('button', {
          cls: 'claudian-work-header',
          text: label,
          attr: { type: 'button', 'aria-expanded': 'false', 'aria-controls': historyId },
        });
        const history = wrapper.createDiv({ cls: 'claudian-work-history', attr: { id: historyId } });
        history.hidden = true;
        header.addEventListener('click', () => {
          history.hidden = !history.hidden;
          header.setAttribute('aria-expanded', String(!history.hidden));
        });
        for (const el of [...earlierEls, ...workEls]) history.appendChild(el);
      }
    }

    // The response toolbar copies the final answer, leaving per-block copy inside history.
    const toolbar = this.#getOrCreateActionsToolbar(msgEl);
    toolbar.empty();
    for (const child of Array.from(contentEl.children)) {
      if (getResponseElementKind(child as HTMLElement) === 'text') {
        child.querySelector('.claudian-text-copy-btn')?.remove();
      }
    }
    const copyText = canCollapse ? finalText
      : blocks.filter(block => block.type === 'text').map(block => block.content).join('\n\n') || msg.content;
    if (copyText.trim()) this.addTextCopyButton(toolbar, copyText);
    if (this.forkCallback && msg.assistantMessageId
      && (this.getCapabilities().forkMode !== 'full-session' || messages.at(-1)?.id === msg.id)) {
      this.#addForkButton(msgEl, msg.id);
    }
    const stats = msg.turnStats;
    if (msg.role === 'assistant' && !msg.isInterrupt && stats && this.getCapabilities().supportsResponseThroughput) {
      const rate = (stats.outputTokens / (stats.durationMs / 1000)).toFixed(1);
      // Obsidian renders aria-label as its tooltip; a title would duplicate it.
      toolbar.createSpan({
        cls: 'claudian-response-throughput', text: `${rate} tok/s`,
        attr: { 'aria-label': `${stats.outputTokens.toLocaleString()} tokens · ${formatTurnDuration(stats.durationMs)}` },
      });
    }
    this.#appendMessageTimestamp(msgEl, msg.role === 'user' ? msg.timestamp : msg.completedAt);
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

  #isRewindEligible(allMessages?: ChatMessage[], index?: number): boolean {
    if (!allMessages || index === undefined) return false;
    const ctx = findRewindContext(allMessages, index);
    return ctx.hasResponse;
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
    const wrapper = markResponseElement(contentEl.createDiv({ cls: 'claudian-task-notification' }), 'notification');
    const historyId = `claudian-task-notification-${MessageRenderer.nextHistoryId++}`;
    const header = wrapper.createEl('button', {
      cls: 'claudian-work-header',
      text: 'Task notification',
      attr: { type: 'button', 'aria-expanded': 'false', 'aria-controls': historyId },
    });
    const history = wrapper.createDiv({ cls: 'claudian-work-history', attr: { id: historyId } });
    history.hidden = true;
    const body = history.createDiv({ text: content });
    let rendered = false;
    header.addEventListener('click', () => {
      if (!rendered && !this.isDisposed) {
        rendered = true;
        void this.renderContent(body, content);
      }
      history.hidden = !history.hidden;
      header.setAttribute('aria-expanded', String(!history.hidden));
    });
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
          this.renderCitationGroup(contentEl, block.citations);
        } else if (block.type === 'tool_use') {
          const toolCall = msg.toolCalls?.find(tc => tc.id === block.toolId);
          if (toolCall) {
            this.renderToolCall(contentEl, toolCall, msg);
            renderedToolIds.add(toolCall.id);
          }
        } else if (block.type === 'task_notification') {
          this.renderTaskNotification(contentEl, block.content);
        } else if (block.type === 'context_compacted') {
          const boundaryEl = contentEl.createDiv({ cls: 'claudian-compact-boundary' });
          boundaryEl.createSpan({ cls: 'claudian-compact-boundary-label', text: 'Conversation compacted' });
        } else if (block.type === 'subagent') {
          const taskToolCall = msg.toolCalls?.find((toolCall) => {
            if (toolCall.id !== block.subagentId) return false;
            const adapter = this.getSubagentAdapter(toolCall.name);
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
          this.renderToolCall(contentEl, toolCall, msg);
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
          this.renderToolCall(contentEl, toolCall, msg);
        }
      }
    }
  }

  renderCitationGroup(parentEl: HTMLElement, citations: CitationGroup): HTMLElement {
    return markResponseElement(renderCitationBlock(parentEl, citations), 'citations');
  }

  /**
   * Renders a tool call with special handling for Write/Edit, Agent (subagent),
   * and Codex collab agent lifecycle tools.
   */
  private renderToolCall(contentEl: HTMLElement, toolCall: ToolCallInfo, msg?: ChatMessage): void {
    if (!this.#shouldRenderToolCall(toolCall, msg)) return;
    const subagentAdapter = this.getSubagentAdapter(toolCall.name);

    if (isWriteEditTool(toolCall.name)) {
      renderStoredWriteEdit(contentEl, toolCall, {
        initiallyExpanded: this.#shouldExpandFileEditsByDefault(),
      });
    } else if (
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
      renderStoredToolCall(contentEl, toolCall, {
        initiallyExpanded: toolCall.name === TOOL_APPLY_PATCH ? this.#shouldExpandFileEditsByDefault() : toolCall.input.replyMode === 'user-message' ? undefined : false,
      });
    }
  }

  #shouldRenderToolCall(toolCall: ToolCallInfo, msg?: ChatMessage): boolean {
    if (toolCall.name === TOOL_WRITE_STDIN && this.#isSilentWriteStdinTool(toolCall)) return false;
    if (toolCall.name === 'custom_tool_call_output') return false;

    const subagentAdapter = this.getSubagentAdapter(toolCall.name);
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

  #isSilentWriteStdinTool(toolCall: ToolCallInfo): boolean {
    return typeof toolCall.input.chars !== 'string' || toolCall.input.chars.length === 0;
  }

  #renderTaskSubagent(
    contentEl: HTMLElement,
    toolCall: ToolCallInfo,
    modeHint?: 'sync' | 'async'
  ): void {
    const subagentInfo = this.#resolveTaskSubagent(toolCall, modeHint);
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
    const subagentAdapter = this.getSubagentAdapter(spawnToolCall.name);
    if (!subagentAdapter || subagentAdapter.protocol !== 'lifecycle') {
      renderStoredToolCall(contentEl, spawnToolCall);
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

  #resolveTaskSubagent(toolCall: ToolCallInfo, modeHint?: 'sync' | 'async'): SubagentInfo {
    if (toolCall.subagent) {
      if (!modeHint || toolCall.subagent.mode === modeHint) {
        return toolCall.subagent;
      }
      return {
        ...toolCall.subagent,
        mode: modeHint,
      };
    }

    const description = (toolCall.input?.description as string) || 'Subagent task';
    const prompt = (toolCall.input?.prompt as string) || '';
    const mode = modeHint ?? (toolCall.input?.run_in_background === true ? 'async' : 'sync');

    if (mode !== 'async') {
      return {
        id: toolCall.id,
        description,
        prompt,
        status: this.#mapToolStatusToSubagentStatus(toolCall.status),
        toolCalls: [],
        isExpanded: false,
        result: toolCall.result,
      };
    }

    const asyncStatus = this.#inferAsyncStatusFromTaskTool(toolCall);
    return {
      id: toolCall.id,
      description,
      prompt,
      mode: 'async',
      status: asyncStatus,
      asyncStatus,
      toolCalls: [],
      isExpanded: false,
      result: toolCall.result,
    };
  }

  #mapToolStatusToSubagentStatus(
    status: ToolCallInfo['status']
  ): 'completed' | 'error' | 'running' {
    switch (status) {
      case 'completed':
        return 'completed';
      case 'error':
      case 'blocked':
        return 'error';
      default:
        return 'running';
    }
  }

  #inferAsyncStatusFromTaskTool(toolCall: ToolCallInfo): 'running' | 'completed' | 'error' {
    if (toolCall.status === 'error' || toolCall.status === 'blocked') return 'error';
    if (toolCall.status === 'running') return 'running';

    const lowerResult = extractToolResultContent(toolCall.result, { fallbackIndent: 2 }).toLowerCase();
    if (
      lowerResult.includes('not_ready') ||
      lowerResult.includes('not ready') ||
      lowerResult.includes('"status":"running"') ||
      lowerResult.includes('"status":"pending"') ||
      lowerResult.includes('"retrieval_status":"running"') ||
      lowerResult.includes('"retrieval_status":"not_ready"')
    ) {
      return 'running';
    }

    return 'completed';
  }

  // ============================================
  // Image Rendering
  // ============================================

  /**
   * Renders image attachments above a message.
   */
  renderMessageImages(containerEl: HTMLElement, images: ImageAttachment[]): HTMLElement {
    const imagesEl = containerEl.createDiv({ cls: 'claudian-message-images' });

    for (const image of images) {
      const imageWrapper = imagesEl.createEl('button', {
        cls: 'claudian-message-image',
        attr: {
          'aria-label': `Preview ${image.name}`,
          type: 'button',
        },
      });
      const imgEl = imageWrapper.createEl('img', {
        attr: {
          alt: image.name,
        },
      });

      void this.setImageSrc(imgEl, image);

      imageWrapper.addEventListener('click', () => {
        void this.showFullImage(image);
      });
    }
    return imagesEl;
  }

  /**
   * Shows full-size image in modal overlay.
   */
  showFullImage(image: ImageAttachment): void {
    if (this.isDisposed) return;

    const ownerDocument = this.messagesEl.ownerDocument ?? window.document;
    this.imagePreviewModal.open(ownerDocument, image);
  }

  /**
   * Sets image src from attachment data.
   */
  setImageSrc(imgEl: HTMLImageElement, image: ImageAttachment): void {
    const dataUri = `data:${image.mediaType};base64,${image.data}`;
    imgEl.setAttribute('src', dataUri);
  }

  // ============================================
  // Content Rendering
  // ============================================

  /**
   * Renders markdown content with code block enhancements.
   */
  async renderContent(
    el: HTMLElement,
    markdown: string,
    options?: RenderContentOptions
  ): Promise<void> {
    if (this.isDisposed) return;
    this.releaseContentRender(el);
    const scope = new MarkdownRenderScope();
    this.contentRenders.set(el, scope);
    scope.register(() => {
      if (this.contentRenders.get(el) === scope) this.contentRenders.delete(el);
    });
    this.component.addChild(scope);
    scope.load();
    const isCurrent = () => !this.isDisposed && !scope.isReleased
      && this.contentRenders.get(el) === scope;
    el.empty();

    try {
      const normalizedMarkdown = normalizeLatexMathDelimiters(markdown);
      const renderMarkdown = options?.deferMath
        ? escapeMathDelimitersForStreaming(normalizedMarkdown)
        : normalizedMarkdown;
      // Escape user-authored HTML first so placeholders like <meta-name> render
      // as plain text. Trusted plugin markup (image embeds) is injected only
      // after this step, otherwise it would be escaped too.
      const safeMarkdown = escapeRawHTMLTags(renderMarkdown);
      const displayOnlyCodeFences = prepareDisplayOnlyCodeFences(safeMarkdown);
      const processedMarkdown = replaceImageEmbedsWithHTML(
        displayOnlyCodeFences.markdown,
        this.app,
        { mediaFolder: this.plugin.settings.mediaFolder }
      );
      await MarkdownRenderer.render(
        this.app,
        processedMarkdown,
        el,
        '',
        scope
      );
      if (!isCurrent()) return;
      await restoreDisplayOnlyCodeFences(el, displayOnlyCodeFences.fences);

      if (!isCurrent()) return;
      el.querySelectorAll('pre').forEach(enhanceRenderedCodeFence);
      if (!options?.deferDiagrams
        && displayOnlyCodeFences.fences.some(fence => fence.originalLanguage.toLowerCase() === 'mermaid')) {
        await renderMermaidDiagrams(el, isCurrent);
      }

      // Process wikilinks only when the source can contain them; the DOM pass is expensive.
      if (isCurrent() && processedMarkdown.includes('[[')) {
        processFileLinks(this.app, el);
      }
    } catch {
      if (!isCurrent()) return;
      this.releaseContentRender(el);
      el.createDiv({
        cls: 'claudian-render-error',
        text: 'Failed to render message content.',
      });
    }
  }

  private findMessageEl(id: string): HTMLElement | null {
    const cached = this.messageEls.get(id);
    if (cached && this.messagesEl.contains(cached)) return cached;
    this.messageEls.delete(id);
    return this.messagesEl.querySelector<HTMLElement>(`[data-message-id="${id}"]`);
  }

  private releaseContentRender(el: HTMLElement): void {
    const scope = this.contentRenders.get(el);
    if (!scope) return;
    this.contentRenders.delete(el);
    this.component.removeChild(scope);
  }

  private releaseContentRenders(container?: HTMLElement): void {
    for (const el of this.contentRenders.keys()) {
      if (!container || container === el || container.contains(el)) {
        this.releaseContentRender(el);
      }
    }
  }

  // ============================================
  // Copy Button
  // ============================================

  /**
   * Adds a copy button to a text block.
   * Button shows clipboard icon on hover, changes to "copied!" on click.
   * @param textEl The rendered text element
   * @param markdown The original markdown content to copy
   */
  addTextCopyButton(textEl: HTMLElement, markdown: string): void {
    const copyBtn = textEl.createEl('button', {
      cls: 'claudian-text-copy-btn',
      attr: {
        'aria-label': 'Copy message',
        type: 'button',
      },
    });
    setIcon(copyBtn, 'copy');

    let feedbackTimeout: number | null = null;

    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      runRendererAction(async () => {

        try {
          await navigator.clipboard.writeText(markdown);
        } catch {
          // Clipboard API may fail in non-secure contexts
          return;
        }

        // Clear any pending timeout from rapid clicks
        if (feedbackTimeout) {
          window.clearTimeout(feedbackTimeout);
        }

        // Show "copied!" feedback
        copyBtn.empty();
        copyBtn.setText('Copied!');
        copyBtn.classList.add('copied');

        feedbackTimeout = window.setTimeout(() => {
          copyBtn.empty();
          setIcon(copyBtn, 'copy');
          copyBtn.classList.remove('copied');
          feedbackTimeout = null;
        }, 1500);
      });
    });
  }

  refreshActionButtons(msg: ChatMessage, allMessages?: ChatMessage[], index?: number): void {
    this.refreshBranchButtons([msg]);
    if (!msg.userMessageId || !this.#isRewindEligible(allMessages, index)) return;
    const msgEl = this.liveMessageEls.get(msg.id);
    if (!msgEl) return;
    if (this.rewindCallback && !msgEl.querySelector('.claudian-message-rewind-btn')) {
      this.#addRewindButton(msgEl, msg.id);
    }
    this.liveMessageEls.delete(msg.id);
  }

  refreshBranchButtons(messages: readonly ChatMessage[]): void {
    if (!this.branchActions || !this.getCapabilities().supportsConversationBranches) return;
    const elements = new Map(Array.from(this.messagesEl.querySelectorAll<HTMLElement>('[data-message-id]'))
      .map(element => [element.dataset.messageId, element]));
    for (const message of messages) {
      const element = this.liveMessageEls.get(message.id) ?? elements.get(message.id);
      if (element) this.#addBranchButtons(element, message, this.liveMessageEls.has(message.id));
    }
    this.refreshBranchButtonState();
  }

  refreshBranchButtonState(): void {
    this.messagesEl.querySelectorAll<HTMLButtonElement>('[data-branch-action]').forEach(button => {
      this.#updateBranchButtonState(button);
    });
  }

  #updateBranchButtonState(button: HTMLButtonElement): void {
    const busy = !!this.branchActions?.isBusy();
    const unavailable = button.dataset.branchUnavailable === 'true';
    button.disabled = busy || unavailable;
    // Obsidian uses aria-label for its tooltip; title would add a second one.
    button.setAttribute('aria-description', busy ? 'Wait for the current response to finish.'
      : unavailable ? button.dataset.branchUnavailableReason ?? '' : '');
  }

  #addBranchButtons(element: HTMLElement, message: ChatMessage, pendingNativeIdentity = false): void {
    if (!this.branchActions || !this.getCapabilities().supportsConversationBranches
      || message.role !== 'user' || (!message.treeBranches && !pendingNativeIdentity)) return;
    element.querySelectorAll('[data-branch-action], .claudian-branch-position, .claudian-branch-marker').forEach(child => child.remove());
    element.classList.remove('claudian-message-branched');
    const toolbar = this.#getOrCreateActionsToolbar(element);
    if (element === this.messagesEl.querySelector('[data-role="user"]')) return;
    const anchor = toolbar.querySelector('.claudian-user-msg-copy-btn, .claudian-message-timestamp');
    const addButton = (label: string, icon: string, target?: string, unavailable = false, reason = '') => {
      const button = toolbar.createEl('button', {
        attr: { type: 'button', 'aria-label': label, 'data-branch-action': 'true', 'data-branch-unavailable': String(unavailable), 'data-branch-unavailable-reason': reason },
      });
      toolbar.insertBefore(button, anchor);
      setIcon(button, icon);
      this.#updateBranchButtonState(button);
      button.addEventListener('click', event => {
        event.stopPropagation();
        if (this.branchActions!.isBusy() || unavailable) return;
        runRendererAction(() => this.branchActions!.navigate(message.id, target));
      });
    };
    const branches = message.treeBranches ?? [];
    const index = message.userMessageId ? branches.indexOf(message.userMessageId) : -1;
    if (branches.length > 1 && index >= 0) {
      element.classList.add('claudian-message-branched');
      const marker = element.querySelector('.claudian-message-content')?.createSpan({
        cls: 'claudian-branch-marker', attr: { 'aria-hidden': 'true' },
      });
      if (marker) setIcon(marker, 'git-branch');
      addButton('Previous branch', 'chevron-left', branches[index - 1], index === 0, 'No previous branch.');
      const position = toolbar.createSpan({ cls: 'claudian-branch-position', text: `${index + 1}/${branches.length}`,
        attr: { 'aria-label': `Branch ${index + 1} of ${branches.length}` } });
      toolbar.insertBefore(position, anchor);
      addButton('Next branch', 'chevron-right', branches[index + 1], index === branches.length - 1, 'No next branch.');
    }
    addButton('Branch from this prompt', 'git-branch', undefined, !message.userMessageId,
      'Branching is available after this prompt is saved.');
  }

  #getOrCreateActionsToolbar(msgEl: HTMLElement): HTMLElement {
    const existing = Array.from(msgEl.children).find(child => child.classList.contains('claudian-user-msg-actions')) as HTMLElement | undefined;
    if (existing) return existing;
    return msgEl.createDiv({ cls: 'claudian-user-msg-actions claudian-message-actions' });
  }

  #addUserCopyButton(msgEl: HTMLElement, content: string): void {
    const toolbar = this.#getOrCreateActionsToolbar(msgEl);
    const copyBtn = toolbar.createEl('button', {
      cls: 'claudian-user-msg-copy-btn',
      attr: { type: 'button' },
    });
    setIcon(copyBtn, 'copy');
    copyBtn.setAttribute('aria-label', 'Copy message');

    let feedbackTimeout: number | null = null;

    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      runRendererAction(async () => {
        try {
          await navigator.clipboard.writeText(content);
        } catch {
          return;
        }
        if (feedbackTimeout) window.clearTimeout(feedbackTimeout);
        copyBtn.empty();
        copyBtn.setText('Copied!');
        copyBtn.classList.add('copied');
        feedbackTimeout = window.setTimeout(() => {
          copyBtn.empty();
          setIcon(copyBtn, 'copy');
          copyBtn.classList.remove('copied');
          feedbackTimeout = null;
        }, 1500);
      });
    });
  }

  #addRewindButton(msgEl: HTMLElement, messageId: string): void {
    if (!this.getCapabilities().supportsRewind) return;
    const toolbar = this.#getOrCreateActionsToolbar(msgEl);
    const btn = toolbar.createEl('button', {
      cls: 'claudian-message-rewind-btn',
      attr: { type: 'button' },
    });
    if (toolbar.firstChild !== btn) toolbar.insertBefore(btn, toolbar.firstChild);
    setIcon(btn, 'rotate-ccw');
    btn.setAttribute('aria-label', t('chat.rewind.ariaLabel'));
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.#showRewindMenu(e, messageId, btn);
    });
  }

  #showRewindMenu(
    event: MouseEvent,
    messageId: string,
    anchor: HTMLButtonElement,
  ): void {
    const menu = new Menu();
    this.#addRewindMenuItem(menu, messageId, 'conversation');
    this.#addRewindMenuItem(menu, messageId, 'code-and-conversation');
    if (event.detail > 0) {
      menu.showAtMouseEvent(event);
      return;
    }
    const rect = anchor.getBoundingClientRect();
    menu.showAtPosition({ x: rect.left, y: rect.bottom }, anchor.ownerDocument);
  }

  #addRewindMenuItem(menu: Menu, messageId: string, mode: ChatRewindMode): void {
    menu.addItem((item) => {
      item
        .setTitle(
          mode === 'conversation'
            ? t('chat.rewind.menuConversationOnly')
            : t('chat.rewind.menuCodeAndConversation')
        )
        .setIcon(mode === 'conversation' ? 'message-square' : 'rotate-ccw')
        .onClick(() => {
          runRendererAction(async () => {
            try {
              await this.rewindCallback?.(messageId, mode);
            } catch (err) {
              new Notice(t('chat.rewind.failed', { error: err instanceof Error ? err.message : 'Unknown error' }));
            }
          });
        });
    });
  }

  #addForkButton(msgEl: HTMLElement, messageId: string): void {
    if (!this.getCapabilities().supportsFork) return;
    const toolbar = this.#getOrCreateActionsToolbar(msgEl);
    const btn = toolbar.createEl('button', {
      cls: 'claudian-message-fork-btn',
      attr: { type: 'button' },
    });
    setIcon(btn, 'git-fork');
    btn.setAttribute('aria-label', t('chat.fork.ariaLabel'));
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      runRendererAction(async () => {
        try {
          await this.forkCallback?.(messageId);
        } catch (err) {
          new Notice(t('chat.fork.failed', { error: err instanceof Error ? err.message : 'Unknown error' }));
        }
      });
    });
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

/** Rounds to tenths before splitting so 119.96s reads "2m 0s", not "1m 60s". */
function formatTurnDuration(durationMs: number): string {
  const tenths = Math.round(durationMs / 100);
  const seconds = `${(tenths % 600) / 10}s`;
  return tenths < 600 ? seconds : `${Math.floor(tenths / 600)}m ${seconds}`;
}
