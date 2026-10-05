import { resolveToolDiffData } from '@/core/tools/toolDiff';
import { extractResolvedAnswersFromResultText } from '@/core/tools/toolInput';
import {
  isEditTool,
  isWriteEditTool,
  TOOL_APPLY_PATCH,
  TOOL_ASK_USER_QUESTION,
} from '@/core/tools/toolNames';
import { normalizeToolProviderPayload } from '@/core/tools/toolProviderPayload';
import { extractToolResultContent } from '@/core/tools/toolResultContent';
import { applyToolResultPresentation } from '@/core/tools/toolResultDetails';
import type { ChatMessage, StreamChunk, ToolCallInfo } from '@/core/types';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import { updateToolCallResult } from '@/features/chat/rendering/tools/ToolCallRenderer';
import { isSilentWriteStdinTool, renderToolCard } from '@/features/chat/rendering/tools/toolCardDispatch';
import { getToolName, getToolSummary } from '@/features/chat/rendering/tools/toolPresentation';
import { finalizeWriteEditBlock, updateWriteEditWithDiff } from '@/features/chat/rendering/tools/WriteEditRenderer';
import type { ChatState } from '@/features/chat/state/ChatState';
import type { ThinkingIndicator } from '@/features/chat/turns/ThinkingIndicator';
import {
  notifyApplyPatchFileChanges,
  notifyScriptFileChanges,
  notifyVaultFileChange,
} from '@/features/chat/turns/vaultFileChangeNotifications';
import {
  cancelScheduledAnimationFrame,
  scheduleAnimationFrame,
  type ScheduledAnimationFrame,
} from '@/features/chat/utils/animationFrame';

/** A tool call as reported by a stream chunk, before the stream records its lifecycle. */
interface ToolCallChunk {
  id: string;
  name: string;
  input: Record<string, unknown>;
  providerPayload?: unknown;
}

/** A tool completion as reported by a stream chunk. */
interface ToolCompletionChunk {
  content: unknown;
  isError?: boolean;
  isBlocked?: boolean;
  providerPayload?: unknown;
  resultDetails?: Extract<StreamChunk, { type: 'tool_result' }>['resultDetails'];
}

export function toolCallFromChunk(chunk: ToolCallChunk): ToolCallInfo {
  const providerPayload = normalizeToolProviderPayload(chunk.providerPayload);
  return {
    id: chunk.id,
    name: chunk.name,
    input: chunk.input,
    ...(providerPayload ? { providerPayload } : {}),
    status: 'running',
    isExpanded: false,
  };
}

export function mergeToolProviderPayload(toolCall: ToolCallInfo, value: unknown): void {
  const providerPayload = normalizeToolProviderPayload(value);
  if (!providerPayload) return;
  toolCall.providerPayload = {
    ...toolCall.providerPayload,
    ...providerPayload,
  };
}

/** Applies a repeated tool snapshot; a blank name or empty input keeps the earlier value. */
export function mergeToolCallChunk(
  toolCall: ToolCallInfo,
  chunk: ToolCallChunk,
): { nameChanged: boolean; inputChanged: boolean } {
  const refinedName = chunk.name.trim();
  const nameChanged = refinedName.length > 0 && refinedName !== toolCall.name;
  if (nameChanged) toolCall.name = refinedName;
  mergeToolProviderPayload(toolCall, chunk.providerPayload);
  const input = chunk.input || {};
  const inputChanged = Object.keys(input).length > 0;
  if (inputChanged) toolCall.input = { ...toolCall.input, ...input };
  return { nameChanged, inputChanged };
}

/**
 * Records a provider-reported completion. Outcomes come from the provider boundary; result
 * content is arbitrary tool data and is never interpreted as status metadata.
 */
export function applyToolCompletion(toolCall: ToolCallInfo, chunk: ToolCompletionChunk): void {
  mergeToolProviderPayload(toolCall, chunk.providerPayload);
  toolCall.status = chunk.isBlocked === true
    ? 'blocked'
    : (chunk.isError ? 'error' : 'completed');
  toolCall.result = extractToolResultContent(chunk.content, { fallbackIndent: 2 });
  applyToolResultPresentation(toolCall, chunk.resultDetails);
}

export interface ToolCallStreamDeps {
  plugin: Pick<ChatFeatureHost, 'app' | 'settings'>;
  state: ChatState;
  indicator: Pick<ThinkingIndicator, 'show'>;
  getMessagesEl: () => HTMLElement;
  scrollToBottom: () => void;
  onQuestionToolChanged?: (tool: ToolCallInfo) => void;
}

/**
 * Streams main-agent tool cards. While a response streams, this is the only writer of the
 * state's pending tools, rendered tool elements, and write/edit block states. New tools are
 * buffered until another content type arrives so repeated snapshots refine them before render.
 */
