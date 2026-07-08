import { scheduleAnimationFrame } from '../../../utils/animationFrame';
import type { TabBarItem, TabId } from './types';

const EXPANDED_TITLE_MAX_LENGTH = 32;
const TRUNCATED_TITLE_SUFFIX = '...';

/** Callbacks for TabBar interactions. */
export interface TabBarCallbacks {
  /** Called when a tab badge is clicked. */
  onTabClick: (tabId: TabId) => void;

  /** Called when the close button is clicked on a tab. */
  onTabClose: (tabId: TabId) => void;

  /** Called when the new tab button is clicked. */
  onNewTab: () => void;
}

/** Optional configuration for TabBar rendering. */
export interface TabBarOptions {
  /**
   * Whether badges should display the conversation title by default
   * instead of the tab number. Read lazily so the setting applies live.
   * Defaults to `false` (number-first, legacy behavior).
   */
  getShowTitlesByDefault?: () => boolean;
}

/**
 * TabBar renders minimal numbered badge navigation.
 */
export class TabBar {
  private containerEl: HTMLElement;
  private callbacks: TabBarCallbacks;
  private readonly getShowTitlesByDefault: () => boolean;
  // Tabs whose display the user has flipped away from the current default via
  // double-click (title <-> number). Interpreted relative to the default mode.
  private toggledTabIds = new Set<TabId>();
  // Signature of the last rendered items; used to skip redundant rebuilds.
  // Rebuilding empties the container and recreates badge nodes, which destroys
  // the element mid-gesture and breaks native double-click. Skipping no-op
  // rebuilds (e.g. clicking the already-active tab) keeps badge nodes stable.
  private lastRenderSignature: string | null = null;
  private forceNextRender = false;
  private lastKnownScrollLeft = 0;
  private readonly handleScroll = (): void => {
    this.captureScrollPosition();
  };

  constructor(containerEl: HTMLElement, callbacks: TabBarCallbacks, options?: TabBarOptions) {
    this.containerEl = containerEl;
    this.callbacks = callbacks;
    this.getShowTitlesByDefault = options?.getShowTitlesByDefault ?? (() => false);
    this.build();
  }

  /** Builds the tab bar UI. */
  private build(): void {
    this.containerEl.addClass('claudian-tab-badges');
    this.containerEl.addEventListener('scroll', this.handleScroll);
  }

  /**
   * Updates the tab bar with new tab data.
   * @param items Tab items to render.
   */
  update(items: TabBarItem[]): void {
    this.pruneExpandedTitleState(items);

    // Skip redundant rebuilds: recreating badge nodes on every call (e.g. when
    // clicking the already-active tab) destroys the element a double-click is
    // landing on, which breaks the title/number toggle. Only rebuild when the
    // rendered inputs actually changed, or when a refresh was forced.
    const signature = this.computeRenderSignature(items);
    if (!this.forceNextRender && signature === this.lastRenderSignature) {
      return;
    }
    this.forceNextRender = false;
    this.lastRenderSignature = signature;

    this.captureStableScrollPosition();

    // Clear existing badges
    this.containerEl.empty();

    // Render badges
    for (const item of items) {
      this.renderBadge(item);
    }

    this.restoreScrollPosition();
  }

  /**
   * Forces the next update() to rebuild even if the item signature is unchanged.
   * Used when a rendering input outside the item list changes (e.g. the
   * "show tab titles by default" setting).
   */
  invalidate(): void {
    this.forceNextRender = true;
    this.lastRenderSignature = null;
  }

  /** Builds a stable signature of every input that affects badge rendering. */
  private computeRenderSignature(items: TabBarItem[]): string {
    return items
      .map(item => [
        item.id,
        item.index,
        item.title,
        item.providerId,
        item.isActive ? 1 : 0,
        item.isStreaming ? 1 : 0,
        item.needsAttention ? 1 : 0,
        item.canClose ? 1 : 0,
      ].join(''))
      .join('');
  }

