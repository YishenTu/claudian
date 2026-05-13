import type { KeyboardNavigationSettings } from '../../../core/types';
import {
  cancelScheduledAnimationFrame,
  scheduleAnimationFrame,
  type ScheduledAnimationFrame,
} from '../../../utils/animationFrame';

/** Scroll speed in pixels per frame (~60fps = 480px/sec). */
const SCROLL_SPEED = 8;

export interface NavigationControllerDeps {
  getMessagesEl: () => HTMLElement;
  getInputEl: () => HTMLTextAreaElement;
  getSettings: () => KeyboardNavigationSettings;
  isStreaming: () => boolean;
  /** Returns true if a UI component (dropdown, modal, mode) should handle Escape instead. */
  shouldSkipEscapeHandling?: () => boolean;
}

export class NavigationController {
  private deps: NavigationControllerDeps;
  private scrollDirection: 'up' | 'down' | null = null;
  private animationFrame: ScheduledAnimationFrame | null = null;
  private keyboardDocument: Document | null = null;
  private initialized = false;
  private disposed = false;

  // Bound handlers for cleanup
  private boundMessagesKeydown: (e: KeyboardEvent) => void;
  private boundKeyup: (e: KeyboardEvent) => void;
  private boundInputKeydown: (e: KeyboardEvent) => void;

  constructor(deps: NavigationControllerDeps) {
    this.deps = deps;
    this.boundMessagesKeydown = (e) => this.handleMessagesKeydown(e);
    this.boundKeyup = (e) => this.handleKeyup(e);
    this.boundInputKeydown = (e) => this.handleInputKeydown(e);
  }

  initialize(): void {
    if (this.initialized || this.disposed) return;

    const messagesEl = this.deps.getMessagesEl();
    const inputEl = this.deps.getInputEl();

    // Guard against missing DOM elements
    if (!messagesEl || !inputEl) return;

    // Make messages panel focusable (focus style handled in CSS)
    messagesEl.setAttribute('tabindex', '0');
    messagesEl.addClass('claudian-messages-focusable');

    // Attach event listeners
    messagesEl.addEventListener('keydown', this.boundMessagesKeydown);
    this.keyboardDocument = messagesEl.ownerDocument;
    this.keyboardDocument.addEventListener('keyup', this.boundKeyup);

    // Use capture phase to run before other handlers
    inputEl.addEventListener('keydown', this.boundInputKeydown, { capture: true });

    this.initialized = true;
  }

  /** Cleans up event listeners and animation frames. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.stopScrolling();

    // Always clean up document listener first (most important for preventing leaks)
    this.keyboardDocument?.removeEventListener('keyup', this.boundKeyup);
    this.keyboardDocument = null;

    // Element cleanup - may already be destroyed during view teardown
    const messagesEl = this.deps.getMessagesEl();
    messagesEl?.removeEventListener('keydown', this.boundMessagesKeydown);
    messagesEl?.removeClass('claudian-messages-focusable');

    const inputEl = this.deps.getInputEl();
    inputEl?.removeEventListener('keydown', this.boundInputKeydown, { capture: true });
  }

  // ============================================
  // Messages Panel Keyboard Handling
  // ============================================

  private handleMessagesKeydown(e: KeyboardEvent): void {
    // Ignore if any modifier is held - allow system shortcuts (Ctrl+W, Cmd+W, etc.)
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;

    const settings = this.deps.getSettings();
    const key = e.key.toLowerCase();

    // Scroll up
    if (key === settings.scrollUpKey.toLowerCase()) {
      e.preventDefault();
      this.startScrolling('up');
      return;
    }

    // Scroll down
    if (key === settings.scrollDownKey.toLowerCase()) {
      e.preventDefault();
      this.startScrolling('down');
      return;
    }

    // Focus input (vim 'i' for insert mode)
    if (key === settings.focusInputKey.toLowerCase()) {
      e.preventDefault();
      this.deps.getInputEl().focus();
      return;
    }
  }

  private handleKeyup(e: KeyboardEvent): void {
    const settings = this.deps.getSettings();
    const key = e.key.toLowerCase();

    // Stop scrolling when scroll key is released
    if (
      key === settings.scrollUpKey.toLowerCase() ||
      key === settings.scrollDownKey.toLowerCase()
    ) {
      this.stopScrolling();
    }
  }

  // ============================================
  // Input Keyboard Handling (Escape)
  // ============================================

  private handleInputKeydown(e: KeyboardEvent): void {
    if (e.key !== 'Escape') return;

    // Ignore if composing (IME support for Chinese, Japanese, Korean, etc.)
    if (e.isComposing) return;

    // If streaming, let existing handler interrupt (don't interfere)
    if (this.deps.isStreaming()) {
      return;
    }

    if (this.deps.shouldSkipEscapeHandling?.()) {
      return;
    }

    // Not streaming, no active UI: blur input and focus messages panel
    e.preventDefault();
    e.stopPropagation();
    this.deps.getInputEl().blur();
    this.deps.getMessagesEl().focus();
  }

  // ============================================
  // Continuous Scrolling with requestAnimationFrame
  // ============================================

  private startScrolling(direction: 'up' | 'down'): void {
    if (this.scrollDirection === direction) {
      return; // Already scrolling in this direction
    }

    this.scrollDirection = direction;
    this.scrollLoop();
  }

  private stopScrolling(): void {
    this.scrollDirection = null;
    if (this.animationFrame !== null) {
      cancelScheduledAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }
  }

  private scrollLoop = (): void => {
    if (this.scrollDirection === null || this.disposed) return;

    const messagesEl = this.deps.getMessagesEl();
    if (!messagesEl) {
      // Element was destroyed - stop scrolling silently (expected on cleanup)
      this.stopScrolling();
      return;
    }

    const scrollAmount = this.scrollDirection === 'up' ? -SCROLL_SPEED : SCROLL_SPEED;
    messagesEl.scrollTop += scrollAmount;

    this.animationFrame = scheduleAnimationFrame(
      this.scrollLoop,
      messagesEl.ownerDocument.defaultView ?? null,
    );
  };

  // ============================================
  // Public API
  // ============================================

  /** Focuses the messages panel. */
  focusMessages(): void {
    this.deps.getMessagesEl().focus();
  }

  /** Focuses the input. */
  focusInput(): void {
    this.deps.getInputEl().focus();
  }
}
