/**
 * Chat rendering module exports.
 */

export {
  computeLineDiff,
  countLineChanges,
  type DiffHunk,
  type DiffLine,
  diffLinesToHtml,
  type DiffStats,
  isBinaryContent,
  renderDiffContent,
  splitIntoHunks,
} from './DiffRenderer';
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
  appendFlavorThinkingContent,
  appendThinkingContent,
  cleanupThinkingBlock,
  createFlavorThinkingBlock,
  createThinkingBlock,
  finalizeFlavorThinking,
  finalizeThinkingBlock,
  type FlavorThinkingState,
  hideFlavorThinking,
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
