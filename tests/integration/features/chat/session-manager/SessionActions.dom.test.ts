/** @vitest-environment jsdom */

import { axe } from '@test/helpers/accessibility';
import { createSessionBrowserHost } from '@test/helpers/features/chat/SessionBrowserTestHarness';
import { testDate } from '@test/helpers/testClock';
import { fireEvent, waitFor, within } from '@testing-library/dom';
import { Menu, Notice } from 'obsidian';
import type { Mock } from 'vitest';

import type { ConversationMeta } from '@/core/types';
import { SessionActions } from '@/features/chat/session-manager/SessionActions';
import { SessionBrowser } from '@/features/chat/session-manager/SessionBrowser';
import type { HistoryConversationStatus } from '@/features/chat/session-manager/SessionStatusPresentation';
import { setLocale } from '@/i18n/i18n';





type MockMenu = {
  items: Array<{ title: string; disabled: boolean; clickHandler: (() => void) | null }>;
};

function lastMenu(): MockMenu {
  return (Menu as unknown as { instances: MockMenu[] }).instances.at(-1)!;
}

function session(id: string, title: string, extra: Partial<ConversationMeta> = {}): ConversationMeta {
  return {
    id, providerId: 'claude', title, messageCount: 1, preview: '',
    createdAt: testDate({ days: -3 }).getTime(), lastActivityAt: testDate({ days: -1 }).getTime(), ...extra,
  };
}

function selectedCount(container: HTMLElement): number {
  return within(container).queryAllByText('Selected').length;
}

const conversations = [
  session('alpha', 'Alpha session'),
  session('beta', 'Beta session'),
  session('gamma', 'Gamma session'),
  session('running', 'Running session'),
  session('pinned', 'Pinned session', { isPinned: true }),
  session('pinned-too', 'Second pinned session', { isPinned: true }),
];

async function renderList(options: {
  onSelectConversation?: Mock;
  onSetConversationsArchived?: Mock;
} = {}) {
  const { plugin, lifecycle } = await createSessionBrowserHost({ conversations: structuredClone(conversations) });
  const onSetConversationsPinned = vi.spyOn(lifecycle, 'setPinned');
  const onSetConversationsArchived = vi.spyOn(lifecycle, 'archive');
  const controller = new SessionBrowser({
    plugin,
    getCurrentConversationId: () => null,
    getTitleGenerationService: () => null,
    onListChanged: () => undefined,
  });
  onTestFinished(() => controller.dispose());
  const container = document.createElement('div');
  document.body.append(container);
  const onSelectConversation = options.onSelectConversation ?? vi.fn().mockResolvedValue(undefined);
  const render = (): void => controller.renderHistoryDropdown(container, {
    onSelectConversation,



    onRerender: render,
    showMetadataPopover: true,
    sessionActionMode: 'active',
    getConversationStatus: (id): HistoryConversationStatus => ({
      openState: 'closed',
      isRunning: id === 'running',
    }),
  });
  await render();
  const button = (name: string): HTMLElement => within(container).getByRole('button', {
    name: new RegExp(`^${name}`),
  });
  return {
    controller, container, button, onSelectConversation, onSetConversationsArchived, onSetConversationsPinned, render,
  };
}

