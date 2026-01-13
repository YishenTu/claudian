/**
 * Type definitions for the multi-tab system.
 *
 * Each tab represents an independent chat conversation with its own
 * ClaudianService instance for concurrent streaming support.
 */

import type { ClaudianService } from '../../../core/agent';
import type { SlashCommandManager } from '../../../core/commands';
import type { SlashCommandDropdown } from '../../../shared/components/SlashCommandDropdown';
import type {
  ConversationController,
  InputController,
  NavigationController,
  SelectionController,
  StreamController,
} from '../controllers';
import type { MessageRenderer } from '../rendering';
import type { AsyncSubagentManager } from '../services/AsyncSubagentManager';
import type { InstructionRefineService } from '../services/InstructionRefineService';
import type { TitleGenerationService } from '../services/TitleGenerationService';
import type { ChatState } from '../state';
import type {
  ContextUsageMeter,
  ExternalContextSelector,
  FileContextManager,
  ImageContextManager,
  InstructionModeManager,
  McpServerSelector,
  ModelSelector,
  PermissionToggle,
  ThinkingBudgetSelector,
  TodoPanel,
} from '../ui';

/** Maximum number of tabs allowed. */
export const MAX_TABS = 3;

/** Tab identifier type. */
export type TabId = string;

/** Generates a unique tab ID. */
export function generateTabId(): TabId {
  return `tab-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Controllers managed per-tab.
 * Each tab has its own set of controllers for independent operation.
 */
export interface TabControllers {
  selectionController: SelectionController | null;
  conversationController: ConversationController | null;
  streamController: StreamController | null;
  inputController: InputController | null;
  navigationController: NavigationController | null;
}

/**
 * Services managed per-tab.
 */
export interface TabServices {
  asyncSubagentManager: AsyncSubagentManager;
  instructionRefineService: InstructionRefineService | null;
  titleGenerationService: TitleGenerationService | null;
}

/**
 * UI components managed per-tab.
 */
export interface TabUIComponents {
  fileContextManager: FileContextManager | null;
  imageContextManager: ImageContextManager | null;
  modelSelector: ModelSelector | null;
  thinkingBudgetSelector: ThinkingBudgetSelector | null;
  externalContextSelector: ExternalContextSelector | null;
  mcpServerSelector: McpServerSelector | null;
  permissionToggle: PermissionToggle | null;
  slashCommandManager: SlashCommandManager | null;
  slashCommandDropdown: SlashCommandDropdown | null;
  instructionModeManager: InstructionModeManager | null;
  contextUsageMeter: ContextUsageMeter | null;
  todoPanel: TodoPanel | null;
}

/**
 * DOM elements managed per-tab.
 */
export interface TabDOMElements {
  contentEl: HTMLElement;
  messagesEl: HTMLElement;
  welcomeEl: HTMLElement | null;
  inputContainerEl: HTMLElement;
  inputWrapper: HTMLElement;
  inputEl: HTMLTextAreaElement;
  selectionIndicatorEl: HTMLElement | null;
}

/**
 * Represents a single tab in the multi-tab system.
 * Each tab is an independent chat session with its own agent service.
 */
export interface TabData {
  /** Unique tab identifier. */
  id: TabId;

  /** Conversation ID bound to this tab (null for new/empty tabs). */
  conversationId: string | null;

  /** Per-tab ClaudianService instance for independent streaming. */
  service: ClaudianService | null;

  /** Whether the service has been initialized (lazy start). */
  serviceInitialized: boolean;

  /** Per-tab chat state. */
  state: ChatState;

  /** Per-tab controllers. */
  controllers: TabControllers;

  /** Per-tab services. */
  services: TabServices;

  /** Per-tab UI components. */
  ui: TabUIComponents;

  /** Per-tab DOM elements. */
  dom: TabDOMElements;

  /** Per-tab renderer. */
  renderer: MessageRenderer | null;
}

/**
 * Persisted tab state for restoration on plugin reload.
 */
export interface PersistedTabState {
  tabId: TabId;
  conversationId: string | null;
}

/**
 * Tab manager state persisted to data.json.
 */
export interface PersistedTabManagerState {
  openTabs: PersistedTabState[];
  activeTabId: TabId | null;
}

/**
 * Callbacks for tab state changes.
 */
export interface TabManagerCallbacks {
  /** Called when a tab is created. */
  onTabCreated?: (tab: TabData) => void;

  /** Called when switching to a different tab. */
  onTabSwitched?: (fromTabId: TabId | null, toTabId: TabId) => void;

  /** Called when a tab is closed. */
  onTabClosed?: (tabId: TabId) => void;

  /** Called when tab streaming state changes. */
  onTabStreamingChanged?: (tabId: TabId, isStreaming: boolean) => void;

  /** Called when tab title changes. */
  onTabTitleChanged?: (tabId: TabId, title: string) => void;

  /** Called when tab attention state changes (approval pending, etc.). */
  onTabAttentionChanged?: (tabId: TabId, needsAttention: boolean) => void;
}

/**
 * Tab bar item representation for rendering.
 */
export interface TabBarItem {
  id: TabId;
  /** 1-based index for display. */
  index: number;
  title: string;
  isActive: boolean;
  isStreaming: boolean;
  needsAttention: boolean;
  canClose: boolean;
}
