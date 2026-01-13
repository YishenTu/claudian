/**
 * Tests for TabBar - Minimal numbered badge UI for tab navigation.
 */

import { TabBar, type TabBarCallbacks } from '@/features/chat/tabs/TabBar';
import type { TabBarItem } from '@/features/chat/tabs/types';

// Helper to create mock DOM element
function createMockElement(): any {
  const classList = new Set<string>();
  const children: any[] = [];
  const eventListeners: Map<string, Array<(...args: unknown[]) => void>> = new Map();
  const attributes: Map<string, string> = new Map();

  const el: any = {
    style: {},
    classList: {
      add: (cls: string) => classList.add(cls),
      remove: (cls: string) => classList.delete(cls),
      contains: (cls: string) => classList.has(cls),
    },
    addClass: (cls: string) => classList.add(cls),
    removeClass: (cls: string) => classList.delete(cls),
    empty: () => {
      children.length = 0;
    },
    createDiv: (opts?: { cls?: string; text?: string }) => {
      const child = createMockElement();
      // Handle space-separated class strings (e.g., "claudian-tab-badge claudian-tab-badge-idle")
      if (opts?.cls) {
        opts.cls.split(' ').forEach(c => child.addClass(c.trim()));
      }
      if (opts?.text) child.textContent = opts.text;
      children.push(child);
      return child;
    },
    setAttribute: (name: string, value: string) => {
      attributes.set(name, value);
    },
    getAttribute: (name: string) => attributes.get(name),
    addEventListener: (event: string, handler: (...args: unknown[]) => void) => {
      if (!eventListeners.has(event)) {
        eventListeners.set(event, []);
      }
      eventListeners.get(event)!.push(handler);
    },
    removeEventListener: (event: string, handler: (...args: unknown[]) => void) => {
      const handlers = eventListeners.get(event);
      if (handlers) {
        const index = handlers.indexOf(handler);
        if (index > -1) handlers.splice(index, 1);
      }
    },
    dispatchEvent: (event: string, eventObj?: any) => {
      const handlers = eventListeners.get(event);
      if (handlers) {
        handlers.forEach(h => h(eventObj));
      }
    },
    textContent: '',
    _children: children,
    _classList: classList,
    _attributes: attributes,
    _eventListeners: eventListeners,
  };

  return el;
}

// Helper to create mock callbacks
function createMockCallbacks(): TabBarCallbacks {
  return {
    onTabClick: jest.fn(),
    onTabClose: jest.fn(),
    onNewTab: jest.fn(),
  };
}

// Helper to create tab bar items
function createTabBarItem(overrides: Partial<TabBarItem> = {}): TabBarItem {
  return {
    id: 'tab-1',
    index: 1,
    title: 'Test Tab',
    isActive: false,
    isStreaming: false,
    needsAttention: false,
    canClose: true,
    ...overrides,
  };
}

