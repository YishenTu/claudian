import { NavigationSidebar } from '@/features/chat/ui/NavigationSidebar';

// Mock obsidian
jest.mock('obsidian', () => ({
  setIcon: jest.fn((el: any, iconName: string) => {
    el.setAttribute('data-icon', iconName);
  }),
}));

type Listener = (event: any) => void;

class MockClassList {
  private classes = new Set<string>();

  add(...items: string[]): void {
    items.forEach((item) => this.classes.add(item));
  }

  remove(...items: string[]): void {
    items.forEach((item) => this.classes.delete(item));
  }

  contains(item: string): boolean {
    return this.classes.has(item);
  }

  toggle(item: string, force?: boolean): void {
    if (force === undefined) {
      if (this.classes.has(item)) {
        this.classes.delete(item);
      } else {
        this.classes.add(item);
      }
      return;
    }
    if (force) {
      this.classes.add(item);
    } else {
      this.classes.delete(item);
    }
  }

  clear(): void {
    this.classes.clear();
  }

  toArray(): string[] {
    return Array.from(this.classes);
  }
}

class MockElement {
  tagName: string;
  classList = new MockClassList();
  style: Record<string, string> = {};
  ownerDocument: { defaultView: Window | null };
  children: MockElement[] = [];
  attributes: Record<string, string> = {};
  dataset: Record<string, string> = {};
  parent: MockElement | null = null;
  textContent = '';
  private _scrollTop = 0;
  private _scrollHeight = 500;
  private _clientHeight = 500;
  private listeners: Record<string, Listener[]> = {};
  public scrollToCalls: Array<{ top: number; behavior: string }> = [];

