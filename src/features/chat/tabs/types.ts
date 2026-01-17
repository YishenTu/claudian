/**
 * Type definitions for the multi-tab system.
 *
 * Each tab represents an independent chat conversation with its own
 * ClaudianService instance for concurrent streaming support.
 */

import type { Component, WorkspaceLeaf } from 'obsidian';

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
  StatusPanel,
  ThinkingBudgetSelector,
} from '../ui';

/**
 * Default number of tabs allowed.
 *
 * Set to 3 to balance usability with resource usage:
 * - Each tab has its own ClaudianService and persistent query
 * - More tabs = more memory and potential SDK processes
 * - 3 tabs allows multi-tasking without excessive overhead
 */
export const DEFAULT_MAX_TABS = 3;

/**
 * Minimum number of tabs allowed (settings floor).
 */
export const MIN_TABS = 3;

/**
 * Maximum number of tabs allowed (settings ceiling).
 * Users can configure up to this many tabs via settings.
 */
export const MAX_TABS = 10;

/**
 * Minimum max-height for textarea in pixels.
 * Used by autoResizeTextarea to ensure minimum usable space.
 */
export const TEXTAREA_MIN_MAX_HEIGHT = 150;

/**
 * Percentage of view height for max textarea height.
 * Textarea can grow up to this portion of the view.
 */
export const TEXTAREA_MAX_HEIGHT_PERCENT = 0.55;

/**
 * Minimal interface for the ClaudianView methods used by TabManager and Tab.
 * Extends Component for Obsidian integration (event handling, cleanup).
 * Avoids circular dependency by not importing ClaudianView directly.
 */
export interface TabManagerViewHost extends Component {
  /** Reference to the workspace leaf for revealing the view. */
  leaf: WorkspaceLeaf;

  /** Gets the tab manager instance (used for cross-view coordination). */
  getTabManager(): TabManagerInterface | null;
}

/**
 * Minimal interface for TabManager methods used by external code.
 * Used to break circular dependencies.
 */
export interface TabManagerInterface {
  /** Switches to a specific tab. */
  switchToTab(tabId: TabId): Promise<void>;

  /** Gets all tabs. */
  getAllTabs(): TabData[];
}

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
  statusPanel: StatusPanel | null;
}

/**
 * DOM elements managed per-tab.
 */
export interface TabDOMElements {
  contentEl: HTMLElement;
  messagesEl: HTMLElement;
  welcomeEl: HTMLElement | null;

  /** Container for status panel (fixed between messages and input). */
  statusPanelContainerEl: HTMLElement;

  inputContainerEl: HTMLElement;
  inputWrapper: HTMLElement;
  inputEl: HTMLTextAreaElement;

  /** Nav row for tab badges and header icons (above input wrapper). */
  navRowEl: HTMLElement;

  /** Context row for file chips and selection indicator (inside input wrapper). */
  contextRowEl: HTMLElement;

  selectionIndicatorEl: HTMLElement | null;

  /** Scroll-to-bottom button (shown when user scrolls up). */
  scrollToBottomEl: HTMLElement | null;

  /** Cleanup functions for event listeners (prevents memory leaks). */
  eventCleanups: Array<() => void>;
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

  /** Called when a tab's conversation changes (loaded different conversation in same tab). */
  onTabConversationChanged?: (tabId: TabId, conversationId: string | null) => void;
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
