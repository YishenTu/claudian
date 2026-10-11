/** @jest-environment jsdom */
import { fireEvent, within } from '@testing-library/dom';
import { axe } from 'jest-axe';
import { Menu } from 'obsidian';

import type { TabBarItem } from '@/features/chat/tabs/ChatTab';
import { TabBar } from '@/features/chat/tabs/TabBar';

type MockMenu = Menu & {
  items: Array<{ title: string; clickHandler: (() => void) | null }>;
  showAtMouseEvent: jest.Mock;
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
    onTabClick: jest.fn(),
    onTabClose: jest.fn(),
    onTabLabelChange: jest.fn(),
    onDisplayStateChanged: jest.fn(),
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

function menuTitles(menu: MockMenu): string[] {
  return menu.items.map(menuItem => menuItem.title);
}

beforeAll(() => {
  Object.assign(HTMLElement.prototype, {
    addClass(this: HTMLElement, ...names: string[]) { this.classList.add(...names); },
    removeClass(this: HTMLElement, ...names: string[]) { this.classList.remove(...names); },
    empty(this: HTMLElement) { this.replaceChildren(); },
    toggleClass(this: HTMLElement, name: string, enabled: boolean) { this.classList.toggle(name, enabled); },
  });
});

afterEach(() => {
  document.body.replaceChildren();
});

describe('TabBar tab labels', () => {
  it('renders badges as native buttons whose context menu replaces right-click close', async () => {
    const { container, callbacks, ui } = setup([
      item(),
      item({ id: 'tab-2', index: 2, title: 'Pinned session', canClose: false }),
    ]);

    const closeable = ui.getByRole('button', { name: 'Refactor ACP session restore, idle' });
    expect(closeable.getAttribute('type')).toBe('button');
    expect(await axe(container)).toHaveNoViolations();

    const menu = openMenu(closeable);
    expect(callbacks.onTabClose).not.toHaveBeenCalled();
    expect(menuTitles(menu)).toEqual(['Rename tab…', 'Show title', 'Close tab']);
    chooseMenuItem(menu, 'Close tab');
    expect(callbacks.onTabClose).toHaveBeenCalledWith('tab-1');

    const pinned = ui.getByRole('button', { name: 'Pinned session, idle' });
    expect(menuTitles(openMenu(pinned))).toEqual(['Rename tab…', 'Show title']);
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
    expect(second.className).toBe('claudian-tab-badge claudian-tab-badge-active');
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
    expect(menuTitles(menu)).toEqual(['Rename tab…', 'Reset tab name', 'Show name', 'Close tab']);
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
    jest.useFakeTimers();
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

      jest.runOnlyPendingTimers();
      expect(input.isConnected).toBe(false);
      expect(ui.getByRole('button', { name: /^Docs/ }).textContent).toBe('Docs');
      expect(callbacks.onTabLabelChange).toHaveBeenCalledTimes(1);
      expect(callbacks.onTabClick).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('toggles between number and expanded name from the menu or double click', () => {
    const { callbacks, tabBar, ui } = setup();

    chooseMenuItem(openMenu(ui.getByRole('button', { name: /^Refactor/ })), 'Show title');
    expect(ui.getByRole('button', { name: /^Refactor/ }).textContent).toBe('Refactor ACP session restore');
    expect(callbacks.onDisplayStateChanged).toHaveBeenCalledTimes(1);

    const menu = openMenu(ui.getByRole('button', { name: /^Refactor/ }));
    expect(menuTitles(menu)).toContain('Show number');
    chooseMenuItem(menu, 'Show number');
    expect(ui.getByRole('button', { name: /^Refactor/ }).textContent).toBe('1');

    tabBar.update([item({ label: 'ACP' }), item({ id: 'tab-2', index: 2, title: 'Second session' })]);
    const labelled = ui.getByRole('button', { name: /^ACP/ });
    expect(labelled.textContent).toBe('1');
    fireEvent.dblClick(labelled);
    expect(labelled.textContent).toBe('ACP');
    expect(tabBar.getExpandedTitleTabIds()).toEqual(['tab-1']);
    fireEvent.dblClick(labelled);
    expect(labelled.textContent).toBe('1');
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
