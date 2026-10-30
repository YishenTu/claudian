/** @vitest-environment jsdom */
import { axe } from '@test/helpers/accessibility';
import { createProjectsFake, projectRecord } from '@test/helpers/features/chat/ProjectsFake';
import { createSessionBrowserHost } from '@test/helpers/features/chat/SessionBrowserTestHarness';
import { testDate } from '@test/helpers/testClock';
import { fireEvent, waitFor, within } from '@testing-library/dom';
import { Menu } from 'obsidian';
import type { Mock } from 'vitest';

import type { ConversationMeta, ProjectRecord } from '@/core/types';
import { SessionBrowser } from '@/features/chat/session-manager/SessionBrowser';
import type { HistoryConversationStatus } from '@/features/chat/session-manager/SessionStatusPresentation';
import { t } from '@/i18n/i18n';





type MockMenuItem = {
  title: string; checked: boolean | null; disabled: boolean; isWarning?: boolean;
  clickHandler: ((event?: unknown) => void) | null;
};
type MockMenu = { items: MockMenuItem[]; showAtPosition: Mock; showAtMouseEvent: Mock };

const menus = (): MockMenu[] => (Menu as unknown as { instances: MockMenu[] }).instances;
const titles = (menu: MockMenu): string[] => menu.items.map(item => item.title);
const item = (menu: MockMenu, title: string): MockMenuItem => menu.items.find(entry => entry.title === title)!;

function session(id: string, extra: Partial<ConversationMeta> = {}): ConversationMeta {
  return {
    id, providerId: 'claude', title: `${id} session`, messageCount: 1, preview: '',
    createdAt: testDate({ days: -5 }).getTime(), lastActivityAt: testDate({ days: -1 }).getTime(), ...extra,
  };
}

const launch = projectRecord({ id: 'launch', name: 'Launch', createdAt: testDate({ days: -10 }).getTime() });
const research = projectRecord({ id: 'research', name: 'Research', isPinned: true });
const idle = projectRecord({ id: 'idle', name: 'Idle', createdAt: testDate({ days: -20 }).getTime() });

async function setup(options: {
  conversations?: ConversationMeta[];
  records?: ProjectRecord[];
  render?: Record<string, unknown>;
  /** The document showing the list, such as a popped-out window's. */
  doc?: Document;
} = {}) {
  const conversations = structuredClone(options.conversations ?? [
    session('alpha', { projectId: 'launch', lastActivityAt: testDate({ hours: -1 }).getTime() }),
    session('busy', { projectId: 'launch', lastActivityAt: testDate({ hours: -2 }).getTime() }),
    session('notes', { projectId: 'research' }),
    session('stale', { projectId: 'deleted-project' }),
    session('loose'),
  ]);
  const reader = createProjectsFake(structuredClone(options.records ?? [launch, research, idle]));
  const projects = {
    ...reader,
    create: vi.fn(),
    update: vi.fn().mockResolvedValue(undefined),
    setPinned: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn(async (id: string) => reader.remove(id)),
    setArchived: vi.fn(async (id: string, value: boolean) => { const record = reader.get(id); if (record) reader.put({ ...record, isArchived: value }); }),
    readMemory: vi.fn(), saveMemory: vi.fn(), recreateMemory: vi.fn(),
  };
  const fixture = await createSessionBrowserHost({ conversations, host: {
    settings: { enableAutoTitleGeneration: false }, projects,
  }, store: { archiveProjectIfEmpty: async id => {
    if (!conversations.some(record => record.projectId === id && !record.isArchived)) await projects.setArchived(id, true);
  } } });
  const lifecycle = {
    archive: vi.spyOn(fixture.lifecycle, 'archive'),
    archiveProject: vi.spyOn(fixture.lifecycle, 'archiveProject'),
    restoreProject: vi.spyOn(fixture.lifecycle, 'restoreProject'),
    setPinned: vi.spyOn(fixture.lifecycle, 'setPinned'),
    setPlacement: vi.spyOn(fixture.lifecycle, 'setPlacement'),
  };
  const browser = new SessionBrowser({
    plugin: fixture.plugin,
    getCurrentConversationId: () => null,
    getTitleGenerationService: () => null,
    onListChanged: () => undefined,
  });
  onTestFinished(() => browser.dispose());
  const container = (options.doc ?? document).body.createDiv();
  const onStartProjectConversation = vi.fn().mockResolvedValue(undefined);
  const onGroupCollapseChange = vi.fn();
  const collapsedGroupKeys = new Set<string>();
  const render = (): void => browser.renderHistoryDropdown(container, {
    onSelectConversation: vi.fn().mockResolvedValue(undefined),
    onRerender: render,
    showMetadataPopover: true,
    showPinnedSection: true,
    sessionScope: 'active',
    sessionActionMode: 'active',
    isGroupCollapsed: (groupKey: string) => collapsedGroupKeys.has(groupKey),
    onGroupCollapseChange: (groupKey: string, collapsed: boolean) => {
      onGroupCollapseChange(groupKey, collapsed);
      if (collapsed) collapsedGroupKeys.add(groupKey); else collapsedGroupKeys.delete(groupKey);
    },
    onStartProjectConversation,
    getConversationStatus: (id: string): HistoryConversationStatus => ({ openState: 'closed', isRunning: id === 'busy' }),
    ...options.render,
  });
  render();
  return {
    browser, collapsedGroupKeys, container, lifecycle, onGroupCollapseChange, onStartProjectConversation, projects,
    render, view: within(container),
  };
}

