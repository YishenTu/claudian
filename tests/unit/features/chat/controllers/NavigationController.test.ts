/**
 * Tests for NavigationController - Vim-style keyboard navigation
 */

import { NavigationController, type NavigationControllerDeps } from '@/features/chat/controllers/NavigationController';

type Listener = (event: any) => void;

/** Mock KeyboardEvent for Node environment. */
class MockKeyboardEvent {
  public type: string;
  public key: string;
  public cancelable: boolean;
  public bubbles: boolean;
  public ctrlKey: boolean;
  public metaKey: boolean;
  public altKey: boolean;
  public shiftKey: boolean;
  private defaultPrevented = false;
  private propagationStopped = false;

  constructor(type: string, options: {
    key: string;
    cancelable?: boolean;
    bubbles?: boolean;
    ctrlKey?: boolean;
    metaKey?: boolean;
    altKey?: boolean;
    shiftKey?: boolean;
  } = { key: '' }) {
    this.type = type;
    this.key = options.key;
    this.cancelable = options.cancelable ?? false;
    this.bubbles = options.bubbles ?? false;
    this.ctrlKey = options.ctrlKey ?? false;
    this.metaKey = options.metaKey ?? false;
    this.altKey = options.altKey ?? false;
    this.shiftKey = options.shiftKey ?? false;
  }

  preventDefault(): void {
    if (this.cancelable) {
      this.defaultPrevented = true;
    }
  }

  stopPropagation(): void {
    this.propagationStopped = true;
  }

  get defaultPreventedValue(): boolean {
    return this.defaultPrevented;
  }
}

// Replace global KeyboardEvent if not defined
if (typeof KeyboardEvent === 'undefined') {
  (global as any).KeyboardEvent = MockKeyboardEvent;
}

/** Mock HTML element for testing. */
class MockElement {
  public tagName: string;
  public scrollTop = 0;
  public style: Record<string, string> = {};
  private attributes: Map<string, string> = new Map();
  private classes: Set<string> = new Set();
  private listeners: Map<string, { listener: Listener; options?: AddEventListenerOptions }[]> = new Map();

  constructor(tagName = 'DIV') {
    this.tagName = tagName;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  addClass(cls: string): void {
    this.classes.add(cls);
  }

  removeClass(cls: string): void {
    this.classes.delete(cls);
  }

  hasClass(cls: string): boolean {
    return this.classes.has(cls);
  }

  addEventListener(type: string, listener: Listener, options?: AddEventListenerOptions | boolean): void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, []);
    }
    const opts = typeof options === 'boolean' ? { capture: options } : options;
    this.listeners.get(type)!.push({ listener, options: opts });
  }

  removeEventListener(type: string, listener: Listener, options?: AddEventListenerOptions | boolean): void {
    const eventListeners = this.listeners.get(type);
    if (eventListeners) {
      const opts = typeof options === 'boolean' ? { capture: options } : options;
      const idx = eventListeners.findIndex((l) => l.listener === listener && l.options?.capture === opts?.capture);
      if (idx !== -1) {
        eventListeners.splice(idx, 1);
      }
    }
  }

  dispatchEvent(event: KeyboardEvent): boolean {
    const eventListeners = this.listeners.get(event.type) ?? [];
    // Sort by capture phase (capture first, then bubble)
    const sortedListeners = [...eventListeners].sort((a, b) => {
      const aCapture = a.options?.capture ?? false;
      const bCapture = b.options?.capture ?? false;
      return aCapture === bCapture ? 0 : aCapture ? -1 : 1;
    });
    for (const { listener } of sortedListeners) {
      listener(event);
    }
    return true;
  }

  focus(): void {
    // Mock focus
  }

  blur(): void {
    // Mock blur
  }
}

