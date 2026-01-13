/**
 * TabBar - UI component for tab navigation.
 *
 * Renders the tab bar in the header between the logo and right-side buttons.
 * Shows tab titles, streaming indicators, and close buttons.
 */

import { setIcon } from 'obsidian';

import type { TabBarItem, TabId } from './types';
import { MAX_TABS } from './types';

/** Callbacks for TabBar interactions. */
export interface TabBarCallbacks {
  /** Called when a tab is clicked. */
  onTabClick: (tabId: TabId) => void;

  /** Called when the close button is clicked on a tab. */
  onTabClose: (tabId: TabId) => void;

  /** Called when the new tab button is clicked. */
  onNewTab: () => void;
}

/**
 * TabBar renders the tab navigation UI.
 */
export class TabBar {
  private containerEl: HTMLElement;
  private callbacks: TabBarCallbacks;
  private tabsContainerEl: HTMLElement | null = null;
  private newTabBtnEl: HTMLElement | null = null;

  constructor(containerEl: HTMLElement, callbacks: TabBarCallbacks) {
    this.containerEl = containerEl;
    this.callbacks = callbacks;
    this.build();
  }

  /** Builds the tab bar UI. */
  private build(): void {
    this.containerEl.addClass('claudian-tab-bar');

    // Container for tabs
    this.tabsContainerEl = this.containerEl.createDiv({ cls: 'claudian-tab-bar-tabs' });

    // New tab button
    this.newTabBtnEl = this.containerEl.createDiv({ cls: 'claudian-tab-bar-new' });
    setIcon(this.newTabBtnEl, 'plus');
    this.newTabBtnEl.setAttribute('aria-label', 'New tab');
    this.newTabBtnEl.addEventListener('click', (e) => {
      e.stopPropagation();
      this.callbacks.onNewTab();
    });
  }

  /**
   * Updates the tab bar with new tab data.
   * @param items Tab items to render.
   */
  update(items: TabBarItem[]): void {
    if (!this.tabsContainerEl) return;

    // Clear existing tabs
    this.tabsContainerEl.empty();

    // Render tabs
    for (const item of items) {
      this.renderTab(item);
    }

    // Update new tab button visibility
    if (this.newTabBtnEl) {
      this.newTabBtnEl.style.display = items.length >= MAX_TABS ? 'none' : 'flex';
    }
  }

  /** Renders a single tab. */
  private renderTab(item: TabBarItem): void {
    if (!this.tabsContainerEl) return;

    const tabEl = this.tabsContainerEl.createDiv({
      cls: `claudian-tab-bar-tab ${item.isActive ? 'claudian-tab-bar-tab-active' : ''}`,
    });

    // Tab content (title and streaming indicator)
    const contentEl = tabEl.createDiv({ cls: 'claudian-tab-bar-tab-content' });

    // Streaming indicator
    if (item.isStreaming) {
      const spinnerEl = contentEl.createSpan({ cls: 'claudian-tab-bar-spinner' });
      setIcon(spinnerEl, 'loader-2');
    }

    // Title
    const titleEl = contentEl.createSpan({
      cls: 'claudian-tab-bar-tab-title',
      text: this.truncateTitle(item.title),
    });
    titleEl.setAttribute('title', item.title);

    // Close button (shown on hover)
    if (item.canClose) {
      const closeEl = tabEl.createDiv({ cls: 'claudian-tab-bar-tab-close' });
      setIcon(closeEl, 'x');
      closeEl.setAttribute('aria-label', 'Close tab');
      closeEl.addEventListener('click', (e) => {
        e.stopPropagation();
        this.callbacks.onTabClose(item.id);
      });
    }

    // Tab click handler
    tabEl.addEventListener('click', () => {
      this.callbacks.onTabClick(item.id);
    });
  }

  /** Truncates a title to fit in the tab. */
  private truncateTitle(title: string): string {
    const maxLength = 20;
    if (title.length <= maxLength) return title;
    return title.substring(0, maxLength - 1) + '…';
  }

  /** Destroys the tab bar. */
  destroy(): void {
    this.containerEl.empty();
    this.containerEl.removeClass('claudian-tab-bar');
    this.tabsContainerEl = null;
    this.newTabBtnEl = null;
  }
}
