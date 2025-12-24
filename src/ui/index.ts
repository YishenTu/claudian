/** Claudian UI components - barrel export. */

export { type ApprovalDecision,ApprovalModal } from './ApprovalModal';
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
export {
  EnvSnippetManager,
  EnvSnippetModal,
} from './EnvSnippetManager';
export {
  type FileContextCallbacks,
  FileContextManager,
} from './FileContext';
export {
  type ImageContextCallbacks,
  ImageContextManager,
} from './ImageContext';
export {
  type InlineEditDecision,
  InlineEditModal,
} from './InlineEditModal';
export {
  createInputToolbar,
  ModelSelector,
  PermissionToggle,
  ThinkingBudgetSelector,
  type ToolbarCallbacks,
  type ToolbarSettings,
} from './InputToolbar';
export {
  type ClarificationSubmitCallback,
  InstructionClarificationModal,
  InstructionConfirmModal,
  type InstructionDecision,
  InstructionModal,
  type InstructionModalCallbacks,
} from './InstructionConfirmModal';
export {
  type InstructionModeCallbacks,
  InstructionModeManager,
  type InstructionModeState,
} from './InstructionModeManager';
export {
  SlashCommandDropdown,
  type SlashCommandDropdownCallbacks,
  type SlashCommandDropdownOptions,
} from './SlashCommandDropdown';
export {
  type DetectedCommand,
  type ExpansionResult,
  SlashCommandManager,
} from './SlashCommandManager';
export {
  SlashCommandModal,
  SlashCommandSettings,
} from './SlashCommandSettings';
export {
  addSubagentToolCall,
  createSubagentBlock,
  finalizeSubagentBlock,
  renderStoredSubagent,
  type SubagentState,
  updateSubagentToolResult,
} from './SubagentRenderer';
export {
  type AsyncSubagentState,
  createAsyncSubagentBlock,
  finalizeAsyncSubagent,
  markAsyncSubagentOrphaned,
  renderStoredAsyncSubagent,
  updateAsyncSubagentRunning,
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
  parseTodoInput,
  renderStoredTodoList,
  renderTodoList,
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

// Note: getToolIcon is exported from src/tools/index.ts instead
export { formatSlashCommandWarnings } from './formatSlashCommandWarnings';
export { hideSelectionHighlight, showSelectionHighlight } from './SelectionHighlight';
export {
  createWriteEditBlock,
  finalizeWriteEditBlock,
  renderStoredWriteEdit,
  updateWriteEditWithDiff,
  type WriteEditState,
} from './WriteEditRenderer';
