/** @vitest-environment jsdom */
import { axe } from '@test/helpers/accessibility';
import { firePointer } from '@test/helpers/dom/pointer';
import { testDate } from '@test/helpers/testClock';
import { createEvent, fireEvent, within } from '@testing-library/dom';
import { Menu } from 'obsidian';
import type { Mock } from 'vitest';

import type { TabBarItem } from '@/features/chat/tabs/ChatTab';
import { TabBar } from '@/features/chat/tabs/TabBar';
import { setLocale } from '@/i18n/i18n';



type MockMenu = Menu & {
  items: Array<{ title: string; clickHandler: (() => void) | null }>;
  showAtMouseEvent: Mock;
};

function item(overrides: Partial<TabBarItem> = {}): TabBarItem {
  return {
    id: 'tab-1',
    index: 1,
    title: 'Refactor ACP session restore',
    isActive: false,
    isWorking: false,
    attention: null,
    canClose: true,
    ...overrides,
  };
}

function setup(items: TabBarItem[] = [item(), item({ id: 'tab-2', index: 2, title: 'Second session' })]) {
  const container = document.body.createDiv();
  const callbacks = {
    onTabClick: vi.fn(),
    onTabClose: vi.fn(),
    onTabLabelChange: vi.fn(),
    onTabMove: vi.fn(),
    onDisplayStateChanged: vi.fn(),
  };
  const tabBar = new TabBar(container, callbacks);
  tabBar.update(items);
  return { container, callbacks, tabBar, ui: within(container) };
}

function openMenu(badge: HTMLElement): MockMenu {
  (Menu as unknown as { instances: Menu[] }).instances.length = 0;
  fireEvent.contextMenu(badge);
  const instances = (Menu as unknown as { instances: MockMenu[] }).instances;
  expect(instances).toHaveLength(1);
  expect(instances[0].showAtMouseEvent).toHaveBeenCalled();
  return instances[0];
}

function chooseMenuItem(menu: MockMenu, title: string): void {
  const entry = menu.items.find(menuItem => menuItem.title === title);
  if (!entry?.clickHandler) throw new Error(`Missing menu item: ${title}`);
  entry.clickHandler();
}

/** Lays badges out 24px apart, since jsdom has no layout. */
function layOut(badges: HTMLElement[]): void {
  badges.forEach((badge, index) => {
    badge.getBoundingClientRect = () => DOMRect.fromRect({ x: index * 28, y: 0, width: 24, height: 24 });
  });
}

function threeItems(overrides: Partial<TabBarItem> = {}): TabBarItem[] {
  return [
    item(overrides),
    item({ id: 'tab-2', index: 2, title: 'Second session', ...overrides }),
    item({ id: 'tab-3', index: 3, title: 'Third session', ...overrides }),
  ];
}

function menuTitles(menu: MockMenu): string[] {
  return menu.items.map(menuItem => menuItem.title);
}

afterEach(() => {
  document.body.replaceChildren();
  setLocale('en');
});

