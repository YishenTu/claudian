import type { Workspace, WorkspaceLeaf } from 'obsidian';
import { ItemView } from 'obsidian';

import {
  decodeTabWorkspaceViewState,
  TAB_WORKSPACE_VIEW_STATE_KEY,
} from '@/core/bootstrap/tabManagerState';
import { VIEW_TYPE_CLAUDIAN } from '@/core/types';
import type { ChatViewPlacement } from '@/core/types/settings';
import type { ClaudianView } from '@/features/chat/ClaudianView';
import type { ZenModeController } from '@/features/chat/zen/ZenModeController';
import { revealWorkspaceLeaf } from '@/utils/obsidianCompat';

/** Identifies a mounted chat view without relying on class identity across reloads. */
export function isClaudianView(value: unknown): value is ClaudianView {
  return !!value
    && typeof value === 'object'
    && typeof (value as { getTabManager?: unknown }).getTabManager === 'function';
}

/** Locates and opens the chat views mounted in the Obsidian workspace. */
export class ClaudianViews {
  /** The chat the toggle last hid, restored by its next show; only a preference, never a guard. */
  #toggleHiddenLeaf: WorkspaceLeaf | null = null;

  constructor(
    private readonly workspace: Workspace,
    private readonly getPlacement: () => ChatViewPlacement,
  ) {}

  /** The focused chat view, else the first mounted one. */
  getView(): ClaudianView | null {
    const leaves = this.workspace.getLeavesOfType(VIEW_TYPE_CLAUDIAN);
    return this.#getActiveView(leaves) ?? leaves.map(leaf => leaf.view).find(isClaudianView) ?? null;
  }

