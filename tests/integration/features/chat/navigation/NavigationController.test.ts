/** @vitest-environment jsdom */
import { createPopoutDocument } from "@test/helpers/dom/popoutDocument";
import type { Mock } from 'vitest';

import { NavigationController, type NavigationControllerDeps } from '@/features/chat/navigation/NavigationController';



describe('NavigationController', () => {
  let controller: NavigationController;
  let messagesEl: HTMLElement;
  let inputEl: HTMLTextAreaElement;
  let deps: NavigationControllerDeps;
  let settings: { scrollUpKey: string; scrollDownKey: string; focusInputKey: string };
  let isStreaming: boolean;
  let shouldSkipEscapeHandling: Mock | undefined;
  let mockRaf: Mock;
  let mockCancelRaf: Mock;
  let originalRaf: typeof requestAnimationFrame;
  let originalCancelRaf: typeof cancelAnimationFrame;

  beforeEach(() => {
    vi.useFakeTimers();

    // Save originals
    originalRaf = global.requestAnimationFrame;
    originalCancelRaf = global.cancelAnimationFrame;

    // Mock requestAnimationFrame
    let rafId = 0;
    mockRaf = vi.fn((cb: FrameRequestCallback) => {
      rafId++;
      setTimeout(() => cb(performance.now()), 16);
      return rafId;
    });
    mockCancelRaf = vi.fn();
    global.requestAnimationFrame = mockRaf;
    global.cancelAnimationFrame = mockCancelRaf;

    messagesEl = document.body.createDiv();
    inputEl = document.body.createEl('textarea');
    settings = { scrollUpKey: 'w', scrollDownKey: 's', focusInputKey: 'i' };
    isStreaming = false;
    shouldSkipEscapeHandling = undefined;

    deps = {
      getMessagesEl: () => messagesEl,
      getInputEl: () => inputEl,
      getSettings: () => settings,
      isStreaming: () => isStreaming,
    };

    controller = new NavigationController(deps);
  });

  afterEach(() => {
    if (controller) {
      controller.dispose();
    }
    vi.useRealTimers();

    // Restore originals
    global.requestAnimationFrame = originalRaf;
    global.cancelAnimationFrame = originalCancelRaf;
  });

  describe('initialization', () => {
    it('initializes and disposes keyboard navigation listeners', () => {
      const addMessagesListener = vi.spyOn(messagesEl, 'addEventListener');
      const addDocumentListener = vi.spyOn(document, 'addEventListener');
      const addInputListener = vi.spyOn(inputEl, 'addEventListener');
      const removeMessagesListener = vi.spyOn(messagesEl, 'removeEventListener');
      const removeDocumentListener = vi.spyOn(document, 'removeEventListener');
      const removeInputListener = vi.spyOn(inputEl, 'removeEventListener');

      controller.initialize();

      expect(messagesEl.getAttribute('tabindex')).toBe('0');
      expect(messagesEl.hasClass('claudian-messages-focusable')).toBe(true);
      expect(addMessagesListener).toHaveBeenCalledWith('keydown', expect.any(Function));
      expect(addDocumentListener).toHaveBeenCalledWith('keyup', expect.any(Function));
      expect(addInputListener).toHaveBeenCalledWith('keydown', expect.any(Function), { capture: true });
      const messagesListener = addMessagesListener.mock.calls[0][1];
      const documentListener = addDocumentListener.mock.calls[0][1];
      const inputListener = addInputListener.mock.calls[0][1];

      controller.dispose();

      expect(removeMessagesListener).toHaveBeenCalledWith('keydown', messagesListener);
      expect(removeDocumentListener).toHaveBeenCalledWith('keyup', documentListener);
      expect(removeInputListener).toHaveBeenCalledWith('keydown', inputListener, { capture: true });
    });
  });

  describe('disposal', () => {
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
      const keydownEvent = new KeyboardEvent('keydown', { key: 'w', cancelable: true });
      const preventDefaultSpy = vi.spyOn(keydownEvent, 'preventDefault');
      messagesEl.dispatchEvent(keydownEvent);
      expect(preventDefaultSpy).toHaveBeenCalled();

      // Advance timers to trigger RAF callback
      vi.advanceTimersByTime(16);

      expect(messagesEl.scrollTop).toBeLessThan(100);
    });

    it('scrolls down when scroll down key is pressed', () => {
      const keydownEvent = new KeyboardEvent('keydown', { key: 's' });
      messagesEl.dispatchEvent(keydownEvent);

      vi.advanceTimersByTime(16);

      expect(messagesEl.scrollTop).toBeGreaterThan(100);
    });

    it('stops scrolling when key is released', () => {
      // Start scrolling
      const keydownEvent = new KeyboardEvent('keydown', { key: 'w' });
      messagesEl.dispatchEvent(keydownEvent);

      // Release key - this should trigger cancelAnimationFrame
      const keyupEvent = new KeyboardEvent('keyup', { key: 'w' });
      document.dispatchEvent(keyupEvent);

      // Scrolling should have stopped (cancelAnimationFrame was called)
      expect(mockCancelRaf).toHaveBeenCalled();
    });

    it('uses the messages owner window for scroll animation frames', () => {
      const ownerRequestAnimationFrame = vi.fn<(...args: Parameters<Window['requestAnimationFrame']>) => ReturnType<Window['requestAnimationFrame']>>()
        .mockReturnValue(42);
      const ownerCancelAnimationFrame = vi.fn<(...args: [number]) => void>();
      const popout = createPopoutDocument();
      controller.dispose();
      messagesEl = popout.body.createDiv();
      popout.defaultView!.requestAnimationFrame = ownerRequestAnimationFrame;
      popout.defaultView!.cancelAnimationFrame = ownerCancelAnimationFrame;
      controller = new NavigationController(deps);
      controller.initialize();
      messagesEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'w' }));

      expect(ownerRequestAnimationFrame).toHaveBeenCalledWith(expect.any(Function));
      expect(mockRaf).not.toHaveBeenCalled();

      messagesEl.ownerDocument.dispatchEvent(new KeyboardEvent('keyup', { key: 'w' }));

      expect(ownerCancelAnimationFrame).toHaveBeenCalledWith(42);
      expect(mockCancelRaf).not.toHaveBeenCalled();
    });

    it('uses configured scroll keys (case insensitive)', () => {
      settings.scrollUpKey = 'k';
      settings.scrollDownKey = 'j';

      // 'w' should not scroll now
      const keydownW = new KeyboardEvent('keydown', { key: 'w' });
      messagesEl.dispatchEvent(keydownW);
      vi.advanceTimersByTime(16);
      expect(messagesEl.scrollTop).toBe(100);

      // 'k' should scroll up
      const keydownK = new KeyboardEvent('keydown', { key: 'K' }); // Test uppercase
      messagesEl.dispatchEvent(keydownK);
      vi.advanceTimersByTime(16);
      expect(messagesEl.scrollTop).toBeLessThan(100);
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
      vi.advanceTimersByTime(16);

      const scrollAfterUp = messagesEl.scrollTop;
      expect(scrollAfterUp).toBeLessThan(100);

      // Change to scrolling down
      const keydownDown = new KeyboardEvent('keydown', { key: 's' });
      messagesEl.dispatchEvent(keydownDown);
      vi.advanceTimersByTime(16);

      expect(messagesEl.scrollTop).toBeGreaterThan(scrollAfterUp);
    });

    it('ignores scroll key when modifier keys are held (Ctrl)', () => {
      const keydownEvent = new KeyboardEvent('keydown', { key: 'w', ctrlKey: true });
      messagesEl.dispatchEvent(keydownEvent);
      vi.advanceTimersByTime(16);

      // scrollTop should not change - modifier key blocks scrolling
      expect(messagesEl.scrollTop).toBe(100);
    });

    it('ignores scroll key when modifier keys are held (Meta/Cmd)', () => {
      const keydownEvent = new KeyboardEvent('keydown', { key: 'w', metaKey: true });
      messagesEl.dispatchEvent(keydownEvent);
      vi.advanceTimersByTime(16);

      expect(messagesEl.scrollTop).toBe(100);
    });

    it('ignores scroll key when modifier keys are held (Alt)', () => {
      const keydownEvent = new KeyboardEvent('keydown', { key: 's', altKey: true });
      messagesEl.dispatchEvent(keydownEvent);
      vi.advanceTimersByTime(16);

      expect(messagesEl.scrollTop).toBe(100);
    });

    it('ignores scroll key when modifier keys are held (Shift)', () => {
      const keydownEvent = new KeyboardEvent('keydown', { key: 'w', shiftKey: true });
      messagesEl.dispatchEvent(keydownEvent);
      vi.advanceTimersByTime(16);

      expect(messagesEl.scrollTop).toBe(100);
    });
  });

  describe('focus input key (i)', () => {
    beforeEach(() => {
      controller.initialize();
    });

    it('focuses input when i is pressed on messages', () => {
      const focusSpy = vi.spyOn(inputEl, 'focus');

      const keydownEvent = new KeyboardEvent('keydown', { key: 'i', cancelable: true });
      const preventDefaultSpy = vi.spyOn(keydownEvent, 'preventDefault');
      messagesEl.dispatchEvent(keydownEvent);
      expect(preventDefaultSpy).toHaveBeenCalled();

      expect(focusSpy).toHaveBeenCalled();
    });

    it('works with uppercase I', () => {
      const focusSpy = vi.spyOn(inputEl, 'focus');

      const keydownEvent = new KeyboardEvent('keydown', { key: 'I' });
      messagesEl.dispatchEvent(keydownEvent);

      expect(focusSpy).toHaveBeenCalled();
    });

    it('uses configured focus input key', () => {
      settings.focusInputKey = 'a';
      const focusSpy = vi.spyOn(inputEl, 'focus');

      // 'i' should not focus now
      const keydownI = new KeyboardEvent('keydown', { key: 'i' });
      messagesEl.dispatchEvent(keydownI);
      expect(focusSpy).not.toHaveBeenCalled();

      // 'a' should focus
      const keydownA = new KeyboardEvent('keydown', { key: 'a' });
      messagesEl.dispatchEvent(keydownA);
      expect(focusSpy).toHaveBeenCalled();
    });

    it('does not steal focus when the focus key comes from the Linked content editor', () => {
      const focusSpy = vi.spyOn(inputEl, 'focus');
      const linkedContentInput = {
        tagName: 'INPUT',
        classList: {
          contains: (className: string) => (
            className === 'claudian-linked-content-picker-search'
          ),
        },
      };
      const keydownEvent = new KeyboardEvent('keydown', {
        key: 'i',
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(keydownEvent, 'target', {
        configurable: true,
        value: linkedContentInput,
      });

      messagesEl.dispatchEvent(keydownEvent);

      expect(focusSpy).not.toHaveBeenCalled();
      expect(keydownEvent.defaultPrevented).toBe(false);
    });
  });

  describe('escape key in input', () => {
    beforeEach(() => {
      controller.initialize();
    });

    it('blurs input and focuses messages when Escape pressed (not streaming)', () => {
      isStreaming = false;
      const blurSpy = vi.spyOn(inputEl, 'blur');
      const focusSpy = vi.spyOn(messagesEl, 'focus');

      const keydownEvent = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true });
      const preventDefaultSpy = vi.spyOn(keydownEvent, 'preventDefault');
      const stopPropagationSpy = vi.spyOn(keydownEvent, 'stopPropagation');
      inputEl.dispatchEvent(keydownEvent);

      expect(preventDefaultSpy).toHaveBeenCalled();
      expect(stopPropagationSpy).toHaveBeenCalled();

      expect(blurSpy).toHaveBeenCalled();
      expect(focusSpy).toHaveBeenCalled();
    });

    it('does not handle Escape when streaming (lets other handlers work)', () => {
      isStreaming = true;
      const blurSpy = vi.spyOn(inputEl, 'blur');

      const keydownEvent = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true });
      const preventDefaultSpy = vi.spyOn(keydownEvent, 'preventDefault');

      inputEl.dispatchEvent(keydownEvent);

      expect(blurSpy).not.toHaveBeenCalled();
      expect(preventDefaultSpy).not.toHaveBeenCalled();
    });

    it('does not handle Escape when shouldSkipEscapeHandling returns true', () => {
      // Dispose current controller and create one with shouldSkipEscapeHandling
      controller.dispose();

      shouldSkipEscapeHandling = vi.fn().mockReturnValue(true);
      controller = new NavigationController({
        ...deps,
        shouldSkipEscapeHandling,
      });
      controller.initialize();

      isStreaming = false;
      const blurSpy = vi.spyOn(inputEl, 'blur');

      const keydownEvent = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true });
      const preventDefaultSpy = vi.spyOn(keydownEvent, 'preventDefault');

      inputEl.dispatchEvent(keydownEvent);

      expect(shouldSkipEscapeHandling).toHaveBeenCalled();
      expect(blurSpy).not.toHaveBeenCalled();
      expect(preventDefaultSpy).not.toHaveBeenCalled();
    });

    it('handles Escape when shouldSkipEscapeHandling returns false', () => {
      // Dispose current controller and create one with shouldSkipEscapeHandling
      controller.dispose();

      shouldSkipEscapeHandling = vi.fn().mockReturnValue(false);
      controller = new NavigationController({
        ...deps,
        shouldSkipEscapeHandling,
      });
      controller.initialize();

      isStreaming = false;
      const blurSpy = vi.spyOn(inputEl, 'blur');

      const keydownEvent = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true });

      inputEl.dispatchEvent(keydownEvent);

      expect(shouldSkipEscapeHandling).toHaveBeenCalled();
      expect(blurSpy).toHaveBeenCalled();
    });

    it('ignores non-Escape keys', () => {
      const blurSpy = vi.spyOn(inputEl, 'blur');

      const keydownEvent = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true });
      inputEl.dispatchEvent(keydownEvent);

      expect(blurSpy).not.toHaveBeenCalled();
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
      vi.advanceTimersByTime(16);
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
