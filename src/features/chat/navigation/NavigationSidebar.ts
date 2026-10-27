import { setIcon } from 'obsidian';

import {
  cancelScheduledAnimationFrame,
  scheduleAnimationFrame,
  type ScheduledAnimationFrame,
} from '@/features/chat/utils/animationFrame';
import { type ConversationDirectoryEntry, getRenderedConversationDirectory } from '@/features/chat/utils/conversationDirectoryTitle';
import { t } from '@/i18n/i18n';

type NavigationScrollIntent = 'away' | 'bottom';

/**
 * Floating sidebar for navigating chat history.
 * Provides quick access to top/bottom and previous/next user messages.
 */
export class NavigationSidebar {
  private container: HTMLElement;
  private topBtn!: HTMLButtonElement;
  private prevBtn!: HTMLButtonElement;
  private tocBtn!: HTMLButtonElement;
  private nextBtn!: HTMLButtonElement;
  private bottomBtn!: HTMLButtonElement;
  private tocPopover: HTMLElement | null = null;
  private scrollHandler: () => void = () => {};
  private outsideClickHandler: ((event: MouseEvent) => void) | null = null;
  private mutationObserver: MutationObserver | null = null;
  private pendingVisibilityFrame: ScheduledAnimationFrame | null = null;
  private isVisible: boolean | null = null;
  private onScrollIntent: ((intent: NavigationScrollIntent) => void) | null = null;

  constructor(
    private parentEl: HTMLElement,
    private messagesEl: HTMLElement,
    /** Includes unrendered prompts; choosing an entry reveals only the needed transcript window. */
    private readonly getDirectoryEntries?: () => readonly ConversationDirectoryEntry[],
  ) {
    this.container = this.parentEl.createDiv({ cls: 'claudian-nav-sidebar' });

    try {
      // Create buttons
      this.topBtn = this.#createButton('claudian-nav-btn-top', 'chevrons-up', t('chat.navigation.scrollToTop'));
      this.prevBtn = this.#createButton('claudian-nav-btn-prev', 'chevron-up', t('chat.navigation.previousMessage'));
      this.tocBtn = this.#createButton('claudian-nav-btn-toc', 'list-tree', t('chat.navigation.directory'));
      this.tocBtn.setAttribute('aria-expanded', 'false');
      this.nextBtn = this.#createButton('claudian-nav-btn-next', 'chevron-down', t('chat.navigation.nextMessage'));
      this.bottomBtn = this.#createButton('claudian-nav-btn-bottom', 'chevrons-down', t('chat.navigation.scrollToBottom'));

      this.#setupEventListeners();
      this.#applyVisibility();
    } catch (error) {
      this.destroy();
      throw error;
    }
  }

