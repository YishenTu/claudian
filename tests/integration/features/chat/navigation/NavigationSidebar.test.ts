/** @vitest-environment jsdom */

import { NavigationSidebar } from '@/features/chat/navigation/NavigationSidebar';

describe('NavigationSidebar', () => {
  let parentEl: HTMLElement;
  let messagesEl: HTMLElement;
  let sidebar: NavigationSidebar;
  let originalMutationObserver: typeof MutationObserver | undefined;
  let mutationCallback: MutationCallback | null;

  beforeEach(() => {
    vi.useFakeTimers();
    originalMutationObserver = (globalThis as { MutationObserver?: typeof MutationObserver }).MutationObserver;
    mutationCallback = null;
    Object.defineProperty(globalThis, 'MutationObserver', {
      value: class MockMutationObserver {
        constructor(callback: MutationCallback) {
          mutationCallback = callback;
        }

        observe(): void {}
        disconnect(): void {}
        takeRecords(): MutationRecord[] {
          return [];
        }
      } as unknown as typeof MutationObserver,
      configurable: true,
    });
    parentEl = document.body.createDiv();
    messagesEl = document.createElement('div');
    Object.defineProperties(messagesEl, {scrollHeight: {value: 500, writable: true, configurable: true}, clientHeight: {value: 500, writable: true, configurable: true}});
    messagesEl.scrollTo = vi.fn((options?: ScrollToOptions | number) => { if (typeof options === 'object') messagesEl.scrollTop = options.top ?? 0; });
    parentEl.appendChild(messagesEl);
  });

  afterEach(() => {
    sidebar?.destroy();
    if (originalMutationObserver === undefined) {
      delete (globalThis as { MutationObserver?: typeof MutationObserver }).MutationObserver;
    } else {
      Object.defineProperty(globalThis, 'MutationObserver', {
        value: originalMutationObserver,
        configurable: true,
      });
    }
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('initialization', () => {
    it('rolls back global listeners and DOM when observer setup fails', () => {
      const initializationError = new Error('Navigation observer failed');
      const disconnect = vi.fn();
      const removeScrollListener = vi.spyOn(messagesEl, 'removeEventListener');
      const removeDocumentListener = vi.spyOn(parentEl.ownerDocument, 'removeEventListener');
      Object.defineProperty(globalThis, 'MutationObserver', {
        value: class ThrowingMutationObserver {
          observe(): void {
            throw initializationError;
          }

          disconnect(): void {
            disconnect();
          }
        } as unknown as typeof MutationObserver,
        configurable: true,
      });

      expect(() => new NavigationSidebar(
        parentEl,
        messagesEl,
      )).toThrow(initializationError);

      expect(disconnect).toHaveBeenCalledTimes(1);
      expect(removeScrollListener).toHaveBeenCalledWith('scroll', expect.any(Function));
      expect(removeDocumentListener).toHaveBeenCalledWith('click', expect.any(Function));
      expect(parentEl.querySelector<HTMLElement>('.claudian-nav-sidebar')).toBeNull();
    });


  });

  describe('visibility', () => {
    it('should be visible when content overflows', () => {
      Object.defineProperty(messagesEl, 'scrollHeight', { value: 1000, configurable: true });
      Object.defineProperty(messagesEl, 'clientHeight', { value: 500, configurable: true });

      sidebar = new NavigationSidebar(
        parentEl,
        messagesEl
      );

      const container = parentEl.querySelector<HTMLElement>('.claudian-nav-sidebar');
      expect(container!.classList.contains('visible')).toBe(true);
    });

    it('should batch visibility updates until the next animation frame', () => {
      const requestFrame = vi.spyOn(window, 'requestAnimationFrame');
      try {
        Object.defineProperty(messagesEl, 'scrollHeight', { value: 500, configurable: true });
        Object.defineProperty(messagesEl, 'clientHeight', { value: 500, configurable: true });

        sidebar = new NavigationSidebar(
          parentEl,
          messagesEl
        );

        const container = parentEl.querySelector<HTMLElement>('.claudian-nav-sidebar');
        expect(container!.classList.contains('visible')).toBe(false);
        Object.defineProperty(messagesEl, 'scrollHeight', { value: 1000, configurable: true });
        sidebar.updateVisibility();
        sidebar.updateVisibility();

        expect(container!.classList.contains('visible')).toBe(false);
        expect(requestFrame).toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(16);

        expect(container!.classList.contains('visible')).toBe(true);
      } finally {
        requestFrame.mockRestore();
      }
    });
  });

  describe('scroll to top button', () => {
    it('should scroll to top when clicked', () => {
      Object.defineProperty(messagesEl, 'scrollHeight', { value: 1000, configurable: true });
      Object.defineProperty(messagesEl, 'clientHeight', { value: 500, configurable: true });
      messagesEl.scrollTop = 500;

      sidebar = new NavigationSidebar(
        parentEl,
        messagesEl
      );

      const container = parentEl.querySelector<HTMLElement>('.claudian-nav-sidebar');
      const topBtn = container!.querySelectorAll<HTMLElement>('button')[0];
      topBtn.click();

      expect(vi.mocked(messagesEl.scrollTo).mock.calls.map(call => call[0] as ScrollToOptions).length).toBe(1);
      expect(vi.mocked(messagesEl.scrollTo).mock.calls.map(call => call[0] as ScrollToOptions)[0].top).toBe(0);
      expect(vi.mocked(messagesEl.scrollTo).mock.calls.map(call => call[0] as ScrollToOptions)[0].behavior).toBe('smooth');
    });
  });

  describe('scroll to bottom button', () => {
    it('should scroll to bottom when clicked', () => {
      Object.defineProperty(messagesEl, 'scrollHeight', { value: 1000, configurable: true });
      Object.defineProperty(messagesEl, 'clientHeight', { value: 500, configurable: true });
      messagesEl.scrollTop = 0;

      sidebar = new NavigationSidebar(
        parentEl,
        messagesEl
      );

      const container = parentEl.querySelector<HTMLElement>('.claudian-nav-sidebar');
      const bottomBtn = container!.querySelectorAll<HTMLElement>('button')[4];
      bottomBtn.click();

      expect(vi.mocked(messagesEl.scrollTo).mock.calls.map(call => call[0] as ScrollToOptions).length).toBe(1);
      expect(vi.mocked(messagesEl.scrollTo).mock.calls.map(call => call[0] as ScrollToOptions)[0].top).toBe(1000);
      expect(vi.mocked(messagesEl.scrollTo).mock.calls.map(call => call[0] as ScrollToOptions)[0].behavior).toBe('smooth');
    });
  });

  describe('previous/next message navigation', () => {
    function addUserMessage(el: HTMLElement, offset: number): HTMLElement {
      const msg = el.createDiv({ cls: 'claudian-message claudian-message-user' });
      Object.defineProperty(msg, 'offsetTop', { value: offset, configurable: true });
      return msg;
    }

    function addAssistantMessage(el: HTMLElement, offset: number): HTMLElement {
      const msg = el.createDiv({ cls: 'claudian-message claudian-message-assistant' });
      Object.defineProperty(msg, 'offsetTop', { value: offset, configurable: true });
      return msg;
    }

    function addConversation(el: HTMLElement, userOffsets: number[], assistantOffsets: number[]): void {
      // Interleave user and assistant messages in order
      const all = [
        ...userOffsets.map(o => ({ offset: o, role: 'user' as const })),
        ...assistantOffsets.map(o => ({ offset: o, role: 'assistant' as const })),
      ].sort((a, b) => a.offset - b.offset);
      for (const m of all) {
        if (m.role === 'user') addUserMessage(el, m.offset);
        else addAssistantMessage(el, m.offset);
      }
    }

    function getButtons(parent: HTMLElement) {
      const container = parent.querySelector<HTMLElement>('.claudian-nav-sidebar')!;
      return {
        prev: container!.querySelectorAll<HTMLElement>('button')[1],
        next: container!.querySelectorAll<HTMLElement>('button')[3],
      };
    }

    it('should scroll to next user message below current scroll position', () => {
      Object.defineProperty(messagesEl, 'scrollHeight', { value: 2000, configurable: true });
      Object.defineProperty(messagesEl, 'clientHeight', { value: 500, configurable: true });
      // user@0, assistant@100, user@400, assistant@500, user@800
      addConversation(messagesEl, [0, 400, 800], [100, 500]);
      messagesEl.scrollTop = 0;

      sidebar = new NavigationSidebar(
        parentEl,
        messagesEl
      );

      const { next } = getButtons(parentEl);
      next.click();

      const lastCall = vi.mocked(messagesEl.scrollTo).mock.calls.map(call => call[0] as ScrollToOptions)[vi.mocked(messagesEl.scrollTo).mock.calls.map(call => call[0] as ScrollToOptions).length - 1];
      // Should skip assistant@100 and go to user@400
      expect(lastCall.top).toBe(390); // offsetTop(400) - 10
      expect(lastCall.behavior).toBe('smooth');
    });

    it('should scroll to previous user message above current scroll position', () => {
      Object.defineProperty(messagesEl, 'scrollHeight', { value: 2000, configurable: true });
      Object.defineProperty(messagesEl, 'clientHeight', { value: 500, configurable: true });
      addConversation(messagesEl, [0, 400, 800], [100, 500]);
      messagesEl.scrollTop = 800;

      sidebar = new NavigationSidebar(
        parentEl,
        messagesEl
      );

      const { prev } = getButtons(parentEl);
      prev.click();

      const lastCall = vi.mocked(messagesEl.scrollTo).mock.calls.map(call => call[0] as ScrollToOptions)[vi.mocked(messagesEl.scrollTo).mock.calls.map(call => call[0] as ScrollToOptions).length - 1];
      // Should skip assistant@500 and go to user@400
      expect(lastCall.top).toBe(390); // offsetTop(400) - 10
      expect(lastCall.behavior).toBe('smooth');
    });

    it('should not require double-click when scrolled to a user message', () => {
      Object.defineProperty(messagesEl, 'scrollHeight', { value: 2000, configurable: true });
      Object.defineProperty(messagesEl, 'clientHeight', { value: 500, configurable: true });
      addConversation(messagesEl, [0, 400, 800], [100, 500]);
      // Scrolled to user message at offset 400 (scroll position = 390)
      messagesEl.scrollTop = 390;

      sidebar = new NavigationSidebar(
        parentEl,
        messagesEl
      );

      const { next } = getButtons(parentEl);
      next.click();

      const lastCall = vi.mocked(messagesEl.scrollTo).mock.calls.map(call => call[0] as ScrollToOptions)[vi.mocked(messagesEl.scrollTo).mock.calls.map(call => call[0] as ScrollToOptions).length - 1];
      // Should go to user@800, not stay at user@400
      expect(lastCall.top).toBe(790); // offsetTop(800) - 10
    });

    it('should not require double-click for prev when scrolled to a user message', () => {
      Object.defineProperty(messagesEl, 'scrollHeight', { value: 2000, configurable: true });
      Object.defineProperty(messagesEl, 'clientHeight', { value: 500, configurable: true });
      addConversation(messagesEl, [0, 400, 800], [100, 500]);
      // Scrolled to user message at offset 800
      messagesEl.scrollTop = 790;

      sidebar = new NavigationSidebar(
        parentEl,
        messagesEl
      );

      const { prev } = getButtons(parentEl);
      prev.click();

      const lastCall = vi.mocked(messagesEl.scrollTo).mock.calls.map(call => call[0] as ScrollToOptions)[vi.mocked(messagesEl.scrollTo).mock.calls.map(call => call[0] as ScrollToOptions).length - 1];
      // Should go to user@400, not stay at user@800
      expect(lastCall.top).toBe(390); // offsetTop(400) - 10
    });

    it('should scroll to bottom when at the last user message and next is clicked', () => {
      Object.defineProperty(messagesEl, 'scrollHeight', { value: 2000, configurable: true });
      Object.defineProperty(messagesEl, 'clientHeight', { value: 500, configurable: true });
      addConversation(messagesEl, [0, 400, 800], [100, 500]);
      messagesEl.scrollTop = 790;

      sidebar = new NavigationSidebar(
        parentEl,
        messagesEl
      );

      const { next } = getButtons(parentEl);
      next.click();

      const lastCall = vi.mocked(messagesEl.scrollTo).mock.calls.map(call => call[0] as ScrollToOptions)[vi.mocked(messagesEl.scrollTo).mock.calls.map(call => call[0] as ScrollToOptions).length - 1];
      expect(lastCall.top).toBe(2000);
    });

    it('should scroll to top when at the first user message and prev is clicked', () => {
      Object.defineProperty(messagesEl, 'scrollHeight', { value: 2000, configurable: true });
      Object.defineProperty(messagesEl, 'clientHeight', { value: 500, configurable: true });
      addConversation(messagesEl, [0, 400, 800], [100, 500]);
      messagesEl.scrollTop = 0;

      sidebar = new NavigationSidebar(
        parentEl,
        messagesEl
      );

      const { prev } = getButtons(parentEl);
      prev.click();

      const lastCall = vi.mocked(messagesEl.scrollTo).mock.calls.map(call => call[0] as ScrollToOptions)[vi.mocked(messagesEl.scrollTo).mock.calls.map(call => call[0] as ScrollToOptions).length - 1];
      expect(lastCall.top).toBe(0);
    });
  });

  describe('conversation directory', () => {
    function addMessage(
      el: HTMLElement,
      role: 'user' | 'assistant',
      offset: number,
      tocTitle?: string
    ): HTMLElement {
      const msg = el.createDiv({ cls: `claudian-message claudian-message-${role}` });
      Object.defineProperty(msg, 'offsetTop', { value: offset, configurable: true });
      if (tocTitle) {
        msg.setAttribute('data-toc-title', tocTitle);
      }
      return msg;
    }

    function getDirectoryButton(parent: HTMLElement): HTMLElement {
      const container = parent.querySelector<HTMLElement>('.claudian-nav-sidebar')!;
      return container!.querySelectorAll<HTMLElement>('button')[2];
    }

    it('should show an empty directory state when there are no user messages', () => {
      Object.defineProperty(messagesEl, 'scrollHeight', { value: 1000, configurable: true });
      Object.defineProperty(messagesEl, 'clientHeight', { value: 500, configurable: true });

      sidebar = new NavigationSidebar(
        parentEl,
        messagesEl
      );

      const directoryBtn = getDirectoryButton(parentEl);
      expect(directoryBtn.classList.contains('claudian-hidden')).toBe(false);

      directoryBtn.click();

      const popover = parentEl.querySelector<HTMLElement>('.claudian-nav-toc-popover');
      const emptyState = parentEl.querySelector<HTMLElement>('.claudian-nav-toc-empty');
      expect(popover).not.toBeNull();
      expect(emptyState?.textContent).toBe('No user prompts in this conversation');
    });

    it('should fall back to visible user message text when toc metadata is missing', () => {
      Object.defineProperty(messagesEl, 'scrollHeight', { value: 2000, configurable: true });
      Object.defineProperty(messagesEl, 'clientHeight', { value: 500, configurable: true });
      const userMsg = addMessage(messagesEl, 'user', 0);
      userMsg.createDiv({
        cls: 'claudian-message-content',
        text: 'Legacy prompt title\nsecond line',
      });

      sidebar = new NavigationSidebar(
        parentEl,
        messagesEl
      );

      const directoryBtn = getDirectoryButton(parentEl);
      expect(directoryBtn.classList.contains('claudian-hidden')).toBe(false);

      directoryBtn.click();

      const items = parentEl.querySelectorAll<HTMLElement>('.claudian-nav-toc-item');
      expect(items).toHaveLength(1);
      expect(items[0].textContent).toBe('1. Legacy prompt title');
    });

    it('should include user messages marked by data-role when class lookup misses', () => {
      Object.defineProperty(messagesEl, 'scrollHeight', { value: 2000, configurable: true });
      Object.defineProperty(messagesEl, 'clientHeight', { value: 500, configurable: true });
      const userMsg = messagesEl.createDiv({
        cls: 'claudian-message',
        attr: { 'data-role': 'user' },
      });
      Object.defineProperty(userMsg, 'offsetTop', { value: 120, configurable: true });
      userMsg.createDiv({
        cls: 'claudian-message-content',
        text: 'Role based prompt',
      });

      sidebar = new NavigationSidebar(
        parentEl,
        messagesEl
      );

      getDirectoryButton(parentEl).click();

      const items = parentEl.querySelectorAll<HTMLElement>('.claudian-nav-toc-item');
      expect(items).toHaveLength(1);
      expect(items[0].textContent).toBe('1. Role based prompt');
    });

    it('should scroll to a selected directory entry and close the directory', () => {
      Object.defineProperty(messagesEl, 'scrollHeight', { value: 2000, configurable: true });
      Object.defineProperty(messagesEl, 'clientHeight', { value: 500, configurable: true });
      addMessage(messagesEl, 'user', 0, 'First prompt');
      addMessage(messagesEl, 'assistant', 120, 'Assistant should not appear');
      addMessage(messagesEl, 'user', 400, 'Second prompt');

      sidebar = new NavigationSidebar(
        parentEl,
        messagesEl
      );

      getDirectoryButton(parentEl).click();
      const items = parentEl.querySelectorAll<HTMLElement>('.claudian-nav-toc-item');
      expect(parentEl.querySelector<HTMLElement>('.claudian-nav-toc-popover')).not.toBeNull();
      expect(items).toHaveLength(2);
      expect(items[0].textContent).toBe('1. First prompt');
      expect(items[1].textContent).toBe('2. Second prompt');
      items[1].click();

      const lastCall = vi.mocked(messagesEl.scrollTo).mock.calls.map(call => call[0] as ScrollToOptions)[vi.mocked(messagesEl.scrollTo).mock.calls.map(call => call[0] as ScrollToOptions).length - 1];
      expect(lastCall.top).toBe(390);
      expect(lastCall.behavior).toBe('smooth');
      expect(parentEl.querySelector<HTMLElement>('.claudian-nav-toc-popover')).toBeNull();
    });

    it('should close the directory when the directory button is clicked again', () => {
      Object.defineProperty(messagesEl, 'scrollHeight', { value: 2000, configurable: true });
      Object.defineProperty(messagesEl, 'clientHeight', { value: 500, configurable: true });
      addMessage(messagesEl, 'user', 0, 'First prompt');

      sidebar = new NavigationSidebar(
        parentEl,
        messagesEl
      );

      const directoryBtn = getDirectoryButton(parentEl);
      directoryBtn.click();
      expect(parentEl.querySelector<HTMLElement>('.claudian-nav-toc-popover')).not.toBeNull();

      directoryBtn.click();
      expect(parentEl.querySelector<HTMLElement>('.claudian-nav-toc-popover')).toBeNull();
    });

    it('should refresh an open directory when a user message is added', () => {
      Object.defineProperty(messagesEl, 'scrollHeight', { value: 1000, configurable: true });
      Object.defineProperty(messagesEl, 'clientHeight', { value: 500, configurable: true });

      sidebar = new NavigationSidebar(
        parentEl,
        messagesEl
      );

      const directoryBtn = getDirectoryButton(parentEl);
      expect(directoryBtn.classList.contains('claudian-hidden')).toBe(false);

      directoryBtn.click();
      expect(parentEl.querySelector<HTMLElement>('.claudian-nav-toc-empty')?.textContent).toBe('No user prompts in this conversation');
      const newUser = addMessage(messagesEl, 'user', 0, 'New prompt');
      mutationCallback?.([{
        type: 'childList', target: messagesEl, addedNodes: [newUser], removedNodes: [],
      } as unknown as MutationRecord], {} as MutationObserver);
      vi.advanceTimersByTime(16);
      expect(parentEl.querySelector<HTMLElement>('.claudian-nav-toc-empty')).toBeNull();
      const items = parentEl.querySelectorAll<HTMLElement>('.claudian-nav-toc-item');
      expect(items).toHaveLength(1);
      expect(items[0].textContent).toBe('1. New prompt');

      expect(directoryBtn.classList.contains('claudian-hidden')).toBe(false);
    });

    it('should refresh an open directory to an empty state when user messages are removed', () => {
      Object.defineProperty(messagesEl, 'scrollHeight', { value: 2000, configurable: true });
      Object.defineProperty(messagesEl, 'clientHeight', { value: 500, configurable: true });
      const userMsg = addMessage(messagesEl, 'user', 0, 'First prompt');

      sidebar = new NavigationSidebar(
        parentEl,
        messagesEl
      );

      const directoryBtn = getDirectoryButton(parentEl);
      directoryBtn.click();
      expect(parentEl.querySelector<HTMLElement>('.claudian-nav-toc-popover')).not.toBeNull();

      messagesEl.empty();
      mutationCallback?.([
        {
          type: 'childList',
          target: messagesEl,
          addedNodes: [],
          removedNodes: [userMsg],
        } as unknown as MutationRecord,
      ], {} as MutationObserver);
      vi.advanceTimersByTime(16);

      const emptyState = parentEl.querySelector<HTMLElement>('.claudian-nav-toc-empty');
      expect(directoryBtn.classList.contains('claudian-hidden')).toBe(false);
      expect(parentEl.querySelector<HTMLElement>('.claudian-nav-toc-popover')).not.toBeNull();
      expect(emptyState?.textContent).toBe('No user prompts in this conversation');
    });

    it('should not rebuild an open directory for assistant content mutations', () => {
      Object.defineProperty(messagesEl, 'scrollHeight', { value: 2000, configurable: true });
      Object.defineProperty(messagesEl, 'clientHeight', { value: 500, configurable: true });
      addMessage(messagesEl, 'user', 0, 'First prompt');
      const assistantMsg = addMessage(messagesEl, 'assistant', 120);
      const assistantContent = assistantMsg.createDiv({ cls: 'claudian-message-content' });

      sidebar = new NavigationSidebar(
        parentEl,
        messagesEl
      );

      const directoryBtn = getDirectoryButton(parentEl);
      directoryBtn.click();
      const originalPopover = parentEl.querySelector<HTMLElement>('.claudian-nav-toc-popover');
      expect(originalPopover).not.toBeNull();

      const assistantChunk = assistantContent.createDiv({ text: 'Streaming response chunk' });
      mutationCallback?.([
        {
          type: 'childList',
          target: assistantContent,
          addedNodes: [assistantChunk],
          removedNodes: [],
        } as unknown as MutationRecord,
      ], {} as MutationObserver);
      vi.advanceTimersByTime(16);

      expect(parentEl.querySelector<HTMLElement>('.claudian-nav-toc-popover')).toBe(originalPopover);
    });

    it('should refresh an open directory when a user message toc title changes', () => {
      Object.defineProperty(messagesEl, 'scrollHeight', { value: 2000, configurable: true });
      Object.defineProperty(messagesEl, 'clientHeight', { value: 500, configurable: true });
      const userMsg = addMessage(messagesEl, 'user', 0, 'First prompt');

      sidebar = new NavigationSidebar(
        parentEl,
        messagesEl
      );

      getDirectoryButton(parentEl).click();
      const originalPopover = parentEl.querySelector<HTMLElement>('.claudian-nav-toc-popover');
      expect(originalPopover).not.toBeNull();

      userMsg.setAttribute('data-toc-title', 'Updated prompt');
      mutationCallback?.([
        {
          type: 'attributes',
          target: userMsg,
          attributeName: 'data-toc-title',
        } as unknown as MutationRecord,
      ], {} as MutationObserver);
      vi.advanceTimersByTime(16);

      const updatedPopover = parentEl.querySelector<HTMLElement>('.claudian-nav-toc-popover');
      const items = parentEl.querySelectorAll<HTMLElement>('.claudian-nav-toc-item');
      expect(updatedPopover).not.toBe(originalPopover);
      expect(items).toHaveLength(1);
      expect(items[0].textContent).toBe('1. Updated prompt');
    });
  });

  describe('destroy', () => {
    it('should remove container from DOM', () => {
      sidebar = new NavigationSidebar(
        parentEl,
        messagesEl
      );

      expect(parentEl.querySelector<HTMLElement>('.claudian-nav-sidebar')).not.toBeNull();

      sidebar.destroy();

      expect(parentEl.querySelector<HTMLElement>('.claudian-nav-sidebar')).toBeNull();
    });
  });
});