describe('TabBar', () => {
  describe('constructor', () => {
    it('should add tab badges class to container', () => {
      const containerEl = createMockElement();
      const callbacks = createMockCallbacks();

      new TabBar(containerEl, callbacks);

      expect(containerEl._classList.has('claudian-tab-badges')).toBe(true);
    });
  });

  describe('update', () => {
    it('should clear existing badges before rendering', () => {
      const containerEl = createMockElement();
      const callbacks = createMockCallbacks();
      const tabBar = new TabBar(containerEl, callbacks);

      // First update
      tabBar.update([createTabBarItem()]);
      expect(containerEl._children.length).toBe(1);

      // Second update should clear first
      tabBar.update([createTabBarItem(), createTabBarItem({ id: 'tab-2', index: 2 })]);
      expect(containerEl._children.length).toBe(2);
    });

    it('should render badge for each tab item', () => {
      const containerEl = createMockElement();
      const callbacks = createMockCallbacks();
      const tabBar = new TabBar(containerEl, callbacks);

      tabBar.update([
        createTabBarItem({ id: 'tab-1', index: 1 }),
        createTabBarItem({ id: 'tab-2', index: 2 }),
        createTabBarItem({ id: 'tab-3', index: 3 }),
      ]);

      expect(containerEl._children.length).toBe(3);
    });

    it('should render empty when no items', () => {
      const containerEl = createMockElement();
      const callbacks = createMockCallbacks();
      const tabBar = new TabBar(containerEl, callbacks);

      tabBar.update([]);

      expect(containerEl._children.length).toBe(0);
    });
  });

  describe('badge rendering', () => {
    it('should display index number as text', () => {
      const containerEl = createMockElement();
      const callbacks = createMockCallbacks();
      const tabBar = new TabBar(containerEl, callbacks);

      tabBar.update([createTabBarItem({ index: 5 })]);

      expect(containerEl._children[0].textContent).toBe('5');
    });

    it('should set title tooltip from item title', () => {
      const containerEl = createMockElement();
      const callbacks = createMockCallbacks();
      const tabBar = new TabBar(containerEl, callbacks);

      tabBar.update([createTabBarItem({ title: 'My Conversation' })]);

      expect(containerEl._children[0].getAttribute('title')).toBe('My Conversation');
      expect(containerEl._children[0].getAttribute('aria-label')).toBe('My Conversation');
    });
  });

  describe('badge state classes', () => {
    it('should apply idle class for inactive tab', () => {
      const containerEl = createMockElement();
      const callbacks = createMockCallbacks();
      const tabBar = new TabBar(containerEl, callbacks);

      tabBar.update([createTabBarItem({ isActive: false, isStreaming: false, needsAttention: false })]);

      expect(containerEl._children[0]._classList.has('claudian-tab-badge-idle')).toBe(true);
    });

    it('should apply active class for active tab', () => {
      const containerEl = createMockElement();
      const callbacks = createMockCallbacks();
      const tabBar = new TabBar(containerEl, callbacks);

      tabBar.update([createTabBarItem({ isActive: true })]);

      expect(containerEl._children[0]._classList.has('claudian-tab-badge-active')).toBe(true);
    });

    it('should apply streaming class for streaming tab', () => {
      const containerEl = createMockElement();
      const callbacks = createMockCallbacks();
      const tabBar = new TabBar(containerEl, callbacks);

      tabBar.update([createTabBarItem({ isStreaming: true })]);

      expect(containerEl._children[0]._classList.has('claudian-tab-badge-streaming')).toBe(true);
    });

    it('should apply attention class for tab needing attention', () => {
      const containerEl = createMockElement();
      const callbacks = createMockCallbacks();
      const tabBar = new TabBar(containerEl, callbacks);

      tabBar.update([createTabBarItem({ needsAttention: true })]);

      expect(containerEl._children[0]._classList.has('claudian-tab-badge-attention')).toBe(true);
    });

    it('should prioritize active over attention', () => {
      const containerEl = createMockElement();
      const callbacks = createMockCallbacks();
      const tabBar = new TabBar(containerEl, callbacks);

      tabBar.update([createTabBarItem({ isActive: true, needsAttention: true })]);

      expect(containerEl._children[0]._classList.has('claudian-tab-badge-active')).toBe(true);
      expect(containerEl._children[0]._classList.has('claudian-tab-badge-attention')).toBe(false);
    });

    it('should prioritize attention over streaming', () => {
      const containerEl = createMockElement();
      const callbacks = createMockCallbacks();
      const tabBar = new TabBar(containerEl, callbacks);

      tabBar.update([createTabBarItem({ isStreaming: true, needsAttention: true })]);

      expect(containerEl._children[0]._classList.has('claudian-tab-badge-attention')).toBe(true);
      expect(containerEl._children[0]._classList.has('claudian-tab-badge-streaming')).toBe(false);
    });

    it('should prioritize active over streaming', () => {
      const containerEl = createMockElement();
      const callbacks = createMockCallbacks();
      const tabBar = new TabBar(containerEl, callbacks);

      tabBar.update([createTabBarItem({ isActive: true, isStreaming: true })]);

      expect(containerEl._children[0]._classList.has('claudian-tab-badge-active')).toBe(true);
      expect(containerEl._children[0]._classList.has('claudian-tab-badge-streaming')).toBe(false);
    });
  });

  describe('badge interactions', () => {
    it('should call onTabClick when badge is clicked', () => {
      const containerEl = createMockElement();
      const callbacks = createMockCallbacks();
      const tabBar = new TabBar(containerEl, callbacks);

      tabBar.update([createTabBarItem({ id: 'clicked-tab' })]);

      // Simulate click
      containerEl._children[0].dispatchEvent('click');

      expect(callbacks.onTabClick).toHaveBeenCalledWith('clicked-tab');
    });

    it('should call onTabClose on right-click when canClose is true', () => {
      const containerEl = createMockElement();
      const callbacks = createMockCallbacks();
      const tabBar = new TabBar(containerEl, callbacks);

      tabBar.update([createTabBarItem({ id: 'closeable-tab', canClose: true })]);

      // Simulate right-click (contextmenu)
      const mockEvent = { preventDefault: jest.fn() };
      containerEl._children[0].dispatchEvent('contextmenu', mockEvent);

      expect(mockEvent.preventDefault).toHaveBeenCalled();
      expect(callbacks.onTabClose).toHaveBeenCalledWith('closeable-tab');
    });

    it('should not register contextmenu handler when canClose is false', () => {
      const containerEl = createMockElement();
      const callbacks = createMockCallbacks();
      const tabBar = new TabBar(containerEl, callbacks);

      tabBar.update([createTabBarItem({ id: 'uncloseable-tab', canClose: false })]);

      // Check that contextmenu handler was not registered
      expect(containerEl._children[0]._eventListeners.has('contextmenu')).toBe(false);
    });
  });

  describe('destroy', () => {
    it('should empty container', () => {
      const containerEl = createMockElement();
      const callbacks = createMockCallbacks();
      const tabBar = new TabBar(containerEl, callbacks);

      tabBar.update([createTabBarItem(), createTabBarItem({ id: 'tab-2', index: 2 })]);
      expect(containerEl._children.length).toBe(2);

      tabBar.destroy();

      expect(containerEl._children.length).toBe(0);
    });

    it('should remove tab badges class from container', () => {
      const containerEl = createMockElement();
      const callbacks = createMockCallbacks();
      const tabBar = new TabBar(containerEl, callbacks);

      expect(containerEl._classList.has('claudian-tab-badges')).toBe(true);

      tabBar.destroy();

      expect(containerEl._classList.has('claudian-tab-badges')).toBe(false);
    });
  });
});
