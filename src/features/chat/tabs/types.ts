import type { Component, WorkspaceLeaf } from 'obsidian';

import type { ProviderCommandDropdownConfig } from '../../../core/providers/commands/ProviderCommandCatalog';
import type { ProviderCommandDiscoveryController } from '../../../core/providers/commands/ProviderCommandDiscoveryStore';
import type { ProviderCommandEntry } from '../../../core/providers/commands/ProviderCommandEntry';
import type { InstructionRefineService, ProviderId, TitleGenerationService } from '../../../core/providers/types';
import type { SlashCommandDropdown } from '../../../shared/components/SlashCommandDropdown';
import type { BrowserSelectionController } from '../controllers/BrowserSelectionController';
import type { CanvasSelectionController } from '../controllers/CanvasSelectionController';
import type { ConversationController } from '../controllers/ConversationController';
import type { InputController } from '../controllers/InputController';
import type { NavigationController } from '../controllers/NavigationController';
import type { SelectionController } from '../controllers/SelectionController';
import type { StreamController } from '../controllers/StreamController';
import type { ChatExecutionCoordinator } from '../execution/ChatExecutionCoordinator';
import type { MessageRenderer } from '../rendering/MessageRenderer';
import type { SubagentManager } from '../services/SubagentManager';
import type { ChatState } from '../state/ChatState';
import type { TabAttention } from '../state/types';
import type { BangBashModeManager } from '../ui/BangBashModeManager';
import type { ComposerContextTray } from '../ui/ComposerContextTray';
import type { FileContextManager } from '../ui/FileContext';
import type { ImageContextManager } from '../ui/ImageContext';
import type {
  ContextUsageMeter,
  ExternalContextSelector,
  ModelSelector,
  ModeSelector,
  PermissionToggle,
  ServiceTierToggle,
  ThinkingBudgetSelector,
} from '../ui/InputToolbar';
import type { InstructionModeManager } from '../ui/InstructionModeManager';
import type { NavigationSidebar } from '../ui/NavigationSidebar';
import type { StatusPanel } from '../ui/StatusPanel';
import type { TabSession } from './TabSession';

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

  /** Gets view-owned elements that should preserve active tab selection context. */
  getSharedSelectionFocusScopeEls?(): HTMLElement[];

  /** Handles /clear and /new when the active layout gives New different semantics. */
  handleNewConversationCommand?(): Promise<boolean>;

  /** Starts approved plan content in a layout-owned new conversation when required. */
  handleNewSessionPlan?(
    planContent: string,
    isSourceLive?: () => boolean,
  ): Promise<boolean>;
}

/**
 * Minimal interface for TabManager methods used by external code.
 * Used to break circular dependencies.
 */
export interface TabManagerInterface {
  /** Switches to a specific tab. */
  switchToTab(tabId: TabId): Promise<void>;

  /** Gets all tabs. */
  getAllTabs(): AssembledTabRuntime[];
}

/** Tab identifier type. */
export type TabId = string;

export type ProviderCatalogInfo = {
  config: ProviderCommandDropdownConfig;
  discovery: ProviderCommandDiscoveryController<ProviderCommandEntry>;
} | null;

export type ProviderCatalogResolver = () => ProviderCatalogInfo;

