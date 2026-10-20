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
  constructor(
    private readonly workspace: Workspace,
    private readonly getPlacement: () => ChatViewPlacement,
  ) {}

  /** The focused chat view, else the first mounted one. */
  getView(): ClaudianView | null {
    const leaves = this.workspace.getLeavesOfType(VIEW_TYPE_CLAUDIAN);
    const activeView = this.workspace.getActiveViewOfType(ItemView);
    if (isClaudianView(activeView) && leaves.some(leaf => leaf.view === activeView)) {
      return activeView;
    }
    return leaves.map(leaf => leaf.view).find(isClaudianView) ?? null;
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
  async toggleView(zen: Pick<ZenModeController, 'toggleVisibility' | 'hide'>): Promise<void> {
    if (zen.toggleVisibility()) return;
    // Main-area chats are revealed rather than closed, since closing shuts down their sessions.
    const shown = this.workspace.getLeavesOfType(VIEW_TYPE_CLAUDIAN).filter(candidate => (
      isClaudianView(candidate.view) && candidate.view.containerEl.isShown() && this.#getExpandedSidebar(candidate)
    ));
    const preferred = this.getView();
    const leaf = shown.find(candidate => candidate.view === preferred) ?? shown[0];
    const sidebar = leaf ? this.#getExpandedSidebar(leaf) : null;
    if (!leaf || !sidebar) {
      await this.activateView();
      return;
    }
    const sibling = this.#findMostRecentSibling(leaf);
    if (sibling) {
      await revealWorkspaceLeaf(this.workspace, sibling);
      return;
    }
    // A lone sidebar chat can only hide with its sidebar; zen must not replace it.
    sidebar.collapse();
    zen.hide(leaf);
  }

  async activateView(): Promise<void> {
    const { workspace } = this;
    const existingLeaf = workspace.getLeavesOfType(VIEW_TYPE_CLAUDIAN)[0];
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

  #getExpandedSidebar(leaf: WorkspaceLeaf): { collapse(): void } | null {
    const root = leaf.getRoot();
    const { leftSplit, rightSplit } = this.workspace;
    if (root === leftSplit && !leftSplit.collapsed) return leftSplit;
    if (root === rightSplit && !rightSplit.collapsed) return rightSplit;
    return null;
  }

  #findMostRecentSibling(leaf: WorkspaceLeaf): WorkspaceLeaf | null {
    const siblings: WorkspaceLeaf[] = [];
    this.workspace.iterateAllLeaves((candidate) => {
      if (candidate !== leaf && candidate.parent === leaf.parent) siblings.push(candidate);
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
