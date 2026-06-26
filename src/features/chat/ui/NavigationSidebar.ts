import { setIcon } from 'obsidian';

import {
  cancelScheduledAnimationFrame,
  scheduleAnimationFrame,
  type ScheduledAnimationFrame,
} from '../../../utils/animationFrame';
import { formatConversationDirectoryTitle } from '../utils/conversationDirectoryTitle';

/**
 * Floating sidebar for navigating chat history.
 * Provides quick access to top/bottom and previous/next user messages.
 */
export class NavigationSidebar {
  private container: HTMLElement;
  private topBtn: HTMLElement;
  private prevBtn: HTMLElement;
  private tocBtn: HTMLElement;
  private nextBtn: HTMLElement;
  private bottomBtn: HTMLElement;
  private tocPopover: HTMLElement | null = null;
  private scrollHandler: () => void = () => {};
  private outsideClickHandler: ((event: MouseEvent) => void) | null = null;
  private mutationObserver: MutationObserver | null = null;
  private pendingVisibilityFrame: ScheduledAnimationFrame | null = null;
  private isVisible: boolean | null = null;

  constructor(
    private parentEl: HTMLElement,
    private messagesEl: HTMLElement
  ) {
    this.container = this.parentEl.createDiv({ cls: 'claudian-nav-sidebar' });

    // Create buttons
    this.topBtn = this.createButton('claudian-nav-btn-top', 'chevrons-up', 'Scroll to top');
    this.prevBtn = this.createButton('claudian-nav-btn-prev', 'chevron-up', 'Previous message');
    this.tocBtn = this.createButton('claudian-nav-btn-toc', 'list-tree', 'Conversation directory');
    this.nextBtn = this.createButton('claudian-nav-btn-next', 'chevron-down', 'Next message');
    this.bottomBtn = this.createButton('claudian-nav-btn-bottom', 'chevrons-down', 'Scroll to bottom');

    this.setupEventListeners();
    this.applyVisibility();
  }

  private createButton(cls: string, icon: string, label: string): HTMLElement {
    const btn = this.container.createDiv({ cls: `claudian-nav-btn ${cls}` });
    setIcon(btn, icon);
    btn.setAttribute('aria-label', label);
    return btn;
  }

