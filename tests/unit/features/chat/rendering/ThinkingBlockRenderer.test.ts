/**
 * Tests for ThinkingBlockRenderer - Extended thinking block UI
 */

import {
  createThinkingBlock,
  finalizeThinkingBlock,
  renderStoredThinkingBlock,
} from '@/features/chat/rendering/ThinkingBlockRenderer';

// Create mock HTML element with Obsidian-like methods
function createMockElement(tag = 'div'): any {
  const children: any[] = [];
  const classes = new Set<string>();
  const attributes = new Map<string, string>();
  const eventListeners = new Map<string, ((...args: unknown[]) => void)[]>();

  const element: any = {
    tagName: tag.toUpperCase(),
    children,
    style: {},
    textContent: '',
    innerHTML: '',
    get className() {
      return Array.from(classes).join(' ');
    },
    set className(value: string) {
      classes.clear();
      if (value) {
        value.split(' ').filter(Boolean).forEach(c => classes.add(c));
      }
    },
    addClass: (cls: string) => {
      classes.add(cls);
      return element;
    },
    removeClass: (cls: string) => {
      classes.delete(cls);
      return element;
    },
    hasClass: (cls: string) => classes.has(cls),
    empty: () => {
      children.length = 0;
      element.innerHTML = '';
      element.textContent = '';
    },
    setAttribute: (name: string, value: string) => attributes.set(name, value),
    getAttribute: (name: string) => attributes.get(name),
    querySelector: (selector: string) => {
      const cls = selector.replace('.', '');
      const findByClass = (el: any): any => {
        if (el.hasClass && el.hasClass(cls)) return el;
        for (const child of el.children || []) {
          const found = findByClass(child);
          if (found) return found;
        }
        return null;
      };
      return findByClass(element);
    },
    addEventListener: (event: string, handler: (...args: unknown[]) => void) => {
      if (!eventListeners.has(event)) eventListeners.set(event, []);
      eventListeners.get(event)!.push(handler);
    },
    createDiv: (opts?: { cls?: string; text?: string }) => {
      const child = createMockElement('div');
      if (opts?.cls) {
        opts.cls.split(' ').forEach(c => child.addClass(c));
      }
      if (opts?.text) child.textContent = opts.text;
      children.push(child);
      return child;
    },
    createSpan: (opts?: { cls?: string; text?: string }) => {
      const child = createMockElement('span');
      if (opts?.cls) {
        opts.cls.split(' ').forEach(c => child.addClass(c));
      }
      if (opts?.text) child.textContent = opts.text;
      children.push(child);
      return child;
    },
    setText: (text: string) => {
      element.textContent = text;
    },
    // Test helpers
    _classes: classes,
    _attributes: attributes,
    _eventListeners: eventListeners,
    _children: children,
  };

  return element;
}

// Mock renderContent function
const mockRenderContent = jest.fn().mockResolvedValue(undefined);