describe('SessionActions selection menu', () => {
  afterEach(() => {
    document.body.replaceChildren();
    (Menu as unknown as { instances: MockMenu[] }).instances.length = 0;
  });

  it('skips running sessions in the selection', async () => {
    const { button, onSetConversationsArchived } = await renderList();

    fireEvent.click(button('Alpha session'), { altKey: true });
    fireEvent.click(button('Running session'), { altKey: true });
    fireEvent.contextMenu(button('Alpha session'));
    const menu = lastMenu();
    expect(menu.items.map(menuItem => menuItem.title)).toEqual(['Pin 2 sessions', 'Move 2 sessions to project…', 'Archive 1 session']);
    menu.items[2].clickHandler?.();

    expect(onSetConversationsArchived).toHaveBeenCalledWith(['alpha']);
  });

  it('pins the unpinned sessions in a mixed selection', async () => {
    const { container, button, onSetConversationsPinned } = await renderList();

    fireEvent.click(button('Alpha session'), { altKey: true });
    fireEvent.click(button('Pinned session'), { altKey: true });
    fireEvent.click(button('Running session'), { altKey: true });
    expect(selectedCount(container)).toBe(3);
    fireEvent.contextMenu(button('Alpha session'));
    const menu = lastMenu();
    expect(menu.items[0].title).toBe('Pin 2 sessions');
    menu.items[0].clickHandler?.();

    expect(onSetConversationsPinned).toHaveBeenCalledWith(['alpha', 'running'], true);
    expect(selectedCount(container)).toBe(0);
  });

  it('unpins the selection when every selected session is pinned', async () => {
    const { button, onSetConversationsPinned } = await renderList();

    fireEvent.click(button('Pinned session'), { altKey: true });
    fireEvent.click(button('Second pinned session'), { altKey: true });
    fireEvent.contextMenu(button('Pinned session'));
    const menu = lastMenu();
    expect(menu.items[0].title).toBe('Unpin 2 sessions');
    menu.items[0].clickHandler?.();

    expect(onSetConversationsPinned).toHaveBeenCalledWith(['pinned', 'pinned-too'], false);
  });
});

