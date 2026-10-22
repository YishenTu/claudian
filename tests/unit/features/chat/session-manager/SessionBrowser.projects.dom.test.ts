/** @jest-environment jsdom */

import { createProjectsFake, projectRecord } from '@test/helpers/features/chat/ProjectsFake';
import { testDate } from '@test/helpers/testClock';
import { fireEvent, within } from '@testing-library/dom';
import { axe } from 'jest-axe';
import { Menu } from 'obsidian';

import type { ConversationMeta, ProjectRecord } from '@/core/types';
import { SessionBrowser, type SessionBrowserDeps } from '@/features/chat/session-manager/SessionBrowser';
import type { HistoryConversationStatus } from '@/features/chat/session-manager/SessionStatusPresentation';
import { t } from '@/i18n/i18n';
import { confirm } from '@/shared/modals/ConfirmModal';

jest.mock('@/shared/modals/ConfirmModal', () => ({ confirm: jest.fn(), confirmDelete: jest.fn() }));

HTMLElement.prototype.empty = function () { this.replaceChildren(); };
HTMLElement.prototype.addClass = function (...classes) { this.classList.add(...classes); };
HTMLElement.prototype.removeClass = function (...classes) { this.classList.remove(...classes); };
HTMLElement.prototype.hasClass = function (className) { return this.classList.contains(className); };
HTMLElement.prototype.toggleClass = function (classes, value) {
  for (const name of [classes].flat()) this.classList.toggle(name, value);
};

type MockMenuItem = {
  title: string; checked: boolean | null; isWarning?: boolean;
  clickHandler: ((event?: unknown) => void) | null;
};
type MockMenu = { items: MockMenuItem[]; showAtPosition: jest.Mock; showAtMouseEvent: jest.Mock };

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

function setup(options: {
  conversations?: ConversationMeta[];
  records?: ProjectRecord[];
  render?: Record<string, unknown>;
} = {}) {
  const conversations = options.conversations ?? [
    session('alpha', { projectId: 'launch', lastActivityAt: testDate({ hours: -1 }).getTime() }),
    session('busy', { projectId: 'launch', lastActivityAt: testDate({ hours: -2 }).getTime() }),
    session('notes', { projectId: 'research' }),
    session('stale', { projectId: 'deleted-project' }),
    session('loose'),
  ];
  const reader = createProjectsFake(options.records ?? [launch, research, idle]);
  const projects = {
    ...reader,
    create: jest.fn(),
    update: jest.fn().mockResolvedValue(undefined),
    setPinned: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
    setConversationsProject: jest.fn().mockResolvedValue(undefined),
    readMemory: jest.fn(), saveMemory: jest.fn(), recreateMemory: jest.fn(),
  };
  const lifecycle = { archive: jest.fn().mockResolvedValue(undefined), setPinned: jest.fn() };
  const browser = new SessionBrowser({
    plugin: {
      app: {}, settings: { enableAutoTitleGeneration: false }, getConversationList: () => conversations,
      conversationLifecycle: lifecycle, projects,
    },
    getCurrentConversationId: () => null,
    getTitleGenerationService: () => null,
    onListChanged: () => undefined,
  } as unknown as SessionBrowserDeps);
  const container = document.body.createDiv();
  const onStartProjectConversation = jest.fn().mockResolvedValue(undefined);
  const onProjectExpandedChange = jest.fn();
  const expandedProjectIds = new Set<string>(['launch', 'research', 'idle']);
  const render = (): void => browser.renderHistoryDropdown(container, {
    onSelectConversation: jest.fn().mockResolvedValue(undefined),
    onRerender: render,
    showMetadataPopover: true,
    showPinnedSection: true,
    showProjectsSection: true,
    sessionScope: 'active',
    sessionActionMode: 'active',
    isProjectExpanded: (projectId: string) => expandedProjectIds.has(projectId),
    onProjectExpandedChange: (projectId: string, expanded: boolean) => {
      onProjectExpandedChange(projectId, expanded);
      if (expanded) expandedProjectIds.add(projectId); else expandedProjectIds.delete(projectId);
    },
    onStartProjectConversation,
    getConversationStatus: (id: string): HistoryConversationStatus => ({ openState: 'closed', isRunning: id === 'busy' }),
    ...options.render,
  });
  render();
  return {
    browser, container, expandedProjectIds, lifecycle, onProjectExpandedChange, onStartProjectConversation, projects,
    render, view: within(container),
  };
}

