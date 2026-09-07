import { createMockEl } from '@test/helpers/MockElement';

import { TabBar, type TabBarCallbacks } from '@/features/chat/tabs/TabBar';
import type { TabBarItem } from '@/features/chat/tabs/types';

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
    isWorking: false,
    attention: null,
    canClose: true,
    ...overrides,
  };
}

describe('TabBar', () => {
  describe('constructor', () => {
    it('should add tab badges class to container', () => {
      const containerEl = createMockEl();
      const callbacks = createMockCallbacks();

      new TabBar(containerEl, callbacks);

      expect(containerEl._classList.has('claudian-tab-badges')).toBe(true);
    });
  });

  describe('update', () => {
    it('should clear existing badges before rendering', () => {
      const containerEl = createMockEl();
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
      const containerEl = createMockEl();
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
      const containerEl = createMockEl();
      const callbacks = createMockCallbacks();
      const tabBar = new TabBar(containerEl, callbacks);

      tabBar.update([]);

      expect(containerEl._children.length).toBe(0);
    });
  });

  describe('badge rendering', () => {
    it('should display index number as text', () => {
      const containerEl = createMockEl();
      const callbacks = createMockCallbacks();
      const tabBar = new TabBar(containerEl, callbacks);

      tabBar.update([createTabBarItem({ index: 5 })]);

      expect(containerEl._children[0].textContent).toBe('5');
    });

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
      const callbacks = createMockCallbacks();
      const tabBar = new TabBar(containerEl, callbacks);

      tabBar.update([createTabBarItem({ index: 2, title: 'My Conversation' })]);

      const badge = containerEl._children[0];
      const event = { preventDefault: jest.fn(), stopPropagation: jest.fn() };

      badge.dispatchEvent('dblclick', event);

      expect(badge.textContent).toBe('My Conversation');
      expect(badge.hasClass('claudian-tab-badge-expanded')).toBe(true);
      expect(badge.getAttribute('data-title-expanded')).toBe('true');
      expect(event.preventDefault).toHaveBeenCalled();
      expect(event.stopPropagation).toHaveBeenCalled();

      badge.dispatchEvent('dblclick', { preventDefault: jest.fn(), stopPropagation: jest.fn() });

      expect(badge.textContent).toBe('2');
      expect(badge.hasClass('claudian-tab-badge-expanded')).toBe(false);
      expect(badge.getAttribute('data-title-expanded')).toBe('false');
    });

    it('should notify when title expansion state changes', () => {
      const containerEl = createMockEl();
      const callbacks = {
        ...createMockCallbacks(),
        onTitleExpansionChanged: jest.fn(),
      };
      const tabBar = new TabBar(containerEl, callbacks);

      tabBar.update([createTabBarItem({ id: 'tab-2', index: 2, title: 'My Conversation' })]);

      const badge = containerEl._children[0];
      badge.dispatchEvent('dblclick', { preventDefault: jest.fn(), stopPropagation: jest.fn() });
      badge.dispatchEvent('dblclick', { preventDefault: jest.fn(), stopPropagation: jest.fn() });

      expect(callbacks.onTitleExpansionChanged).toHaveBeenNthCalledWith(1, ['tab-2']);
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
      expect(containerEl._children[0].textContent.endsWith('...')).toBe(true);
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
    it('should apply idle class for inactive tab', () => {
      const containerEl = createMockEl();
      const callbacks = createMockCallbacks();
      const tabBar = new TabBar(containerEl, callbacks);

      tabBar.update([createTabBarItem({ isActive: false, isWorking: false, attention: null })]);

      expect(containerEl._children[0]._classList.has('claudian-tab-badge-idle')).toBe(true);
    });

    it('should apply active class for active tab', () => {
      const containerEl = createMockEl();
      const callbacks = createMockCallbacks();
      const tabBar = new TabBar(containerEl, callbacks);

      tabBar.update([createTabBarItem({ isActive: true })]);

      expect(containerEl._children[0]._classList.has('claudian-tab-badge-active')).toBe(true);
    });

    it('should apply streaming class for streaming tab', () => {
      const containerEl = createMockEl();
      const callbacks = createMockCallbacks();
      const tabBar = new TabBar(containerEl, callbacks);

      tabBar.update([createTabBarItem({ isWorking: true })]);

      expect(containerEl._children[0]._classList.has('claudian-tab-badge-streaming')).toBe(true);
    });

    it('should apply review class for a completed turn awaiting review', () => {
      const containerEl = createMockEl();
      const callbacks = createMockCallbacks();
      const tabBar = new TabBar(containerEl, callbacks);

      tabBar.update([createTabBarItem({
        attention: { kind: 'review', outcome: 'completed', since: 1 },
      })]);

      expect(containerEl._children[0]._classList.has('claudian-tab-badge-review')).toBe(true);
      expect(containerEl._children[0]._classList.has('claudian-tab-badge-action-required')).toBe(false);
    });

    it('should apply error-review class for a failed turn awaiting review', () => {
      const containerEl = createMockEl();
      const callbacks = createMockCallbacks();
      const tabBar = new TabBar(containerEl, callbacks);

      tabBar.update([createTabBarItem({
        attention: { kind: 'review', outcome: 'error', since: 1 },
      })]);

      expect(containerEl._children[0]._classList.has('claudian-tab-badge-review-error')).toBe(true);
      expect(containerEl._children[0]._classList.has('claudian-tab-badge-review')).toBe(false);
    });

    it('should apply action-required class for a pending interaction', () => {
      const containerEl = createMockEl();
      const callbacks = createMockCallbacks();
      const tabBar = new TabBar(containerEl, callbacks);

      tabBar.update([createTabBarItem({
        attention: { kind: 'action-required', since: 1 },
      })]);

      expect(containerEl._children[0]._classList.has('claudian-tab-badge-action-required')).toBe(true);
      expect(containerEl._children[0]._classList.has('claudian-tab-badge-review')).toBe(false);
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
      [createTabBarItem(), 'idle'],
      [createTabBarItem({ isWorking: true }), 'working'],
      [createTabBarItem({ attention: { kind: 'review', outcome: 'completed', since: 1 } }), 'finished, ready to review'],
      [createTabBarItem({ attention: { kind: 'review', outcome: 'error', since: 1 } }), 'stopped with an error, ready to review'],
      [createTabBarItem({ attention: { kind: 'action-required', since: 1 } }), 'needs your input'],
    ] as const)('should expose the color state in the accessible label', (item, status) => {
      const containerEl = createMockEl();
      const callbacks = createMockCallbacks();
      const tabBar = new TabBar(containerEl, callbacks);

      tabBar.update([item]);

      expect(containerEl._children[0].getAttribute('aria-label')).toBe(`Test Tab, ${status}`);
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

      tabBar.update([createTabBarItem(), createTabBarItem({ id: 'tab-2', index: 2 })]);
      expect(containerEl._children.length).toBe(2);

      tabBar.destroy();

      expect(containerEl._children.length).toBe(0);
    });

    it('should remove tab badges class from container', () => {
      const containerEl = createMockEl();
      const callbacks = createMockCallbacks();
      const tabBar = new TabBar(containerEl, callbacks);

      expect(containerEl._classList.has('claudian-tab-badges')).toBe(true);

      tabBar.destroy();

      expect(containerEl._classList.has('claudian-tab-badges')).toBe(false);
    });
  });
});
