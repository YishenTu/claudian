/**
 * Claudian - Type definitions barrel export.
 *
 * Re-exports all types from modular type files for backward compatibility.
 */

// Chat types
export {
  type ChatMessage,
  type ContentBlock,
  type Conversation,
  type ConversationMeta,
  type ImageAttachment,
  type ImageMediaType,
  type StreamChunk,
  VIEW_TYPE_CLAUDIAN,
} from './chat';

// Model types
export {
  type ClaudeModel,
  DEFAULT_CLAUDE_MODELS,
  DEFAULT_THINKING_BUDGET,
  THINKING_BUDGETS,
  type ThinkingBudget,
} from './models';

// SDK types
export {
  type SDKContentBlock,
  type SDKMessage,
  type SDKMessageContent,
  type SDKStreamEvent,
} from './sdk';

// Settings types
export {
  type ApprovedAction, // @deprecated - use Permission
  type ClaudianSettings,
  DEFAULT_SETTINGS,
  type EnvSnippet,
  getBashToolBlockedCommands,
  getCurrentPlatformBlockedCommands,
  getCurrentPlatformKey,
  getDefaultBlockedCommands,
  type InstructionRefineResult,
  type Permission,
  type PermissionMode,
  type PlatformBlockedCommands,
  type SlashCommand,
} from './settings';

// Tool types
export {
  type AsyncSubagentStatus,
  type SubagentInfo,
  type SubagentMode,
  type ToolCallInfo,
  type ToolDiffData,
} from './tools';
