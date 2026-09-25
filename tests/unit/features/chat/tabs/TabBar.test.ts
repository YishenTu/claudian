import { createMockEl } from '@test/helpers/MockElement';

import { TabBar, type TabBarCallbacks } from '@/features/chat/tabs/TabBar';
import type { TabBarItem } from '@/features/chat/tabs/types';

// Helper to create mock callbacks
function createMockCallbacks(): TabBarCallbacks {
  return {
    onTabClick: jest.fn(),
    onTabClose: jest.fn(),
  };
}

// Helper to create tab bar items
function createTabBarItem(overrides: Partial<TabBarItem> = {}): TabBarItem {
  return {
    id: 'tab-1',
    index: 1,
    title: 'Test Tab',
    isActive: false,
    isWorking: false,
    attention: null,
    canClose: true,
    ...overrides,
  };
}

describe('TabBar', () => {
  describe('update', () => {
    it('should clear existing badges before rendering', () => {
      const containerEl = createMockEl();
      const callbacks = createMockCallbacks();
      const tabBar = new TabBar(containerEl, callbacks);

      // First update
      tabBar.update([createTabBarItem()]);
      expect(containerEl._children.length).toBe(1);

      // Second update should clear first
      tabBar.update([
        createTabBarItem({ id: 'tab-1', index: 1 }),
        createTabBarItem({ id: 'tab-2', index: 2 }),
        createTabBarItem({ id: 'tab-3', index: 3 }),
      ]);
      expect(containerEl._children.length).toBe(3);

      tabBar.update([]);
      expect(containerEl._children.length).toBe(0);
    });
  });

  describe('badge rendering', () => {

    it('should use aria-label as the single tab title tooltip source', () => {
      const containerEl = createMockEl();
      const callbacks = createMockCallbacks();
      const tabBar = new TabBar(containerEl, callbacks);

      tabBar.update([createTabBarItem({ title: 'My Conversation' })]);

      expect(containerEl._children[0].getAttribute('aria-label')).toBe('My Conversation, idle');
      expect(containerEl._children[0].getAttribute('title')).toBeNull();
    });

    it('does not expose a provider-specific tab styling hook', () => {
      const containerEl = createMockEl();
      const callbacks = createMockCallbacks();
      const tabBar = new TabBar(containerEl, callbacks);

      tabBar.update([createTabBarItem()]);

      expect(containerEl._children[0].getAttribute('data-provider')).toBeNull();
    });

    it('should toggle between index and title labels on double click', () => {
      const containerEl = createMockEl();
      const callbacks = {
        ...createMockCallbacks(),
        onTitleExpansionChanged: jest.fn(),
      };
      const tabBar = new TabBar(containerEl, callbacks);

      tabBar.update([createTabBarItem({ id: 'tab-2', index: 5, title: 'My Conversation' })]);

      const badge = containerEl._children[0];
      const event = { preventDefault: jest.fn(), stopPropagation: jest.fn() };

      expect(badge.textContent).toBe('5');
      badge.dispatchEvent('dblclick', event);

      expect(badge.textContent).toBe('My Conversation');
      expect(badge.hasClass('claudian-tab-badge-expanded')).toBe(true);
      expect(badge.getAttribute('data-title-expanded')).toBe('true');
      expect(event.preventDefault).toHaveBeenCalled();
      expect(event.stopPropagation).toHaveBeenCalled();
      expect(callbacks.onTitleExpansionChanged).toHaveBeenNthCalledWith(1, ['tab-2']);

      badge.dispatchEvent('dblclick', { preventDefault: jest.fn(), stopPropagation: jest.fn() });

      expect(badge.textContent).toBe('5');
      expect(badge.hasClass('claudian-tab-badge-expanded')).toBe(false);
      expect(badge.getAttribute('data-title-expanded')).toBe('false');
      expect(callbacks.onTitleExpansionChanged).toHaveBeenNthCalledWith(2, []);
    });

    it('should render restored expanded title state', () => {
      const containerEl = createMockEl();
      const callbacks = createMockCallbacks();
      const tabBar = new TabBar(containerEl, callbacks);

      tabBar.setExpandedTitleTabIds(['tab-1']);
      tabBar.update([createTabBarItem({ id: 'tab-1', index: 1, title: 'Restored Title' })]);

      expect(containerEl._children[0].textContent).toBe('Restored Title');
      expect(containerEl._children[0].getAttribute('data-title-expanded')).toBe('true');
      expect(tabBar.getExpandedTitleTabIds()).toEqual(['tab-1']);
    });

    it('should truncate expanded title labels with a literal ellipsis suffix', () => {
      const containerEl = createMockEl();
      const callbacks = createMockCallbacks();
      const tabBar = new TabBar(containerEl, callbacks);
      const title = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

      tabBar.update([createTabBarItem({ title })]);
      containerEl._children[0].dispatchEvent('dblclick', {
        preventDefault: jest.fn(),
        stopPropagation: jest.fn(),
      });

      expect(containerEl._children[0].textContent).toBe('ABCDEFGHIJKLMNOPQRSTUVWXYZ012...');
    });

    it('should keep expanded title state across tab bar updates', () => {
      const containerEl = createMockEl();
      const callbacks = createMockCallbacks();
      const tabBar = new TabBar(containerEl, callbacks);

      tabBar.update([createTabBarItem({ id: 'tab-1', index: 1, title: 'First Title' })]);
      containerEl._children[0].dispatchEvent('dblclick', {
        preventDefault: jest.fn(),
        stopPropagation: jest.fn(),
      });

      tabBar.update([createTabBarItem({ id: 'tab-1', index: 1, title: 'Renamed Title' })]);

      expect(containerEl._children[0].textContent).toBe('Renamed Title');
      expect(containerEl._children[0].hasClass('claudian-tab-badge-expanded')).toBe(true);
    });

    it('should preserve horizontal scroll position across tab bar updates', () => {
      const containerEl = createMockEl();
      const callbacks = createMockCallbacks();
      const tabBar = new TabBar(containerEl, callbacks);

      tabBar.update([
        createTabBarItem({ id: 'tab-1', index: 1 }),
        createTabBarItem({ id: 'tab-2', index: 2 }),
      ]);
      containerEl.scrollLeft = 72;

      tabBar.update([
        createTabBarItem({ id: 'tab-1', index: 1 }),
        createTabBarItem({ id: 'tab-2', index: 2, isActive: true }),
      ]);

      expect(containerEl.scrollLeft).toBe(72);
    });

    it('should restore the last known scroll position when live DOM scroll resets before update', () => {
      const containerEl = createMockEl();
      const callbacks = createMockCallbacks();
      const tabBar = new TabBar(containerEl, callbacks);

      tabBar.update([
        createTabBarItem({ id: 'tab-1', index: 1 }),
        createTabBarItem({ id: 'tab-2', index: 2 }),
        createTabBarItem({ id: 'tab-3', index: 3 }),
      ]);
      containerEl.scrollLeft = 96;
      containerEl.dispatchEvent('scroll');
      containerEl.scrollLeft = 0;

      tabBar.update([
        createTabBarItem({ id: 'tab-1', index: 1 }),
        createTabBarItem({ id: 'tab-2', index: 2 }),
        createTabBarItem({ id: 'tab-3', index: 3, isActive: true }),
      ]);

      expect(containerEl.scrollLeft).toBe(96);
    });
  });

  describe('badge state classes', () => {

    it('should apply active class for active tab', () => {
      const containerEl = createMockEl();
      const callbacks = createMockCallbacks();
      const tabBar = new TabBar(containerEl, callbacks);

      tabBar.update([createTabBarItem({ isActive: true })]);

      expect(containerEl._children[0]._classList.has('claudian-tab-badge-active')).toBe(true);
    });

    it('should prioritize active over attention states', () => {
      const containerEl = createMockEl();
      const callbacks = createMockCallbacks();
      const tabBar = new TabBar(containerEl, callbacks);

      tabBar.update([createTabBarItem({
        isActive: true,
        attention: { kind: 'action-required', since: 1 },
      })]);

      expect(containerEl._children[0]._classList.has('claudian-tab-badge-active')).toBe(true);
      expect(containerEl._children[0]._classList.has('claudian-tab-badge-action-required')).toBe(false);
    });

    it('should prioritize action-required attention over ongoing work', () => {
      const containerEl = createMockEl();
      const callbacks = createMockCallbacks();
      const tabBar = new TabBar(containerEl, callbacks);

      tabBar.update([createTabBarItem({
        isWorking: true,
        attention: { kind: 'action-required', since: 1 },
      })]);

      expect(containerEl._children[0]._classList.has('claudian-tab-badge-action-required')).toBe(true);
      expect(containerEl._children[0]._classList.has('claudian-tab-badge-streaming')).toBe(false);
    });

    it.each(['completed', 'error'] as const)(
      'should keep showing ongoing work over an unread %s result',
      (outcome) => {
        const containerEl = createMockEl();
        const callbacks = createMockCallbacks();
        const tabBar = new TabBar(containerEl, callbacks);

        tabBar.update([createTabBarItem({
          isWorking: true,
          attention: { kind: 'review', outcome, since: 1 },
        })]);

        expect(containerEl._children[0]._classList.has('claudian-tab-badge-streaming')).toBe(true);
        expect(containerEl._children[0]._classList.has('claudian-tab-badge-review')).toBe(false);
        expect(containerEl._children[0]._classList.has('claudian-tab-badge-review-error')).toBe(false);
      },
    );

    it('should prioritize active over streaming', () => {
      const containerEl = createMockEl();
      const callbacks = createMockCallbacks();
      const tabBar = new TabBar(containerEl, callbacks);

      tabBar.update([createTabBarItem({ isActive: true, isWorking: true })]);

      expect(containerEl._children[0]._classList.has('claudian-tab-badge-active')).toBe(true);
      expect(containerEl._children[0]._classList.has('claudian-tab-badge-streaming')).toBe(false);
    });

    it.each([
      [createTabBarItem(), 'idle', 'claudian-tab-badge-idle', []],
      [createTabBarItem({ isWorking: true }), 'working', 'claudian-tab-badge-streaming', []],
      [createTabBarItem({ attention: { kind: 'review', outcome: 'completed', since: 1 } }), 'finished, ready to review', 'claudian-tab-badge-review', ['claudian-tab-badge-action-required']],
      [createTabBarItem({ attention: { kind: 'review', outcome: 'error', since: 1 } }), 'stopped with an error, ready to review', 'claudian-tab-badge-review-error', ['claudian-tab-badge-review']],
      [createTabBarItem({ attention: { kind: 'action-required', since: 1 } }), 'needs your input', 'claudian-tab-badge-action-required', ['claudian-tab-badge-review']],
    ] as const)('should expose the color state in the accessible label', (item, status, expectedClass, forbiddenClasses) => {
      const containerEl = createMockEl();
      const callbacks = createMockCallbacks();
      const tabBar = new TabBar(containerEl, callbacks);

      tabBar.update([item]);

      const badge = containerEl._children[0];
      expect(badge.getAttribute('aria-label')).toBe(`Test Tab, ${status}`);
      expect(badge._classList.has(expectedClass)).toBe(true);
      expect(forbiddenClasses.filter(className => badge._classList.has(className))).toEqual([]);
    });
  });

  describe('badge interactions', () => {
    it('should call onTabClick when badge is clicked', () => {
      const containerEl = createMockEl();
      const callbacks = createMockCallbacks();
      const tabBar = new TabBar(containerEl, callbacks);

      tabBar.update([createTabBarItem({ id: 'clicked-tab' })]);

      // Simulate click
      containerEl._children[0].dispatchEvent('click');

      expect(callbacks.onTabClick).toHaveBeenCalledWith('clicked-tab');
    });

    it('should call onTabClose on right-click when canClose is true', () => {
      const containerEl = createMockEl();
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
      const containerEl = createMockEl();
      const callbacks = createMockCallbacks();
      const tabBar = new TabBar(containerEl, callbacks);

      tabBar.update([createTabBarItem({ id: 'uncloseable-tab', canClose: false })]);

      // Check that contextmenu handler was not registered
      expect(containerEl._children[0]._eventListeners.has('contextmenu')).toBe(false);
    });
  });

  describe('destroy', () => {
    it('should empty container', () => {
      const containerEl = createMockEl();
      const callbacks = createMockCallbacks();
      const tabBar = new TabBar(containerEl, callbacks);

      expect(containerEl._classList.has('claudian-tab-badges')).toBe(true);

      tabBar.update([createTabBarItem(), createTabBarItem({ id: 'tab-2', index: 2 })]);
      expect(containerEl._children.length).toBe(2);

      tabBar.destroy();

      expect(containerEl._children.length).toBe(0);
      expect(containerEl._classList.has('claudian-tab-badges')).toBe(false);
    });
  });
});
