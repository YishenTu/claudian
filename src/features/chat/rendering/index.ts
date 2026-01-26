/**
 * Chat rendering module exports.
 */

// Diff types re-exported from core for convenience
export type { DiffLine, DiffStats, StructuredPatchHunk } from '../../../core/types/diff';
// Diff data functions re-exported from utils for convenience
export { countLineChanges, structuredPatchToDiffLines } from '../../../utils/diff';
// Rendering-specific diff exports
export { type DiffHunk, renderDiffContent, splitIntoHunks } from './DiffRenderer';
export { MessageRenderer } from './MessageRenderer';
export {
  addSubagentToolCall,
  type AsyncSubagentState,
  createAsyncSubagentBlock,
  createSubagentBlock,
  finalizeAsyncSubagent,
  finalizeSubagentBlock,
  markAsyncSubagentOrphaned,
  renderStoredAsyncSubagent,
  renderStoredSubagent,
  type SubagentState,
  updateAsyncSubagentRunning,
  updateSubagentToolResult,
} from './SubagentRenderer';
export {
  appendThinkingContent,
  cleanupThinkingBlock,
  createThinkingBlock,
  finalizeThinkingBlock,
  type RenderContentFn,
  renderStoredThinkingBlock,
  type ThinkingBlockState,
} from './ThinkingBlockRenderer';
export {
  extractLastTodosFromMessages,
  parseTodoInput,
  type TodoItem,
} from './TodoListRenderer';
export {
  formatToolInput,
  getToolLabel,
  isBlockedToolResult,
  renderStoredToolCall,
  renderToolCall,
  setToolIcon,
  truncateResult,
  updateToolCallResult,
} from './ToolCallRenderer';
export {
  createWriteEditBlock,
  finalizeWriteEditBlock,
  renderStoredWriteEdit,
  updateWriteEditWithDiff,
  type WriteEditState,
} from './WriteEditRenderer';