describe('NavigationController', () => {
  let controller: NavigationController;
  let messagesEl: MockElement;
  let inputEl: MockElement;
  let deps: NavigationControllerDeps;
  let settings: { scrollUpKey: string; scrollDownKey: string; focusInputKey: string };
  let isStreaming: boolean;
  let shouldSkipEscapeHandling: jest.Mock | undefined;
  let mockRaf: jest.Mock;
  let mockCancelRaf: jest.Mock;
  let originalRaf: typeof requestAnimationFrame;
  let originalCancelRaf: typeof cancelAnimationFrame;
  let originalDocument: typeof document;

  beforeEach(() => {
    jest.useFakeTimers();

    // Save originals
    originalRaf = global.requestAnimationFrame;
    originalCancelRaf = global.cancelAnimationFrame;
    originalDocument = (global as any).document;

    // Mock requestAnimationFrame
    let rafId = 0;
    mockRaf = jest.fn((cb: FrameRequestCallback) => {
      rafId++;
      setTimeout(() => cb(performance.now()), 16);
      return rafId;
    });
    mockCancelRaf = jest.fn();
    global.requestAnimationFrame = mockRaf;
    global.cancelAnimationFrame = mockCancelRaf;

    // Mock document for event listeners
    const documentListeners: Map<string, Listener[]> = new Map();
    (global as any).document = {
      addEventListener: (type: string, listener: Listener) => {
        if (!documentListeners.has(type)) {
          documentListeners.set(type, []);
        }
        documentListeners.get(type)!.push(listener);
      },
      removeEventListener: (type: string, listener: Listener) => {
        const listeners = documentListeners.get(type);
        if (listeners) {
          const idx = listeners.indexOf(listener);
          if (idx !== -1) {
            listeners.splice(idx, 1);
          }
        }
      },
      dispatchEvent: (event: KeyboardEvent) => {
        const listeners = documentListeners.get(event.type) ?? [];
        for (const listener of listeners) {
          listener(event);
        }
        return true;
      },
    };

    // Create mock elements
    messagesEl = new MockElement('DIV');
    inputEl = new MockElement('TEXTAREA');
    settings = { scrollUpKey: 'w', scrollDownKey: 's', focusInputKey: 'i' };
    isStreaming = false;
    shouldSkipEscapeHandling = undefined;

    deps = {
      getMessagesEl: () => messagesEl as unknown as HTMLElement,
      getInputEl: () => inputEl as unknown as HTMLTextAreaElement,
      getSettings: () => settings,
      isStreaming: () => isStreaming,
    };

    controller = new NavigationController(deps);
  });

  afterEach(() => {
    if (controller) {
      controller.dispose();
    }
    jest.useRealTimers();

    // Restore originals
    global.requestAnimationFrame = originalRaf;
    global.cancelAnimationFrame = originalCancelRaf;
    (global as any).document = originalDocument;
  });

  describe('initialization', () => {
    it('makes messagesEl focusable with tabindex', () => {
      controller.initialize();
      expect(messagesEl.getAttribute('tabindex')).toBe('0');
    });

    it('adds focusable CSS class to messagesEl', () => {
      controller.initialize();
      expect(messagesEl.hasClass('claudian-messages-focusable')).toBe(true);
    });

    it('attaches keydown listener to messagesEl', () => {
      const addEventListenerSpy = jest.spyOn(messagesEl, 'addEventListener');
      controller.initialize();
      expect(addEventListenerSpy).toHaveBeenCalledWith('keydown', expect.any(Function));
    });

    it('attaches keyup listener to document', () => {
      const addEventListenerSpy = jest.spyOn((global as any).document, 'addEventListener');
      controller.initialize();
      expect(addEventListenerSpy).toHaveBeenCalledWith('keyup', expect.any(Function));
    });

    it('attaches keydown listener to inputEl with capture phase', () => {
      const addEventListenerSpy = jest.spyOn(inputEl, 'addEventListener');
      controller.initialize();
      expect(addEventListenerSpy).toHaveBeenCalledWith('keydown', expect.any(Function), { capture: true });
    });
  });

  describe('disposal', () => {
    it('removes keydown listener from messagesEl', () => {
      controller.initialize();
      const removeEventListenerSpy = jest.spyOn(messagesEl, 'removeEventListener');
      controller.dispose();
      expect(removeEventListenerSpy).toHaveBeenCalledWith('keydown', expect.any(Function));
    });

    it('removes keyup listener from document', () => {
      controller.initialize();
      const removeEventListenerSpy = jest.spyOn((global as any).document, 'removeEventListener');
      controller.dispose();
      expect(removeEventListenerSpy).toHaveBeenCalledWith('keyup', expect.any(Function));
    });

    it('removes keydown listener from inputEl', () => {
      controller.initialize();
      const removeEventListenerSpy = jest.spyOn(inputEl, 'removeEventListener');
      controller.dispose();
      expect(removeEventListenerSpy).toHaveBeenCalledWith('keydown', expect.any(Function), { capture: true });
    });

    it('cancels ongoing animation frame', () => {
      controller.initialize();

      // Trigger scrolling
      const keydownEvent = new KeyboardEvent('keydown', { key: 'w' });
      messagesEl.dispatchEvent(keydownEvent);

      controller.dispose();
      expect(mockCancelRaf).toHaveBeenCalled();
    });
  });

  describe('scroll key handling', () => {
    beforeEach(() => {
      controller.initialize();
      messagesEl.scrollTop = 100;
    });

    it('scrolls up when scroll up key is pressed', () => {
      const keydownEvent = new KeyboardEvent('keydown', { key: 'w' });
      messagesEl.dispatchEvent(keydownEvent);

      // Advance timers to trigger RAF callback
      jest.advanceTimersByTime(16);

      expect(messagesEl.scrollTop).toBeLessThan(100);
    });

    it('scrolls down when scroll down key is pressed', () => {
      const keydownEvent = new KeyboardEvent('keydown', { key: 's' });
      messagesEl.dispatchEvent(keydownEvent);

      jest.advanceTimersByTime(16);

      expect(messagesEl.scrollTop).toBeGreaterThan(100);
    });

    it('stops scrolling when key is released', () => {
      // Start scrolling
      const keydownEvent = new KeyboardEvent('keydown', { key: 'w' });
      messagesEl.dispatchEvent(keydownEvent);

      // Release key - this should trigger cancelAnimationFrame
      const keyupEvent = new KeyboardEvent('keyup', { key: 'w' });
      (global as any).document.dispatchEvent(keyupEvent);

      // Scrolling should have stopped (cancelAnimationFrame was called)
      expect(mockCancelRaf).toHaveBeenCalled();
    });

    it('uses configured scroll keys (case insensitive)', () => {
      settings.scrollUpKey = 'k';
      settings.scrollDownKey = 'j';

      // 'w' should not scroll now
      const keydownW = new KeyboardEvent('keydown', { key: 'w' });
      messagesEl.dispatchEvent(keydownW);
      jest.advanceTimersByTime(16);
      expect(messagesEl.scrollTop).toBe(100);

      // 'k' should scroll up
      const keydownK = new KeyboardEvent('keydown', { key: 'K' }); // Test uppercase
      messagesEl.dispatchEvent(keydownK);
      jest.advanceTimersByTime(16);
      expect(messagesEl.scrollTop).toBeLessThan(100);
    });

    it('prevents default on scroll key press', () => {
      const keydownEvent = new KeyboardEvent('keydown', { key: 'w', cancelable: true });
      const preventDefaultSpy = jest.spyOn(keydownEvent, 'preventDefault');

      messagesEl.dispatchEvent(keydownEvent);

      expect(preventDefaultSpy).toHaveBeenCalled();
    });

    it('does not start duplicate scroll in same direction', () => {
      // First keydown
      const keydown1 = new KeyboardEvent('keydown', { key: 'w' });
      messagesEl.dispatchEvent(keydown1);

      const rafCallCount = mockRaf.mock.calls.length;

      // Second keydown in same direction
      const keydown2 = new KeyboardEvent('keydown', { key: 'w' });
      messagesEl.dispatchEvent(keydown2);

      // RAF should not be called again (already scrolling)
      expect(mockRaf.mock.calls.length).toBe(rafCallCount);
    });

    it('changes direction when opposite key pressed', () => {
      messagesEl.scrollTop = 100;

      // Start scrolling up
      const keydownUp = new KeyboardEvent('keydown', { key: 'w' });
      messagesEl.dispatchEvent(keydownUp);
      jest.advanceTimersByTime(16);

      const scrollAfterUp = messagesEl.scrollTop;
      expect(scrollAfterUp).toBeLessThan(100);

      // Change to scrolling down
      const keydownDown = new KeyboardEvent('keydown', { key: 's' });
      messagesEl.dispatchEvent(keydownDown);
      jest.advanceTimersByTime(16);

      expect(messagesEl.scrollTop).toBeGreaterThan(scrollAfterUp);
    });

    it('ignores scroll key when modifier keys are held (Ctrl)', () => {
      const keydownEvent = new KeyboardEvent('keydown', { key: 'w', ctrlKey: true });
      messagesEl.dispatchEvent(keydownEvent);
      jest.advanceTimersByTime(16);

      // scrollTop should not change - modifier key blocks scrolling
      expect(messagesEl.scrollTop).toBe(100);
    });

    it('ignores scroll key when modifier keys are held (Meta/Cmd)', () => {
      const keydownEvent = new KeyboardEvent('keydown', { key: 'w', metaKey: true });
      messagesEl.dispatchEvent(keydownEvent);
      jest.advanceTimersByTime(16);

      expect(messagesEl.scrollTop).toBe(100);
    });

    it('ignores scroll key when modifier keys are held (Alt)', () => {
      const keydownEvent = new KeyboardEvent('keydown', { key: 's', altKey: true });
      messagesEl.dispatchEvent(keydownEvent);
      jest.advanceTimersByTime(16);

      expect(messagesEl.scrollTop).toBe(100);
    });

    it('ignores scroll key when modifier keys are held (Shift)', () => {
      const keydownEvent = new KeyboardEvent('keydown', { key: 'w', shiftKey: true });
      messagesEl.dispatchEvent(keydownEvent);
      jest.advanceTimersByTime(16);

      expect(messagesEl.scrollTop).toBe(100);
    });
  });

  describe('focus input key (i)', () => {
    beforeEach(() => {
      controller.initialize();
    });

    it('focuses input when i is pressed on messages', () => {
      const focusSpy = jest.spyOn(inputEl, 'focus');

      const keydownEvent = new KeyboardEvent('keydown', { key: 'i' });
      messagesEl.dispatchEvent(keydownEvent);

      expect(focusSpy).toHaveBeenCalled();
    });

    it('prevents default on i key press', () => {
      const keydownEvent = new KeyboardEvent('keydown', { key: 'i', cancelable: true });
      const preventDefaultSpy = jest.spyOn(keydownEvent, 'preventDefault');

      messagesEl.dispatchEvent(keydownEvent);

      expect(preventDefaultSpy).toHaveBeenCalled();
    });

    it('works with uppercase I', () => {
      const focusSpy = jest.spyOn(inputEl, 'focus');

      const keydownEvent = new KeyboardEvent('keydown', { key: 'I' });
      messagesEl.dispatchEvent(keydownEvent);

      expect(focusSpy).toHaveBeenCalled();
    });

    it('uses configured focus input key', () => {
      settings.focusInputKey = 'a';
      const focusSpy = jest.spyOn(inputEl, 'focus');

      // 'i' should not focus now
      const keydownI = new KeyboardEvent('keydown', { key: 'i' });
      messagesEl.dispatchEvent(keydownI);
      expect(focusSpy).not.toHaveBeenCalled();

      // 'a' should focus
      const keydownA = new KeyboardEvent('keydown', { key: 'a' });
      messagesEl.dispatchEvent(keydownA);
      expect(focusSpy).toHaveBeenCalled();
    });
  });

  describe('escape key in input', () => {
    beforeEach(() => {
      controller.initialize();
    });

    it('blurs input and focuses messages when Escape pressed (not streaming)', () => {
      isStreaming = false;
      const blurSpy = jest.spyOn(inputEl, 'blur');
      const focusSpy = jest.spyOn(messagesEl, 'focus');

      const keydownEvent = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true });
      inputEl.dispatchEvent(keydownEvent);

      expect(blurSpy).toHaveBeenCalled();
      expect(focusSpy).toHaveBeenCalled();
    });

    it('prevents default and stops propagation when Escape handled', () => {
      isStreaming = false;

      const keydownEvent = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true });
      const preventDefaultSpy = jest.spyOn(keydownEvent, 'preventDefault');
      const stopPropagationSpy = jest.spyOn(keydownEvent, 'stopPropagation');

      inputEl.dispatchEvent(keydownEvent);

      expect(preventDefaultSpy).toHaveBeenCalled();
      expect(stopPropagationSpy).toHaveBeenCalled();
    });

    it('does not handle Escape when streaming (lets other handlers work)', () => {
      isStreaming = true;
      const blurSpy = jest.spyOn(inputEl, 'blur');

      const keydownEvent = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true });
      const preventDefaultSpy = jest.spyOn(keydownEvent, 'preventDefault');

      inputEl.dispatchEvent(keydownEvent);

      expect(blurSpy).not.toHaveBeenCalled();
      expect(preventDefaultSpy).not.toHaveBeenCalled();
    });

    it('does not handle Escape when shouldSkipEscapeHandling returns true', () => {
      // Dispose current controller and create one with shouldSkipEscapeHandling
      controller.dispose();

      shouldSkipEscapeHandling = jest.fn().mockReturnValue(true);
      controller = new NavigationController({
        ...deps,
        shouldSkipEscapeHandling,
      });
      controller.initialize();

      isStreaming = false;
      const blurSpy = jest.spyOn(inputEl, 'blur');

      const keydownEvent = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true });
      const preventDefaultSpy = jest.spyOn(keydownEvent, 'preventDefault');

      inputEl.dispatchEvent(keydownEvent);

      expect(shouldSkipEscapeHandling).toHaveBeenCalled();
      expect(blurSpy).not.toHaveBeenCalled();
      expect(preventDefaultSpy).not.toHaveBeenCalled();
    });

    it('handles Escape when shouldSkipEscapeHandling returns false', () => {
      // Dispose current controller and create one with shouldSkipEscapeHandling
      controller.dispose();

      shouldSkipEscapeHandling = jest.fn().mockReturnValue(false);
      controller = new NavigationController({
        ...deps,
        shouldSkipEscapeHandling,
      });
      controller.initialize();

      isStreaming = false;
      const blurSpy = jest.spyOn(inputEl, 'blur');

      const keydownEvent = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true });

      inputEl.dispatchEvent(keydownEvent);

      expect(shouldSkipEscapeHandling).toHaveBeenCalled();
      expect(blurSpy).toHaveBeenCalled();
    });

    it('ignores non-Escape keys', () => {
      const blurSpy = jest.spyOn(inputEl, 'blur');

      const keydownEvent = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true });
      inputEl.dispatchEvent(keydownEvent);

      expect(blurSpy).not.toHaveBeenCalled();
    });
  });

  describe('public API', () => {
    beforeEach(() => {
      controller.initialize();
    });

    it('focusMessages focuses the messages element', () => {
      const focusSpy = jest.spyOn(messagesEl, 'focus');
      controller.focusMessages();
      expect(focusSpy).toHaveBeenCalled();
    });

    it('focusInput focuses the input element', () => {
      const focusSpy = jest.spyOn(inputEl, 'focus');
      controller.focusInput();
      expect(focusSpy).toHaveBeenCalled();
    });
  });

  describe('edge cases', () => {
    beforeEach(() => {
      controller.initialize();
    });

    it('handles rapid direction changes', () => {
      messagesEl.scrollTop = 100;

      // Rapidly alternate directions
      for (let i = 0; i < 5; i++) {
        messagesEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'w' }));
        messagesEl.dispatchEvent(new KeyboardEvent('keydown', { key: 's' }));
      }

      // Should not throw and should be scrolling down (last direction)
      jest.advanceTimersByTime(16);
      expect(messagesEl.scrollTop).toBeGreaterThan(100);
    });

    it('handles empty settings keys gracefully', () => {
      settings.scrollUpKey = '';
      settings.scrollDownKey = '';

      // Should not throw
      const keydownEvent = new KeyboardEvent('keydown', { key: 'w' });
      expect(() => messagesEl.dispatchEvent(keydownEvent)).not.toThrow();
    });
  });
});