  #getActiveView(leaves: readonly WorkspaceLeaf[]): ClaudianView | null {
    const activeView = this.workspace.getActiveViewOfType(ItemView);
    return isClaudianView(activeView) && leaves.some(leaf => leaf.view === activeView) ? activeView : null;
  }

  getAllViews(): ClaudianView[] {
    const leaves = this.workspace.getLeavesOfType(VIEW_TYPE_CLAUDIAN);
    return leaves.map(leaf => leaf.view).filter(isClaudianView);
  }

  /** Chooses a visible composer without opening or revealing a chat. */
  getInputFocusView(zenLeaf: WorkspaceLeaf | null): ClaudianView | null {
    const views = this.getAllViews().filter(view => view.getActiveTab()?.composer.isVisible());
    const preferred = this.getView();
    return views.find(view => view.getActiveTab()?.composer.isFocused())
      ?? views.find(view => view.leaf === zenLeaf)
      ?? views.find(view => view === preferred)
      ?? views[0]
      ?? null;
  }

  findConversationAcrossViews(conversationId: string): { view: ClaudianView; tabId: string } | null {
    for (const view of this.getAllViews()) {
      const tabManager = view.getTabManager();
      if (!tabManager) continue;

      const tabs = tabManager.getTabIdentities();
      for (const tab of tabs) {
        if (tab.conversationId === conversationId) {
          return { view, tabId: tab.id };
        }
      }
    }
    return null;
  }

  /** Sessions held by any chat pane's tabs, including unloaded panes and pending restoration. */
  getWorkspaceConversationIds(): ReadonlySet<string> {
    const ids = new Set<string>();
    for (const leaf of this.workspace.getLeavesOfType(VIEW_TYPE_CLAUDIAN)) {
      const liveTabs = isClaudianView(leaf.view) ? leaf.view.getTabManager()?.getTabIdentities() ?? [] : [];
      // Deferred leaves keep their saved state; mounted views report pending restoration through getState().
      const savedTabs = decodeTabWorkspaceViewState(
        leaf.getViewState().state?.[TAB_WORKSPACE_VIEW_STATE_KEY],
      )?.openTabs ?? [];
      for (const { conversationId } of [...liveTabs, ...savedTabs]) {
        if (conversationId) ids.add(conversationId);
      }
    }
    return ids;
  }

  /**
   * Hides a chat the user can see, else shows one. A shown zen panel hides itself; a
   * sidebar chat yields to a sibling tab so the sidebar stays open.
   */
  async toggleView(zen: Pick<ZenModeController, 'toggleVisibility' | 'hide' | 'getActiveLeaf'>): Promise<void> {
    if (zen.toggleVisibility()) {
      const leaf = zen.getActiveLeaf();
      if (leaf && isClaudianView(leaf.view)) leaf.view.focusActiveInput();
      return;
    }
    const leaves = this.workspace.getLeavesOfType(VIEW_TYPE_CLAUDIAN);
    // Main-area chats are revealed rather than closed, since closing shuts down their sessions.
    const shown = leaves.filter(candidate => (
      isClaudianView(candidate.view) && candidate.view.containerEl.isShown() && this.#getExpandedSidebar(candidate)
    ));
    const preferred = this.getView();
    const leaf = shown.find(candidate => candidate.view === preferred) ?? shown[0];
    const sidebar = leaf ? this.#getExpandedSidebar(leaf) : null;
    if (!leaf || !sidebar) {
      const hidden = this.#toggleHiddenLeaf;
      this.#toggleHiddenLeaf = null;
      await this.activateView(hidden && leaves.includes(hidden) ? hidden : undefined);
      return;
    }
    this.#toggleHiddenLeaf = leaf;
    const sibling = this.#findMostRecentSibling(leaf);
    if (sibling) {
      await revealWorkspaceLeaf(this.workspace, sibling);
      return;
    }
    // A chat-only tab group can only hide with its sidebar; zen must not replace it.
    sidebar.collapse();
    zen.hide(leaf);
  }

  /** Reveals and focuses the preferred or active chat leaf, else the first one, else opens one. */
  async activateView(preferred?: WorkspaceLeaf): Promise<void> {
    const { workspace } = this;
    const leaves = workspace.getLeavesOfType(VIEW_TYPE_CLAUDIAN);
    const existingLeaf = preferred ?? this.#getActiveView(leaves)?.leaf ?? leaves[0];
    const leaf = existingLeaf
      ?? this.#getLeafForPlacement(this.getPlacement());
    if (!leaf) return;

    let focusSuperseded = false;
    const focusIntentRef = workspace.on('active-leaf-change', (activeLeaf) => {
      if (activeLeaf && activeLeaf !== leaf) {
        focusSuperseded = true;
      }
    });

    try {
      if (!existingLeaf) {
        await leaf.setViewState({
          type: VIEW_TYPE_CLAUDIAN,
          active: true,
        });
      }

      await revealWorkspaceLeaf(workspace, leaf);
      if (!focusSuperseded && isClaudianView(leaf.view)) {
        leaf.view.focusActiveInput();
      }
    } finally {
      workspace.offref(focusIntentRef);
    }
  }

  /**
   * Shows a session in the focused chat view, else the first one, else a new one at the configured
   * placement. Focus and reveal follow only when asked; a new view then opens as the active leaf.
   */
  async openSession(conversationId: string, options: { focus: boolean }): Promise<void> {
    const leaves = this.workspace.getLeavesOfType(VIEW_TYPE_CLAUDIAN);
    let leaf: WorkspaceLeaf | null = this.#getActiveView(leaves)?.leaf ?? leaves[0] ?? null;
    if (leaf) {
      await leaf.loadIfDeferred();
    } else {
      leaf = this.#getLeafForPlacement(this.getPlacement());
      if (!leaf) throw new Error('No chat view could be opened');
      await leaf.setViewState({ type: VIEW_TYPE_CLAUDIAN, active: options.focus });
    }
    if (!isClaudianView(leaf.view)) throw new Error('The chat view is not ready');
    await leaf.view.openSession(conversationId);
    // Navigation may show the session in the view that already holds it rather than this one.
    if (options.focus) await this.activateView(this.findConversationAcrossViews(conversationId)?.view.leaf ?? leaf);
  }

  #getExpandedSidebar(leaf: WorkspaceLeaf): { collapse(): void } | null {
    const root = leaf.getRoot();
    const { leftSplit, rightSplit } = this.workspace;
    if (root === leftSplit && !leftSplit.collapsed) return leftSplit;
    if (root === rightSplit && !rightSplit.collapsed) return rightSplit;
    return null;
  }

  #findMostRecentSibling(leaf: WorkspaceLeaf): WorkspaceLeaf | null {
    const siblings: WorkspaceLeaf[] = [];
    // The workspace identifies deferred chat leaves before their views are mounted.
    const chatLeaves = this.workspace.getLeavesOfType(VIEW_TYPE_CLAUDIAN);
    this.workspace.iterateAllLeaves((candidate) => {
      if (candidate !== leaf && candidate.parent === leaf.parent && !chatLeaves.includes(candidate)) siblings.push(candidate);
    });
    // activeTime is Obsidian's unexposed focus timestamp; without it, tab order decides.
    const activeTime = (candidate: WorkspaceLeaf) => (candidate as { activeTime?: number }).activeTime ?? 0;
    return siblings.reduce<WorkspaceLeaf | null>(
      (best, candidate) => (!best || activeTime(candidate) > activeTime(best) ? candidate : best),
      null,
    );
  }

  #getLeafForPlacement(placement: ChatViewPlacement): WorkspaceLeaf | null {
    const { workspace } = this;
    switch (placement) {
      case 'main-tab':
        return workspace.getLeaf('tab');
      case 'left-sidebar':
        return workspace.getLeftLeaf(false);
      case 'right-sidebar':
        return workspace.getRightLeaf(false);
    }
  }
}
