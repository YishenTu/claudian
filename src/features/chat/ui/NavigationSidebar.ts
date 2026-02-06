import { setIcon } from 'obsidian';

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
    this.updateVisibility();
  }

  private createButton(cls: string, icon: string, label: string): HTMLElement {
    const btn = this.container.createDiv({ cls: `claudian-nav-btn ${cls}` });
    setIcon(btn, icon);
    btn.setAttribute('aria-label', label);
    return btn;
  }

  private setupEventListeners(): void {
    // Scroll handling to toggle visibility
    this.messagesEl.addEventListener('scroll', () => {
      this.updateVisibility();
    }, { passive: true });

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
    const { scrollHeight, clientHeight } = this.messagesEl;
    const isScrollable = scrollHeight > clientHeight + 50; // Small buffer
    this.container.classList.toggle('visible', isScrollable);
  }

  /**
   * Scrolls to previous or next message (all messages, not just user).
   */
  private scrollToMessage(direction: 'prev' | 'next'): void {
    const messages = Array.from(this.messagesEl.querySelectorAll('.claudian-message')) as HTMLElement[];

    if (messages.length === 0) return;

    const scrollTop = this.messagesEl.scrollTop;
    let currentIndex = -1;

    // Find the first message at or below current scroll position
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].offsetTop >= scrollTop - 10) {
        currentIndex = i;
        break;
      }
    }

    let targetEl: HTMLElement | undefined;

    if (direction === 'prev') {
      if (currentIndex === -1) {
        targetEl = messages[messages.length - 1];
      } else if (currentIndex > 0) {
        targetEl = messages[currentIndex - 1];
      }
    } else {
      if (currentIndex !== -1 && currentIndex < messages.length - 1) {
        targetEl = messages[currentIndex + 1];
      } else if (currentIndex === messages.length - 1) {
        // 已在最后一条消息，滚动到底部
        this.messagesEl.scrollTo({ top: this.messagesEl.scrollHeight, behavior: 'smooth' });
        return;
      }
    }

    if (targetEl) {
      this.messagesEl.scrollTo({ top: targetEl.offsetTop - 10, behavior: 'smooth' });
    }
  }

  destroy(): void {
    this.container.remove();
  }
}
