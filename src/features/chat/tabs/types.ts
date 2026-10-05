import type { ProviderCommandDropdownConfig } from '@/core/providers/commands/ProviderCommandCatalog';
import type { ProviderCommandDiscoveryController } from '@/core/providers/commands/ProviderCommandDiscoveryStore';
import type { ProviderCommandEntry } from '@/core/providers/commands/ProviderCommandEntry';
import type { ProviderId, TitleGenerationService } from '@/core/providers/types';
import type { ComposerContextTray } from '@/features/chat/composer/ComposerContextTray';
import type { ComposerPromptSuggestion } from '@/features/chat/composer/ComposerPromptSuggestion';
import type { FileContextManager } from '@/features/chat/composer/FileContextManager';
import type { ImageContextManager } from '@/features/chat/composer/ImageContextManager';
import type { MainChatComposerDropdown } from '@/features/chat/composer/MainChatComposerDropdown';
import type { ContextUsageMeter } from '@/features/chat/composer/toolbar/ContextUsageMeter';
import type { EffortSelector } from '@/features/chat/composer/toolbar/EffortSelector';
import type { ModelSelector } from '@/features/chat/composer/toolbar/ModelSelector';
import type { ModeSelector } from '@/features/chat/composer/toolbar/ModeSelector';
import type { PermissionToggle } from '@/features/chat/composer/toolbar/PermissionToggle';
import type { ServiceTierToggle } from '@/features/chat/composer/toolbar/ServiceTierToggle';
import type { ToolbarMenus } from '@/features/chat/composer/toolbar/ToolbarMenu';
import type { ConversationController } from '@/features/chat/conversation/ConversationController';
import type { ChatExecutionCoordinator } from '@/features/chat/execution/ChatExecutionCoordinator';
import type { BuiltInCommandController } from '@/features/chat/input/BuiltInCommandController';
import type { ComposerSelections } from '@/features/chat/input/ComposerSelections';
import type { InputController } from '@/features/chat/input/InputController';
import type { InlineInteractionPrompts } from '@/features/chat/interactions/InlineInteractionPrompts';
import type { LinkedContentController } from '@/features/chat/linked-content';
import type { NavigationController } from '@/features/chat/navigation/NavigationController';
import type { NavigationSidebar } from '@/features/chat/navigation/NavigationSidebar';
import type { MessageRenderer } from '@/features/chat/rendering/MessageRenderer';
import type { SideChatController } from '@/features/chat/side-chat/SideChatController';
import type { ChatState } from '@/features/chat/state/ChatState';
import type { TabAttention, TabReviewOutcome } from '@/features/chat/state/types';
import type { SubagentManager } from '@/features/chat/subagents/SubagentManager';
import type { ChatTab, TabHydrationState, TabId } from '@/features/chat/tabs/ChatTab';
import type { TabSession, TabSessionState } from '@/features/chat/tabs/TabSession';
import type { StreamController } from '@/features/chat/turns/StreamController';
import type { ComposerInputElement } from '@/shared/composer-dropdown/types';

/**
 * Read-only projection of TabManager-owned membership and liveness. Collaborators that
 * await revalidate through this view; only TabManager mutates membership.
 */
export interface TabMembershipView {
  isDestroyed(): boolean;
  getActiveTabId(): TabId | null;
  getTab(tabId: TabId): AssembledTabRuntime | null;
  /** Assembled runtimes in membership order. */
  getAllTabs(): AssembledTabRuntime[];
  /** Ordered membership, including unassembled restored shells. */
  getTabIdentities(): readonly Readonly<TabSessionState>[];
  /** Owned, not closing, and the manager is live: the tab may receive new work. */
  isTabAlive(tab: TabSessionState): boolean;
  /** Owned and the manager is not destroyed: closing tabs may still record terminal state. */
  isTabStateMutable(tab: TabSessionState): boolean;
  /** A close has been admitted for this tab and has not finished releasing it. */
  isCloseClaimed(tabId: TabId): boolean;
}

export type ProviderCatalogInfo = {
  config: ProviderCommandDropdownConfig;
  discovery: ProviderCommandDiscoveryController<ProviderCommandEntry>;
} | null;

export type ProviderCatalogResolver = () => ProviderCatalogInfo;

/**
 * Controllers managed per-tab.
 * Each tab has its own set of controllers for independent operation.
 */
export interface TabControllers {
  readonly composerSelections: ComposerSelections;
  /** Inline approval and question prompts shared by input and the provider interaction port. */
  readonly inlinePrompts: InlineInteractionPrompts;
  readonly conversationController: ConversationController;
  readonly streamController: StreamController;
  readonly inputController: InputController;
  readonly builtInCommandController: BuiltInCommandController;
  readonly navigationController: NavigationController;
  /** Owner of this tab's single temporary side chat and composer destination. */
  readonly sideChatController: SideChatController;
}