describe('TabBar tab labels', () => {
  it('renders badges as native buttons whose context menu replaces right-click close', async () => {
    const { container, callbacks, ui } = setup([
      item(),
      item({ id: 'tab-2', index: 2, title: 'Pinned session', canClose: false }),
    ]);

    const closeable = ui.getByRole('button', { name: 'Refactor ACP session restore, idle' });
    expect(closeable.getAttribute('type')).toBe('button');
    expect(closeable.getAttribute('title')).toBeNull();
    expect(await axe(container)).toHaveNoViolations();

    const menu = openMenu(closeable);
    expect(callbacks.onTabClose).not.toHaveBeenCalled();
    expect(menuTitles(menu)).toEqual(['Rename tab…', 'Show title', 'Move right', 'Close tab']);
    chooseMenuItem(menu, 'Close tab');
    expect(callbacks.onTabClose).toHaveBeenCalledWith('tab-1');

    const pinned = ui.getByRole('button', { name: 'Pinned session, idle' });
    expect(menuTitles(openMenu(pinned))).toEqual(['Rename tab…', 'Show title', 'Move left']);
  });

  it('renders whole localized badge names for every status without translating titles or labels', () => {
    const since = testDate().getTime();
    const rows = [
      item({ title: 'working', isActive: true, isWorking: true, attention: { kind: 'action-required', since } }),
      item({ title: 'Archive', isWorking: true, attention: { kind: 'action-required', since } }),
      item({ title: 'working', isWorking: true, attention: { kind: 'review', outcome: 'error', since } }),
      item({ title: 'Archive', attention: { kind: 'review', outcome: 'error', since } }),
      item({ title: 'New Chat', attention: { kind: 'review', outcome: 'completed', since } }),
      item({ title: 'Archive' }),
      item({ title: 'Archive', label: '新建 · working', isActive: true }),
    ];
    const english = [
      'working, active',
      'Archive, needs your input',
      'working, working',
      'Archive, stopped with an error, ready to review',
      'New Chat, finished, ready to review',
      'Archive, idle',
      '新建 · working (Archive), active',
    ];
    const chinese = [
      'working，当前',
      'Archive，需要您输入',
      'working，工作中',
      'Archive，因错误而停止，可供查看',
      'New Chat，已完成，可供查看',
      'Archive，空闲',
      '新建 · working（Archive），当前',
    ];
    for (const [locale, names] of [['en', english], ['zh-CN', chinese], ['en', english]] as const) {
      setLocale(locale);
      const { tabBar, container, ui } = setup([]);
      try {
        for (const [index, row] of rows.entries()) {
          tabBar.update([row]);
          const badge = ui.getByRole('button', { name: names[index] });
          expect(badge.textContent).toBe('1');
          expect(badge.getAttribute('title')).toBeNull();
        }
      } finally {
        tabBar.destroy();
        container.remove();
      }
    }
  });

  it('renames, resets, toggles and closes through the localized menu', async () => {
    setLocale('zh-CN');
    const { container, callbacks, tabBar, ui } = setup([item({ title: 'New Chat' })]);
    try {
      const badge = ui.getByRole('button', { name: 'New Chat，空闲' });
      expect(badge.getAttribute('type')).toBe('button');
      const menu = openMenu(badge);
      expect(menuTitles(menu)).toEqual(['重命名标签页…', '显示标题', '关闭标签页']);
      chooseMenuItem(menu, '显示标题');
      expect(badge.textContent).toBe('New Chat');
      chooseMenuItem(openMenu(badge), '显示编号');
      expect(badge.textContent).toBe('1');
      chooseMenuItem(openMenu(badge), '重命名标签页…');
      const input = ui.getByRole<HTMLInputElement>('textbox', { name: '标签页名称' });
      expect(input.value).toBe('');
      expect(input.placeholder).toBe('New Chat');
      expect(document.activeElement).toBe(input);
      expect(await axe(container)).toHaveNoViolations();

      fireEvent.input(input, { target: { value: '  Archive / 研究  ' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(callbacks.onTabLabelChange).toHaveBeenCalledWith('tab-1', 'Archive / 研究');
      const named = ui.getByRole('button', { name: 'Archive / 研究（New Chat），空闲' });
      expect(document.activeElement).toBe(named);
      expect(named.textContent).toBe('Archive / 研究');
      expect(named.getAttribute('data-title-expanded')).toBe('true');
      chooseMenuItem(openMenu(named), '显示编号');
      const namedMenu = openMenu(named);
      expect(menuTitles(namedMenu)).toEqual(['重命名标签页…', '重置标签页名称', '显示名称', '关闭标签页']);
      chooseMenuItem(namedMenu, '显示名称');
      expect(named.textContent).toBe('Archive / 研究');
      chooseMenuItem(openMenu(named), '重置标签页名称');
      expect(callbacks.onTabLabelChange).toHaveBeenLastCalledWith('tab-1', null);
      chooseMenuItem(openMenu(named), '关闭标签页');
      expect(callbacks.onTabClose).toHaveBeenCalledExactlyOnceWith('tab-1');
    } finally {
      tabBar.destroy();
      (Menu as unknown as { instances: Menu[] }).instances.length = 0;
    }
  });

  it('closes closeable tabs on middle click only', () => {
    const { callbacks, ui } = setup([
      item(),
      item({ id: 'tab-2', index: 2, title: 'Pinned session', canClose: false }),
    ]);

    fireEvent(ui.getByRole('button', { name: 'Pinned session, idle' }), new MouseEvent('auxclick', { bubbles: true, button: 1 }));
    fireEvent(ui.getByRole('button', { name: /^Refactor/ }), new MouseEvent('auxclick', { bubbles: true, button: 2 }));
    expect(callbacks.onTabClose).not.toHaveBeenCalled();

    fireEvent(ui.getByRole('button', { name: /^Refactor/ }), new MouseEvent('auxclick', { bubbles: true, button: 1 }));
    expect(callbacks.onTabClose).toHaveBeenCalledWith('tab-1');
  });

  it('reconciles badges by tab id, reordering, restyling, and removing in place until destroyed', () => {
    const { container, tabBar, ui } = setup();
    const first = ui.getByRole('button', { name: /^Refactor/ });
    const second = ui.getByRole('button', { name: /^Second/ });
    const names = () => ui.getAllByRole('button').map(badge => badge.getAttribute('aria-label'));

    tabBar.update([
      item({ id: 'tab-2', index: 1, title: 'Second session', isActive: true }),
      item({ id: 'tab-3', index: 2, title: 'Third session', isWorking: true }),
      item({ index: 3 }),
    ]);
    expect(names()).toEqual([
      'Second session, active', 'Third session, working', 'Refactor ACP session restore, idle',
    ]);
    expect(ui.getByRole('button', { name: /^Second/ })).toBe(second);
    expect(ui.getByRole('button', { name: /^Refactor/ })).toBe(first);
    expect(second.classList.contains('claudian-tab-badge-active')).toBe(true);
    expect(first.textContent).toBe('3');

    tabBar.update([item({ index: 1 })]);
    expect(names()).toEqual(['Refactor ACP session restore, idle']);
    expect(second.isConnected).toBe(false);
    tabBar.update([]);
    expect(container.children).toHaveLength(0);

    tabBar.update([item()]);
    tabBar.destroy();
    expect(container.children).toHaveLength(0);
    expect(container.classList.contains('claudian-tab-badges')).toBe(false);
  });

  it('renames a tab inline without changing its session title', async () => {
    const { container, callbacks, tabBar, ui } = setup();

    chooseMenuItem(openMenu(ui.getByRole('button', { name: /^Refactor/ })), 'Rename tab…');
    const input = ui.getByRole('textbox', { name: 'Tab name' }) as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe('');
    expect(input.placeholder).toBe('Refactor ACP session restore');
    expect(await axe(container)).toHaveNoViolations();

    fireEvent.input(input, { target: { value: '  ACP restore  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(ui.queryByRole('textbox')).toBeNull();
    expect(callbacks.onTabLabelChange).toHaveBeenCalledWith('tab-1', 'ACP restore');
    const badge = ui.getByRole('button', { name: 'ACP restore (Refactor ACP session restore), idle' });
    expect(badge.textContent).toBe('ACP restore');
    expect(document.activeElement).toBe(badge);
    expect(tabBar.getExpandedTitleTabIds()).toEqual(['tab-1']);
    expect(callbacks.onDisplayStateChanged).toHaveBeenCalledTimes(1);

    // The tab owns the label and republishes it; the refresh keeps keyboard focus on the badge.
    tabBar.update([
      item({ label: 'ACP restore', title: 'A brand new session', isActive: true }),
      item({ id: 'tab-2', index: 2, title: 'Second session' }),
    ]);
    const refreshed = ui.getByRole('button', { name: 'ACP restore (A brand new session), active' });
    expect(refreshed.textContent).toBe('ACP restore');
    expect(document.activeElement).toBe(refreshed);
  });

  it('keeps an in-progress rename focused while the tab bar refreshes', () => {
    const { tabBar, ui } = setup();

    chooseMenuItem(openMenu(ui.getByRole('button', { name: /^Second/ })), 'Rename tab…');
    const input = ui.getByRole('textbox', { name: 'Tab name' }) as HTMLInputElement;
    fireEvent.input(input, { target: { value: 'Draft' } });

    tabBar.update([
      item({ isWorking: true }),
      item({ id: 'tab-2', index: 2, title: 'Second session' }),
      item({ id: 'tab-3', index: 3, title: 'Third session' }),
    ]);

    expect(ui.getByRole('textbox', { name: 'Tab name' })).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe('Draft');
    expect(ui.getByRole('button', { name: /^Refactor.*working$/ })).toBeTruthy();
    const editor = input.parentElement!;
    const order = Array.from(editor.parentElement!.children).map(el => (el === editor ? input.value : el.textContent));
    expect(order).toEqual(['1', 'Draft', '3']);
  });

  it('cancels with Escape, commits on blur, and clears with an empty name or reset', () => {
    const { callbacks, tabBar, ui } = setup();
    const rename = (name: RegExp) => {
      chooseMenuItem(openMenu(ui.getByRole('button', { name })), 'Rename tab…');
      return ui.getByRole('textbox', { name: 'Tab name' }) as HTMLInputElement;
    };

    let input = rename(/^Refactor/);
    fireEvent.input(input, { target: { value: 'Discarded' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(callbacks.onTabLabelChange).not.toHaveBeenCalled();
    expect(callbacks.onDisplayStateChanged).not.toHaveBeenCalled();

    input = rename(/^Refactor/);
    fireEvent.input(input, { target: { value: 'x'.repeat(40) } });
    // Focus leaving without a pointer press (keyboard, app switch) swaps the badge back at once.
    fireEvent.blur(input);
    expect(callbacks.onTabLabelChange).toHaveBeenLastCalledWith('tab-1', 'x'.repeat(32));
    expect(input.isConnected).toBe(false);
    expect(ui.getByRole('button', { name: /^x+ \(/ }).textContent).toBe('x'.repeat(32));

    tabBar.update([
      item({ label: 'x'.repeat(32) }),
      item({ id: 'tab-2', index: 2, title: 'Second session' }),
    ]);
    input = rename(/^x+ \(/);
    expect(input.value).toBe('x'.repeat(32));
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(callbacks.onTabLabelChange).toHaveBeenCalledTimes(1);
    input = rename(/^x+ \(/);
    fireEvent.input(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(callbacks.onTabLabelChange).toHaveBeenLastCalledWith('tab-1', null);

    tabBar.update([item(), item({ id: 'tab-2', index: 2, title: 'Second session', label: 'Docs' })]);
    expect(ui.getByRole('button', { name: /^Docs/ }).textContent).toBe('2');
    const menu = openMenu(ui.getByRole('button', { name: /^Docs/ }));
    expect(menuTitles(menu)).toEqual(['Rename tab…', 'Reset tab name', 'Show name', 'Move left', 'Close tab']);
    chooseMenuItem(menu, 'Reset tab name');
    expect(callbacks.onTabLabelChange).toHaveBeenLastCalledWith('tab-2', null);
  });

  it('lets the view cancel an open rename with Escape before anything else', () => {
    const { callbacks, tabBar, ui } = setup();

    expect(tabBar.handleEscape()).toBe(false);
    chooseMenuItem(openMenu(ui.getByRole('button', { name: /^Refactor/ })), 'Rename tab…');
    fireEvent.input(ui.getByRole('textbox', { name: 'Tab name' }), { target: { value: 'Discarded' } });

    expect(tabBar.handleEscape()).toBe(true);
    expect(ui.queryByRole('textbox')).toBeNull();
    expect(document.activeElement).toBe(ui.getByRole('button', { name: 'Refactor ACP session restore, idle' }));
    expect(callbacks.onTabLabelChange).not.toHaveBeenCalled();
    expect(tabBar.handleEscape()).toBe(false);
  });

  it('keeps the rename editor in place until a click whose mousedown commits it lands', () => {
    const tabs = [item(), item({ id: 'tab-2', index: 2, title: 'Second session' })];
    const { callbacks, tabBar, ui } = setup(tabs);
    // Like the view, the owner republishes the bar as soon as the label changes.
    callbacks.onTabLabelChange.mockImplementation((tabId: string, label: string | null) => {
      tabBar.update(tabs.map(tab => (tab.id === tabId && label ? { ...tab, label } : tab)));
    });
    chooseMenuItem(openMenu(ui.getByRole('button', { name: /^Refactor/ })), 'Rename tab…');
    const input = ui.getByRole('textbox', { name: 'Tab name' });
    fireEvent.input(input, { target: { value: 'Docs' } });

    // The editor is wider than the badge replacing it; swapping before the click lands would
    // shift the clicked badge out from under the pointer, so the browser would not fire click.
    const target = ui.getByRole('button', { name: /^Second/ });
    const editorPresent: Record<string, boolean> = {};
    target.addEventListener('mouseup', () => { editorPresent.mouseup = input.isConnected; });
    callbacks.onTabClick.mockImplementation(() => { editorPresent.click = input.isConnected; });

    fireEvent.mouseDown(target);
    fireEvent.blur(input);
    // The label commits with the press; only the swap waits for the click.
    expect(callbacks.onTabLabelChange).toHaveBeenCalledWith('tab-1', 'Docs');
    expect(ui.getByRole('button', { name: /^Second/ })).toBe(target);

    fireEvent.mouseUp(target);
    fireEvent.click(target);
    expect(editorPresent).toEqual({ mouseup: true, click: true });
    expect(callbacks.onTabClick).toHaveBeenCalledWith('tab-2');
    expect(input.isConnected).toBe(false);
    const names = ui.getAllByRole('button').map(badge => badge.textContent);
    expect(names).toEqual(['Docs', '2']);
  });

  it('swaps a held rename editor back after a press that ends without a click', () => {
    vi.useFakeTimers();
    try {
      const { callbacks, tabBar, ui } = setup();
      chooseMenuItem(openMenu(ui.getByRole('button', { name: /^Refactor/ })), 'Rename tab…');
      const input = ui.getByRole('textbox', { name: 'Tab name' });
      fireEvent.input(input, { target: { value: 'Docs' } });

      // The pointer is dragged off the badge and released elsewhere, so no click follows.
      fireEvent.mouseDown(ui.getByRole('button', { name: /^Second/ }));
      fireEvent.blur(input);
      fireEvent.mouseUp(document.body);
      expect(callbacks.onTabLabelChange).toHaveBeenCalledWith('tab-1', 'Docs');
      expect(input.isConnected).toBe(true);
      expect(tabBar.handleEscape()).toBe(false);

      vi.runOnlyPendingTimers();
      expect(input.isConnected).toBe(false);
      expect(ui.getByRole('button', { name: /^Docs/ }).textContent).toBe('Docs');
      expect(callbacks.onTabLabelChange).toHaveBeenCalledTimes(1);
      expect(callbacks.onTabClick).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('toggles between number and expanded name from the menu or double click', () => {
    const { callbacks, tabBar, ui } = setup();

    chooseMenuItem(openMenu(ui.getByRole('button', { name: /^Refactor/ })), 'Show title');
    expect(ui.getByRole('button', { name: /^Refactor/ }).textContent).toBe('Refactor ACP session restore');
    expect(callbacks.onDisplayStateChanged).toHaveBeenCalledTimes(1);
    tabBar.update([item({ title: 'Refactor renamed session' }), item({ id: 'tab-2', index: 2, title: 'Second session' })]);
    expect(ui.getByRole('button', { name: /^Refactor/ }).textContent).toBe('Refactor renamed session');
    expect(ui.getByRole('button', { name: /^Refactor/ }).classList.contains('claudian-tab-badge-expanded')).toBe(true);

    const menu = openMenu(ui.getByRole('button', { name: /^Refactor/ }));
    expect(menuTitles(menu)).toContain('Show number');
    chooseMenuItem(menu, 'Show number');
    expect(ui.getByRole('button', { name: /^Refactor/ }).textContent).toBe('1');

    tabBar.update([item({ label: 'ACP' }), item({ id: 'tab-2', index: 2, title: 'Second session' })]);
    const labelled = ui.getByRole('button', { name: /^ACP/ });
    expect(labelled.textContent).toBe('1');
    const bubbled = vi.fn();
    labelled.parentElement!.addEventListener('dblclick', bubbled);
    const expand = createEvent.dblClick(labelled);
    fireEvent(labelled, expand);
    expect(expand.defaultPrevented).toBe(true);
    expect(bubbled).not.toHaveBeenCalled();
    expect(labelled.textContent).toBe('ACP');
    expect(labelled.classList.contains('claudian-tab-badge-expanded')).toBe(true);
    expect(labelled.getAttribute('data-title-expanded')).toBe('true');
    expect(callbacks.onDisplayStateChanged).toHaveBeenCalledTimes(3);
    expect(tabBar.getExpandedTitleTabIds()).toEqual(['tab-1']);
    fireEvent.dblClick(labelled);
    expect(labelled.textContent).toBe('1');
    expect(labelled.classList.contains('claudian-tab-badge-expanded')).toBe(false);
    expect(labelled.getAttribute('data-title-expanded')).toBe('false');
    expect(tabBar.getExpandedTitleTabIds()).toEqual([]);
    expect(callbacks.onDisplayStateChanged).toHaveBeenCalledTimes(4);
  });

  it('moves a tab one position from the menu, emitting the tab it moves before', () => {
    const { callbacks, ui } = setup([
      item(),
      item({ id: 'tab-2', index: 2, title: 'Second session' }),
      item({ id: 'tab-3', index: 3, title: 'Third session' }),
    ]);
    const middle = ui.getByRole('button', { name: /^Second/ });

    chooseMenuItem(openMenu(middle), 'Move left');
    expect(callbacks.onTabMove).toHaveBeenLastCalledWith('tab-2', 'tab-1');
    chooseMenuItem(openMenu(middle), 'Move right');
    expect(callbacks.onTabMove).toHaveBeenLastCalledWith('tab-2', null);
    chooseMenuItem(openMenu(ui.getByRole('button', { name: /^Refactor/ })), 'Move right');
    expect(callbacks.onTabMove).toHaveBeenLastCalledWith('tab-1', 'tab-3');
  });

  it('starts renaming the requested tab from a command', () => {
    const { tabBar, ui } = setup();

    expect(tabBar.beginRename('missing-tab')).toBe(false);
    expect(tabBar.beginRename('tab-2')).toBe(true);

    const input = ui.getByRole('textbox', { name: 'Tab name' }) as HTMLInputElement;
    expect(input.placeholder).toBe('Second session');
    expect(document.activeElement).toBe(input);
  });
});

describe('TabBar live sorting', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); });
  // A release's click swallow ends on a timer; run it so it cannot reach the next test's clicks.
  afterEach(async () => {
    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
  });

  it('slides the other tabs aside while a tab is dragged, holding refreshes until the drop', async () => {
    const { callbacks, tabBar, ui } = setup(threeItems());
    const [first, second, third] = ui.getAllByRole('button');
    layOut([first, second, third]);
    const offsets = () => [first, second, third].map(badge => badge.style.transform);

    firePointer('pointerDown', first, 0, 10);
    firePointer('pointerMove', document, 0, 40);
    expect(offsets()).toEqual(['translateX(30px)', 'translateX(-28px)', '']);
    // A streaming refresh mid-drag waits, so the badges under the pointer stay put.
    tabBar.update(threeItems({ isWorking: true }));
    expect(third.classList.contains('claudian-tab-badge-streaming')).toBe(false);
    firePointer('pointerMove', document, 0, 90);
    expect(offsets()).toEqual(['translateX(56px)', 'translateX(-28px)', 'translateX(-28px)']);
    firePointer('pointerUp', document, 0, 90);
    fireEvent.click(first);

    expect(callbacks.onTabMove).toHaveBeenCalledExactlyOnceWith('tab-1', null);
    expect(callbacks.onTabClick).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(third.classList.contains('claudian-tab-badge-streaming')).toBe(true);
    expect(offsets()).toEqual(['', '', '']);
    // Only the release's own click is swallowed.
    fireEvent.click(first);
    expect(callbacks.onTabClick).toHaveBeenCalledExactlyOnceWith('tab-1');
  });

  it('moves a tab before the one it is dragged past toward the start', async () => {
    const { callbacks, ui } = setup(threeItems());
    const [first, second, third] = ui.getAllByRole('button');
    layOut([first, second, third]);

    firePointer('pointerDown', third, 0, 60);
    firePointer('pointerMove', document, 0, 46);
    expect([first, second, third].map(badge => badge.style.transform)).toEqual(['', 'translateX(28px)', 'translateX(-14px)']);
    firePointer('pointerUp', document, 0, 46);
    expect(callbacks.onTabMove).toHaveBeenCalledExactlyOnceWith('tab-3', 'tab-2');
    fireEvent.click(third);
    expect(callbacks.onTabClick).not.toHaveBeenCalled();
  });

  it('lifts a pressed tab whose badge the bar refreshed before the drag began', () => {
    const { callbacks, tabBar, ui } = setup(threeItems());
    const [first, second, third] = ui.getAllByRole('button');
    layOut([first, second, third]);

    firePointer('pointerDown', first, 0, 10);
    tabBar.update(threeItems({ isWorking: true }));
    firePointer('pointerMove', document, 0, 40);
    expect([first, second, third].map(badge => badge.style.transform)).toEqual(['translateX(30px)', 'translateX(-28px)', '']);
    firePointer('pointerUp', document, 0, 40);
    expect(callbacks.onTabMove).toHaveBeenCalledExactlyOnceWith('tab-1', 'tab-3');
  });

  it('keeps clicks, Escape and renames free of drags', async () => {
    const { callbacks, tabBar, ui } = setup(threeItems());
    const [first, second, third] = ui.getAllByRole('button');
    layOut([first, second, third]);
    const offsets = () => [first, second, third].map(badge => badge.style.transform);

    // A press that barely moves is a click.
    firePointer('pointerDown', second, 0, 30);
    firePointer('pointerMove', document, 0, 32);
    firePointer('pointerUp', document, 0, 32);
    fireEvent.click(second);
    expect(callbacks.onTabClick).toHaveBeenCalledExactlyOnceWith('tab-2');

    // Escape cancels a lifted drag before the view's Escape chain can reach the turn.
    firePointer('pointerDown', first, 0, 10);
    firePointer('pointerMove', document, 0, 40);
    expect(offsets()).not.toEqual(['', '', '']);
    expect(tabBar.handleEscape()).toBe(true);
    expect(offsets()).toEqual(['', '', '']);
    firePointer('pointerUp', document, 0, 40);
    fireEvent.click(first);
    expect(callbacks.onTabClick).toHaveBeenCalledOnce();
    expect(tabBar.handleEscape()).toBe(false);
    await vi.advanceTimersByTimeAsync(0);

    tabBar.beginRename('tab-2');
    firePointer('pointerDown', first, 0, 10);
    firePointer('pointerMove', document, 0, 70);
    firePointer('pointerUp', document, 0, 70);
    expect(offsets()).toEqual(['', '', '']);
    expect(callbacks.onTabMove).not.toHaveBeenCalled();
  });
});