  private setupEventListeners(): void {
    // Scroll handling to toggle visibility
    this.scrollHandler = () => this.updateVisibility();
    this.messagesEl.addEventListener('scroll', this.scrollHandler, { passive: true });

    // Button clicks
    this.topBtn.addEventListener('click', () => {
      this.messagesEl.scrollTo({ top: 0, behavior: 'smooth' });
    });

    this.bottomBtn.addEventListener('click', () => {
      this.messagesEl.scrollTo({ top: this.messagesEl.scrollHeight, behavior: 'smooth' });
    });

    this.prevBtn.addEventListener('click', () => this.scrollToMessage('prev'));
    this.nextBtn.addEventListener('click', () => this.scrollToMessage('next'));
    this.tocBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      this.toggleDirectory();
    });

    this.outsideClickHandler = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      const containerContainsTarget = typeof this.container.contains === 'function'
        && this.container.contains(target);
      const popoverContainsTarget = typeof this.tocPopover?.contains === 'function'
        && this.tocPopover.contains(target);
      if (!containerContainsTarget && !popoverContainsTarget) {
        this.closeDirectory();
      }
    };
    this.parentEl.ownerDocument?.addEventListener?.('click', this.outsideClickHandler);

    if (typeof MutationObserver !== 'undefined') {
      this.mutationObserver = new MutationObserver((mutations) => {
        this.updateVisibility();
        if (this.shouldRefreshDirectory(mutations)) {
          this.refreshOpenDirectory();
        }
      });
      this.mutationObserver.observe(this.messagesEl, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['data-toc-title'],
      });
    }
  }

  /**
   * Updates visibility of the sidebar based on scroll state.
   * Visible if content overflows.
   */
  updateVisibility(): void {
    if (this.pendingVisibilityFrame !== null) return;
    this.pendingVisibilityFrame = scheduleAnimationFrame(() => {
      this.pendingVisibilityFrame = null;
      this.applyVisibility();
    }, this.messagesEl.ownerDocument.defaultView ?? null);
  }

  private applyVisibility(): void {
    const { scrollHeight, clientHeight } = this.messagesEl;
    const isScrollable = scrollHeight > clientHeight + 50; // Small buffer
    this.tocBtn.classList.remove('claudian-hidden');
    if (this.isVisible === isScrollable) return;
    this.isVisible = isScrollable;
    this.container.classList.toggle('visible', isScrollable);
  }

  private getDirectoryEntries(): Array<{ el: HTMLElement; title: string }> {
    return Array.from(this.messagesEl.querySelectorAll<HTMLElement>('.claudian-message-user, [data-role="user"]'))
      .map(el => ({
        el,
        title: this.getDirectoryTitle(el),
      }))
      .filter((entry): entry is { el: HTMLElement; title: string } => entry.title.length > 0);
  }

  private getDirectoryTitle(el: HTMLElement): string {
    const explicitTitle = (el.getAttribute('data-toc-title') ?? '').trim();
    if (explicitTitle) return explicitTitle;

    const contentEl = el.querySelector<HTMLElement>('.claudian-message-content');
    return formatConversationDirectoryTitle(contentEl?.textContent ?? el.textContent ?? '');
  }

  private shouldRefreshDirectory(mutations: MutationRecord[]): boolean {
    if (!this.tocPopover) return false;
    return mutations.some((mutation) => {
      if (mutation.type === 'attributes') {
        return mutation.attributeName === 'data-toc-title'
          && this.isDirectoryMessageElement(mutation.target);
      }
      if (mutation.type !== 'childList') return false;
      return Array.from(mutation.addedNodes).some(node => this.nodeContainsDirectoryMessage(node))
        || Array.from(mutation.removedNodes).some(node => this.nodeContainsDirectoryMessage(node));
    });
  }

  private nodeContainsDirectoryMessage(node: Node): boolean {
    if (this.isDirectoryMessageElement(node)) return true;
    const candidate = node as { querySelector?: (selector: string) => Element | null };
    return typeof candidate.querySelector === 'function'
      && candidate.querySelector('.claudian-message-user, [data-role="user"]') !== null;
  }

  private isDirectoryMessageElement(node: Node): boolean {
    const candidate = node as {
      matches?: (selector: string) => boolean;
      classList?: { contains?: (className: string) => boolean };
      getAttribute?: (name: string) => string | null;
    };
    if (typeof candidate.matches === 'function') {
      return candidate.matches('.claudian-message-user, [data-role="user"]');
    }
    return candidate.classList?.contains?.('claudian-message-user') === true
      || candidate.getAttribute?.('data-role') === 'user';
  }

  private toggleDirectory(): void {
    if (this.tocPopover) {
      this.closeDirectory();
      return;
    }
    this.openDirectory();
  }

  private openDirectory(): void {
    const entries = this.getDirectoryEntries();
    this.closeDirectory();
    this.tocPopover = this.parentEl.createDiv({ cls: 'claudian-nav-toc-popover' });
    this.tocPopover.createDiv({ cls: 'claudian-nav-toc-title', text: 'Conversation directory' });
    const listEl = this.tocPopover.createDiv({ cls: 'claudian-nav-toc-list' });

    if (entries.length === 0) {
      listEl.createDiv({
        cls: 'claudian-nav-toc-empty',
        text: 'No user prompts in this conversation',
      });
      return;
    }

    entries.forEach((entry, index) => {
      const itemEl = listEl.createDiv({
        cls: 'claudian-nav-toc-item',
        text: `${index + 1}. ${entry.title}`,
      });
      itemEl.setAttribute('role', 'button');
      itemEl.setAttribute('tabindex', '0');
      itemEl.setAttribute('title', entry.title);

      const selectEntry = () => {
        this.scrollToElement(entry.el);
        this.closeDirectory();
      };
      itemEl.addEventListener('click', selectEntry);
      itemEl.addEventListener('keydown', (event: KeyboardEvent) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        selectEntry();
      });
    });
  }

  private refreshOpenDirectory(): void {
    if (!this.tocPopover) return;
    this.openDirectory();
  }

  private closeDirectory(): void {
    this.tocPopover?.remove();
    this.tocPopover = null;
  }

  private scrollToElement(el: HTMLElement): void {
    this.messagesEl.scrollTo({
      top: Math.max(el.offsetTop - 10, 0),
      behavior: 'smooth',
    });
  }

  /**
   * Scrolls to previous or next user message, skipping assistant messages.
   */
  private scrollToMessage(direction: 'prev' | 'next'): void {
    const messages = Array.from(this.messagesEl.querySelectorAll<HTMLElement>('.claudian-message-user'));

    if (messages.length === 0) return;

    const scrollTop = this.messagesEl.scrollTop;
    const threshold = 30;

    if (direction === 'prev') {
      // Find the last message strictly above the current scroll position
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].offsetTop < scrollTop - threshold) {
          this.scrollToElement(messages[i]);
          return;
        }
      }
      // Already at or above the first message — scroll to top
      this.messagesEl.scrollTo({ top: 0, behavior: 'smooth' });
    } else {
      // Find the first message strictly below the current scroll position
      for (let i = 0; i < messages.length; i++) {
        if (messages[i].offsetTop > scrollTop + threshold) {
          this.scrollToElement(messages[i]);
          return;
        }
      }
      // Already at or past the last message — scroll to bottom
      this.messagesEl.scrollTo({ top: this.messagesEl.scrollHeight, behavior: 'smooth' });
    }
  }

  destroy(): void {
    if (this.pendingVisibilityFrame !== null) {
      cancelScheduledAnimationFrame(this.pendingVisibilityFrame);
      this.pendingVisibilityFrame = null;
    }
    this.closeDirectory();
    if (this.outsideClickHandler) {
      this.parentEl.ownerDocument?.removeEventListener?.('click', this.outsideClickHandler);
      this.outsideClickHandler = null;
    }
    this.mutationObserver?.disconnect();
    this.mutationObserver = null;
    this.messagesEl.removeEventListener('scroll', this.scrollHandler);
    this.container.remove();
  }
}