/**
 * Services managed per-tab.
 */
export interface TabServices {
  readonly subagentManager: SubagentManager;
  readonly titleGenerationService: TitleGenerationService;
}

/**
 * UI components managed per-tab.
 */
export interface TabUIComponents {
  readonly promptSuggestion: ComposerPromptSuggestion;
  readonly contextTray: ComposerContextTray;
  readonly fileContextManager: FileContextManager;
  readonly linkedContentController: LinkedContentController;
  readonly imageContextManager: ImageContextManager;
  readonly modelSelector: ModelSelector;
  readonly modeSelector: ModeSelector;
  readonly effortSelector: EffortSelector;
  readonly permissionToggle: PermissionToggle;
  readonly serviceTierToggle: ServiceTierToggle;
  readonly composerDropdown: MainChatComposerDropdown;
  readonly contextUsageMeter: ContextUsageMeter;
  /** Toolbar menus; Escape closes an open one before it can cancel a turn. */
  readonly toolbarMenus: ToolbarMenus;
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

  /** Per-tab composer root. Inline prompts render here as siblings of the input container. */
  readonly inputComposerEl: HTMLElement;
  readonly inputContainerEl: HTMLElement;
  /** Queued-message strip at the top of the input wrapper. */
  readonly queueIndicatorEl: HTMLElement;
  readonly inputWrapper: HTMLElement;
  readonly inputEl: ComposerInputElement;

  /** Nav row for tab badges and header icons (above input wrapper). */
  readonly navRowEl: HTMLElement;

  /** Composer-owned context tray container inside the input wrapper, for per-turn context. */
  readonly contextRowEl: HTMLElement;

  /** Read-only conversation facts (Linked content, context usage) directly under the input wrapper. */
  readonly infoRowEl: HTMLElement;
}

/** Proof that input/event wiring completed before the runtime was published. */
export interface TabInputBindings {
  readonly installed: true;
}

export interface TabRuntimeResourceState {
  readonly isDisposed: boolean;
}

/**
 * Represents a single assembled tab in the multi-tab system.
 * Each tab is an independent chat session with its own runtime instance.
 */
export interface AssembledTabRuntime extends ChatTab {
  readonly session: TabSession;
  /** State of loading the provider-owned conversation into the tab UI. */
  hydrationState: TabHydrationState;

  /** Per-tab owner of provider execution and session lifecycle. */
  readonly executionCoordinator: ChatExecutionCoordinator;

  /** Tab-manager-owned provider discovery callback retained across UI/runtime refreshes. */
  readonly providerCatalogResolver: ProviderCatalogResolver;

  /** Captures whether completed runtime work will need review after finalization. */
  readonly captureReviewableSettlement: ((outcome: TabReviewOutcome) => () => void) | null;

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

/**
 * Callbacks for tab state changes.
 */
export interface TabManagerCallbacks {
  /** Skips the target prompt when the active layout always forks into a new runtime tab. */
  shouldForkToNewTab?: () => boolean;

  /** Called after a newly created tab completes admission. */
  onTabCreated?: (tab: AssembledTabRuntime) => void;

  /** Called immediately after the active tab changes, before async tab loading completes. */
  onActiveTabChanged?: (fromTabId: TabId | null, toTabId: TabId) => void;

  /** Called after an explicit active-tab switch completes without rollback. */
  onActiveTabCommitted?: (fromTabId: TabId | null, toTabId: TabId) => void;

  /** Called when switching to a different tab. */
  onTabSwitched?: (fromTabId: TabId | null, toTabId: TabId) => void;

  /** Called when a tab is closed. */
  onTabClosed?: (tabId: TabId) => void;

  /** Called when tab streaming state changes. */
  onTabStreamingChanged?: (tabId: TabId, isStreaming: boolean) => void;

  /** Called when foreground, continuation, provider-background, or async-subagent work changes. */
  onTabWorkChanged?: (tabId: TabId) => void;

  /** Called when tab rewind transaction state changes. */
  onTabRewindingChanged?: (tabId: TabId, isRewinding: boolean) => void;

  /** Called when tab title changes. */
  onTabTitleChanged?: (tabId: TabId, title: string) => void;

  /** Called when tab attention state changes (approval pending, etc.). */
  onTabAttentionChanged?: (tabId: TabId, attention: TabAttention) => void;

  /** Called when a tab's conversation changes (loaded different conversation in same tab). */
  onTabConversationChanged?: (tabId: TabId, conversationId: string | null) => void;

  /** Called when the selected model for a blank retained tab changes. */
  onTabDraftChanged?: (tabId: TabId, draftModel: string | null) => void;

  /** Called when the active provider changes within a tab (blank tab model selection). */
  onTabProviderChanged?: (tabId: TabId, providerId: ProviderId | null) => void;
}
