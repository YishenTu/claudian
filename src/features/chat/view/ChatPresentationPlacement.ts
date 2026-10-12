import type { ChatTab, TabTranscriptPlacement } from '@/features/chat/tabs/ChatTab';
import type { ZenModeSlots } from '@/features/chat/zen/types';

export interface ChatPresentationContext {
  getActiveTab(): ChatTab | null;
  isWide(): boolean;
  getTabCount(): number | null;
}

/**
 * The view's placement authority: where the active tab's composer, transcript,
 * and side-chat chip live, in the view footer or in attached zen slots.
 */
export class ChatPresentationPlacement {
  private chatPanelEl: HTMLElement | null = null;
  private inputFooterEl: HTMLElement | null = null;
  private sideChatChipHostEl: HTMLElement | null = null;
  private inputNavRowHostEl: HTMLElement | null = null;
  private activeInputSlotEl: HTMLElement | null = null;
  private navRowContentEl: HTMLElement | null = null;
  /**
   * The runtime whose composer sits in the active input slot. Held by reference, not by id: a
   * rebind installs a new runtime under the same tab id, so an id match cannot tell whether the
   * composer in the slot still belongs to the active tab.
   */
  private activeInputTab: ChatTab | null = null;
  private sideChatChipTab: ChatTab | null = null;
  private zenSlots: ZenModeSlots | null = null;
  private zenTranscript: { tab: ChatTab; placement: TabTranscriptPlacement } | null = null;

  constructor(private readonly context: ChatPresentationContext) {}

  /** Builds the view-owned footer: chip slot, navigation row host, and composer slot. */
  mount(chatPanelEl: HTMLElement): void {
    this.chatPanelEl = chatPanelEl;
    this.inputFooterEl = chatPanelEl.createDiv({ cls: 'claudian-input-footer' });
    this.sideChatChipHostEl = this.inputFooterEl.createDiv({ cls: 'claudian-side-chat-chip-slot' });
    this.inputNavRowHostEl = this.inputFooterEl.createDiv({
      cls: 'claudian-input-nav-row claudian-view-input-nav-row',
    });
    this.activeInputSlotEl = this.inputFooterEl.createDiv({ cls: 'claudian-active-input-slot' });
    this.navRowContentEl = null;
  }

  /** Moves the shared navigation row content into the footer's navigation host. */
  attachNavRow(navRowContentEl: HTMLElement): void {
    this.navRowContentEl = navRowContentEl;
    this.inputNavRowHostEl?.appendChild(navRowContentEl);
  }

  /** View controls that keep the active tab's selection context while focused. */
  getSharedFocusScopeEls(): HTMLElement[] {
    return this.inputNavRowHostEl ? [this.inputNavRowHostEl] : [];
  }

  /** Places the active composer in the footer slot, or the zen slot while zen owns presentation. */
  update(): void {
    const activeTab = this.context.getActiveTab();
    const activeInputSlotEl = this.activeInputSlotEl;
    if (!activeInputSlotEl) return;
    this.updateChip();
    this.updateZenTranscript(activeTab);
    const zenComposerSlotEl = this.zenSlots?.composerEl ?? null;
    const inputSlotEl = zenComposerSlotEl ?? activeInputSlotEl;

    if (!activeTab) {
      activeInputSlotEl.empty();
      zenComposerSlotEl?.empty();
      this.activeInputTab = null;
      return;
    }

    if (this.activeInputTab && this.activeInputTab !== activeTab) {
      this.activeInputTab.placement.restoreComposer();
    }

    if (this.activeInputTab === activeTab) {
      if (!activeTab.placement.isComposerPlacedIn(inputSlotEl)) {
        activeTab.placement.placeComposer(inputSlotEl);
      }
      return;
    }

    inputSlotEl.empty();
    activeTab.placement.placeComposer(inputSlotEl);
    this.activeInputTab = activeTab;
  }

  /** Lends the side-chat chip and full height hosts to the active tab for the current layout. */
  updateChip(): void {
    const hostEl = this.sideChatChipHostEl;
    if (!hostEl) return;
    const isWide = this.context.isWide();
    if (this.navRowContentEl && this.inputFooterEl && this.inputNavRowHostEl) {
      const useNavRow = !isWide && this.context.getTabCount() === 1;
      const parent = useNavRow ? this.navRowContentEl : this.inputFooterEl;
      if (hostEl.parentElement !== parent) {
        parent.insertBefore(hostEl, useNavRow ? parent.firstChild : this.inputNavRowHostEl);
      }
    }
    const chipTab = this.context.getActiveTab();
    if (this.sideChatChipTab !== chipTab) {
      this.sideChatChipTab?.placement.setSideChatChipHost(null);
      this.sideChatChipTab?.placement.setSideChatFullHeightHost(null);
    }
    this.sideChatChipTab = chipTab;
    // Zen provides its own chip slot; the wide layout keeps the chip inside the composer.
    chipTab?.placement.setSideChatChipHost(
      this.zenSlots?.sideChatChipEl ?? (isWide ? null : hostEl),
    );
    // The floating zen composer has no transcript of its own to give up.
    chipTab?.placement.setSideChatFullHeightHost(this.zenSlots ? null : this.chatPanelEl);
  }

  /** Lends presentation to zen slots until the returned release runs. */
  attachZen(slots: ZenModeSlots): () => void {
    this.zenSlots = slots;
    this.update();
    return () => {
      if (this.zenSlots !== slots) return;
      this.zenSlots = null;
      this.update();
    };
  }

  /** Returns the chip and the active composer to their tab-owned locations. */
  restoreAll(): void {
    this.sideChatChipTab?.placement.setSideChatChipHost(null);
    this.sideChatChipTab?.placement.setSideChatFullHeightHost(null);
    this.sideChatChipTab = null;
    if (!this.activeInputTab) return;

    this.activeInputTab.placement.restoreComposer();
    this.activeInputSlotEl?.empty();
    this.activeInputTab = null;
  }

  /** Moves the active transcript into zen history, restoring any other placement first. */
  private updateZenTranscript(activeTab: ChatTab | null): void {
    const historyEl = this.zenSlots?.historyEl ?? null;
    const placed = this.zenTranscript;
    if (placed && (placed.tab !== activeTab || !placed.placement.isPlacedIn(historyEl))) {
      placed.placement.restore();
      this.zenTranscript = null;
    }
    if (!historyEl || !activeTab || this.zenTranscript) return;

    this.zenTranscript = { tab: activeTab, placement: activeTab.placement.placeTranscript(historyEl) };
  }
}
