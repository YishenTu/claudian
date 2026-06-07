import { Menu, Notice, setIcon } from 'obsidian';

import { ProviderRegistry } from '../../../core/providers/ProviderRegistry';
import type { ProviderId } from '../../../core/providers/types';
import type { ConversationMeta } from '../../../core/types';
import type ClaudianPlugin from '../../../main';
import { createProviderIconSvg } from '../../../shared/icons';
import type { TabManager } from '../tabs/TabManager';
import type { TabBarItem } from '../tabs/types';

/**
 * Plain-DOM renderer for the right-sidebar session switcher.
 *
 * Reads from and drives the active main-window chat view's TabManager. Open tabs
 * and recent (non-open) conversations are rendered as two sections; the panel
 * stays fresh via the plugin's sessions-change emitter (re-render on each notify).
 */
export class SessionsPanel {
  private plugin: ClaudianPlugin;
  private containerEl: HTMLElement;

  constructor(plugin: ClaudianPlugin, containerEl: HTMLElement) {
    this.plugin = plugin;
    this.containerEl = containerEl;
  }

  render(): void {
    this.containerEl.empty();

    this.renderNewSessionButton();

    const tabManager = this.plugin.getActiveChatView()?.getTabManager() ?? null;
    const openItems = tabManager?.getTabBarItems() ?? [];
    const openConversationIds = new Set(
      (tabManager?.getAllTabs() ?? [])
        .map((tab) => tab.conversationId)
        .filter((id): id is string => !!id),
    );

    this.renderOpenTabs(openItems, tabManager);
    this.renderRecentSessions(openConversationIds);
  }

  destroy(): void {
    this.containerEl.empty();
  }

  // ============================================
  // Sections
  // ============================================

  private renderNewSessionButton(): void {
    const btn = this.containerEl.createDiv({ cls: 'claudian-sessions-new-btn' });
    const iconEl = btn.createSpan({ cls: 'claudian-sessions-new-btn-icon' });
    setIcon(iconEl, 'square-plus');
    btn.createSpan({ cls: 'claudian-sessions-new-btn-label', text: 'New session' });
    btn.setAttribute('aria-label', 'Create a new session');
    btn.addEventListener('click', () => {
      void this.withTabManager(async (tabManager) => {
        const tab = await tabManager.createTab();
        if (!tab) {
          const maxTabs = this.plugin.settings.maxTabs ?? 3;
          new Notice(`Maximum ${maxTabs} tabs allowed`);
        }
      }, 'Failed to create session');
    });
  }

