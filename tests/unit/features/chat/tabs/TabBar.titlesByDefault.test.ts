import { createMockEl } from '@test/helpers/mockElement';

import { TabBar, type TabBarCallbacks, type TabBarOptions } from '@/features/chat/tabs/TabBar';
import type { TabBarItem } from '@/features/chat/tabs/types';

function cbs(): TabBarCallbacks {
  return { onTabClick: jest.fn(), onTabClose: jest.fn(), onNewTab: jest.fn() };
}
function item(o: Partial<TabBarItem> = {}): TabBarItem {
  return { id: 'tab-1', index: 1, title: 'My Chat', providerId: 'claude',
    isActive: true, isStreaming: false, needsAttention: false, canClose: true, ...o };
}
const dbl = () => ({ preventDefault: jest.fn(), stopPropagation: jest.fn() });

describe('TabBar — titles by default', () => {
  it('shows the title by default when the option is on', () => {
    const el = createMockEl();
    const opts: TabBarOptions = { getShowTitlesByDefault: () => true };
    const bar = new TabBar(el, cbs(), opts);
    bar.update([item()]);
    expect(el._children[0].textContent).toBe('My Chat');
  });

  it('double-click toggles title <-> number both ways (title default)', () => {
    const el = createMockEl();
    const bar = new TabBar(el, cbs(), { getShowTitlesByDefault: () => true });
    bar.update([item()]);
    const b = el._children[0];
    expect(b.textContent).toBe('My Chat');
    b.dispatchEvent('dblclick', dbl());
    expect(b.textContent).toBe('1');
    b.dispatchEvent('dblclick', dbl());
    expect(b.textContent).toBe('My Chat');
  });

  it('placeholder tabs (New Chat) always show the number even when titles default on', () => {
    const el = createMockEl();
    const bar = new TabBar(el, cbs(), { getShowTitlesByDefault: () => true });
    bar.update([item({ title: 'New Chat' })]);
    expect(el._children[0].textContent).toBe('1');
  });
});

describe('TabBar — redundant rebuild guard (double-click stability)', () => {
  it('does NOT recreate badge nodes when items are unchanged', () => {
    const el = createMockEl();
    const bar = new TabBar(el, cbs());
    bar.update([item()]);
    const firstNode = el._children[0];
    // Same items again (e.g. clicking the already-active tab -> updateTabBar)
    bar.update([item()]);
    expect(el._children[0]).toBe(firstNode); // node identity preserved -> dblclick survives
  });

  it('rebuilds when an item actually changes', () => {
    const el = createMockEl();
    const bar = new TabBar(el, cbs());
    bar.update([item({ isActive: false })]);
    const firstNode = el._children[0];
    bar.update([item({ isActive: true })]);
    expect(el._children[0]).not.toBe(firstNode);
  });

  it('invalidate() forces a rebuild even with identical items', () => {
    const el = createMockEl();
    const bar = new TabBar(el, cbs());
    bar.update([item()]);
    const firstNode = el._children[0];
    bar.invalidate();
    bar.update([item()]);
    expect(el._children[0]).not.toBe(firstNode);
  });

  it('toggle survives a subsequent no-op update (unchanged items)', () => {
    const el = createMockEl();
    const bar = new TabBar(el, cbs(), { getShowTitlesByDefault: () => true });
    bar.update([item()]);
    el._children[0].dispatchEvent('dblclick', dbl()); // -> number
    expect(el._children[0].textContent).toBe('1');
    bar.update([item()]); // no-op, must not revert
    expect(el._children[0].textContent).toBe('1');
  });
});
