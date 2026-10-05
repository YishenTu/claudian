import { isWriteEditTool, TOOL_APPLY_PATCH, TOOL_WRITE_STDIN } from '@/core/tools/toolNames';
import type { ToolCallInfo } from '@/core/types';
import { renderStoredToolCall, renderToolCall, updateToolCallResult } from '@/features/chat/rendering/tools/ToolCallRenderer';
import { createWriteEditBlock, finalizeWriteEditBlock, renderStoredWriteEdit, updateWriteEditWithDiff, type WriteEditState } from '@/features/chat/rendering/tools/WriteEditRenderer';

export function isSilentWriteStdinTool(tool: ToolCallInfo): boolean {
  return tool.name === TOOL_WRITE_STDIN
    && (typeof tool.input.chars !== 'string' || tool.input.chars.length === 0);
}

/** Chooses the same card and file-edit expansion policy for live and restored tools. */
export function renderToolCard(
  parent: HTMLElement,
  tool: ToolCallInfo,
  options: { mode: 'live' | 'stored'; expandFileEditsByDefault: boolean; initiallyExpanded?: boolean },
): { element: HTMLElement; writeEditState?: WriteEditState } {
  const initiallyExpanded = options.initiallyExpanded
    ?? ((isWriteEditTool(tool.name) || tool.name === TOOL_APPLY_PATCH) && options.expandFileEditsByDefault);
  if (isWriteEditTool(tool.name)) {
    if (options.mode === 'stored') {
      return { element: renderStoredWriteEdit(parent, tool, { initiallyExpanded }) };
    }
    const writeEditState = createWriteEditBlock(parent, tool, { initiallyExpanded });
    if (tool.diffData) updateWriteEditWithDiff(writeEditState, tool.diffData);
    if (tool.status !== 'running') finalizeWriteEditBlock(writeEditState, tool.status === 'error' || tool.status === 'blocked');
    return { element: writeEditState.wrapperEl, writeEditState };
  }
  const element = options.mode === 'live'
    ? renderToolCall(parent, tool, { initiallyExpanded })
    : renderStoredToolCall(parent, tool, { initiallyExpanded });
  if (options.mode === 'live' && (tool.result !== undefined || tool.status !== 'running')) {
    updateToolCallResult(element, tool);
  }
  return { element };
}