const sectionName = (name: string, _count: number) => name;

afterEach(() => {
  document.body.replaceChildren();
  menus().length = 0;
  jest.mocked(confirm).mockReset();
});

const projectsRegion = (container: HTMLElement) => within(container).getByRole('region', { name: t('chat.projects.header') });
/** Expanded project rows, without the section header's own toggle. */
const expandedProjectToggles = (region: HTMLElement) => {
  const sectionToggle = within(region).getByRole('button', { name: t('chat.projects.header') });
  return within(region).getAllByRole('button', { expanded: true }).filter(toggle => toggle !== sectionToggle);
};

it('places the Pinned section above the projects', () => {
  const { container, view } = setup({
    conversations: [session('favorite', { isPinned: true }), session('alpha', { projectId: 'launch' })],
  });
  const pinned = view.getByRole('region', { name: 'Pinned' });
  const region = projectsRegion(container);
  expect(pinned.compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it('lists projects above the sessions, pinned first, with their members only under them', async () => {
  const { container, view } = setup();
  const region = projectsRegion(container);
  const sessions = view.getByRole('region', { name: 'Sessions' });
  expect(region.compareDocumentPosition(sessions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

  const toggles = expandedProjectToggles(region);
  expect(toggles.map(toggle => toggle.textContent)).toEqual([
    sectionName('Research', 1),
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

it('shows the projects header without rows when there are no projects, and no section in the archive', () => {
  const empty = setup({ records: [] });
  expect(within(projectsRegion(empty.container)).queryAllByRole('button').map(button => button.textContent))
    .toEqual([t('chat.projects.header')]);
  expect(within(projectsRegion(empty.container)).queryByText(t('chat.projects.noSessions'))).toBeNull();
  document.body.replaceChildren();

  const archived = setup({
    conversations: [session('old', { projectId: 'launch', isArchived: true })],
    render: { sessionScope: 'archived', sessionActionMode: 'archived', showPinnedSection: false, showArchivedSection: true },
  });
  expect(archived.view.queryByRole('region', { name: t('chat.projects.header') })).toBeNull();
  expect(within(archived.view.getByRole('region', { name: 'Archived' })).getByText('old session')).toBeTruthy();
});

it('expands and collapses a project from its native toggle', () => {
  const { container, expandedProjectIds, onProjectExpandedChange, render, view } = setup();
  expandedProjectIds.clear();
  render();
  const toggle = () => view.getByRole('button', { name: sectionName('Launch', 2) });

  expect(toggle().getAttribute('aria-expanded')).toBe('false');
  expect(within(projectsRegion(container)).queryByText('alpha session')).toBeNull();
  fireEvent.click(toggle());
  expect(onProjectExpandedChange).toHaveBeenLastCalledWith('launch', true);
  expect(toggle().getAttribute('aria-expanded')).toBe('true');
  expect(within(projectsRegion(container)).getByText('alpha session')).toBeTruthy();

  fireEvent.click(toggle());
  expect(onProjectExpandedChange).toHaveBeenLastCalledWith('launch', false);
  expect(within(projectsRegion(container)).queryByText('alpha session')).toBeNull();
});

it.each([
  ['last-updated', ['Research', 'Launch', 'Idle']],
  // Launch was created ten days ago, Idle twelve hours ago; pinned Research stays first.
  ['created', ['Research', 'Idle', 'Launch']],
])('orders projects by the %s project sort', (projectSort, names) => {
  const recentIdle = projectRecord({ id: 'idle', name: 'Idle', createdAt: testDate({ hours: -12 }).getTime() });
  const { container } = setup({ records: [launch, research, recentIdle], render: { projectSort } });

  expect(expandedProjectToggles(projectsRegion(container))
    .map(toggle => toggle.textContent)).toEqual(names.map(name => (
    sectionName(name, { Research: 1, Launch: 2, Idle: 0 }[name]!)
  )));
});

it('starts a session in a project and manages the project from its section menu', async () => {
  const { lifecycle, onStartProjectConversation, projects, view } = setup();

  fireEvent.click(view.getByRole('button', { name: t('chat.projects.newSessionIn', { name: 'Launch' }) }));
  expect(onStartProjectConversation).toHaveBeenCalledWith('launch');

  const actions = view.getByRole('button', { name: t('chat.projects.actionsFor', { name: 'Launch' }) });
  expect(actions.getAttribute('aria-haspopup')).toBe('menu');
  fireEvent.click(actions);
  const menu = menus().at(-1)!;
  expect(menu.showAtPosition).toHaveBeenCalled();
  expect(titles(menu)).toEqual([
    t('chat.projects.menu.newSession'),
    t('chat.projects.menu.edit'),
    t('chat.projects.menu.openMemory'),
    t('chat.projects.menu.pin'),
    t('chat.projects.menu.archiveIdle'),
    t('chat.projects.menu.delete'),
  ]);

  item(menu, t('chat.projects.menu.pin')).clickHandler!();
  item(menu, t('chat.projects.menu.archiveIdle')).clickHandler!();
  jest.mocked(confirm).mockResolvedValue(true);
  item(menu, t('chat.projects.menu.delete')).clickHandler!();
  await new Promise(resolve => setTimeout(resolve, 0));

  expect(projects.setPinned).toHaveBeenCalledWith('launch', true);
  // The running member stays active.
  expect(lifecycle.archive).toHaveBeenCalledWith(['alpha']);
  expect(confirm).toHaveBeenCalledWith(
    expect.anything(),
    t('chat.projects.deleteConfirm', { name: 'Launch' }),
    t('common.delete'),
  );
  expect(projects.delete).toHaveBeenCalledWith('launch');

  fireEvent.contextMenu(view.getByRole('button', { name: sectionName('Research', 1) }));
  expect(titles(menus().at(-1)!)).toContain(t('chat.projects.menu.unpin'));
});

it('keeps the project when deletion is not confirmed', async () => {
  const { projects, view } = setup();
  fireEvent.click(view.getByRole('button', { name: t('chat.projects.actionsFor', { name: 'Idle' }) }));
  jest.mocked(confirm).mockResolvedValue(false);
  item(menus().at(-1)!, t('chat.projects.menu.delete')).clickHandler!();
  await new Promise(resolve => setTimeout(resolve, 0));

  expect(confirm).toHaveBeenCalled();
  expect(projects.delete).not.toHaveBeenCalled();
});

it('moves a session between projects and removes it from its project from the row menu', async () => {
  const { projects, view } = setup();

  fireEvent.contextMenu(view.getByText('alpha session'));
  const rowMenu = menus().at(-1)!;
  expect(titles(rowMenu)).toEqual(expect.arrayContaining([
    t('chat.projects.menu.moveTo'), t('chat.projects.menu.removeFrom'),
  ]));
  item(rowMenu, t('chat.projects.menu.moveTo')).clickHandler!();
  const picker = menus().at(-1)!;
  expect(titles(picker)).toEqual(['Idle', 'Launch', 'Research', t('chat.projects.menu.newProject')]);
  expect(item(picker, 'Launch').checked).toBe(true);
  item(picker, 'Research').clickHandler!();
  item(rowMenu, t('chat.projects.menu.removeFrom')).clickHandler!();
  await new Promise(resolve => setTimeout(resolve, 0));

  expect(projects.setConversationsProject.mock.calls).toEqual([[['alpha'], 'research'], [['alpha'], null]]);

  // A stale project id offers moving, but nothing to remove from.
  fireEvent.contextMenu(view.getByText('stale session'));
  expect(titles(menus().at(-1)!)).toContain(t('chat.projects.menu.moveTo'));
  expect(titles(menus().at(-1)!)).not.toContain(t('chat.projects.menu.removeFrom'));
});

it('moves and removes a multi-selection', async () => {
  const { projects, view } = setup();

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
  expect(projects.setConversationsProject.mock.calls).toEqual([[['alpha', 'loose'], 'idle'], [['alpha'], null]]);
});

it('anchors the keyboard-invoked project picker to the session row', () => {
  const { view } = setup();
  const row = view.getByText('alpha session').closest('.claudian-history-item') as HTMLElement;
  jest.spyOn(row, 'getBoundingClientRect').mockReturnValue({ left: 40, bottom: 120 } as DOMRect);

  fireEvent.contextMenu(row);
  // Keyboard activation closes the menu; its event target is no longer anything near the row.
  item(menus().at(-1)!, t('chat.projects.menu.moveTo'))
    .clickHandler!(new KeyboardEvent('keydown', { key: 'Enter' }));

  const picker = menus().at(-1)!;
  expect(titles(picker)).toContain(t('chat.projects.menu.newProject'));
  expect(picker.showAtPosition).toHaveBeenCalledWith({ x: 40, y: 120 });
});