/** Generates a unique tab ID. */
export function generateTabId(): TabId {
  return `tab-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Controllers managed per-tab.
 * Each tab has its own set of controllers for independent operation.
 */
export interface TabControllers {
  readonly selectionController: SelectionController;
  readonly browserSelectionController: BrowserSelectionController;
  readonly canvasSelectionController: CanvasSelectionController;
  readonly conversationController: ConversationController;
  readonly streamController: StreamController;
  readonly inputController: InputController;
  readonly navigationController: NavigationController;
}

/**
 * Services managed per-tab.
 */
export interface TabServices {
  readonly subagentManager: SubagentManager;
  instructionRefineService: InstructionRefineService | null;
  readonly titleGenerationService: TitleGenerationService;
}

/**
 * UI components managed per-tab.
 */
export interface TabUIComponents {
  readonly contextTray: ComposerContextTray;
  readonly fileContextManager: FileContextManager;
  readonly imageContextManager: ImageContextManager;
  readonly modelSelector: ModelSelector;
  readonly modeSelector: ModeSelector;
  readonly thinkingBudgetSelector: ThinkingBudgetSelector;
  readonly externalContextSelector: ExternalContextSelector;
  readonly permissionToggle: PermissionToggle;
  readonly serviceTierToggle: ServiceTierToggle;
  readonly slashCommandDropdown: SlashCommandDropdown;
  readonly instructionModeManager: InstructionModeManager;
  readonly bangBashModeManager: BangBashModeManager | null;
  readonly contextUsageMeter: ContextUsageMeter;
  readonly statusPanel: StatusPanel;
  readonly navigationSidebar: NavigationSidebar;
}

/**
 * DOM elements managed per-tab.
 */
export interface TabDOMElements {
  readonly contentEl: HTMLElement;
  readonly messagesWrapperEl: HTMLElement;
  readonly messagesEl: HTMLElement;
  welcomeEl: HTMLElement | null;

  /** Container for status panel (fixed between messages and input). */
  readonly statusPanelContainerEl: HTMLElement;

  /** Per-tab composer root. Inline prompts render here as siblings of the input container. */
  readonly inputComposerEl: HTMLElement;
  readonly inputContainerEl: HTMLElement;
  readonly queueIndicatorEl: HTMLElement;
  readonly inputWrapper: HTMLElement;
  readonly inputEl: HTMLTextAreaElement;

  /** Nav row for tab badges and header icons (above input wrapper). */
  readonly navRowEl: HTMLElement;

  /** Composer-owned context tray container inside the input wrapper. */
  readonly contextRowEl: HTMLElement;
}

/**
 * Runtime tab lifecycle states, independent from conversation binding:
 * - `provisional`: Replaceable session preview created by dual-mode navigation.
 * - `cold`: Retained working state without provider execution resources.
 * - `warm`: Retained working state holding provider execution resources.
 * - `closing`: Tab is being torn down.
 */
export type TabLifecycleState = 'provisional' | 'cold' | 'warm' | 'closing';

/** Conversation hydration state, independent from runtime activation. */
export type TabHydrationState = 'idle' | 'loading' | 'ready' | 'failed';

/**
 * Represents a single tab in the multi-tab system.
 * Each tab is an independent chat session with its own runtime instance.
 */
export interface TabInputBindings {
  readonly installed: true;
}

export interface TabRuntimeCleanupFailure {
  readonly resource: string;
  readonly error: unknown;
}

export interface TabRuntimeResourceState {
  readonly isDisposed: boolean;
}

export interface TabRuntimeResourceOwner extends TabRuntimeResourceState {
  dispose(): Promise<readonly TabRuntimeCleanupFailure[]>;
}

export interface AssembledTabRuntime {
  /** Authoritative identity and runtime owner for the tab. */
  readonly session: TabSession;
  /** Unique tab identifier. */
  readonly id: TabId;

  /** Explicit lifecycle state. */
  lifecycleState: TabLifecycleState;

  /** State of loading the provider-owned conversation into the tab UI. */
  hydrationState: TabHydrationState;

  /**
   * Draft model selected in a blank tab (before first send).
   * Used to derive provider on first send. Null after binding.
   */
  draftModel: string | null;

  /** Active provider for this tab's current conversation/runtime. */
  providerId: ProviderId;

  /** Conversation ID bound to this tab (null for new/empty tabs). */
  conversationId: string | null;

  /** Per-tab owner of provider execution and session lifecycle. */
  readonly executionCoordinator: ChatExecutionCoordinator;

  /** Tab-manager-owned provider discovery callback retained across UI/runtime refreshes. */
  readonly providerCatalogResolver: ProviderCatalogResolver;

  /** Captures whether completed runtime work will need review after finalization. */
  readonly captureReviewableSettlement: (() => () => void) | null;

  /** Per-tab chat state. */
  readonly state: ChatState;

  /** Per-tab controllers. */
  readonly controllers: TabControllers;

  /** Per-tab services. */
  readonly services: TabServices;

  /** Per-tab UI components. */
  readonly ui: TabUIComponents;

  /** Per-tab DOM elements. */
  readonly dom: TabDOMElements;

  /** Per-tab renderer. */
  readonly renderer: MessageRenderer;

  /** Confirms that input/event wiring completed before publication. */
  readonly inputBindings: TabInputBindings;

  /** Reports operational disposal without exposing teardown authority. */
  readonly resources: TabRuntimeResourceState;
}

export type TabProviderContext = Pick<
  AssembledTabRuntime,
  'conversationId' | 'providerId' | 'lifecycleState' | 'draftModel'
>;

/** Stable session projection available while a tab runtime is being assembled. */
export type TabProviderCatalogContext = Readonly<Pick<
  AssembledTabRuntime,
  'id' | 'conversationId' | 'providerId' | 'lifecycleState' | 'draftModel'
>>;

/**
 * Callbacks for tab state changes.
 */
export interface TabManagerCallbacks {
  /** Skips the target prompt when the active layout always forks into a new runtime tab. */
  shouldForkToNewTab?: () => boolean;

  /** Called when a tab is created. */
  onTabCreated?: (tab: AssembledTabRuntime) => void;

  /** Called immediately after the active tab changes, before async tab loading completes. */
  onActiveTabChanged?: (fromTabId: TabId | null, toTabId: TabId) => void;

  /** Called when switching to a different tab. */
  onTabSwitched?: (fromTabId: TabId | null, toTabId: TabId) => void;

  /** Called when a tab is closed. */
  onTabClosed?: (tabId: TabId) => void;

  /** Called when tab streaming state changes. */
  onTabStreamingChanged?: (tabId: TabId, isStreaming: boolean) => void;

  /** Called when tab rewind transaction state changes. */
  onTabRewindingChanged?: (tabId: TabId, isRewinding: boolean) => void;

  /** Called when tab title changes. */
  onTabTitleChanged?: (tabId: TabId, title: string) => void;

  /** Called when tab attention state changes (approval pending, etc.). */
  onTabAttentionChanged?: (tabId: TabId, attention: TabAttention) => void;

  /** Called when a tab's conversation changes (loaded different conversation in same tab). */
  onTabConversationChanged?: (tabId: TabId, conversationId: string | null) => void;

  /** Called when the active provider changes within a tab (blank tab model selection). */
  onTabProviderChanged?: (tabId: TabId, providerId: ProviderId) => void;
}

/**
 * Tab bar item representation for rendering.
 */
export interface TabBarItem {
  id: TabId;
  /** 1-based index for display. */
  index: number;
  title: string;
  providerId: ProviderId;
  isActive: boolean;
  isStreaming: boolean;
  needsAttention: boolean;
  canClose: boolean;
}
