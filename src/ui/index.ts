/** Claudian UI components - barrel export. */

export { ApprovalModal, type ApprovalDecision } from './ApprovalModal';

export {
  ModelSelector,
  ThinkingBudgetSelector,
  PermissionToggle,
  createInputToolbar,
  type ToolbarSettings,
  type ToolbarCallbacks,
} from './InputToolbar';

export {
  EnvSnippetManager,
  EnvSnippetModal,
} from './EnvSnippetManager';

export {
  FileContextManager,
  type FileContextCallbacks,
} from './FileContext';

export {
  ImageContextManager,
  type ImageContextCallbacks,
} from './ImageContext';

export {
  getToolIcon,
  setToolIcon,
  getToolLabel,
  formatToolInput,
  truncateResult,
  isBlockedToolResult,
  renderToolCall,
  updateToolCallResult,
  renderStoredToolCall,
} from './ToolCallRenderer';

export {
  createThinkingBlock,
  appendThinkingContent,
  finalizeThinkingBlock,
  cleanupThinkingBlock,
  renderStoredThinkingBlock,
  type ThinkingBlockState,
  type RenderContentFn,
} from './ThinkingBlockRenderer';

export {
  parseTodoInput,
  renderTodoList,
  renderStoredTodoList,
  type TodoItem,
} from './TodoListRenderer';

export {
  createSubagentBlock,
  addSubagentToolCall,
  updateSubagentToolResult,
  finalizeSubagentBlock,
  renderStoredSubagent,
  type SubagentState,
} from './SubagentRenderer';

export {
  createAsyncSubagentBlock,
  updateAsyncSubagentRunning,
  finalizeAsyncSubagent,
  markAsyncSubagentOrphaned,
  renderStoredAsyncSubagent,
  type AsyncSubagentState,
} from './SubagentRenderer';

export {
  InlineEditModal,
  type InlineEditDecision,
} from './InlineEditModal';

export {
  computeLineDiff,
  countLineChanges,
  splitIntoHunks,
  renderDiffContent,
  diffLinesToHtml,
  isBinaryContent,
  type DiffLine,
  type DiffHunk,
  type DiffStats,
} from './DiffRenderer';

export {
  createWriteEditBlock,
  updateWriteEditWithDiff,
  finalizeWriteEditBlock,
  renderStoredWriteEdit,
  type WriteEditState,
} from './WriteEditRenderer';

export {
  SlashCommandManager,
  type ExpansionResult,
  type DetectedCommand,
} from './SlashCommandManager';

export {
  SlashCommandDropdown,
  type SlashCommandDropdownCallbacks,
  type SlashCommandDropdownOptions,
} from './SlashCommandDropdown';

export {
  SlashCommandSettings,
  SlashCommandModal,
} from './SlashCommandSettings';