  /** Renders a single tab badge. */
  private renderBadge(item: TabBarItem): void {
    // Determine state class (priority: active > attention > streaming > idle)
    let stateClass = 'claudian-tab-badge-idle';
    if (item.isActive) {
      stateClass = 'claudian-tab-badge-active';
    } else if (item.needsAttention) {
      stateClass = 'claudian-tab-badge-attention';
    } else if (item.isStreaming) {
      stateClass = 'claudian-tab-badge-streaming';
    }

    const showTitle = this.shouldShowTitle(item);
    const badgeEl = this.containerEl.createDiv({
      cls: [
        'claudian-tab-badge',
        stateClass,
        showTitle ? 'claudian-tab-badge-expanded' : '',
      ].filter(Boolean).join(' '),
      text: this.getBadgeLabel(item),
    });

    // Obsidian uses aria-label for hover tooltips here; adding title causes duplicate tooltip text.
    badgeEl.setAttribute('aria-label', item.title);
    badgeEl.setAttribute('data-provider', item.providerId);
    badgeEl.setAttribute('data-title-expanded', showTitle ? 'true' : 'false');

    // Click handler to switch tab
    badgeEl.addEventListener('click', () => {
      this.captureScrollPosition();
      this.callbacks.onTabClick(item.id);
    });

    badgeEl.addEventListener('dblclick', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.toggleBadgeTitle(item, badgeEl);
    });

    // Right-click to close (if allowed)
    if (item.canClose) {
      badgeEl.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.callbacks.onTabClose(item.id);
      });
    }
  }

  /** Destroys the tab bar. */
  destroy(): void {
    this.containerEl.empty();
    this.containerEl.removeClass('claudian-tab-badges');
    this.containerEl.removeEventListener('scroll', this.handleScroll);
    this.toggledTabIds.clear();
    this.lastRenderSignature = null;
    this.forceNextRender = false;
    this.lastKnownScrollLeft = 0;
  }

  captureScrollPosition(): void {
    this.lastKnownScrollLeft = this.containerEl.scrollLeft;
  }

  restoreScrollPosition(): void {
    const scrollLeft = this.lastKnownScrollLeft;
    this.containerEl.scrollLeft = scrollLeft;
    if (scrollLeft <= 0) return;

    scheduleAnimationFrame(() => {
      if (this.containerEl.scrollLeft !== 0) return;
      this.containerEl.scrollLeft = scrollLeft;
    }, this.containerEl.ownerDocument.defaultView ?? null);
  }

  private captureStableScrollPosition(): void {
    const currentScrollLeft = this.containerEl.scrollLeft;
    if (currentScrollLeft > 0 || this.lastKnownScrollLeft === 0) {
      this.lastKnownScrollLeft = currentScrollLeft;
    }
  }

  private pruneExpandedTitleState(items: TabBarItem[]): void {
    const visibleTabIds = new Set(items.map(item => item.id));
    for (const tabId of this.toggledTabIds) {
      if (!visibleTabIds.has(tabId)) {
        this.toggledTabIds.delete(tabId);
      }
    }
  }

  private toggleBadgeTitle(item: TabBarItem, badgeEl: HTMLElement): void {
    // A tab with no displayable title can only ever show its number, so nothing to toggle.
    if (!this.hasDisplayableTitle(item)) return;

    if (this.toggledTabIds.has(item.id)) {
      this.toggledTabIds.delete(item.id);
    } else {
      this.toggledTabIds.add(item.id);
    }

    const showTitle = this.shouldShowTitle(item);
    badgeEl.textContent = this.getBadgeLabel(item);
    badgeEl.toggleClass('claudian-tab-badge-expanded', showTitle);
    badgeEl.setAttribute('data-title-expanded', showTitle ? 'true' : 'false');
  }

  /** Whether the item has a meaningful title worth displaying (not empty / placeholder). */
  private hasDisplayableTitle(item: TabBarItem): boolean {
    const title = item.title?.trim();
    return Boolean(title) && title !== 'New Chat';
  }

  /**
   * Resolves whether a badge shows its title (vs its number).
   * Starts from the configured default, then flips for any tab the user
   * toggled via double-click. Tabs without a real title always show the number.
   */
  private shouldShowTitle(item: TabBarItem): boolean {
    if (!this.hasDisplayableTitle(item)) return false;
    const base = this.getShowTitlesByDefault();
    return this.toggledTabIds.has(item.id) ? !base : base;
  }

  private getBadgeLabel(item: TabBarItem): string {
    if (!this.shouldShowTitle(item)) {
      return String(item.index);
    }

    return this.truncateExpandedTitle(item.title);
  }

  private truncateExpandedTitle(title: string): string {
    const chars = Array.from(title);
    if (chars.length <= EXPANDED_TITLE_MAX_LENGTH) {
      return title;
    }

    return `${chars.slice(0, EXPANDED_TITLE_MAX_LENGTH - TRUNCATED_TITLE_SUFFIX.length).join('')}${TRUNCATED_TITLE_SUFFIX}`;
  }
}
