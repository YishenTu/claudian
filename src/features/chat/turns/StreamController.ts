import { DEFAULT_CHAT_PROVIDER_ID, type ProviderId } from '@/core/providers/types';
import type {
  ChatMessage,
  StreamChunk,
  ToolCallInfo,
} from '@/core/types';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import { renderCitationGroup } from '@/features/chat/rendering/CitationRenderer';
import {
  getPluginFenceLanguageSet,
  hasDeferredDiagramFence,
} from '@/features/chat/rendering/markdown/DisplayOnlyCodeFences';
import type { RenderContentOptions } from '@/features/chat/rendering/markdown/MarkdownContentRenderer';
import type { LiveTranscriptOptions, MessageRenderer } from '@/features/chat/rendering/MessageRenderer';
import { createResponseTextBlock } from '@/features/chat/rendering/ResponseLayout';
import {
  createThinkingBlock,
  finalizeThinkingBlock,
  type ThinkingBlockState,
} from '@/features/chat/rendering/ThinkingBlockRenderer';
import type { ChatState } from '@/features/chat/state/ChatState';
import type { AsyncSubagentHistoryRecovery } from '@/features/chat/subagents/AsyncSubagentHistoryRecovery';
import type { SubagentManager } from '@/features/chat/subagents/SubagentManager';
import { SubagentStreamRouter } from '@/features/chat/subagents/SubagentStreamRouter';
import { StreamingRenderCoordinator } from '@/features/chat/turns/StreamingRenderCoordinator';
import { ThinkingIndicator } from '@/features/chat/turns/ThinkingIndicator';
import { mergeToolProviderPayload, ToolCallStream } from '@/features/chat/turns/ToolCallStream';
import {
  cancelScheduledAnimationFrame,
  scheduleAnimationFrame,
  type ScheduledAnimationFrame,
} from '@/features/chat/utils/animationFrame';
import { hasStreamingMathDelimiters } from '@/utils/markdownMath';

export interface StreamControllerDeps {
  onQuestionToolChanged?: (tool: ToolCallInfo) => void;
  plugin: ChatFeatureHost;
  state: ChatState;
  renderer: MessageRenderer | null;
  subagentManager: SubagentManager;
  getMessagesEl: () => HTMLElement | null;
  updateQueueIndicator: () => void;
  getProviderId?: () => ProviderId;
  /** Recovers finished async subagents from provider history; absent when the owner has none. */
  asyncSubagentHistoryRecovery?: AsyncSubagentHistoryRecovery;
}

interface StreamingContentSnapshot {
  el: HTMLElement;
  content: string;
  /** Final renders never defer math or diagrams. */
  final?: true;
}

const STREAMING_RENDER_MIN_INTERVAL_MS = 150;

/**
 * Renders one response stream: text and thinking blocks, ordering between content types,
 * and scroll and render availability. Tool cards, subagents, and the waiting indicator are
 * delegated to their owners.
 */
export class StreamController {
  readonly thinkingIndicator: ThinkingIndicator;
  readonly subagents: SubagentStreamRouter;
  readonly #tools: ToolCallStream;
  private deps: StreamControllerDeps;
  private readonly textRenderCoordinator: StreamingRenderCoordinator<StreamingContentSnapshot>;
  private readonly thinkingRenderCoordinator: StreamingRenderCoordinator<StreamingContentSnapshot>;
  private tabActive = true;
  private viewportVisible = true;
  private readonly backgroundStreams = new Set<StreamController>();
  private onDispose?: () => void;
  private pendingScrollFrame: ScheduledAnimationFrame | null = null;