  private renderOpenTabs(items: TabBarItem[], tabManager: TabManager | null): void {
    if (!tabManager || items.length === 0) {
      return;
    }

    this.containerEl.createDiv({ cls: 'claudian-sessions-section-header', text: 'Open' });
    const list = this.containerEl.createDiv({ cls: 'claudian-sessions-list' });

    for (const item of items) {
      const row = list.createDiv({
        cls: `claudian-sessions-item${item.isActive ? ' claudian-sessions-item--active' : ''}`,
      });
      if (item.needsAttention) {
        row.addClass('claudian-sessions-item--attention');
      } else if (item.isStreaming) {
        row.addClass('claudian-sessions-item--streaming');
      }

      this.appendProviderDot(row, item.providerId);

      const content = row.createDiv({ cls: 'claudian-sessions-item-content' });
      const titleEl = content.createDiv({ cls: 'claudian-sessions-item-title', text: item.title });
      titleEl.setAttribute('title', item.title);

      const statusText = item.isActive
        ? 'Active'
        : item.needsAttention
          ? 'Needs attention'
          : item.isStreaming
            ? 'Working…'
            : 'Open';
      content.createDiv({ cls: 'claudian-sessions-item-meta', text: statusText });

      content.addEventListener('click', () => {
        void this.runAction(
          () => tabManager.switchToTab(item.id),
          'Failed to switch session',
        );
      });

      if (item.canClose) {
        const closeBtn = row.createEl('button', {
          cls: 'claudian-sessions-item-close',
        });
        setIcon(closeBtn, 'x');
        closeBtn.setAttribute('aria-label', 'Close session');
        closeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          void this.runAction(
            () => tabManager.closeTab(item.id, item.isStreaming),
            'Failed to close session',
          );
        });
      }
    }
  }

  private renderRecentSessions(openConversationIds: Set<string>): void {
    const conversations = [...this.plugin.getConversationList()]
      .sort((a, b) => (b.lastResponseAt ?? b.createdAt) - (a.lastResponseAt ?? a.createdAt))
      .filter((conv) => !openConversationIds.has(conv.id));

    this.containerEl.createDiv({ cls: 'claudian-sessions-section-header', text: 'Recent' });

    if (conversations.length === 0) {
      this.containerEl.createDiv({
        cls: 'claudian-sessions-empty',
        text: openConversationIds.size > 0 ? 'No other sessions' : 'No sessions yet',
      });
      return;
    }

    const list = this.containerEl.createDiv({ cls: 'claudian-sessions-list' });

    for (const conv of conversations) {
      const row = list.createDiv({ cls: 'claudian-sessions-item' });

      this.appendProviderDot(row, conv.providerId);

      const content = row.createDiv({ cls: 'claudian-sessions-item-content' });
      const titleEl = content.createDiv({ cls: 'claudian-sessions-item-title', text: conv.title });
      titleEl.setAttribute('title', conv.title);
      content.createDiv({
        cls: 'claudian-sessions-item-meta',
        text: conv.titleGenerationStatus === 'pending'
          ? 'Generating title…'
          : this.formatDate(conv.lastResponseAt ?? conv.createdAt),
      });

      content.addEventListener('click', () => {
        void this.withTabManager(
          (tabManager) => tabManager.openConversation(conv.id, { preferNewTab: true, activate: true }),
          'Failed to open session',
        );
      });

      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.showRecentContextMenu(conv, e);
      });
    }
  }

  // ============================================
  // Context menu
  // ============================================

  private showRecentContextMenu(conv: ConversationMeta, event: MouseEvent): void {
    const menu = new Menu();

    menu.addItem((item) => item
      .setTitle('Open in new tab')
      .setIcon('square-plus')
      .onClick(() => {
        void this.withTabManager(
          (tabManager) => tabManager.openConversation(conv.id, { preferNewTab: true, activate: true }),
          'Failed to open session',
        );
      }));

    menu.addItem((item) => item
      .setTitle('Delete')
      .setIcon('trash-2')
      .onClick(() => {
        void this.runAction(
          () => this.plugin.deleteConversation(conv.id),
          'Failed to delete session',
        );
      }));

    menu.showAtMouseEvent(event);
  }

  // ============================================
  // Helpers
  // ============================================

  /**
   * Resolves the active chat view's TabManager, opening the chat view first when
   * none exists, then runs the action against it.
   */
  private async withTabManager(
    action: (tabManager: TabManager) => Promise<void>,
    errorMessage: string,
  ): Promise<void> {
    try {
      let view = this.plugin.getActiveChatView();
      if (!view) {
        await this.plugin.activateView();
        view = this.plugin.getActiveChatView();
      }
      const tabManager = view?.getTabManager();
      if (!tabManager) {
        new Notice('Open the Claudian chat view first.');
        return;
      }
      await action(tabManager);
    } catch {
      new Notice(errorMessage);
    }
  }

  private async runAction(action: () => Promise<unknown>, errorMessage: string): Promise<void> {
    try {
      await action();
    } catch {
      new Notice(errorMessage);
    }
  }

  private appendProviderDot(parent: HTMLElement, providerId: ProviderId): void {
    const dot = parent.createSpan({ cls: 'claudian-sessions-provider-dot' });
    dot.setAttribute('data-provider', providerId);
    const icon = ProviderRegistry.getChatUIConfig(providerId).getProviderIcon?.();
    if (icon) {
      dot.appendChild(createProviderIconSvg(icon, {
        dataProvider: providerId,
        height: 12,
        ownerDocument: dot.ownerDocument,
        width: 12,
      }));
    }
  }

  private formatDate(timestamp: number): string {
    const date = new Date(timestamp);
    const now = new Date();
    if (date.toDateString() === now.toDateString()) {
      return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
    }
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
}