describe('ThinkingBlockRenderer', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('createThinkingBlock', () => {
    it('should start collapsed by default', () => {
      const parentEl = createMockElement();

      const state = createThinkingBlock(parentEl, mockRenderContent);

      expect(state.wrapperEl.hasClass('expanded')).toBe(false);
      expect(state.contentEl.style.display).toBe('none');
    });

    it('should set aria-expanded to false by default', () => {
      const parentEl = createMockElement();

      const state = createThinkingBlock(parentEl, mockRenderContent);

      const header = (state.wrapperEl as any)._children[0];
      expect(header.getAttribute('aria-expanded')).toBe('false');
    });

    it('should set correct ARIA attributes for accessibility', () => {
      const parentEl = createMockElement();

      const state = createThinkingBlock(parentEl, mockRenderContent);

      const header = (state.wrapperEl as any)._children[0];
      expect(header.getAttribute('role')).toBe('button');
      expect(header.getAttribute('tabindex')).toBe('0');
      expect(header.getAttribute('aria-expanded')).toBe('false');
      expect(header.getAttribute('aria-label')).toContain('click to expand');
    });

    it('should toggle expand/collapse on header click', () => {
      const parentEl = createMockElement();

      const state = createThinkingBlock(parentEl, mockRenderContent);

      // Initially collapsed
      expect((state.wrapperEl as any).hasClass('expanded')).toBe(false);
      expect((state.contentEl as any).style.display).toBe('none');

      // Trigger click
      const header = (state.wrapperEl as any)._children[0];
      const clickHandlers = header._eventListeners.get('click') || [];
      expect(clickHandlers.length).toBeGreaterThan(0);
      clickHandlers[0]();

      // Should be expanded
      expect((state.wrapperEl as any).hasClass('expanded')).toBe(true);
      expect((state.contentEl as any).style.display).toBe('block');

      // Click again to collapse
      clickHandlers[0]();
      expect((state.wrapperEl as any).hasClass('expanded')).toBe(false);
      expect((state.contentEl as any).style.display).toBe('none');
    });

    it('should update aria-expanded on toggle', () => {
      const parentEl = createMockElement();

      const state = createThinkingBlock(parentEl, mockRenderContent);
      const header = (state.wrapperEl as any)._children[0];

      // Initially collapsed
      expect(header.getAttribute('aria-expanded')).toBe('false');

      // Expand
      const clickHandlers = header._eventListeners.get('click') || [];
      clickHandlers[0]();
      expect(header.getAttribute('aria-expanded')).toBe('true');

      // Collapse
      clickHandlers[0]();
      expect(header.getAttribute('aria-expanded')).toBe('false');
    });

    it('should show timer label', () => {
      const parentEl = createMockElement();

      const state = createThinkingBlock(parentEl, mockRenderContent);

      expect(state.labelEl.textContent).toContain('Thinking');
    });

    it('should clean up timer on finalize', () => {
      const parentEl = createMockElement();

      const state = createThinkingBlock(parentEl, mockRenderContent);

      expect(state.timerInterval).not.toBeNull();

      finalizeThinkingBlock(state);

      expect(state.timerInterval).toBeNull();
    });
  });

  describe('finalizeThinkingBlock', () => {
    it('should collapse the block when finalized', () => {
      const parentEl = createMockElement();

      const state = createThinkingBlock(parentEl, mockRenderContent);

      // Manually expand first
      state.wrapperEl.addClass('expanded');
      state.contentEl.style.display = 'block';

      finalizeThinkingBlock(state);

      expect(state.wrapperEl.hasClass('expanded')).toBe(false);
      expect(state.contentEl.style.display).toBe('none');
    });

    it('should update label with final duration', () => {
      const parentEl = createMockElement();

      const state = createThinkingBlock(parentEl, mockRenderContent);

      // Advance time by 5 seconds
      jest.advanceTimersByTime(5000);

      const duration = finalizeThinkingBlock(state);

      expect(duration).toBeGreaterThanOrEqual(5);
      expect(state.labelEl.textContent).toContain('Thought for');
    });

    it('should sync isExpanded state so toggle works correctly after finalize', () => {
      const parentEl = createMockElement();

      const state = createThinkingBlock(parentEl, mockRenderContent);
      const header = (state.wrapperEl as any)._children[0];

      // Expand the block
      const clickHandlers = header._eventListeners.get('click') || [];
      clickHandlers[0]();
      expect(state.isExpanded).toBe(true);
      expect((state.wrapperEl as any).hasClass('expanded')).toBe(true);

      // Finalize (which collapses)
      finalizeThinkingBlock(state);
      expect(state.isExpanded).toBe(false);
      expect((state.wrapperEl as any).hasClass('expanded')).toBe(false);

      // Now click once - should expand (not require two clicks)
      clickHandlers[0]();
      expect(state.isExpanded).toBe(true);
      expect((state.wrapperEl as any).hasClass('expanded')).toBe(true);
      expect((state.contentEl as any).style.display).toBe('block');
    });

    it('should update aria-expanded on finalize', () => {
      const parentEl = createMockElement();

      const state = createThinkingBlock(parentEl, mockRenderContent);
      const header = (state.wrapperEl as any)._children[0];

      // Expand first
      const clickHandlers = header._eventListeners.get('click') || [];
      clickHandlers[0]();
      expect(header.getAttribute('aria-expanded')).toBe('true');

      // Finalize
      finalizeThinkingBlock(state);
      expect(header.getAttribute('aria-expanded')).toBe('false');
    });
  });

  describe('renderStoredThinkingBlock', () => {
    it('should start collapsed by default', () => {
      const parentEl = createMockElement();

      const wrapperEl = renderStoredThinkingBlock(parentEl, 'thinking content', 10, mockRenderContent);

      expect((wrapperEl as any).hasClass('expanded')).toBe(false);
    });

    it('should set aria-expanded to false by default', () => {
      const parentEl = createMockElement();

      const wrapperEl = renderStoredThinkingBlock(parentEl, 'thinking content', 10, mockRenderContent);

      const header = (wrapperEl as any)._children[0];
      expect(header.getAttribute('aria-expanded')).toBe('false');
    });

    it('should hide content by default', () => {
      const parentEl = createMockElement();

      const wrapperEl = renderStoredThinkingBlock(parentEl, 'thinking content', 10, mockRenderContent);

      const content = (wrapperEl as any)._children[1];
      expect(content.style.display).toBe('none');
    });

    it('should toggle expand/collapse on click', () => {
      const parentEl = createMockElement();

      const wrapperEl = renderStoredThinkingBlock(parentEl, 'thinking content', 10, mockRenderContent);
      const header = (wrapperEl as any)._children[0];
      const content = (wrapperEl as any)._children[1];

      // Initially collapsed
      expect((wrapperEl as any).hasClass('expanded')).toBe(false);
      expect(content.style.display).toBe('none');

      // Click to expand
      const clickHandlers = header._eventListeners.get('click') || [];
      clickHandlers[0]();

      expect((wrapperEl as any).hasClass('expanded')).toBe(true);
      expect(content.style.display).toBe('block');
      expect(header.getAttribute('aria-expanded')).toBe('true');
    });

    it('should support keyboard navigation (Enter/Space)', () => {
      const parentEl = createMockElement();

      const wrapperEl = renderStoredThinkingBlock(parentEl, 'thinking content', 10, mockRenderContent);
      const header = (wrapperEl as any)._children[0];

      const keydownHandlers = header._eventListeners.get('keydown') || [];
      expect(keydownHandlers.length).toBeGreaterThan(0);

      // Simulate Enter key
      const enterEvent = { key: 'Enter', preventDefault: jest.fn() };
      keydownHandlers[0](enterEvent);

      expect(enterEvent.preventDefault).toHaveBeenCalled();
      expect((wrapperEl as any).hasClass('expanded')).toBe(true);

      // Simulate Space key to collapse
      const spaceEvent = { key: ' ', preventDefault: jest.fn() };
      keydownHandlers[0](spaceEvent);

      expect(spaceEvent.preventDefault).toHaveBeenCalled();
      expect((wrapperEl as any).hasClass('expanded')).toBe(false);
    });
  });

  describe('createThinkingBlock keyboard navigation', () => {
    it('should support keyboard navigation (Enter/Space)', () => {
      const parentEl = createMockElement();

      const state = createThinkingBlock(parentEl, mockRenderContent);
      const header = (state.wrapperEl as any)._children[0];

      const keydownHandlers = header._eventListeners.get('keydown') || [];
      expect(keydownHandlers.length).toBeGreaterThan(0);

      // Simulate Enter key
      const enterEvent = { key: 'Enter', preventDefault: jest.fn() };
      keydownHandlers[0](enterEvent);

      expect(enterEvent.preventDefault).toHaveBeenCalled();
      expect((state.wrapperEl as any).hasClass('expanded')).toBe(true);
      expect((state.contentEl as any).style.display).toBe('block');

      // Simulate Space key to collapse
      const spaceEvent = { key: ' ', preventDefault: jest.fn() };
      keydownHandlers[0](spaceEvent);

      expect(spaceEvent.preventDefault).toHaveBeenCalled();
      expect((state.wrapperEl as any).hasClass('expanded')).toBe(false);
      expect((state.contentEl as any).style.display).toBe('none');
    });

    it('should ignore other keys', () => {
      const parentEl = createMockElement();

      const state = createThinkingBlock(parentEl, mockRenderContent);
      const header = (state.wrapperEl as any)._children[0];

      const keydownHandlers = header._eventListeners.get('keydown') || [];

      // Simulate Tab key (should not toggle)
      const tabEvent = { key: 'Tab', preventDefault: jest.fn() };
      keydownHandlers[0](tabEvent);

      expect(tabEvent.preventDefault).not.toHaveBeenCalled();
      expect((state.wrapperEl as any).hasClass('expanded')).toBe(false);
    });
  });
});
