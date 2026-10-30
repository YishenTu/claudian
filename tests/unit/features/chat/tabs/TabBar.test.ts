import { createMockEl } from '@test/helpers/MockElement';

import type { TabBarItem } from '@/features/chat/tabs/ChatTab';
import { TabBar, type TabBarCallbacks } from '@/features/chat/tabs/TabBar';

// Helper to create mock callbacks
function createMockCallbacks(): TabBarCallbacks {
  return {
    onTabClick: vi.fn(),
    onTabClose: vi.fn(),
    onTabLabelChange: vi.fn(),
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
  describe('badge rendering', () => {

    it('does not expose a provider-specific tab styling hook', () => {
      const containerEl = createMockEl();
      const callbacks = createMockCallbacks();
      const tabBar = new TabBar(containerEl, callbacks);

      tabBar.update([createTabBarItem()]);

      expect(containerEl._children[0].getAttribute('data-provider')).toBeNull();
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
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      });

      expect(containerEl._children[0].textContent).toBe('ABCDEFGHIJKLMNOPQRSTUVWXYZ012...');
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

});