const sectionName = (name: string, _count: number) => name;

afterEach(() => {
  document.body.replaceChildren();
  menus().length = 0;
});

const projectsRegion = (container: HTMLElement) => within(container).getByRole('region', { name: t('chat.projects.header') });
/** Expanded project rows, without the section header's own toggle. */
const expandedProjectToggles = (region: HTMLElement) => {
  const sectionToggle = within(region).getByRole('button', { name: t('chat.projects.header') });
  return within(region).getAllByRole('button', { expanded: true }).filter(toggle => toggle !== sectionToggle);
};

it('places the Pinned section above the projects', async () => {
  const { container, view } = await setup({
    conversations: [session('favorite', { isPinned: true }), session('alpha', { projectId: 'launch' })],
  });
  const pinned = view.getByRole('region', { name: 'Pinned' });
  const region = projectsRegion(container);
  expect(pinned.compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it('lists projects above the sessions, with their members only under them', async () => {
  const { container, view } = await setup();
  const region = projectsRegion(container);
  const sessions = view.getByRole('region', { name: 'Sessions' });
  expect(region.compareDocumentPosition(sessions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

  const toggles = expandedProjectToggles(region);
  expect(toggles.map(toggle => toggle.textContent)).toEqual([
    sectionName('Launch', 2),
    sectionName('Idle', 0),
  ]);
  for (const toggle of toggles) expect(toggle.getAttribute('type')).toBe('button');
  expect(within(region).getByText('alpha session')).toBeTruthy();
  expect(within(region).getByText(t('chat.projects.noSessions'))).toBeTruthy();
  // Members leave the session list; a deleted project's member stays there.
  expect(within(sessions).queryByText('alpha session')).toBeNull();
  expect(within(sessions).getByText('stale session')).toBeTruthy();
  expect(within(sessions).getByText('loose session')).toBeTruthy();
  const alphaRow = view.getByText('alpha session').closest('.claudian-history-item') as HTMLElement;
  expect(alphaRow.querySelector('.claudian-history-item-content')?.textContent).toBe('alpha session');
  expect((await axe(container)).violations).toEqual([]);
});

it('lists a pinned project with its header and members under Pinned', async () => {
  const { container, view } = await setup({
    conversations: [
      session('notes', { projectId: 'research' }),
      session('starred', { projectId: 'research', isPinned: true }),
      session('alpha', { projectId: 'launch' }),
    ],
  });
  const pinned = view.getByRole('region', { name: 'Pinned' });
  expect(within(pinned).getByRole('button', { name: sectionName('Research', 2) })).toBeTruthy();
  expect(within(pinned).getByRole('button', { name: t('chat.projects.actionsFor', { name: 'Research' }) })).toBeTruthy();
  expect(within(pinned).getByText('notes session')).toBeTruthy();
  expect(within(pinned).getByText('starred session')).toBeTruthy();
  expect(within(projectsRegion(container)).queryByText('Research')).toBeNull();
  expect(within(projectsRegion(container)).getByText('alpha session')).toBeTruthy();
  expect((await axe(container)).violations).toEqual([]);
});

it('keeps a pinned project first among the projects in a list without a Pinned section', async () => {
  const { container, view } = await setup({ render: { showPinnedSection: false } });
  expect(view.queryByRole('region', { name: 'Pinned' })).toBeNull();
  expect(expandedProjectToggles(projectsRegion(container)).map(toggle => toggle.textContent)).toEqual([
    sectionName('Research', 1), sectionName('Launch', 2), sectionName('Idle', 0),
  ]);
});

it('shows the projects header without rows when there are no projects, and no section in the archive', async () => {
  const empty = await setup({ records: [] });
  const region = projectsRegion(empty.container);
  expect(within(region).queryAllByRole('button')).toEqual([
    within(region).getByRole('button', { name: t('chat.projects.header') }),
    within(region).getByRole('button', { name: t('chat.projects.newProjectAction') }),
  ]);
  expect(within(projectsRegion(empty.container)).queryByText(t('chat.projects.noSessions'))).toBeNull();
  document.body.replaceChildren();

  const archived = await setup({
    conversations: [session('old', { projectId: 'launch', isArchived: true })],
    render: { sessionScope: 'archived', sessionActionMode: 'archived', showPinnedSection: false, showArchivedSection: true },
  });
  expect(archived.view.queryByRole('region', { name: t('chat.projects.header') })).toBeNull();
  expect(within(archived.view.getByRole('region', { name: 'Archived' })).getByText('old session')).toBeTruthy();
});

it('expands and collapses a project from its native toggle', async () => {
  const { collapsedGroupKeys, container, onGroupCollapseChange, render, view } = await setup();
  collapsedGroupKeys.add('project:launch');
  render();
  const toggle = () => view.getByRole('button', { name: sectionName('Launch', 2) });

  expect(toggle().getAttribute('aria-expanded')).toBe('false');
  expect(within(projectsRegion(container)).queryByText('alpha session')).toBeNull();
  fireEvent.click(toggle());
  expect(onGroupCollapseChange).toHaveBeenLastCalledWith('project:launch', false);
  expect(toggle().getAttribute('aria-expanded')).toBe('true');
  expect(within(projectsRegion(container)).getByText('alpha session')).toBeTruthy();

  fireEvent.click(toggle());
  expect(onGroupCollapseChange).toHaveBeenLastCalledWith('project:launch', true);
  expect(within(projectsRegion(container)).queryByText('alpha session')).toBeNull();
});

it('starts a session in a project and manages the project from its section menu', async () => {
  const { lifecycle, onStartProjectConversation, projects, view } = await setup();

  fireEvent.click(view.getByRole('button', { name: t('chat.projects.newSessionIn', { name: 'Launch' }) }));
  expect(onStartProjectConversation).toHaveBeenCalledWith('launch');

  const actions = view.getByRole('button', { name: t('chat.projects.actionsFor', { name: 'Launch' }) });
  expect(actions.getAttribute('aria-haspopup')).toBe('menu');
  fireEvent.click(actions);
  const menu = menus().at(-1)!;
  expect(menu.showAtPosition).toHaveBeenCalled();
  expect(titles(menu)).toEqual([
    t('chat.projects.menu.pin'),
    t('chat.projects.menu.edit'),
    t('chat.projects.menu.openMemory'),
    t('chat.projects.menu.archive'),
    t('chat.projects.menu.delete'),
  ]);

  // Launch has a running member, so it cannot be archived yet.
  expect(item(menu, t('chat.projects.menu.archive')).disabled).toBe(true);
  item(menu, t('chat.projects.menu.pin')).clickHandler!();
  item(menu, t('chat.projects.menu.delete')).clickHandler!();
  const dialog = within(document.body).getByRole('dialog', { name: 'Confirm' });
  expect(dialog.textContent).toContain(t('chat.projects.deleteConfirm', { name: 'Launch' }));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
  await waitFor(() => expect(lifecycle.setPlacement).toHaveBeenCalled());

  expect(projects.setPinned).toHaveBeenCalledWith('launch', true);
  expect(lifecycle.archiveProject).not.toHaveBeenCalled();
  expect(projects.delete).toHaveBeenCalledWith('launch');
  // Members stay as sessions but leave the deleted project, after it can no longer be joined.
  expect(lifecycle.setPlacement).toHaveBeenCalledWith(['alpha', 'busy'], { projectId: null });
  expect(projects.delete.mock.invocationCallOrder[0])
    .toBeLessThan(lifecycle.setPlacement.mock.invocationCallOrder[0]);

  fireEvent.contextMenu(view.getByRole('button', { name: sectionName('Research', 1) }));
  const researchMenu = menus().at(-1)!;
  expect(titles(researchMenu)).toContain(t('chat.projects.menu.unpin'));
  item(researchMenu, t('chat.projects.menu.archive')).clickHandler!();
  expect(lifecycle.archiveProject).toHaveBeenCalledWith('research');
});

it('lists an archived project only in the archive, where it can be restored or deleted', async () => {
  const shelved = projectRecord({ id: 'shelved', name: 'Shelved', isArchived: true });
  const conversations = [
    session('alpha', { projectId: 'launch' }),
    session('old', { projectId: 'shelved', isArchived: true }),
  ];
  const active = await setup({ conversations, records: [launch, shelved] });
  expect(within(projectsRegion(active.container)).queryByText('Shelved')).toBeNull();
  document.body.replaceChildren();

  const { lifecycle, projects, view } = await setup({
    conversations,
    records: [launch, shelved],
    render: { sessionScope: 'archived', sessionActionMode: 'archived', showPinnedSection: false, showArchivedSection: true },
  });
  const region = view.getByRole('region', { name: t('chat.projects.header') });
  expect(within(region).queryByText('Launch')).toBeNull();
  expect(within(region).getByText('old session')).toBeTruthy();
  expect(within(region).queryByRole('button', { name: t('chat.projects.newSessionIn', { name: 'Shelved' }) })).toBeNull();
  expect(within(region).queryByRole('button', { name: t('chat.projects.newProjectAction') })).toBeNull();
  expect(within(view.getByRole('region', { name: 'Archived' })).queryByText('old session')).toBeNull();

  fireEvent.click(within(region).getByRole('button', { name: t('chat.projects.actionsFor', { name: 'Shelved' }) }));
  const menu = menus().at(-1)!;
  expect(titles(menu)).toEqual([t('chat.projects.menu.restore'), t('chat.projects.menu.delete')]);
  item(menu, t('chat.projects.menu.restore')).clickHandler!();
  expect(lifecycle.restoreProject).toHaveBeenCalledWith('shelved');
  item(menu, t('chat.projects.menu.delete')).clickHandler!();
  fireEvent.click(within(within(document.body).getByRole('dialog', { name: 'Confirm' })).getByRole('button', { name: 'Delete' }));
  await waitFor(() => expect(projects.delete).toHaveBeenCalled());
  expect(projects.delete).toHaveBeenCalledWith('shelved');
});

it('keeps the project when deletion is not confirmed', async () => {
  const { projects, view } = await setup();
  fireEvent.click(view.getByRole('button', { name: t('chat.projects.actionsFor', { name: 'Idle' }) }));
  item(menus().at(-1)!, t('chat.projects.menu.delete')).clickHandler!();
  const dialog = within(document.body).getByRole('dialog', { name: 'Confirm' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(dialog.isConnected).toBe(false));
  expect(projects.delete).not.toHaveBeenCalled();
});

it('moves a session between projects and removes it from its project from the row menu', async () => {
  const { lifecycle, view } = await setup();

  fireEvent.contextMenu(view.getByText('alpha session'));
  const rowMenu = menus().at(-1)!;
  expect(titles(rowMenu)).toEqual(expect.arrayContaining([
    t('chat.projects.menu.moveTo'), t('chat.projects.menu.removeFrom'),
  ]));
  item(rowMenu, t('chat.projects.menu.moveTo')).clickHandler!();
  const picker = menus().at(-1)!;
  // Like the composer's project chip, pinned projects come first.
  expect(titles(picker)).toEqual(['Research', 'Idle', 'Launch', t('chat.projects.menu.newProject')]);
  expect(item(picker, 'Launch').checked).toBe(true);
  item(picker, 'Research').clickHandler!();
  item(rowMenu, t('chat.projects.menu.removeFrom')).clickHandler!();
  await new Promise(resolve => setTimeout(resolve, 0));

  expect(lifecycle.setPlacement.mock.calls).toEqual([
    [['alpha'], { projectId: 'research' }],
    [['alpha'], { projectId: null }],
  ]);

  // A stale project id offers moving, but nothing to remove from.
  fireEvent.contextMenu(view.getByText('stale session'));
  expect(titles(menus().at(-1)!)).toContain(t('chat.projects.menu.moveTo'));
  expect(titles(menus().at(-1)!)).not.toContain(t('chat.projects.menu.removeFrom'));
});

it('moves and removes a multi-selection', async () => {
  const { lifecycle, view } = await setup();

  fireEvent.click(view.getByRole('button', { name: /^alpha session/ }), { altKey: true });
  fireEvent.click(view.getByRole('button', { name: /^loose session/ }), { altKey: true });
  fireEvent.contextMenu(view.getByText('alpha session'));
  const menu = menus().at(-1)!;
  expect(titles(menu)).toEqual(expect.arrayContaining([
    t('chat.projects.menu.moveSelectionTo', { count: 2 }),
    t('chat.projects.menu.removeSelectionFrom', { count: 1 }),
  ]));

  item(menu, t('chat.projects.menu.moveSelectionTo', { count: 2 })).clickHandler!();
  item(menus().at(-1)!, 'Idle').clickHandler!();
  item(menu, t('chat.projects.menu.removeSelectionFrom', { count: 1 })).clickHandler!();
  await new Promise(resolve => setTimeout(resolve, 0));

  // One batched write per action, so the list republishes once for the whole selection.
  expect(lifecycle.setPlacement.mock.calls).toEqual([
    [['alpha', 'loose'], { projectId: 'idle' }],
    [['alpha'], { projectId: null }],
  ]);
});

it('opens keyboard-invoked menus under their anchor in the window that shows the list', async () => {
  const popout = document.implementation.createHTMLDocument('popout');
  const { container, view } = await setup({ doc: popout });
  const row = view.getByText('alpha session').closest('.claudian-history-item') as HTMLElement;
  vi.spyOn(row, 'getBoundingClientRect').mockReturnValue({ left: 40, bottom: 120 } as DOMRect);

  // Testing Library's fireEvent needs the node's window, which a detached popout document lacks.
  row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  // Keyboard activation closes the menu; its event target is no longer anything near the row.
  item(menus().at(-1)!, t('chat.projects.menu.moveTo'))
    .clickHandler!(new KeyboardEvent('keydown', { key: 'Enter' }));

  const picker = menus().at(-1)!;
  expect(titles(picker)).toContain(t('chat.projects.menu.newProject'));
  expect(picker.showAtPosition).toHaveBeenCalledWith({ x: 40, y: 120 }, popout);

  // Accessible-name queries also need the node's window.
  const actions = container.querySelector<HTMLElement>(
    `[aria-label="${t('chat.projects.actionsFor', { name: 'Launch' })}"]`,
  )!;
  vi.spyOn(actions, 'getBoundingClientRect').mockReturnValue({ left: 10, bottom: 30 } as DOMRect);
  actions.click();
  expect(menus().at(-1)!.showAtPosition).toHaveBeenCalledWith({ x: 10, y: 30 }, popout);
});
