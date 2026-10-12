import type { Component, TFile, WorkspaceLeaf } from 'obsidian';

import type { ProviderId, TitleGenerationService } from '@/core/providers/types';
import type { ChatMessage } from '@/core/types';
import type { TabAttention } from '@/features/chat/state/types';
import type { TabIdentity } from '@/features/chat/tabs/TabIdentity';
import type { ZenPresentationPort } from '@/features/chat/zen/types';

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
}

/**
 * Minimal interface for TabManager methods used by external code.
 * Used to break circular dependencies.
 */
export interface TabManagerInterface {
  /** Switches to a specific tab. */
  switchToTab(tabId: TabId): Promise<void>;

  /** Gets all tabs. */
  getAllTabs(): ChatTab[];
  getTabIdentities(): readonly Readonly<TabIdentity>[];

  /** Reports aggregate user-visible work for a runtime tab. */
  isTabWorking(tabId: TabId): boolean;
}

/** Tab identifier type. */
export type TabId = string;

/**
 * Runtime tab lifecycle states, independent from conversation binding:
 * - `provisional`: Replaceable session preview created by dual-mode navigation.
 * - `open`: Retained working state; provider execution is owned by the execution coordinator.
 * - `closing`: Tab is being torn down.
 */
export type TabLifecycleState = 'provisional' | 'open' | 'closing';

/** Conversation hydration state, independent from runtime activation. */
export type TabHydrationState = 'idle' | 'loading' | 'ready' | 'failed';

/** Linked content operations a host view forwards to a tab. */
export interface TabLinkedContentPort {
  selectExplicit(path: string | null): void;
  handleActiveFileChanged(file: TFile | null, isActiveOwner: boolean): void;
  handleActiveFileMetadataChanged(file: TFile | null): void;
  handleRenamed(oldPath: string, newPath: string, includeDescendants?: boolean): void;
  handleDeleted(path: string, includeDescendants?: boolean): void;
  handleCreated(path: string): void;
}

/** Composer operations a host view drives without reaching into the composer's DOM or controls. */
export interface TabComposerPort {
  focus(): void;
  isFocused(): boolean;
  /** Whether the mounted input is currently rendered and visible. */
  isVisible(): boolean;
  /** Switches between this input and the control focused before the command entered it. */
  toggleFocus(): void;
  /** Appends text without sending it, as if typed at the end; false when there is nothing to add. */
  appendText(text: string): boolean;
  /** Closes an open toolbar menu; true when one was open. */
  closeOpenMenu(): boolean;
  /** Hides the composer dropdown unless `target` is inside it or is the input. */
  dismissDropdownFor(target: EventTarget | null): void;
  setHiddenCommands(commands: ReadonlySet<string>): void;
  /** Invalidates session mentions after the conversation list changes. */
  invalidateSessionMentions(): void;
}

/** Restores a transcript moved by `TabPlacementPort.placeTranscript`. */
export interface TabTranscriptPlacement {
  isPlacedIn(hostEl: HTMLElement | null): boolean;
  restore(): void;
}

/**
 * Moves a tab's existing composer, transcript, and collapsed side-chat chip between host
 * slots. The host view remains the placement authority; nothing is rebuilt or cloned.
 */
export interface TabPlacementPort {
  /** Moves the composer into `slotEl`, restoring focus when the composer already held it. */
  placeComposer(slotEl: HTMLElement): void;
  isComposerPlacedIn(slotEl: HTMLElement): boolean;
  /** Returns the composer to the tab's own content. */
  restoreComposer(): void;
  /** Moves the transcript into `hostEl`, leaving an anchor that the returned handle restores. */
  placeTranscript(hostEl: HTMLElement): TabTranscriptPlacement;
  setSideChatChipHost(hostEl: HTMLElement | null): void;
  /** Lends the view element that a full height side chat takes over; null outside the view footer. */
  setSideChatFullHeightHost(hostEl: HTMLElement | null): void;
}

/**
 * The surface a host view uses: identity, activity, presentation reads, and tab-level
 * operations. Controllers, UI components, DOM, and the renderer stay with the tab modules.
 */
export interface ChatTab {
  /** Unique tab identifier. */
  readonly id: TabId;
  /** Conversation ID bound to this tab (null for new/empty tabs). */
  readonly conversationId: string | null;
  /** Active provider for this tab's current conversation/runtime. */
  readonly providerId: ProviderId | null;
  /** Explicit lifecycle state. */
  readonly lifecycleState: TabLifecycleState;
  /**
   * Draft model selected in a blank tab (before first send).
   * Used to derive provider on first send. Null after binding.
   */
  readonly draftModel: string | null;
  /** The user's custom name for the tab, absent when it shows its conversation title. */
  readonly label?: string;
  /** The tab's presentation identity and projections of its attached session's activity. */
  readonly session: { readonly hasActiveTurn: boolean };
  readonly hydrationState: TabHydrationState;
  /** Presentation reads; mutation stays with the tab's controllers. */
  readonly state: { readonly attention: TabAttention; readonly isStreaming: boolean; readonly messages: readonly ChatMessage[] };
  readonly services: { readonly titleGenerationService: TitleGenerationService };
  readonly composer: TabComposerPort;
  readonly linkedContent: TabLinkedContentPort;
  readonly placement: TabPlacementPort;
  readonly zenPresentation: ZenPresentationPort;
  /** Re-renders model, mode, effort, permission, service-tier, and context-usage controls. */
  refreshProviderControls(): void;
  refreshMessageTimestamps(): void;
}

/**
 * Tab bar item representation for rendering.
 */
export interface TabBarItem {
  id: TabId;
  /** 1-based index for display. */
  index: number;
  title: string;
  /** The user's custom name for the tab, shown instead of the title when set. */
  label?: string;
  isActive: boolean;
  /** True while any foreground, continuation, provider-background, or async-subagent work remains. */
  isWorking: boolean;
  attention: TabAttention;
  canClose: boolean;
}