  #createButton(cls: string, icon: string, label: string): HTMLButtonElement {
    const btn = this.container.createEl('button', {
      cls: `claudian-nav-btn ${cls}`,
      attr: { type: 'button', 'aria-label': label },
    });
    setIcon(btn, icon);
    return btn;
  }

  #setupEventListeners(): void {
    // Scroll handling to toggle visibility
    this.scrollHandler = () => this.updateVisibility();
    this.messagesEl.addEventListener('scroll', this.scrollHandler, { passive: true });

    // Button clicks
    this.topBtn.addEventListener('click', () => {
      this.onScrollIntent?.('away');
      this.messagesEl.scrollTo({ top: 0, behavior: 'smooth' });
    });

    this.bottomBtn.addEventListener('click', () => {
      this.onScrollIntent?.('bottom');
      this.messagesEl.scrollTo({ top: this.messagesEl.scrollHeight, behavior: 'smooth' });
    });

    this.prevBtn.addEventListener('click', () => {
      this.onScrollIntent?.('away');
      this.#scrollToMessage('prev');
    });
    this.nextBtn.addEventListener('click', () => {
      this.onScrollIntent?.('away');
      this.#scrollToMessage('next');
    });
    this.tocBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      this.#toggleDirectory();
    });

    this.outsideClickHandler = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      const containerContainsTarget = typeof this.container.contains === 'function'
        && this.container.contains(target);
      const popoverContainsTarget = typeof this.tocPopover?.contains === 'function'
        && this.tocPopover.contains(target);
      if (!containerContainsTarget && !popoverContainsTarget) {
        this.#closeDirectory();
      }
    };
    this.parentEl.ownerDocument?.addEventListener?.('click', this.outsideClickHandler);

    if (typeof MutationObserver !== 'undefined') {
      this.mutationObserver = new MutationObserver((mutations) => {
        this.updateVisibility();
        if (this.#shouldRefreshDirectory(mutations)) {
          this.#refreshOpenDirectory();
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
      this.#applyVisibility();
    }, this.messagesEl.ownerDocument.defaultView ?? null);
  }

  #applyVisibility(): void {
    const { scrollHeight, clientHeight } = this.messagesEl;
    const isScrollable = scrollHeight > clientHeight + 50; // Small buffer
    this.tocBtn.classList.remove('claudian-hidden');
    if (this.isVisible === isScrollable) return;
    this.isVisible = isScrollable;
    this.container.classList.toggle('visible', isScrollable);
  }

  #shouldRefreshDirectory(mutations: MutationRecord[]): boolean {
    if (!this.tocPopover) return false;
    return mutations.some((mutation) => {
      if (mutation.type === 'attributes') {
        return mutation.attributeName === 'data-toc-title'
          && this.#isDirectoryMessageElement(mutation.target);
      }
      if (mutation.type !== 'childList') return false;
      return Array.from(mutation.addedNodes).some(node => this.#nodeContainsDirectoryMessage(node))
        || Array.from(mutation.removedNodes).some(node => this.#nodeContainsDirectoryMessage(node));
    });
  }

  #nodeContainsDirectoryMessage(node: Node): boolean {
    if (this.#isDirectoryMessageElement(node)) return true;
    const candidate = node as { querySelector?: (selector: string) => Element | null };
    return typeof candidate.querySelector === 'function'
      && candidate.querySelector('.claudian-message-user, [data-role="user"]') !== null;
  }

  #isDirectoryMessageElement(node: Node): boolean {
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

  #toggleDirectory(): void {
    if (this.tocPopover) {
      this.#closeDirectory();
      return;
    }
    this.#openDirectory();
  }

  #openDirectory(): void {
    const entries = this.getDirectoryEntries?.() ?? getRenderedConversationDirectory(this.messagesEl);
    this.#closeDirectory();
    this.tocBtn.setAttribute('aria-expanded', 'true');
    this.tocPopover = this.parentEl.createDiv({ cls: 'claudian-nav-toc-popover' });
    this.tocPopover.createDiv({ cls: 'claudian-nav-toc-title', text: t('chat.navigation.directory') });
    const listEl = this.tocPopover.createDiv({ cls: 'claudian-nav-toc-list' });

    if (entries.length === 0) {
      listEl.createDiv({
        cls: 'claudian-nav-toc-empty',
        text: t('chat.navigation.emptyDirectory'),
      });
      return;
    }

    entries.forEach((entry, index) => {
      const itemEl = listEl.createEl('button', {
        cls: 'claudian-nav-toc-item',
        text: `${index + 1}. ${entry.title}`,
        attr: { type: 'button', title: entry.title },
      });
      itemEl.addEventListener('click', () => {
        this.onScrollIntent?.('away');
        const element = entry.reveal();
        if (element) this.#scrollToElement(element);
        this.#closeDirectory();
      });
    });
  }

  #refreshOpenDirectory(): void {
    if (!this.tocPopover) return;
    this.#openDirectory();
  }

  #closeDirectory(): void {
    this.tocPopover?.remove();
    this.tocPopover = null;
    // Construction can fail before the toggle exists; destroy() still closes the directory.
    this.tocBtn?.setAttribute('aria-expanded', 'false');
  }

  #scrollToElement(el: HTMLElement): void {
    this.messagesEl.scrollTo({
      top: Math.max(el.offsetTop - 10, 0),
      behavior: 'smooth',
    });
  }

  /**
   * Scrolls to previous or next user message, skipping assistant messages.
   */
  #scrollToMessage(direction: 'prev' | 'next'): void {
    const messages = Array.from(this.messagesEl.querySelectorAll<HTMLElement>('.claudian-message-user'));

    if (messages.length === 0) return;

    const scrollTop = this.messagesEl.scrollTop;
    const threshold = 30;

    if (direction === 'prev') {
      // Find the last message strictly above the current scroll position
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].offsetTop < scrollTop - threshold) {
          this.#scrollToElement(messages[i]);
          return;
        }
      }
      // Already at or above the first message — scroll to top
      this.messagesEl.scrollTo({ top: 0, behavior: 'smooth' });
    } else {
      // Find the first message strictly below the current scroll position
      for (let i = 0; i < messages.length; i++) {
        if (messages[i].offsetTop > scrollTop + threshold) {
          this.#scrollToElement(messages[i]);
          return;
        }
      }
      // Already at or past the last message — scroll to bottom
      this.messagesEl.scrollTo({ top: this.messagesEl.scrollHeight, behavior: 'smooth' });
    }
  }

  setOnScrollIntent(callback: ((intent: NavigationScrollIntent) => void) | null): void {
    this.onScrollIntent = callback;
  }

  destroy(): void {
    if (this.pendingVisibilityFrame !== null) {
      cancelScheduledAnimationFrame(this.pendingVisibilityFrame);
      this.pendingVisibilityFrame = null;
    }
    this.#closeDirectory();
    if (this.outsideClickHandler) {
      this.parentEl.ownerDocument?.removeEventListener?.('click', this.outsideClickHandler);
      this.outsideClickHandler = null;
    }
    this.mutationObserver?.disconnect();
    this.mutationObserver = null;
    this.onScrollIntent = null;
    this.messagesEl.removeEventListener('scroll', this.scrollHandler);
    this.container.remove();
  }
}