  offsetTop = 0;

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = {
      defaultView: (globalThis as { window?: Window }).window ?? null,
    };
  }

  set className(value: string) {
    this.classList.clear();
    value.split(/\s+/).filter(Boolean).forEach((cls) => this.classList.add(cls));
  }

  get className(): string {
    return this.classList.toArray().join(' ');
  }

  get scrollHeight(): number {
    return this._scrollHeight;
  }

  set scrollHeight(value: number) {
    this._scrollHeight = value;
  }

  get clientHeight(): number {
    return this._clientHeight;
  }

  set clientHeight(value: number) {
    this._clientHeight = value;
  }

  get scrollTop(): number {
    return this._scrollTop;
  }

  set scrollTop(value: number) {
    this._scrollTop = value;
  }

  scrollTo(options: { top: number; behavior: string }): void {
    this.scrollToCalls.push(options);
    this._scrollTop = options.top;
  }

  appendChild(child: MockElement): MockElement {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  remove(): void {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((child) => child !== this);
    this.parent = null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  addEventListener(type: string, listener: Listener, _options?: any): void {
    if (!this.listeners[type]) {
      this.listeners[type] = [];
    }
    this.listeners[type].push(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    if (!this.listeners[type]) return;
    this.listeners[type] = this.listeners[type].filter((l) => l !== listener);
  }

  dispatchEvent(event: any): void {
    const listeners = this.listeners[event.type] || [];
    for (const listener of listeners) {
      listener(event);
    }
  }

  click(): void {
    this.dispatchEvent({ type: 'click', stopPropagation: jest.fn(), preventDefault: jest.fn() });
  }

  empty(): void {
    this.children = [];
    this.textContent = '';
  }

  createDiv(options?: { cls?: string; text?: string; attr?: Record<string, string> }): MockElement {
    const el = new MockElement('div');
    if (options?.cls) el.className = options.cls;
    if (options?.text) el.textContent = options.text;
    if (options?.attr) {
      for (const [key, value] of Object.entries(options.attr)) {
        el.setAttribute(key, value);
      }
    }
    this.appendChild(el);
    return el;
  }

  querySelector(selector: string): MockElement | null {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector: string): MockElement[] {
    const matches: MockElement[] = [];
    const selectors = selector.split(',').map((part) => part.trim()).filter(Boolean);
    const matchesSelector = (el: MockElement, singleSelector: string): boolean => {
      if (singleSelector.startsWith('.')) {
        const className = singleSelector.slice(1);
        return el.classList.contains(className);
      }
      const attributeMatch = singleSelector.match(/^\[([^=\]]+)="([^"]+)"\]$/);
      if (attributeMatch) {
        return el.getAttribute(attributeMatch[1]) === attributeMatch[2];
      }
      return false;
    };
    const traverse = (el: MockElement): void => {
      if (selectors.some((singleSelector) => matchesSelector(el, singleSelector))) {
        matches.push(el);
      }
      for (const child of el.children) {
        traverse(child);
      }
    };
    traverse(this);
    return matches;
  }
}

describe('NavigationSidebar', () => {
  let parentEl: MockElement;
  let messagesEl: MockElement;
  let sidebar: NavigationSidebar;
  let originalWindow: Window | undefined;
  let originalMutationObserver: typeof MutationObserver | undefined;
  let mutationCallback: MutationCallback | null;

  beforeEach(() => {
    jest.useFakeTimers();
    originalWindow = (globalThis as { window?: Window }).window;
    originalMutationObserver = (globalThis as { MutationObserver?: typeof MutationObserver }).MutationObserver;
    mutationCallback = null;
    Object.defineProperty(globalThis, 'window', {
      value: {
        requestAnimationFrame: (callback: FrameRequestCallback): number =>
          globalThis.setTimeout(() => callback(performance.now()), 16) as unknown as number,
        cancelAnimationFrame: (handle: number): void => {
          globalThis.clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
        },
        setTimeout: (callback: () => void, timeout: number): number =>
          globalThis.setTimeout(callback, timeout) as unknown as number,
        clearTimeout: (handle: number): void => {
          globalThis.clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
        },
      } as Window,
      configurable: true,
    });
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
    parentEl = new MockElement('div');
    messagesEl = new MockElement('div');
    parentEl.appendChild(messagesEl);
  });

  afterEach(() => {
    sidebar?.destroy();
    if (originalWindow === undefined) {
      delete (globalThis as { window?: Window }).window;
    } else {
      Object.defineProperty(globalThis, 'window', {
        value: originalWindow,
        configurable: true,
      });
    }
    if (originalMutationObserver === undefined) {
      delete (globalThis as { MutationObserver?: typeof MutationObserver }).MutationObserver;
    } else {
      Object.defineProperty(globalThis, 'MutationObserver', {
        value: originalMutationObserver,
        configurable: true,
      });
    }
    jest.useRealTimers();
  });

  describe('initialization', () => {
    it('should create container with correct class', () => {
      sidebar = new NavigationSidebar(
        parentEl as unknown as HTMLElement,
        messagesEl as unknown as HTMLElement
      );

      const container = parentEl.querySelector('.claudian-nav-sidebar');
      expect(container).not.toBeNull();
    });

    it('should create five navigation buttons', () => {
      sidebar = new NavigationSidebar(
        parentEl as unknown as HTMLElement,
        messagesEl as unknown as HTMLElement
      );

      const container = parentEl.querySelector('.claudian-nav-sidebar');
      expect(container).not.toBeNull();
      expect(container!.children.length).toBe(5);
    });

    it('should set correct aria-labels on buttons', () => {
      sidebar = new NavigationSidebar(
        parentEl as unknown as HTMLElement,
        messagesEl as unknown as HTMLElement
      );

      const container = parentEl.querySelector('.claudian-nav-sidebar');
      const buttons = container!.children;

      expect(buttons[0].getAttribute('aria-label')).toBe('Scroll to top');
      expect(buttons[1].getAttribute('aria-label')).toBe('Previous message');
      expect(buttons[2].getAttribute('aria-label')).toBe('Conversation directory');
      expect(buttons[3].getAttribute('aria-label')).toBe('Next message');
      expect(buttons[4].getAttribute('aria-label')).toBe('Scroll to bottom');
    });

    it('should set correct icons on buttons', () => {
      sidebar = new NavigationSidebar(
        parentEl as unknown as HTMLElement,
        messagesEl as unknown as HTMLElement
      );

      const container = parentEl.querySelector('.claudian-nav-sidebar');
      const buttons = container!.children;

      expect(buttons[0].getAttribute('data-icon')).toBe('chevrons-up');
      expect(buttons[1].getAttribute('data-icon')).toBe('chevron-up');
      expect(buttons[2].getAttribute('data-icon')).toBe('list-tree');
      expect(buttons[3].getAttribute('data-icon')).toBe('chevron-down');
      expect(buttons[4].getAttribute('data-icon')).toBe('chevrons-down');
    });
  });

  describe('visibility', () => {
    it('should be hidden when content does not overflow', () => {
      messagesEl.scrollHeight = 500;
      messagesEl.clientHeight = 500;

      sidebar = new NavigationSidebar(
        parentEl as unknown as HTMLElement,
        messagesEl as unknown as HTMLElement
      );

      const container = parentEl.querySelector('.claudian-nav-sidebar');
      expect(container!.classList.contains('visible')).toBe(false);
    });

    it('should be visible when content overflows', () => {
      messagesEl.scrollHeight = 1000;
      messagesEl.clientHeight = 500;

      sidebar = new NavigationSidebar(
        parentEl as unknown as HTMLElement,
        messagesEl as unknown as HTMLElement
      );

      const container = parentEl.querySelector('.claudian-nav-sidebar');
      expect(container!.classList.contains('visible')).toBe(true);
    });

    it('should update visibility when updateVisibility is called', () => {
      messagesEl.scrollHeight = 500;
      messagesEl.clientHeight = 500;

      sidebar = new NavigationSidebar(
        parentEl as unknown as HTMLElement,
        messagesEl as unknown as HTMLElement
      );

      const container = parentEl.querySelector('.claudian-nav-sidebar');
      expect(container!.classList.contains('visible')).toBe(false);

      // Simulate content growth
      messagesEl.scrollHeight = 1000;
      sidebar.updateVisibility();
      jest.advanceTimersByTime(16);

      expect(container!.classList.contains('visible')).toBe(true);
    });

    it('should batch visibility updates until the next animation frame', () => {
      messagesEl.scrollHeight = 500;
      messagesEl.clientHeight = 500;

      sidebar = new NavigationSidebar(
        parentEl as unknown as HTMLElement,
        messagesEl as unknown as HTMLElement
      );

      const container = parentEl.querySelector('.claudian-nav-sidebar');
      messagesEl.scrollHeight = 1000;
      sidebar.updateVisibility();
      sidebar.updateVisibility();

      expect(container!.classList.contains('visible')).toBe(false);

      jest.advanceTimersByTime(16);

      expect(container!.classList.contains('visible')).toBe(true);
    });
  });

  describe('scroll to top button', () => {
    it('should scroll to top when clicked', () => {
      messagesEl.scrollHeight = 1000;
      messagesEl.clientHeight = 500;
      messagesEl.scrollTop = 500;

      sidebar = new NavigationSidebar(
        parentEl as unknown as HTMLElement,
        messagesEl as unknown as HTMLElement
      );

      const container = parentEl.querySelector('.claudian-nav-sidebar');
      const topBtn = container!.children[0];
      topBtn.click();

      expect(messagesEl.scrollToCalls.length).toBe(1);
      expect(messagesEl.scrollToCalls[0].top).toBe(0);
      expect(messagesEl.scrollToCalls[0].behavior).toBe('smooth');
    });
  });

  describe('scroll to bottom button', () => {
    it('should scroll to bottom when clicked', () => {
      messagesEl.scrollHeight = 1000;
      messagesEl.clientHeight = 500;
      messagesEl.scrollTop = 0;

      sidebar = new NavigationSidebar(
        parentEl as unknown as HTMLElement,
        messagesEl as unknown as HTMLElement
      );

      const container = parentEl.querySelector('.claudian-nav-sidebar');
      const bottomBtn = container!.children[4];
      bottomBtn.click();

      expect(messagesEl.scrollToCalls.length).toBe(1);
      expect(messagesEl.scrollToCalls[0].top).toBe(1000);
      expect(messagesEl.scrollToCalls[0].behavior).toBe('smooth');
    });
  });

  describe('previous/next message navigation', () => {
    function addUserMessage(el: MockElement, offset: number): MockElement {
      const msg = el.createDiv({ cls: 'claudian-message claudian-message-user' });
      msg.offsetTop = offset;
      return msg;
    }

    function addAssistantMessage(el: MockElement, offset: number): MockElement {
      const msg = el.createDiv({ cls: 'claudian-message claudian-message-assistant' });
      msg.offsetTop = offset;
      return msg;
    }

    function addConversation(el: MockElement, userOffsets: number[], assistantOffsets: number[]): void {
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

    function getButtons(parent: MockElement) {
      const container = parent.querySelector('.claudian-nav-sidebar')!;
      return {
        prev: container.children[1],
        next: container.children[3],
      };
    }

    it('should scroll to next user message below current scroll position', () => {
      messagesEl.scrollHeight = 2000;
      messagesEl.clientHeight = 500;
      // user@0, assistant@100, user@400, assistant@500, user@800
      addConversation(messagesEl, [0, 400, 800], [100, 500]);
      messagesEl.scrollTop = 0;

      sidebar = new NavigationSidebar(
        parentEl as unknown as HTMLElement,
        messagesEl as unknown as HTMLElement
      );

      const { next } = getButtons(parentEl);
      next.click();

      const lastCall = messagesEl.scrollToCalls[messagesEl.scrollToCalls.length - 1];
      // Should skip assistant@100 and go to user@400
      expect(lastCall.top).toBe(390); // offsetTop(400) - 10
      expect(lastCall.behavior).toBe('smooth');
    });

    it('should scroll to previous user message above current scroll position', () => {
      messagesEl.scrollHeight = 2000;
      messagesEl.clientHeight = 500;
      addConversation(messagesEl, [0, 400, 800], [100, 500]);
      messagesEl.scrollTop = 800;

      sidebar = new NavigationSidebar(
        parentEl as unknown as HTMLElement,
        messagesEl as unknown as HTMLElement
      );

      const { prev } = getButtons(parentEl);
      prev.click();

      const lastCall = messagesEl.scrollToCalls[messagesEl.scrollToCalls.length - 1];
      // Should skip assistant@500 and go to user@400
      expect(lastCall.top).toBe(390); // offsetTop(400) - 10
      expect(lastCall.behavior).toBe('smooth');
    });

    it('should not require double-click when scrolled to a user message', () => {
      messagesEl.scrollHeight = 2000;
      messagesEl.clientHeight = 500;
      addConversation(messagesEl, [0, 400, 800], [100, 500]);
      // Scrolled to user message at offset 400 (scroll position = 390)
      messagesEl.scrollTop = 390;

      sidebar = new NavigationSidebar(
        parentEl as unknown as HTMLElement,
        messagesEl as unknown as HTMLElement
      );

      const { next } = getButtons(parentEl);
      next.click();

      const lastCall = messagesEl.scrollToCalls[messagesEl.scrollToCalls.length - 1];
      // Should go to user@800, not stay at user@400
      expect(lastCall.top).toBe(790); // offsetTop(800) - 10
    });

    it('should not require double-click for prev when scrolled to a user message', () => {
      messagesEl.scrollHeight = 2000;
      messagesEl.clientHeight = 500;
      addConversation(messagesEl, [0, 400, 800], [100, 500]);
      // Scrolled to user message at offset 800
      messagesEl.scrollTop = 790;

      sidebar = new NavigationSidebar(
        parentEl as unknown as HTMLElement,
        messagesEl as unknown as HTMLElement
      );

      const { prev } = getButtons(parentEl);
      prev.click();

      const lastCall = messagesEl.scrollToCalls[messagesEl.scrollToCalls.length - 1];
      // Should go to user@400, not stay at user@800
      expect(lastCall.top).toBe(390); // offsetTop(400) - 10
    });

    it('should scroll to bottom when at the last user message and next is clicked', () => {
      messagesEl.scrollHeight = 2000;
      messagesEl.clientHeight = 500;
      addConversation(messagesEl, [0, 400, 800], [100, 500]);
      messagesEl.scrollTop = 790;

      sidebar = new NavigationSidebar(
        parentEl as unknown as HTMLElement,
        messagesEl as unknown as HTMLElement
      );

      const { next } = getButtons(parentEl);
      next.click();

      const lastCall = messagesEl.scrollToCalls[messagesEl.scrollToCalls.length - 1];
      expect(lastCall.top).toBe(2000);
    });

    it('should scroll to top when at the first user message and prev is clicked', () => {
      messagesEl.scrollHeight = 2000;
      messagesEl.clientHeight = 500;
      addConversation(messagesEl, [0, 400, 800], [100, 500]);
      messagesEl.scrollTop = 0;

      sidebar = new NavigationSidebar(
        parentEl as unknown as HTMLElement,
        messagesEl as unknown as HTMLElement
      );

      const { prev } = getButtons(parentEl);
      prev.click();

      const lastCall = messagesEl.scrollToCalls[messagesEl.scrollToCalls.length - 1];
      expect(lastCall.top).toBe(0);
    });
  });

  describe('conversation directory', () => {
    function addMessage(
      el: MockElement,
      role: 'user' | 'assistant',
      offset: number,
      tocTitle?: string
    ): MockElement {
      const msg = el.createDiv({ cls: `claudian-message claudian-message-${role}` });
      msg.offsetTop = offset;
      if (tocTitle) {
        msg.setAttribute('data-toc-title', tocTitle);
      }
      return msg;
    }

    function getDirectoryButton(parent: MockElement): MockElement {
      const container = parent.querySelector('.claudian-nav-sidebar')!;
      return container.children[2];
    }

    it('should show an empty directory state when there are no user messages', () => {
      messagesEl.scrollHeight = 1000;
      messagesEl.clientHeight = 500;

      sidebar = new NavigationSidebar(
        parentEl as unknown as HTMLElement,
        messagesEl as unknown as HTMLElement
      );

      const directoryBtn = getDirectoryButton(parentEl);
      expect(directoryBtn.classList.contains('claudian-hidden')).toBe(false);

      directoryBtn.click();

      const popover = parentEl.querySelector('.claudian-nav-toc-popover');
      const emptyState = parentEl.querySelector('.claudian-nav-toc-empty');
      expect(popover).not.toBeNull();
      expect(emptyState?.textContent).toBe('No user prompts in this conversation');
    });

    it('should render directory entries for user messages only', () => {
      messagesEl.scrollHeight = 2000;
      messagesEl.clientHeight = 500;
      addMessage(messagesEl, 'user', 0, 'First prompt');
      addMessage(messagesEl, 'assistant', 120, 'Assistant should not appear');
      addMessage(messagesEl, 'user', 400, 'Second prompt');

      sidebar = new NavigationSidebar(
        parentEl as unknown as HTMLElement,
        messagesEl as unknown as HTMLElement
      );

      getDirectoryButton(parentEl).click();

      const popover = parentEl.querySelector('.claudian-nav-toc-popover');
      const items = parentEl.querySelectorAll('.claudian-nav-toc-item');
      expect(popover).not.toBeNull();
      expect(items).toHaveLength(2);
      expect(items[0].textContent).toBe('1. First prompt');
      expect(items[1].textContent).toBe('2. Second prompt');
    });

    it('should fall back to visible user message text when toc metadata is missing', () => {
      messagesEl.scrollHeight = 2000;
      messagesEl.clientHeight = 500;
      const userMsg = addMessage(messagesEl, 'user', 0);
      userMsg.createDiv({
        cls: 'claudian-message-content',
        text: 'Legacy prompt title\nsecond line',
      });

      sidebar = new NavigationSidebar(
        parentEl as unknown as HTMLElement,
        messagesEl as unknown as HTMLElement
      );

      const directoryBtn = getDirectoryButton(parentEl);
      expect(directoryBtn.classList.contains('claudian-hidden')).toBe(false);

      directoryBtn.click();

      const items = parentEl.querySelectorAll('.claudian-nav-toc-item');
      expect(items).toHaveLength(1);
      expect(items[0].textContent).toBe('1. Legacy prompt title');
    });

    it('should include user messages marked by data-role when class lookup misses', () => {
      messagesEl.scrollHeight = 2000;
      messagesEl.clientHeight = 500;
      const userMsg = messagesEl.createDiv({
        cls: 'claudian-message',
        attr: { 'data-role': 'user' },
      });
      userMsg.offsetTop = 120;
      userMsg.createDiv({
        cls: 'claudian-message-content',
        text: 'Role based prompt',
      });

      sidebar = new NavigationSidebar(
        parentEl as unknown as HTMLElement,
        messagesEl as unknown as HTMLElement
      );

      getDirectoryButton(parentEl).click();

      const items = parentEl.querySelectorAll('.claudian-nav-toc-item');
      expect(items).toHaveLength(1);
      expect(items[0].textContent).toBe('1. Role based prompt');
    });

    it('should scroll to a selected directory entry and close the directory', () => {
      messagesEl.scrollHeight = 2000;
      messagesEl.clientHeight = 500;
      addMessage(messagesEl, 'user', 0, 'First prompt');
      addMessage(messagesEl, 'user', 400, 'Second prompt');

      sidebar = new NavigationSidebar(
        parentEl as unknown as HTMLElement,
        messagesEl as unknown as HTMLElement
      );

      getDirectoryButton(parentEl).click();
      const items = parentEl.querySelectorAll('.claudian-nav-toc-item');
      items[1].click();

      const lastCall = messagesEl.scrollToCalls[messagesEl.scrollToCalls.length - 1];
      expect(lastCall.top).toBe(390);
      expect(lastCall.behavior).toBe('smooth');
      expect(parentEl.querySelector('.claudian-nav-toc-popover')).toBeNull();
    });

    it('should close the directory when the directory button is clicked again', () => {
      messagesEl.scrollHeight = 2000;
      messagesEl.clientHeight = 500;
      addMessage(messagesEl, 'user', 0, 'First prompt');

      sidebar = new NavigationSidebar(
        parentEl as unknown as HTMLElement,
        messagesEl as unknown as HTMLElement
      );

      const directoryBtn = getDirectoryButton(parentEl);
      directoryBtn.click();
      expect(parentEl.querySelector('.claudian-nav-toc-popover')).not.toBeNull();

      directoryBtn.click();
      expect(parentEl.querySelector('.claudian-nav-toc-popover')).toBeNull();
    });

    it('should keep the directory button visible when message DOM changes', () => {
      messagesEl.scrollHeight = 1000;
      messagesEl.clientHeight = 500;

      sidebar = new NavigationSidebar(
        parentEl as unknown as HTMLElement,
        messagesEl as unknown as HTMLElement
      );

      const directoryBtn = getDirectoryButton(parentEl);
      expect(directoryBtn.classList.contains('claudian-hidden')).toBe(false);

      addMessage(messagesEl, 'user', 0, 'New prompt');
      mutationCallback?.([], {} as MutationObserver);
      jest.advanceTimersByTime(16);

      expect(directoryBtn.classList.contains('claudian-hidden')).toBe(false);
    });

    it('should refresh an open directory to an empty state when user messages are removed', () => {
      messagesEl.scrollHeight = 2000;
      messagesEl.clientHeight = 500;
      const userMsg = addMessage(messagesEl, 'user', 0, 'First prompt');

      sidebar = new NavigationSidebar(
        parentEl as unknown as HTMLElement,
        messagesEl as unknown as HTMLElement
      );

      const directoryBtn = getDirectoryButton(parentEl);
      directoryBtn.click();
      expect(parentEl.querySelector('.claudian-nav-toc-popover')).not.toBeNull();

      messagesEl.empty();
      mutationCallback?.([
        {
          type: 'childList',
          target: messagesEl,
          addedNodes: [],
          removedNodes: [userMsg],
        } as unknown as MutationRecord,
      ], {} as MutationObserver);
      jest.advanceTimersByTime(16);

      const emptyState = parentEl.querySelector('.claudian-nav-toc-empty');
      expect(directoryBtn.classList.contains('claudian-hidden')).toBe(false);
      expect(parentEl.querySelector('.claudian-nav-toc-popover')).not.toBeNull();
      expect(emptyState?.textContent).toBe('No user prompts in this conversation');
    });

    it('should not rebuild an open directory for assistant content mutations', () => {
      messagesEl.scrollHeight = 2000;
      messagesEl.clientHeight = 500;
      addMessage(messagesEl, 'user', 0, 'First prompt');
      const assistantMsg = addMessage(messagesEl, 'assistant', 120);
      const assistantContent = assistantMsg.createDiv({ cls: 'claudian-message-content' });

      sidebar = new NavigationSidebar(
        parentEl as unknown as HTMLElement,
        messagesEl as unknown as HTMLElement
      );

      const directoryBtn = getDirectoryButton(parentEl);
      directoryBtn.click();
      const originalPopover = parentEl.querySelector('.claudian-nav-toc-popover');
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
      jest.advanceTimersByTime(16);

      expect(parentEl.querySelector('.claudian-nav-toc-popover')).toBe(originalPopover);
    });

    it('should refresh an open directory when a user message toc title changes', () => {
      messagesEl.scrollHeight = 2000;
      messagesEl.clientHeight = 500;
      const userMsg = addMessage(messagesEl, 'user', 0, 'First prompt');

      sidebar = new NavigationSidebar(
        parentEl as unknown as HTMLElement,
        messagesEl as unknown as HTMLElement
      );

      getDirectoryButton(parentEl).click();
      const originalPopover = parentEl.querySelector('.claudian-nav-toc-popover');
      expect(originalPopover).not.toBeNull();

      userMsg.setAttribute('data-toc-title', 'Updated prompt');
      mutationCallback?.([
        {
          type: 'attributes',
          target: userMsg,
          attributeName: 'data-toc-title',
        } as unknown as MutationRecord,
      ], {} as MutationObserver);
      jest.advanceTimersByTime(16);

      const updatedPopover = parentEl.querySelector('.claudian-nav-toc-popover');
      const items = parentEl.querySelectorAll('.claudian-nav-toc-item');
      expect(updatedPopover).not.toBe(originalPopover);
      expect(items).toHaveLength(1);
      expect(items[0].textContent).toBe('1. Updated prompt');
    });
  });

  describe('destroy', () => {
    it('should remove container from DOM', () => {
      sidebar = new NavigationSidebar(
        parentEl as unknown as HTMLElement,
        messagesEl as unknown as HTMLElement
      );

      expect(parentEl.querySelector('.claudian-nav-sidebar')).not.toBeNull();

      sidebar.destroy();

      expect(parentEl.querySelector('.claudian-nav-sidebar')).toBeNull();
    });
  });
});
