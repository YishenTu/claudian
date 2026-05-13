import { setIcon } from 'obsidian';

import {
  cancelScheduledAnimationFrame,
  scheduleAnimationFrame,
  type ScheduledAnimationFrame,
} from '../../../utils/animationFrame';

/**
 * Floating sidebar for navigating chat history.
 * Provides quick access to top/bottom and previous/next user messages.
 */
export class NavigationSidebar {
  private container: HTMLElement;
  private topBtn: HTMLElement;
  private prevBtn: HTMLElement;
  private nextBtn: HTMLElement;
  private bottomBtn: HTMLElement;
  private scrollHandler: () => void = () => {};
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
    if (this.isVisible === isScrollable) return;
    this.isVisible = isScrollable;
    this.container.classList.toggle('visible', isScrollable);
  }

  /**
   * Scrolls to previous or next user message, skipping assistant messages.
   */
  private scrollToMessage(direction: 'prev' | 'next'): void {
    const messages = Array.from(this.messagesEl.querySelectorAll('.claudian-message-user')) as HTMLElement[];

    if (messages.length === 0) return;

    const scrollTop = this.messagesEl.scrollTop;
    const threshold = 30;

    if (direction === 'prev') {
      // Find the last message strictly above the current scroll position
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].offsetTop < scrollTop - threshold) {
          this.messagesEl.scrollTo({ top: messages[i].offsetTop - 10, behavior: 'smooth' });
          return;
        }
      }
      // Already at or above the first message — scroll to top
      this.messagesEl.scrollTo({ top: 0, behavior: 'smooth' });
    } else {
      // Find the first message strictly below the current scroll position
      for (let i = 0; i < messages.length; i++) {
        if (messages[i].offsetTop > scrollTop + threshold) {
          this.messagesEl.scrollTo({ top: messages[i].offsetTop - 10, behavior: 'smooth' });
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
    this.messagesEl.removeEventListener('scroll', this.scrollHandler);
    this.container.remove();
  }
}