export class ToolCallStream {
  readonly #outputFrames = new Map<string, ScheduledAnimationFrame>();

  constructor(private readonly deps: ToolCallStreamDeps) {}

  beginResponse(): void {
    this.cancelAll();
    this.deps.state.toolCallElements.clear();
    this.deps.state.writeEditStates.clear();
  }

  use(chunk: Extract<StreamChunk, { type: 'tool_use' }>, msg: ChatMessage): void {
    const { state } = this.deps;

    const existing = msg.toolCalls?.find(tc => tc.id === chunk.id);
    if (existing) {
      const { nameChanged, inputChanged } = mergeToolCallChunk(existing, chunk);
      if (isSilentWriteStdinTool(existing)) {
        this.remove(existing.id);
        return;
      }
      if (nameChanged || inputChanged) {
        const rendererRebuilt = nameChanged && this.#rebuildRenderedTool(existing);
        // A pending tool already renders from the updated tool call; a rendered one refreshes its header.
        const toolEl = rendererRebuilt ? null : state.toolCallElements.get(chunk.id);
        if (toolEl) {
          const nameEl = toolEl.querySelector('.claudian-tool-name')
            ?? toolEl.querySelector('.claudian-write-edit-name');
          nameEl?.setText(getToolName(existing.name, existing.input));
          const summaryEl = toolEl.querySelector('.claudian-tool-summary')
            ?? toolEl.querySelector('.claudian-write-edit-summary');
          summaryEl?.setText(getToolSummary(existing.name, existing.input));
        }
      }
      this.deps.onQuestionToolChanged?.(existing);
      this.#ensureVisible(existing, msg);
      return;
    }

    const toolCall = toolCallFromChunk(chunk);
    msg.toolCalls = msg.toolCalls || [];
    msg.toolCalls.push(toolCall);
    this.deps.onQuestionToolChanged?.(toolCall);
    msg.contentBlocks = msg.contentBlocks || [];
    msg.contentBlocks.push({ type: 'tool_use', toolId: chunk.id });
    this.#buffer(toolCall);
  }

  output(chunk: Extract<StreamChunk, { type: 'tool_output' }>, msg: ChatMessage): void {
    this.#renderPending(chunk.id);

    const existing = msg.toolCalls?.find(tc => tc.id === chunk.id);
    if (!existing) return;

    if (chunk.content) existing.result = (existing.result ?? '') + chunk.content;
    const scriptToolCalls = chunk.resultDetails?.scriptToolCalls;
    if (scriptToolCalls) {
      notifyScriptFileChanges(this.deps.plugin.app, existing.scriptToolCalls, scriptToolCalls);
      existing.scriptToolCalls = scriptToolCalls;
    }
    this.#scheduleOutputRender(chunk.id, existing);
    this.deps.indicator.show();
  }

  complete(chunk: Extract<StreamChunk, { type: 'tool_result' }>, msg: ChatMessage): void {
    const { state } = this.deps;
    this.#renderPending(chunk.id);

    const existing = msg.toolCalls?.find(tc => tc.id === chunk.id);
    if (existing) {
      const previousScriptToolCalls = existing.scriptToolCalls;
      applyToolCompletion(existing, chunk);
      const succeeded = existing.status === 'completed';

      if (existing.name === TOOL_ASK_USER_QUESTION) {
        const answers = chunk.resultDetails?.resolvedAnswers
          ?? extractResolvedAnswersFromResultText(existing.result ?? '');
        if (answers) existing.resolvedAnswers = answers;
        this.deps.onQuestionToolChanged?.(existing);
      }

      const writeEditState = state.writeEditStates.get(chunk.id);
      if (writeEditState && isWriteEditTool(existing.name)) {
        if (succeeded) {
          const diffData = resolveToolDiffData(chunk.resultDetails?.diff, existing);
          if (diffData) {
            existing.diffData = diffData;
            updateWriteEditWithDiff(writeEditState, diffData);
          }
        }
        finalizeWriteEditBlock(writeEditState, !succeeded);
      } else {
        this.#cancelOutputRender(chunk.id);
        updateToolCallResult(state.toolCallElements.get(chunk.id), existing);
      }

      // Refresh the vault file tree after file-changing tools.
      if (succeeded && isEditTool(existing.name)) {
        notifyVaultFileChange(this.deps.plugin.app, existing.input);
      }
      if (succeeded && existing.name === TOOL_APPLY_PATCH) {
        notifyApplyPatchFileChanges(this.deps.plugin.app, existing.input);
      }
      notifyScriptFileChanges(this.deps.plugin.app, previousScriptToolCalls, existing.scriptToolCalls);
    }

    this.deps.indicator.show();
  }

