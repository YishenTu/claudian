/**
 * Navigation controller for vim-style keyboard navigation.
 *
 * Handles keyboard-based scrolling and focus management for the chat panel.
 * - w/s (configurable) for continuous scrolling when focused on messages
 * - i to focus input
 * - Escape in input: interrupt if streaming, else blur and focus messages
 */

import type { KeyboardNavigationSettings } from '../../../core/types';

/** Scroll speed in pixels per frame (~60fps = 480px/sec). */
const SCROLL_SPEED = 8;

/** Dependencies for NavigationController. */
export interface NavigationControllerDeps {
  getMessagesEl: () => HTMLElement;
  getInputEl: () => HTMLTextAreaElement;
  getSettings: () => KeyboardNavigationSettings;
  isStreaming: () => boolean;
  /** Returns true if a UI component (dropdown, modal, mode) should handle Escape instead. */
  shouldSkipEscapeHandling?: () => boolean;
}

/**
 * NavigationController manages vim-style keyboard navigation.
 *
 * Features:
 * - Configurable keys for continuous scrolling when focused on messages
 * - 'i' to focus input (like vim insert mode)
 * - Escape in input: interrupt if streaming, else blur and focus messages
 */
export class NavigationController {
  private deps: NavigationControllerDeps;
  private scrollDirection: 'up' | 'down' | null = null;
  private animationFrameId: number | null = null;

  // Bound handlers for cleanup
  private boundMessagesKeydown: (e: KeyboardEvent) => void;
  private boundKeyup: (e: KeyboardEvent) => void;
  private boundInputKeydown: (e: KeyboardEvent) => void;

  constructor(deps: NavigationControllerDeps) {
    this.deps = deps;
    this.boundMessagesKeydown = this.handleMessagesKeydown.bind(this);
    this.boundKeyup = this.handleKeyup.bind(this);
    this.boundInputKeydown = this.handleInputKeydown.bind(this);
  }

  // ============================================
  // Lifecycle
  // ============================================

  /** Initializes navigation by making messagesEl focusable and attaching listeners. */
  initialize(): void {
    const messagesEl = this.deps.getMessagesEl();
    messagesEl.setAttribute('tabindex', '0');
    messagesEl.style.outline = 'none'; // No visible focus ring

    // Attach event listeners
    messagesEl.addEventListener('keydown', this.boundMessagesKeydown);
    document.addEventListener('keyup', this.boundKeyup);

    const inputEl = this.deps.getInputEl();
    // Use capture phase to run before other handlers
    inputEl.addEventListener('keydown', this.boundInputKeydown, { capture: true });
  }

  /** Cleans up event listeners and animation frames. */
  dispose(): void {
    this.stopScrolling();

    const messagesEl = this.deps.getMessagesEl();
    messagesEl.removeEventListener('keydown', this.boundMessagesKeydown);
    document.removeEventListener('keyup', this.boundKeyup);

    const inputEl = this.deps.getInputEl();
    inputEl.removeEventListener('keydown', this.boundInputKeydown, { capture: true });
  }

  // ============================================
  // Messages Panel Keyboard Handling
  // ============================================

  private handleMessagesKeydown(e: KeyboardEvent): void {
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
    if (key === 'i') {
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

    // If streaming, let existing handler interrupt (don't interfere)
    if (this.deps.isStreaming()) {
      return;
    }

    // If a UI component (dropdown, modal, instruction mode) should handle Escape, skip
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
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }

  private scrollLoop = (): void => {
    if (this.scrollDirection === null) return;

    const messagesEl = this.deps.getMessagesEl();
    const scrollAmount = this.scrollDirection === 'up' ? -SCROLL_SPEED : SCROLL_SPEED;
    messagesEl.scrollTop += scrollAmount;

    this.animationFrameId = requestAnimationFrame(this.scrollLoop);
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