describe('SessionActions recency divider groups', () => {
  afterEach(() => { document.body.replaceChildren(); });

  async function render(
    groupByRecency: boolean,
    items: ConversationMeta[],
    extra: Partial<Parameters<SessionBrowser['renderHistoryDropdown']>[1]> & { archive?: (ids: readonly string[]) => Promise<void> } = {},
  ): Promise<HTMLElement> {
    const controller = new SessionBrowser({
      plugin: (await createSessionBrowserHost({ conversations: items, store: extra.archive ? { archiveConversationsIf: async ids => { await extra.archive?.(ids); return ids.length; } } : undefined })).plugin,
      getCurrentConversationId: () => null,
      getTitleGenerationService: () => null,
      onListChanged: () => undefined,
    });
    onTestFinished(() => controller.dispose());
  const container = document.createElement('div');
    document.body.append(container);
    controller.renderHistoryDropdown(container, {
      onSelectConversation: vi.fn().mockResolvedValue(undefined),
      showMetadataPopover: true,
      showPinnedSection: true,
      groupByRecency,
      ...extra,
    });
    return container;
  }

  /** Divider labels and session titles in document order. */
  const visibleSequence = (container: HTMLElement): string[] => within(container)
    .getAllByText(/^(Past week|Past 2 weeks|Past month|Older|.+ session)$/)
    .map(element => element.textContent ?? '');

  const recent = (id: string, days: number, extra: Partial<ConversationMeta> = {}): ConversationMeta => ({
    ...session(id, `${id} session`, extra),
    lastActivityAt: testDate({ days: -days }).getTime(),
  });

  it('labels the unpinned list by last activity without dividing pinned sessions', async () => {
    const container = await render(true, [
      recent('fresh', 2), recent('week', 10), recent('month', 20), recent('stale', 60),
      recent('pinned-stale', 60, { isPinned: true }),
    ]);
    expect(visibleSequence(container)).toEqual([
      'pinned-stale session',
      'Past week', 'fresh session', 'Past 2 weeks', 'week session',
      'Past month', 'month session', 'Older', 'stale session',
    ]);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('renders no dividers unless recency grouping is requested', async () => {
    const container = await render(false, [recent('fresh', 2), recent('stale', 60)]);

    expect(visibleSequence(container)).toEqual(['fresh session', 'stale session']);
  });

  it('opens a divider group menu from a focusable native button', async () => {
    const onSetConversationsArchived = vi.fn().mockResolvedValue(undefined);
    const container = await render(true, [recent('fresh', 2), recent('stale', 60)], {
      sessionActionMode: 'active',
      archive: onSetConversationsArchived,
    });
    const actions = within(container).getByRole('button', { name: 'Actions for Older' });

    expect(actions.tagName).toBe('BUTTON');
    expect(actions.getAttribute('type')).toBe('button');
    actions.focus();
    expect(actions.ownerDocument.activeElement).toBe(actions);
    expect(await axe(container)).toHaveNoViolations();

    fireEvent.click(actions);
    const menu = lastMenu() as MockMenu & { showAtPosition: Mock };
    // Under the button, in the window that shows it, which may be a popout.
    expect(menu.showAtPosition).toHaveBeenCalledWith(expect.anything(), actions.ownerDocument);
    expect(menu.items.map(item => item.title)).toEqual(['Archive all sessions']);
    menu.items[0].clickHandler?.();
    await waitFor(() => expect(onSetConversationsArchived).toHaveBeenCalledWith(['stale']));
  });

  it('archives every non-running session in a group from its divider menu', async () => {
    const onSetConversationsArchived = vi.fn().mockResolvedValue(undefined);
    const container = await render(true, [
      recent('fresh', 2), recent('stale', 60), recent('stale-running', 70), recent('ancient', 400),
    ], {
      sessionActionMode: 'active',
      archive: onSetConversationsArchived,
      getConversationStatus: (id: string): HistoryConversationStatus => ({
        openState: 'closed', isRunning: id === 'stale-running',
      }),
    });
    fireEvent.contextMenu(within(container).getByText('Older'));
    const menu = lastMenu();
    expect(menu.items.map(item => item.title)).toEqual(['Archive all sessions']);
    menu.items[0].clickHandler?.();

    await waitFor(() => expect(onSetConversationsArchived).toHaveBeenCalledWith(['stale', 'ancient']));
  });
});

describe('SessionActions archived bulk actions', () => {
  afterEach(() => {
    document.body.replaceChildren();
    (Menu as unknown as { instances: MockMenu[] }).instances.length = 0;
  });

  async function renderArchived() {
    const archived = [
      session('one', 'First archived', { isArchived: true }),
      session('two', 'Second archived', { isArchived: true }),
      session('three', 'Third archived', { isArchived: true }),
    ];
    const { plugin, lifecycle } = await createSessionBrowserHost({ conversations: archived });
    const onRestoreConversations = vi.spyOn(lifecycle, 'restore');
    const deleteConversation = vi.spyOn(lifecycle, 'delete');
    const controller = new SessionBrowser({
      plugin,
      getCurrentConversationId: () => null,
      getTitleGenerationService: () => null,
      onListChanged: () => undefined,
    });
    onTestFinished(() => controller.dispose());
  const container = document.createElement('div');
    document.body.append(container);
    const onRerender = vi.fn();
    controller.renderHistoryDropdown(container, {
      onSelectConversation: vi.fn().mockResolvedValue(undefined),


      onRerender,
      showMetadataPopover: true,
      showArchivedSection: true,
      sessionScope: 'archived',
      sessionActionMode: 'archived',
      allowConversationSelection: false,
    });
    const item = (title: string): HTMLElement => within(container).getByText(title);
    return { container, item, onRestoreConversations, onRerender, deleteConversation, archived };
  }

  it('restores the Option-clicked archived sessions in one batch', async () => {
    const { container, item, onRestoreConversations } = await renderArchived();

    fireEvent.click(item('First archived'), { altKey: true });
    fireEvent.keyDown(item('Third archived'), { key: 'Enter', altKey: true });
    expect(selectedCount(container)).toBe(2);
    expect(await axe(container)).toHaveNoViolations();

    fireEvent.contextMenu(item('Third archived'));
    const menu = lastMenu();
    expect(menu.items.map(menuItem => menuItem.title)).toEqual(['Restore 2 sessions', 'Delete 2 sessions']);
    menu.items[0].clickHandler?.();

    expect(onRestoreConversations).toHaveBeenCalledWith(['one', 'three']);
    expect(selectedCount(container)).toBe(0);
  });

  it.each([true, false])('deletes the selected archived sessions only after confirmation (%s)', async (confirmed) => {
    const { item, onRerender, deleteConversation, archived } = await renderArchived();
    const deletion = vi.spyOn(SessionActions.prototype, 'deleteSessions');
    onTestFinished(() => deletion.mockRestore());

    fireEvent.click(item('First archived'), { altKey: true });
    fireEvent.click(item('Second archived'), { altKey: true });
    fireEvent.contextMenu(item('First archived'));
    expect(lastMenu().items[1].title).toBe('Delete 2 sessions');
    lastMenu().items[1].clickHandler?.();
    const dialog = within(document.body).getByRole('dialog', { name: 'Confirm' });
    expect(dialog.textContent).toContain('Permanently delete 2 sessions?');
    fireEvent.click(within(dialog).getByRole('button', { name: confirmed ? 'Delete' : 'Cancel' }));
    await waitFor(() => expect(dialog.isConnected).toBe(false));
    await deletion.mock.results.at(-1)!.value;
    expect(deleteConversation.mock.calls).toEqual(confirmed ? [[['one', 'two']]] : []);
    expect(onRerender.mock.calls.length > 0).toBe(confirmed);
    expect(archived.map(record => record.id)).toEqual(confirmed ? ['three'] : ['one', 'two', 'three']);
  });

  it('offers restoring or deleting every archived session of a Linked content group', async () => {
    const archived = [
      session('plan-a', 'Plan draft', { isArchived: true, linkedContentPath: 'Projects/Plan.md' }),
      session('plan-b', 'Plan review', { isArchived: true, linkedContentPath: 'Projects/Plan.md' }),
      session('other', 'Other archived', { isArchived: true, linkedContentPath: 'Projects/Other.md' }),
    ];
    const { plugin, lifecycle } = await createSessionBrowserHost({ conversations: archived });
    const onRestoreConversations = vi.spyOn(lifecycle, 'restore');
    const deleteConversation = vi.spyOn(lifecycle, 'delete');
    const controller = new SessionBrowser({
      plugin,
      getCurrentConversationId: () => null,
      getTitleGenerationService: () => null,
      onListChanged: () => undefined,
    });
    onTestFinished(() => controller.dispose());
  const container = document.createElement('div');
    document.body.append(container);
    controller.renderHistoryDropdown(container, {
      onSelectConversation: vi.fn().mockResolvedValue(undefined),
      onSetLinkedContentPinned: vi.fn().mockResolvedValue(undefined),
      onStartLinkedContentConversation: vi.fn().mockResolvedValue(undefined),

      onRerender: vi.fn(),
      organization: 'linked-content',
      contentExists: () => true,
      contentIsNote: () => true,
      showArchivedSection: true,
      sessionScope: 'archived',
      sessionActionMode: 'archived',
      allowConversationSelection: false,
      searchQuery: 'draft',
    });

    expect(within(container).queryByRole('button', { name: /^New chat for/ })).toBeNull();
    fireEvent.contextMenu(within(container).getByText('Plan'));
    const menu = lastMenu();
    expect(menu.items.map(item => item.title)).toEqual(['Restore all sessions', 'Delete all sessions']);
    menu.items[0].clickHandler?.();
    expect(onRestoreConversations).toHaveBeenCalledWith(['plan-a', 'plan-b']);
    menu.items[1].clickHandler?.();
    const dialog = within(document.body).getByRole('dialog', { name: 'Confirm' });
    expect(dialog.textContent).toContain('Permanently delete 2 sessions?');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(deleteConversation).toHaveBeenCalled());
    expect(deleteConversation.mock.calls).toEqual([[['plan-a', 'plan-b']]]);
  });

  it('offers restoring or deleting every archived session under a date divider', async () => {
    const archived = [
      { ...session('fresh', 'Fresh archived', { isArchived: true }), lastActivityAt: testDate({ days: -2 }).getTime() },
      { ...session('stale', 'Stale archived', { isArchived: true }), lastActivityAt: testDate({ days: -60 }).getTime() },
      { ...session('ancient', 'Ancient archived', { isArchived: true }), lastActivityAt: testDate({ days: -400 }).getTime() },
    ];
    const { plugin, lifecycle } = await createSessionBrowserHost({ conversations: archived });
    const onRestoreConversations = vi.spyOn(lifecycle, 'restore');
    const deleteConversation = vi.spyOn(lifecycle, 'delete');
    const controller = new SessionBrowser({
      plugin,
      getCurrentConversationId: () => null,
      getTitleGenerationService: () => null,
      onListChanged: () => undefined,
    });
    onTestFinished(() => controller.dispose());
  const container = document.createElement('div');
    document.body.append(container);
    controller.renderHistoryDropdown(container, {
      onSelectConversation: vi.fn().mockResolvedValue(undefined),

      onRerender: vi.fn(),
      groupByRecency: true,
      showArchivedSection: true,
      sessionScope: 'archived',
      sessionActionMode: 'archived',
      allowConversationSelection: false,
    });

    fireEvent.contextMenu(within(container).getByText('Older'));
    const menu = lastMenu();
    expect(menu.items.map(item => item.title)).toEqual(['Restore all sessions', 'Delete all sessions']);
    menu.items[0].clickHandler?.();
    expect(onRestoreConversations).toHaveBeenCalledWith(['stale', 'ancient']);
    menu.items[1].clickHandler?.();
    fireEvent.click(within(within(document.body).getByRole('dialog', { name: 'Confirm' })).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(deleteConversation).toHaveBeenCalled());

    expect(deleteConversation.mock.calls).toEqual([[['stale', 'ancient']]]);
  });
});


describe('localized session actions through the history UI', () => {
  afterEach(() => {
    setLocale('en');
    vi.restoreAllMocks();
    document.body.replaceChildren();
    (Menu as unknown as { instances: MockMenu[] }).instances.length = 0;
  });

  async function renderLocalized(records: ConversationMeta[], options: Partial<Parameters<SessionBrowser['renderHistoryDropdown']>[1]> = {}, store?: NonNullable<Parameters<typeof createSessionBrowserHost>[0]>['store']) {
    setLocale('zh-CN');
    const { plugin, lifecycle } = await createSessionBrowserHost({ conversations: records, store });
    const container = document.body.createDiv();
    const browser = new SessionBrowser({ plugin, getCurrentConversationId: () => null, getTitleGenerationService: () => null, onListChanged: () => undefined });
    onTestFinished(() => browser.dispose());
    const onSelectConversation = vi.fn().mockResolvedValue(undefined);
    const onOpenConversationInNewTab = vi.fn().mockResolvedValue(undefined);
    const onAssignConversationToDevice = vi.fn().mockResolvedValue(undefined);
    const render = () => browser.renderHistoryDropdown(container, {
      onSelectConversation, onOpenConversationInNewTab, onAssignConversationToDevice,
      sessionActionMode: 'active', onRerender: render, ...options,
    });
    render();
    const row = (title: string) => within(container).getByText(title);
    const choose = (title: string) => {
      const item = lastMenu().items.find(item => item.title === title);
      expect(lastMenu().items.map(item => item.title)).toContain(title);
      item!.clickHandler?.();
    };
    return { container, browser, plugin, lifecycle, row, render, choose, onSelectConversation, onOpenConversationInNewTab, onAssignConversationToDevice };
  }

  it('localizes closed, open, current, legacy and archived menus while preserving native routing and copied IDs', async () => {
    const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    onTestFinished(() => { if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard); else Reflect.deleteProperty(navigator, 'clipboard'); });
    const records = [session('native:Archive/Created', 'Archive', { isLegacySession: true })];
    let status: HistoryConversationStatus = { openState: 'closed', isRunning: false };
    const ui = await renderLocalized(records, { getConversationStatus: () => status, showAttentionState: true });
    const openMenu = () => fireEvent.contextMenu(ui.row('Archive'));
    openMenu();
    expect(lastMenu().items.map(item => item.title)).toEqual([
      '在新标签页中打开', '在后台标签页中打开', '置顶', '标为未读', '重命名', '复制会话 ID', '移动到项目…', '归档',
    ]);
    ui.choose('在新标签页中打开');
    expect(ui.onOpenConversationInNewTab).toHaveBeenLastCalledWith('native:Archive/Created', true);
    openMenu(); ui.choose('在后台标签页中打开');
    expect(ui.onOpenConversationInNewTab).toHaveBeenLastCalledWith('native:Archive/Created', false);
    openMenu(); ui.choose('复制会话 ID');
    await waitFor(() => expect(Notice).toHaveBeenCalledWith('已复制会话 ID'));
    expect(writeText).toHaveBeenCalledWith('native:Archive/Created');
    status = { openState: 'open', isRunning: false }; ui.render(); openMenu();
    expect(lastMenu().items[0].title).toBe('切换到已打开的会话');
    ui.choose('切换到已打开的会话');
    expect(ui.onSelectConversation).toHaveBeenCalledWith('native:Archive/Created');
    status = { openState: 'current', isRunning: false }; ui.render(); openMenu();
    expect(lastMenu().items.map(item => item.title)).toEqual(['置顶', '标为未读', '重命名', '复制会话 ID', '移动到项目…', '归档']);
    // Legacy assignment is an inline action, with the native ID passed to its public port.
    fireEvent.click(within(ui.container).getByRole('button', { name: '分配给此设备' }));
    expect(ui.onAssignConversationToDevice).toHaveBeenCalledWith('native:Archive/Created');
    status = { openState: 'closed', isRunning: true }; ui.render();
    expect((within(ui.container).getByRole('button', { name: '无法归档正在运行的会话' }) as HTMLButtonElement).disabled).toBe(true);
    openMenu(); expect(lastMenu().items.at(-1)?.disabled).toBe(true);
    status = { openState: 'closed', isRunning: false, attention: { kind: 'review', outcome: 'completed', since: testDate().getTime() } }; ui.render(); openMenu();
    expect(lastMenu().items.map(item => item.title)).toContain('标为已读');
    const archived = await renderLocalized([session('native-archived', 'Created', { isArchived: true })], {
      sessionScope: 'archived', sessionActionMode: 'archived', allowConversationSelection: false,
    });
    fireEvent.contextMenu(archived.row('Created'));
    expect(lastMenu().items.map(item => item.title)).toEqual(['在新标签页中打开', '在后台标签页中打开', '恢复', '删除']);
    expect(await axe(ui.container)).toHaveNoViolations();
  });

  it('localizes filtered singular and plural bulk actions without changing pin/archive membership', async () => {
    const records = [session('native:a', 'Archive'), session('native:b', 'Created', { isPinned: true }), session('native:running', 'Native running')];
    const ui = await renderLocalized(records, { getConversationStatus: id => ({ openState: 'closed', isRunning: id === 'native:running' }) });
    fireEvent.click(ui.row('Archive'), { altKey: true });
    fireEvent.click(ui.row('Created'), { altKey: true });
    expect(within(ui.container).getAllByText('已选择')).toHaveLength(2);
    fireEvent.contextMenu(ui.row('Archive'));
    expect(lastMenu().items[0].title).toBe('置顶 1 个会话');
    ui.choose('置顶 1 个会话');
    await waitFor(() => expect(records[0].isPinned).toBe(true));
    fireEvent.click(ui.row('Archive'), { altKey: true }); fireEvent.click(ui.row('Created'), { altKey: true });
    fireEvent.contextMenu(ui.row('Archive'));
    expect(lastMenu().items[0].title).toBe('取消置顶 2 个会话');
    ui.choose('取消置顶 2 个会话');
    await waitFor(() => expect(records.filter(record => record.isPinned)).toHaveLength(0));
    fireEvent.click(ui.row('Archive'), { altKey: true }); fireEvent.click(ui.row('Native running'), { altKey: true });
    fireEvent.contextMenu(ui.row('Archive'));
    expect(lastMenu().items.map(item => item.title)).toEqual(['置顶 2 个会话', '将 2 个会话移动到项目…', '归档 1 个会话']);
    ui.choose('归档 1 个会话');
    await waitFor(() => expect(records[0].isArchived).toBe(true));
    expect(records.filter(record => record.isArchived).map(record => record.id)).toEqual(['native:a']);
  });

  it.each([true, false])('uses a localized plural confirmation and preserves native deletion/cancellation (%s)', async confirmed => {
    const records = [session('native:one', 'Archive', { isArchived: true }), session('native:two', 'Created', { isArchived: true }), session('native:keep', 'Keep', { isArchived: true })];
    const ui = await renderLocalized(records, { sessionScope: 'archived', sessionActionMode: 'archived', allowConversationSelection: false });
    fireEvent.click(ui.row('Archive'), { altKey: true }); fireEvent.click(ui.row('Created'), { altKey: true });
    fireEvent.contextMenu(ui.row('Archive'));
    expect(lastMenu().items.map(item => item.title)).toEqual(['恢复 2 个会话', '删除 2 个会话']);
    ui.choose('删除 2 个会话');
    const dialog = within(document.body).getByRole('dialog', { name: '确认' });
    expect(dialog.textContent).toContain('永久删除 2 个会话？');
    expect(await axe(dialog)).toHaveNoViolations();
    fireEvent.click(within(dialog).getByRole('button', { name: confirmed ? '删除' : '取消' }));
    await waitFor(() => expect(dialog.isConnected).toBe(false));
    await waitFor(() => expect(records.map(record => record.id)).toEqual(confirmed ? ['native:keep'] : ['native:one', 'native:two', 'native:keep']));
    if (!confirmed) {
      fireEvent.contextMenu(ui.row('Archive'));
      // A single row uses row actions; reopen an actual two-row selection for bulk restore.
      fireEvent.click(ui.row('Archive'), { altKey: true }); fireEvent.click(ui.row('Created'), { altKey: true });
      fireEvent.contextMenu(ui.row('Archive')); ui.choose('恢复 2 个会话');
    }
    await waitFor(() => expect(records.filter(record => !record.isArchived).map(record => record.id)).toEqual(confirmed ? [] : ['native:one', 'native:two']));
  });

  it('localizes linked-content group actions and singular confirmation without changing raw path/title', async () => {
    const records = [session('native:Archive', 'Created', { linkedContentPath: 'Projects/Archive.md' })];
    const onSetLinkedContentPinned = vi.fn().mockResolvedValue(undefined);
    const pinnedLinkedContentPaths = new Set<string>();
    const ui = await renderLocalized(records, {
      organization: 'linked-content', contentExists: () => true, contentIsNote: () => false,
      onSetLinkedContentPinned, pinnedLinkedContentPaths,
    });
    fireEvent.contextMenu(within(ui.container).getByText('Archive'));
    expect(lastMenu().items.map(item => item.title)).toEqual(['置顶关联内容', '归档所有会话']);
    ui.choose('置顶关联内容');
    expect(onSetLinkedContentPinned).toHaveBeenCalledWith('Projects/Archive.md', true);
    // A fresh presentation reads the existing pinned-content boundary independently of its title.
    pinnedLinkedContentPaths.add('Projects/Archive.md'); ui.render();
    fireEvent.contextMenu(within(ui.container).getByText('Archive'));
    expect(lastMenu().items.map(item => item.title)).toEqual(['取消置顶关联内容', '归档所有会话']);
    ui.choose('取消置顶关联内容');
    expect(onSetLinkedContentPinned).toHaveBeenLastCalledWith('Projects/Archive.md', false);
    const archived = await renderLocalized(records.map(record => ({ ...record, isArchived: true })), {
      organization: 'linked-content', contentExists: () => true, contentIsNote: () => false,
      sessionScope: 'archived', sessionActionMode: 'archived', allowConversationSelection: false,
    });
    fireEvent.contextMenu(within(archived.container).getByText('Archive'));
    expect(lastMenu().items.map(item => item.title)).toEqual(['恢复所有会话', '删除所有会话']);
    archived.choose('删除所有会话');
    const dialog = within(document.body).getByRole('dialog', { name: '确认' });
    expect(dialog.textContent).toContain('永久删除 1 个会话？');
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    await waitFor(() => expect(dialog.isConnected).toBe(false));
    expect(within(archived.container).getByText('Created')).toBeTruthy();
  });

  it('reports fixed localized failures instead of raw navigation, clipboard or storage errors', async () => {
    const records = [session('native:Archive', 'Archive')];
    const ui = await renderLocalized(records, {}, { setConversationsPlacement: async () => { throw new Error('raw storage diagnostic'); } });
    ui.onOpenConversationInNewTab.mockRejectedValueOnce(new Error('raw navigation diagnostic'));
    fireEvent.contextMenu(ui.row('Archive')); ui.choose('在新标签页中打开');
    await waitFor(() => expect(Notice).toHaveBeenCalledWith('无法加载会话'));
    fireEvent.contextMenu(ui.row('Archive')); ui.choose('置顶');
    await waitFor(() => expect(Notice).toHaveBeenCalledWith('无法置顶会话'));
    const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error('raw clipboard diagnostic')) } });
    onTestFinished(() => { if (original) Object.defineProperty(navigator, 'clipboard', original); else Reflect.deleteProperty(navigator, 'clipboard'); });
    fireEvent.contextMenu(ui.row('Archive')); ui.choose('复制会话 ID');
    await waitFor(() => expect(Notice).toHaveBeenCalledWith('无法复制会话 ID'));
    expect(records[0].isPinned).not.toBe(true);
  });
});