  /** Renders every buffered tool in arrival order. */
  flush(): void {
    const { state } = this.deps;
    if (state.pendingTools.size === 0) return;
    for (const toolId of state.pendingTools.keys()) {
      this.#renderPending(toolId);
    }
    state.pendingTools.clear();
  }

  /** Renders the buffered tools that arrived before the given one, preserving their order. */
  flushBefore(toolId: string): void {
    for (const pendingToolId of [...this.deps.state.pendingTools.keys()]) {
      if (pendingToolId === toolId) return;
      this.#renderPending(pendingToolId);
    }
  }

  /** Releases a tool's card to another renderer, leaving its element in place for replacement. */
  detach(toolId: string): void {
    const { state } = this.deps;
    this.#cancelOutputRender(toolId);
    state.pendingTools.delete(toolId);
    state.writeEditStates.delete(toolId);
    state.toolCallElements.delete(toolId);
  }

  /** Removes a tool's card, whether buffered or rendered. */
  remove(toolId: string): void {
    const toolEl = this.deps.state.toolCallElements.get(toolId);
    this.detach(toolId);
    toolEl?.remove();
  }

  /** Cancels deferred output renders and drops buffered tools. */
  cancelAll(): void {
    for (const frame of this.#outputFrames.values()) {
      cancelScheduledAnimationFrame(frame);
    }
    this.#outputFrames.clear();
    this.deps.state.pendingTools.clear();
  }

  #buffer(toolCall: ToolCallInfo): void {
    const { state } = this.deps;
    if (!state.currentContentEl || isSilentWriteStdinTool(toolCall)) return;
    state.pendingTools.set(toolCall.id, {
      toolCall,
      parentEl: state.currentContentEl,
    });
    this.deps.indicator.show();
  }

  #ensureVisible(toolCall: ToolCallInfo, msg: ChatMessage): void {
    msg.contentBlocks = msg.contentBlocks || [];
    if (!msg.contentBlocks.some(block => block.type === 'tool_use' && block.toolId === toolCall.id)) {
      msg.contentBlocks.push({ type: 'tool_use', toolId: toolCall.id });
    }

    const { state } = this.deps;
    if (state.pendingTools.has(toolCall.id) || state.toolCallElements.has(toolCall.id)) return;
    this.#buffer(toolCall);
  }

  #renderPending(toolId: string): void {
    const { state } = this.deps;
    const pending = state.pendingTools.get(toolId);
    if (!pending) return;

    const { toolCall, parentEl } = pending;
    if (!parentEl) return;
    const { element, writeEditState } = renderToolCard(parentEl, toolCall, {
      mode: 'live', expandFileEditsByDefault: this.deps.plugin.settings.expandFileEditsByDefault === true,
    });
    state.toolCallElements.set(toolId, element);
    if (writeEditState) state.writeEditStates.set(toolId, writeEditState);
    state.pendingTools.delete(toolId);
  }

  /** Replaces a rendered card whose refined name needs a different renderer, in the same position. */
  #rebuildRenderedTool(toolCall: ToolCallInfo): boolean {
    const { state } = this.deps;
    const currentEl = state.toolCallElements.get(toolCall.id);
    if (!currentEl) return false;

    const parentEl = currentEl.parentElement;
    if (!parentEl) return false;

    this.#cancelOutputRender(toolCall.id);
    const { element: replacementEl, writeEditState } = renderToolCard(parentEl, toolCall, {
      mode: 'live', expandFileEditsByDefault: this.deps.plugin.settings.expandFileEditsByDefault === true,
      initiallyExpanded: toolCall.isExpanded === true,
    });
    state.toolCallElements.set(toolCall.id, replacementEl);
    if (writeEditState) state.writeEditStates.set(toolCall.id, writeEditState);
    else state.writeEditStates.delete(toolCall.id);

    parentEl.insertBefore(replacementEl, currentEl);
    currentEl.remove();
    return true;
  }

  #scheduleOutputRender(toolId: string, toolCall: ToolCallInfo): void {
    if (this.#outputFrames.has(toolId)) return;

    const frame = scheduleAnimationFrame(() => {
      this.#outputFrames.delete(toolId);
      updateToolCallResult(this.deps.state.toolCallElements.get(toolId), toolCall);
      this.deps.scrollToBottom();
    }, this.deps.getMessagesEl().ownerDocument.defaultView ?? null);
    this.#outputFrames.set(toolId, frame);
  }

  #cancelOutputRender(toolId: string): void {
    const frame = this.#outputFrames.get(toolId);
    if (!frame) return;
    cancelScheduledAnimationFrame(frame);
    this.#outputFrames.delete(toolId);
  }
}