  constructor(deps: StreamControllerDeps) {
    this.deps = deps;
    const scrollToBottom = () => this.scrollToBottom();
    this.thinkingIndicator = new ThinkingIndicator({
      state: deps.state,
      getMessagesEl: deps.getMessagesEl,
      updateQueueIndicator: deps.updateQueueIndicator,
      scrollToBottom,
    });
    this.#tools = new ToolCallStream({
      plugin: deps.plugin,
      state: deps.state,
      indicator: this.thinkingIndicator,
      getMessagesEl: deps.getMessagesEl,
      scrollToBottom,
      onQuestionToolChanged: deps.onQuestionToolChanged,
    });
    this.subagents = new SubagentStreamRouter({
      state: deps.state,
      subagentManager: deps.subagentManager,
      getMessagesEl: deps.getMessagesEl,
      getProviderId: () => this.deps.getProviderId?.() ?? DEFAULT_CHAT_PROVIDER_ID,
      asyncSubagentHistoryRecovery: deps.asyncSubagentHistoryRecovery,
      tools: this.#tools,
      indicator: this.thinkingIndicator,
      scrollToBottom,
    });
    this.textRenderCoordinator = this.#createRenderCoordinator(
      () => this.#getStreamingRenderWindow()
    );
    this.thinkingRenderCoordinator = this.#createRenderCoordinator(
      () => this.#getThinkingRenderWindow()
    );
  }

  /** Starts a requested response with fresh tool tracking and usage accounting. */
  beginResponse(): void {
    this.#tools.beginResponse();
    this.deps.subagentManager.resetSpawnedCount();
  }

  /** Share provider/subagent ownership, but isolate a background response's render buffers. */
  createBackgroundStream(state: ChatState): StreamController {
    const deps = this.deps;
    const stream = new StreamController({ ...deps, state, get renderer() { return deps.renderer; } });
    this.backgroundStreams.add(stream);
    stream.onDispose = () => this.backgroundStreams.delete(stream);
    stream.tabActive = this.tabActive;
    stream.viewportVisible = this.viewportVisible;
    return stream;
  }

  /** Cursors share transcript order while keeping each response's unfinished blocks separate. */
  get responseStates(): readonly ChatState[] {
    return [this.deps.state, ...[...this.backgroundStreams].flatMap(stream => stream.responseStates)];
  }

  get liveTranscriptOptions(): LiveTranscriptOptions {
    return {
      isResponseOpen: id => this.responseStates.some(state => state.response.messageId === id),
      isSubagentTracked: id => this.deps.subagentManager.isTracking(id),
      onToolRendered: (tool, view) => {
        for (const state of this.responseStates) {
          state.toolCallElements.set(tool.id, view.element);
          if (view.writeEditState) state.writeEditStates.set(tool.id, view.writeEditState);
        }
      },
      renderSubagent: (parent, info) => this.deps.subagentManager.attachTaskView(info, parent),
      reservePendingSubagent: (parent, toolId) => this.deps.subagentManager.attachPendingTaskView(toolId, parent),
    };
  }

  /** Cancels presentation jobs and releases DOM references without changing response models. */
  detachPresentation(): void {
    for (const stream of this.backgroundStreams) stream.detachPresentation();
    this.textRenderCoordinator.cancel();
    this.thinkingRenderCoordinator.cancel();
    this.#cancelPendingScroll();
    this.thinkingIndicator.detachPresentation();
    this.#tools.cancelAll();
    this.deps.state.detachPresentation();
  }

  /** Called synchronously after the transcript's closed blocks and live cards are reconstructed. */
  restorePresentation(): void {
    const { state, renderer } = this.deps;
    state.currentContentEl = state.response.messageId
      ? renderer?.getMessageContentEl(state.response.messageId) ?? null : null;
    if (state.currentTextContent) void this.appendText('');
    if (state.currentThinkingBlock) void this.appendThinking('');
    if (!state.currentTextContent && !state.currentThinkingBlock && state.response.messageId) this.thinkingIndicator.show();
    for (const stream of this.backgroundStreams) stream.restorePresentation();
  }

  #createRenderCoordinator(
    getOwnerWindow: () => Window | null
  ): StreamingRenderCoordinator<StreamingContentSnapshot> {
    return new StreamingRenderCoordinator({
      getOwnerWindow,
      minIntervalMs: STREAMING_RENDER_MIN_INTERVAL_MS,
      maxIntervalMs: 500,
      render: async ({ el, content, final }) => {
        // Derive options only when a render runs so hidden or throttled deltas skip the scans.
        const options = final ? undefined : this.#getStreamingRenderOptions(content);
        if (options) {
          await this.deps.renderer?.renderContent(el, content, options);
        } else {
          await this.deps.renderer?.renderContent(el, content);
        }
        this.scrollToBottom();
      },
    });
  }

  // ============================================
  // Stream Chunk Handling
  // ============================================

  async handleStreamChunk(chunk: StreamChunk, msg: ChatMessage): Promise<void> {
    if ((chunk.type === 'text' || chunk.type === 'thinking') && chunk.content.length === 0) return;
    const { state } = this.deps;
    state.response.messageId ??= msg.id;
    const responseMessage = msg;
    // A notification may split display messages while tools from the earlier segment still run.
    const ownerToolId = chunk.type === 'subagent_tool_use' || chunk.type === 'subagent_tool_result' || chunk.type === 'subagent_tool_output'
      ? chunk.subagentId
      : chunk.type === 'tool_use' || chunk.type === 'tool_result' || chunk.type === 'tool_output' ? chunk.id : undefined;
    if (ownerToolId && !msg.toolCalls?.some(tool => tool.id === ownerToolId)) {
      msg = [...state.messages].reverse().find(message => message.toolCalls?.some(tool => tool.id === ownerToolId)) ?? msg;
    }

    switch (chunk.type) {
      case 'thinking':
        this.#tools.flush();
        if (state.currentTextContent) {
          await this.finalizeCurrentTextBlock(msg);
        }
        await this.appendThinking(chunk.content);
        state.recordActivity({ kind: 'thinking' });
        break;

      case 'text':
        this.#tools.flush();
        if (state.currentThinkingBlock) {
          await this.finalizeCurrentThinkingBlock(msg);
        }
        msg.content += chunk.content;
        await this.appendText(chunk.content);
        state.recordActivity({ kind: 'text', text: state.currentTextContent });
        break;

      case 'citations':
        await this.#closeOpenBlocks(msg);
        msg.contentBlocks = msg.contentBlocks || [];
        msg.contentBlocks.push({ type: 'citations', citations: chunk.citations });
        if (state.currentContentEl) {
          renderCitationGroup(state.currentContentEl, chunk.citations);
        }
        break;

      case 'tool_use':
        if (state.currentThinkingBlock) {
          await this.finalizeCurrentThinkingBlock(responseMessage);
        }
        await this.finalizeCurrentTextBlock(responseMessage);
        if (!this.subagents.routeToolUse(chunk, msg)) {
          this.#tools.use(chunk, msg);
        }
        break;

      case 'tool_result': {
        // The payload belongs to the tool even when a subagent consumes its result.
        const resultToolCall = msg.toolCalls?.find(toolCall => toolCall.id === chunk.id);
        if (resultToolCall) mergeToolProviderPayload(resultToolCall, chunk.providerPayload);
        if (!await this.subagents.routeToolResult(chunk, msg)) {
          this.#tools.complete(chunk, msg);
        }
        break;
      }

      case 'subagent_tool_use':
      case 'subagent_tool_output':
      case 'subagent_tool_result':
        this.subagents.routeChildChunk(chunk, msg);
        break;

      case 'tool_output':
        this.#tools.output(chunk, msg);
        break;

      case 'notice':
        this.#tools.flush();
        await this.appendText(`\n\n⚠️ **${chunk.level === 'warning' ? 'Blocked' : 'Notice'}:** ${chunk.content}`);
        break;

      case 'error':
        this.#tools.flush();
        await this.appendError(chunk.content, '❌ **Error:**');
        break;

      case 'done':
        this.#tools.flush();
        break;

      case 'task_notification':
        await this.#closeOpenBlocks(msg);
        msg.contentBlocks = msg.contentBlocks || [];
        msg.contentBlocks.push({ type: 'task_notification', content: chunk.content });
        if (state.currentContentEl) {
          this.deps.renderer?.renderTaskNotification(state.currentContentEl, chunk.content);
        }
        break;

      case 'context_compacted':
        await this.#closeOpenBlocks(msg);
        msg.contentBlocks = msg.contentBlocks || [];
        msg.contentBlocks.push({ type: 'context_compacted' });
        this.#renderCompactBoundary();
        break;

      case 'usage':
        // Skip usage updates when subagents ran (SDK reports cumulative usage including subagents)
        if (this.deps.subagentManager.subagentsSpawnedThisStream > 0) {
          break;
        }
        state.reportUsage(chunk.usage);
        break;

      default:
        break;
    }

    if (chunk.type === 'tool_use' || chunk.type === 'tool_result') {
      const tool = msg.toolCalls?.find(candidate => candidate.id === chunk.id);
      if (tool) state.recordActivity({ kind: 'tool', tool });
    }

    this.scrollToBottom();
  }

  /** Renders buffered tools and finalizes open thinking and text before a standalone block. */
  async #closeOpenBlocks(msg: ChatMessage): Promise<void> {
    this.#tools.flush();
    if (this.deps.state.currentThinkingBlock) {
      await this.finalizeCurrentThinkingBlock(msg);
    }
    await this.finalizeCurrentTextBlock(msg);
  }

  #shouldDeferMathRendering(): boolean {
    return this.deps.plugin.settings.deferMathRenderingDuringStreaming !== false;
  }

  #getStreamingRenderOptions(content: string): RenderContentOptions | undefined {
    const deferMath = this.#shouldDeferMathRendering() && hasStreamingMathDelimiters(content);
    const deferDiagrams = hasDeferredDiagramFence(
      content,
      getPluginFenceLanguageSet(this.deps.plugin.settings.pluginRenderedFenceLanguages),
    );
    if (!deferMath && !deferDiagrams) return undefined;
    return {
      ...(deferMath ? { deferMath: true } : {}),
      ...(deferDiagrams ? { deferDiagrams: true } : {}),
    };
  }

  // ============================================
  // Text Block Management
  // ============================================

  /** Renders a terminal error and publishes it as the latest activity. */
  async appendError(message: string, label = '**Error:**'): Promise<void> {
    await this.appendText(`\n\n${label} ${message}`);
    this.deps.state.recordActivity({ kind: 'error', message });
  }

  async appendText(text: string): Promise<void> {
    const { state } = this.deps;
    state.currentTextContent += text;
    this.thinkingIndicator.hide();
    if (!state.currentContentEl) return;

    if (!state.currentTextEl) {
      this.textRenderCoordinator.cancel();
      state.currentTextEl = createResponseTextBlock(state.currentContentEl);
    }

    this.textRenderCoordinator.request({
      el: state.currentTextEl,
      content: state.currentTextContent,
    });
    this.thinkingIndicator.afterTextPause();
  }

  async finalizeCurrentTextBlock(msg?: ChatMessage): Promise<void> {
    const { state, renderer } = this.deps;
    const textEl = state.currentTextEl;
    const content = state.currentTextContent;

    if (msg && content) {
      msg.contentBlocks = msg.contentBlocks || [];
      msg.contentBlocks.push({ type: 'text', content });
    }
    state.currentTextEl = null;
    state.currentTextContent = '';
    if (textEl && this.#getStreamingRenderOptions(content)) {
      this.textRenderCoordinator.request({ el: textEl, content, final: true });
    }
    await this.textRenderCoordinator.flush();
    if (textEl && msg && content) renderer?.addTextCopyButton(textEl, content);
    this.textRenderCoordinator.cancel();
  }

  // ============================================
  // Thinking Block Management
  // ============================================

  async appendThinking(content: string): Promise<void> {
    const { state } = this.deps;
    const block = state.currentThinkingBlock ??= { content: '', startTime: Date.now() };
    block.content += content;
    this.thinkingIndicator.hide();
    if (!state.currentContentEl) return;
    if (!state.currentThinkingState) {
      this.thinkingRenderCoordinator.cancel();
      const thinkingState = createThinkingBlock(state.currentContentEl, {
        startTime: block.startTime,
        onToggle: (isExpanded) => {
          this.#handleThinkingToggle(thinkingState, isExpanded);
        },
      });
      state.currentThinkingState = thinkingState;
      this.#syncThinkingRenderAvailability();
    }

    this.thinkingRenderCoordinator.request({
      el: state.currentThinkingState.contentEl,
      content: block.content,
    });
  }

  async finalizeCurrentThinkingBlock(msg?: ChatMessage): Promise<void> {
    const { state } = this.deps;
    const block = state.currentThinkingBlock;
    if (!block) return;

    const thinkingState = state.currentThinkingState;
    const durationSeconds = Math.floor((Date.now() - block.startTime) / 1000);
    if (msg && block.content) {
      msg.contentBlocks = msg.contentBlocks || [];
      msg.contentBlocks.push({ type: 'thinking', content: block.content, durationSeconds });
    }
    state.currentThinkingBlock = null;
    state.currentThinkingState = null;
    if (thinkingState && this.#getStreamingRenderOptions(block.content)) {
      this.thinkingRenderCoordinator.request({ el: thinkingState.contentEl, content: block.content, final: true });
    }
    await this.thinkingRenderCoordinator.flush();
    if (thinkingState) finalizeThinkingBlock(thinkingState, durationSeconds);
    this.thinkingRenderCoordinator.cancel();
  }

  #handleThinkingToggle(
    thinkingState: ThinkingBlockState,
    isExpanded: boolean
  ): void {
    if (this.deps.state.currentThinkingState !== thinkingState) return;

    thinkingState.isExpanded = isExpanded;
    this.#syncThinkingRenderAvailability();
  }

  // ============================================
  // Compact Boundary
  // ============================================

  #renderCompactBoundary(): void {
    const { state } = this.deps;
    if (!state.currentContentEl) return;
    // Compaction is over; later waiting in this response shows ordinary flavor.
    this.thinkingIndicator.endExplicit();
    const el = state.currentContentEl.createDiv({ cls: 'claudian-compact-boundary' });
    el.createSpan({ cls: 'claudian-compact-boundary-label', text: 'Conversation compacted' });
  }

  // ============================================
  // Utilities
  // ============================================

  /** Scrolls messages to bottom if auto-scroll is enabled. */
  private scrollToBottom(): void {
    if (this.pendingScrollFrame !== null || !this.deps.getMessagesEl()) return;

    this.pendingScrollFrame = scheduleAnimationFrame(() => {
      this.pendingScrollFrame = null;
      this.#applyScrollToBottom();
    }, this.#getMessagesWindow());
  }

  #applyScrollToBottom(): void {
    const { state, plugin } = this.deps;
    if (!(plugin.settings.enableAutoScroll ?? true)) return;
    if (!state.autoScrollEnabled) return;

    const messagesEl = this.deps.getMessagesEl();
    if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  #cancelPendingScroll(): void {
    if (this.pendingScrollFrame === null) return;

    cancelScheduledAnimationFrame(this.pendingScrollFrame);
    this.pendingScrollFrame = null;
  }

  setTabActive(active: boolean): void {
    this.tabActive = active;
    this.#syncRenderAvailability();
  }

  setViewportVisible(visible: boolean): void {
    this.viewportVisible = visible;
    this.#syncRenderAvailability();
  }

  #syncRenderAvailability(): void {
    const visible = this.tabActive && this.viewportVisible;
    this.textRenderCoordinator.setAvailable(visible);
    this.#syncThinkingRenderAvailability();
  }

  #syncThinkingRenderAvailability(): void {
    const thinkingExpanded = this.deps.state.currentThinkingState?.isExpanded === true;
    this.thinkingRenderCoordinator.setAvailable(
      this.tabActive && this.viewportVisible && thinkingExpanded
    );
  }

  #getMessagesWindow(): Window | null {
    return this.deps.getMessagesEl()?.ownerDocument.defaultView ?? null;
  }

  #getStreamingRenderWindow(): Window | null {
    const { state } = this.deps;
    return state.currentTextEl?.ownerDocument?.defaultView
      ?? state.currentContentEl?.ownerDocument?.defaultView
      ?? this.#getMessagesWindow();
  }

  #getThinkingRenderWindow(): Window | null {
    const { state } = this.deps;
    return state.currentThinkingState?.contentEl.ownerDocument?.defaultView
      ?? state.currentContentEl?.ownerDocument?.defaultView
      ?? this.#getMessagesWindow();
  }

  resetStreamingState(): void {
    const { state } = this.deps;
    this.textRenderCoordinator.cancel();
    this.thinkingRenderCoordinator.cancel();
    this.#cancelPendingScroll();
    this.thinkingIndicator.hide();
    state.resetStreamingPresentation();
    this.subagents.reset();
    this.#tools.cancelAll();
  }

  dispose(): void {
    this.onDispose?.();
    this.onDispose = undefined;
    for (const stream of this.backgroundStreams) stream.dispose();
    this.thinkingIndicator.dispose();
    this.subagents.releaseManaged();
    this.textRenderCoordinator.dispose();
    this.thinkingRenderCoordinator.dispose();
    this.#tools.cancelAll();
    this.#cancelPendingScroll();
  }
}
