/** @jest-environment jsdom */

import '@/providers';

import { createProjectsFake, projectRecord } from '@test/helpers/features/chat/ProjectsFake';
import { testDate } from '@test/helpers/testClock';
import { fireEvent, within } from '@testing-library/dom';
import { axe } from 'jest-axe';
import { Menu, setIcon } from 'obsidian';

import type { ConversationMeta } from '@/core/types';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import { createProject } from '@/features/chat/projects/projectActions';
import { SessionBrowser } from '@/features/chat/session-manager/SessionBrowser';
import { SessionManagerSurface } from '@/features/chat/session-manager/SessionManagerSurface';
import { t } from '@/i18n/i18n';

jest.mock('@/features/chat/projects/projectActions', () => ({
  ...jest.requireActual('@/features/chat/projects/projectActions'),
  createProject: jest.fn(),
}));

HTMLElement.prototype.empty = function () { this.replaceChildren(); };
HTMLElement.prototype.addClass = function (...classes) { this.classList.add(...classes); };
HTMLElement.prototype.removeClass = function (...classes) { this.classList.remove(...classes); };
HTMLElement.prototype.hasClass = function (className) { return this.classList.contains(className); };
HTMLElement.prototype.toggleClass = function (classes, value) {
  for (const name of [classes].flat()) this.classList.toggle(name, value);
};

function conversation(id: string, overrides: Partial<ConversationMeta> = {}): ConversationMeta {
  const at = testDate({ hours: -1 }).getTime();
  return {
    id,
    providerId: 'claude',
    title: id,
    createdAt: at,
    lastActivityAt: at,
    messageCount: 1,
    preview: '',
    ...overrides,
  };
}

function createSurface() {
  // Active rows carry their own Archive action; an archived-only list keeps navigation names unique.
  const conversations = [conversation('archived', { isArchived: true })];
  const plugin = {
    app: { vault: { getAbstractFileByPath: () => null } },
    settings: { enableAutoTitleGeneration: false },
    getConversationList: () => conversations,
    projects: createProjectsFake(),
  };
  const requestNew = jest.fn();
  const surface = new SessionManagerSurface({
    plugin: plugin as unknown as ChatFeatureHost,
    navigation: {
      contentExists: () => true,
      getConversationStatus: () => ({ openState: 'closed', isRunning: false }),
      openConversation: jest.fn().mockResolvedValue(undefined),
      openSessionConversation: jest.fn().mockResolvedValue(undefined),
      startLinkedContentConversation: jest.fn().mockResolvedValue(undefined),
      startProjectConversation: jest.fn().mockResolvedValue(undefined),
    },
    getActiveTab: () => null,
    isWide: () => true,
    canCreateTab: () => true,
    requestNew,
    notifyOtherViews: jest.fn(),
  });
  const host = document.body.createDiv();
  surface.mountSidebar(host);
  surface.renderSidebar();
  return { host, requestNew, surface };
}

afterEach(() => {
  document.body.replaceChildren();
});

it.each([false, true])('opens selectable history rows by keyboard (metadata popovers: %s)', async showMetadataPopover => {
  const onSelectConversation = jest.fn().mockResolvedValue(undefined);
  const browser = new SessionBrowser({
    plugin: {
      settings: { enableAutoTitleGeneration: false },
      getConversationList: () => [conversation('Keyboard session'), conversation('current', { title: 'Active conversation' })],
    } as unknown as ChatFeatureHost,
    getCurrentConversationId: () => 'current',
    getTitleGenerationService: () => null,
    onListChanged: () => undefined,
  });
  const host = document.body.createDiv();
  try {
    browser.renderHistoryDropdown(host, { onSelectConversation, showMetadataPopover });
    const view = within(host);
    const selectable = view.getByRole('button', { name: /^Keyboard session/ });
    selectable.focus();
    expect(document.activeElement).toBe(selectable);
    for (const key of ['Enter', ' ']) fireEvent.keyDown(selectable, { key });
    expect(onSelectConversation.mock.calls).toEqual([['Keyboard session'], ['Keyboard session']]);
    expect((await axe(selectable)).violations).toEqual([]);

    const current = view.getByText('Active conversation').parentElement!;
    expect(view.queryByRole('button', { name: /^Active conversation/ })).toBeNull();
    fireEvent.keyDown(current, { key: 'Enter' });
    expect(onSelectConversation).toHaveBeenCalledTimes(2);

    browser.renderHistoryDropdown(host, {
      onSelectConversation, showMetadataPopover,
      allowConversationSelection: false, sessionActionMode: 'archived',
    });
    const archived = view.getByText('Keyboard session').parentElement!;
    expect(view.queryByRole('button', { name: /^Keyboard session/ })).toBeNull();
    fireEvent.keyDown(archived, { key: 'Enter' });
    expect(onSelectConversation).toHaveBeenCalledTimes(2);
  } finally {
    browser.dispose();
    host.remove();
  }
});

it.each([false, true])('keeps session navigation named and operable without tooltips (archive: %s)', async archived => {
  const { host, requestNew, surface } = createSurface();
  const sidebar = within(host);
  if (archived) {
    fireEvent.keyDown(sidebar.getByRole('button', { name: 'Archive' }), { key: 'Enter' });
  }
  const archiveName = archived ? 'Sessions' : 'Archive';
  const list = host.querySelector('.claudian-history-list')!;
  expect(within(list as HTMLElement).getByText(archived ? 'Archived' : 'Sessions')).toBeTruthy();

  for (const name of ['New', 'Search', archiveName]) {
    const button = sidebar.getByRole('button', { name });
    expect(button.hasAttribute('aria-label')).toBe(false);
    expect(button.hasAttribute('title')).toBe(false);
    // Navigation sits above the session list and its header.
    expect(button.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    button.focus();
    expect(document.activeElement).toBe(button);
  }
  expect((await axe(host)).violations).toEqual([]);

  fireEvent.keyDown(sidebar.getByRole('button', { name: 'Search' }), { key: 'Enter' });
  const searchBox = sidebar.getByRole('searchbox', {
    name: archived ? 'Search archived sessions' : 'Search sessions',
  });
  expect(document.activeElement).toBe(searchBox);
  expect(sidebar.queryByRole('button', { name: 'Search' })).toBeNull();
  expect((await axe(host)).violations).toEqual([]);

  fireEvent.keyDown(sidebar.getByRole('button', { name: archiveName }), { key: 'Enter' });
  expect(sidebar.getByRole('button', { name: archived ? 'Archive' : 'Sessions' })).toBeTruthy();
  expect(sidebar.queryByRole('searchbox')).toBeNull();

  fireEvent.keyDown(sidebar.getByRole('button', { name: 'New' }), { key: 'Enter' });
  expect(requestNew).toHaveBeenCalledTimes(1);
  // New always returns to active sessions.
  expect(sidebar.getByRole('button', { name: 'Archive' })).toBeTruthy();

  surface.dispose();
});

describe('projects section', () => {
  type MenuEntry = { title: string; checked: boolean | null; isLabel?: boolean; clickHandler: (() => void) | null };
  const menus = (): Array<{ items: MenuEntry[] }> => (Menu as unknown as { instances: Array<{ items: MenuEntry[] }> }).instances;
  const sectionName = (name: string, _count: number) => name;
  /** The icon most recently drawn inside a project toggle. */
  const folderIcon = (toggle: HTMLElement) => jest.mocked(setIcon).mock.calls
    .filter(([element]) => toggle.contains(element)).at(-1)?.[1];

  function createProjectSurface() {
    const conversations = [
      conversation('member', { title: 'Member session', projectId: 'launch', lastActivityAt: testDate({ hours: -1 }).getTime() }),
      conversation('loose', { title: 'Loose session' }),
      conversation('pinned', { title: 'Pinned session', isPinned: true }),
    ];
    const settings: Record<string, unknown> = { enableAutoTitleGeneration: false, sessionManagerOrganization: 'list' };
    const views: { surface?: SessionManagerSurface } = {};
    const plugin = {
      app: { vault: { getAbstractFileByPath: () => null } },
      settings,
      getConversationList: () => conversations,
      projects: createProjectsFake([
        projectRecord({ id: 'launch', name: 'Launch', createdAt: testDate({ days: -10 }).getTime() }),
        projectRecord({ id: 'empty', name: 'Empty', createdAt: testDate({ days: -2 }).getTime() }),
      ]),
      mutateSettings: jest.fn(async (mutation: (value: Record<string, unknown>) => void) => {
        mutation(settings);
        views.surface?.invalidate();
      }),
    };
    const surface = new SessionManagerSurface({
      plugin: plugin as unknown as ChatFeatureHost,
      navigation: {
        contentExists: () => true,
        getConversationStatus: () => ({ openState: 'closed', isRunning: false }),
        openConversation: jest.fn().mockResolvedValue(undefined),
        openSessionConversation: jest.fn().mockResolvedValue(undefined),
        startLinkedContentConversation: jest.fn().mockResolvedValue(undefined),
        startProjectConversation: jest.fn().mockResolvedValue(undefined),
      },
      getActiveTab: () => null,
      isWide: () => true,
      canCreateTab: () => true,
      requestNew: jest.fn(),
      notifyOtherViews: jest.fn(),
    });
    views.surface = surface;
    const host = document.body.createDiv();
    surface.mountSidebar(host);
    surface.renderSidebar();
    const region = () => within(host).getByRole('region', { name: t('chat.projects.header') });
    return { host, plugin, region, settings, surface, view: within(host) };
  }

  afterEach(() => {
    menus().length = 0;
    jest.mocked(createProject).mockReset();
  });

  it('heads the projects with New project and a sort menu, without a By project organization', async () => {
    const { host, plugin, region, settings, view } = createProjectSurface();
    const projectToggles = () => within(region()).getAllByRole('button', { expanded: false })
      .map(toggle => toggle.textContent);
    // Projects start collapsed, above the sessions.
    expect(projectToggles()).toEqual([sectionName('Launch', 1), sectionName('Empty', 0)]);
    expect(within(view.getByRole('region', { name: 'Sessions' })).queryByText('Member session')).toBeNull();

    const newProject = within(region()).getByRole('button', { name: t('chat.projects.newProjectAction') });
    expect(newProject.tagName).toBe('BUTTON');
    expect(newProject.getAttribute('type')).toBe('button');
    fireEvent.click(newProject);
    expect(createProject).toHaveBeenCalledWith(plugin);
    expect((await axe(host)).violations).toEqual([]);

    fireEvent.click(within(region()).getByRole('button', { name: t('chat.projects.options') }));
    const sortMenu = menus().at(-1)!;
    expect(sortMenu.items.map(entry => entry.title)).toEqual([
      t('chat.projects.sortBy'), t('chat.projects.sort.lastActivity'), t('chat.projects.sort.created'),
    ]);
    expect(sortMenu.items.find(entry => entry.title === t('chat.projects.sort.lastActivity'))!.checked).toBe(true);
    sortMenu.items.find(entry => entry.title === t('chat.projects.sort.created'))!.clickHandler!();
    await Promise.resolve();
    expect(settings.projectSort).toBe('created');
    expect(projectToggles()).toEqual([sectionName('Empty', 0), sectionName('Launch', 1)]);

    fireEvent.click(view.getByRole('button', { name: 'Session options' }));
    const sessionMenu = menus().at(-1)!;
    expect(sessionMenu.items.map(entry => entry.title)).toEqual(expect.arrayContaining(['In one list', 'By linked content']));
    expect(sessionMenu.items.map(entry => entry.title)).not.toContain('By project');
  });

  it('keeps a project expanded across re-renders and the archive, which hides the section', () => {
    const { host, region, surface, view } = createProjectSurface();

    const emptyToggle = () => within(region()).getByRole('button', { name: sectionName('Empty', 0) });
    expect(folderIcon(emptyToggle())).toBe('lucide-folder');
    fireEvent.click(emptyToggle());
    expect(within(region()).getByText(t('chat.projects.noSessions'))).toBeTruthy();
    expect(folderIcon(emptyToggle())).toBe('lucide-folder-open');
    surface.invalidate();
    expect(emptyToggle().getAttribute('aria-expanded')).toBe('true');
    expect(folderIcon(emptyToggle())).toBe('lucide-folder-open');
    fireEvent.click(emptyToggle());
    expect(folderIcon(emptyToggle())).toBe('lucide-folder');
    fireEvent.click(emptyToggle());

    fireEvent.click(host.querySelector('.claudian-session-archive-control')!);
    expect(view.queryByRole('region', { name: t('chat.projects.header') })).toBeNull();
    fireEvent.click(host.querySelector('.claudian-session-archive-control')!);
    expect(within(region()).getByRole('button', { name: sectionName('Empty', 0) }).getAttribute('aria-expanded'))
      .toBe('true');
  });

  it('finds project members by search under their expanded project, then restores the collapsed projects', () => {
    const { host, region, view } = createProjectSurface();
    fireEvent.click(host.querySelector('.claudian-session-search-control')!);
    const searchBox = view.getByRole('searchbox', { name: 'Search sessions' });

    fireEvent.input(searchBox, { target: { value: 'member' } });
    expect(within(region()).getAllByRole('button', { expanded: true }).map(toggle => toggle.textContent))
      .toEqual(['Projects', sectionName('Launch', 1)]);
    expect(within(region()).getByText('Member session')).toBeTruthy();
    expect(folderIcon(within(region()).getByRole('button', { name: sectionName('Launch', 1) }))).toBe('lucide-folder-open');
    expect(within(region()).queryByRole('button', { name: sectionName('Empty', 0) })).toBeNull();

    fireEvent.keyDown(view.getByRole('searchbox', { name: 'Search sessions' }), { key: 'Escape' });
    expect(within(region()).getAllByRole('button', { expanded: false })).toHaveLength(2);
    expect(folderIcon(within(region()).getByRole('button', { name: sectionName('Launch', 1) }))).toBe('lucide-folder');
  });

  it('collapses the projects and sessions sections from their headers, across re-renders', async () => {
    const { host, region, settings, surface, view } = createProjectSurface();
    settings.sessionManagerOrganization = 'linked-content';
    surface.invalidate();
    const sessions = () => view.getByRole('region', { name: 'Sessions' });
    // Named by their visible header labels: an aria-label would make Obsidian show it as a hover tooltip over every row.
    const pinned = view.getByRole('region', { name: 'Pinned' });
    for (const named of [region(), sessions(), pinned]) expect(named.hasAttribute('aria-label')).toBe(false);
    const projectsToggle = () => within(region()).getByRole('button', { name: t('chat.projects.header') });
    const sessionsToggle = () => within(sessions()).getByRole('button', { name: 'Sessions' });
    const projectRow = () => within(region()).queryByRole('button', { name: sectionName('Launch', 1) });
    const sessionRow = () => within(sessions()).queryByRole('button', { name: /^Loose session/ });
    for (const toggle of [projectsToggle(), sessionsToggle()]) {
      expect(toggle.tagName).toBe('BUTTON');
      expect(toggle.getAttribute('type')).toBe('button');
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
    }
    expect(projectRow()).not.toBeNull();
    expect(sessionRow()).not.toBeNull();

    // The header actions sit beside the toggle and never collapse their section.
    fireEvent.click(within(region()).getByRole('button', { name: t('chat.projects.options') }));
    fireEvent.click(within(region()).getByRole('button', { name: t('chat.projects.newProjectAction') }));
    fireEvent.click(within(sessions()).getByRole('button', { name: 'Session options' }));
    fireEvent.click(within(sessions()).getByRole('button', { name: 'Collapse all groups' }));
    expect(projectsToggle().getAttribute('aria-expanded')).toBe('true');
    expect(sessionsToggle().getAttribute('aria-expanded')).toBe('true');
    expect(projectRow()).not.toBeNull();
    fireEvent.click(within(sessions()).getByRole('button', { name: 'Expand all groups' }));
    expect(sessionRow()).not.toBeNull();

    fireEvent.click(projectsToggle());
    expect(projectsToggle().getAttribute('aria-expanded')).toBe('false');
    expect(projectRow()).toBeNull();
    expect(sessionRow()).not.toBeNull();

    fireEvent.click(sessionsToggle());
    expect(sessionsToggle().getAttribute('aria-expanded')).toBe('false');
    expect(sessionRow()).toBeNull();
    expect(within(sessions()).getByRole('button', { name: 'Collapse all groups' })).toBeTruthy();
    expect((await axe(host)).violations).toEqual([]);

    surface.invalidate();
    expect(projectsToggle().getAttribute('aria-expanded')).toBe('false');
    expect(sessionsToggle().getAttribute('aria-expanded')).toBe('false');
    expect(projectRow()).toBeNull();
    expect(sessionRow()).toBeNull();

    fireEvent.click(sessionsToggle());
    expect(sessionRow()).not.toBeNull();
    // The archive keeps its own section state.
    fireEvent.click(host.querySelector('.claudian-session-archive-control')!);
    const archived = view.getByRole('region', { name: 'Archived' });
    expect(archived.hasAttribute('aria-label')).toBe(false);
    expect(within(archived).getByRole('button', { name: 'Archived' }).getAttribute('aria-expanded')).toBe('true');
  });

  it('shows matches in collapsed sections while searching, then restores the collapse', () => {
    const { host, region, view } = createProjectSurface();
    fireEvent.click(within(region()).getByRole('button', { name: t('chat.projects.header') }));
    fireEvent.click(host.querySelector('.claudian-session-search-control')!);

    fireEvent.input(view.getByRole('searchbox', { name: 'Search sessions' }), { target: { value: 'member' } });
    expect(within(region()).getByRole('button', { name: t('chat.projects.header') }).getAttribute('aria-expanded'))
      .toBe('true');
    expect(within(region()).getByRole('button', { name: sectionName('Launch', 1) })).toBeTruthy();

    fireEvent.keyDown(view.getByRole('searchbox', { name: 'Search sessions' }), { key: 'Escape' });
    expect(within(region()).getByRole('button', { name: t('chat.projects.header') }).getAttribute('aria-expanded'))
      .toBe('false');
    expect(within(region()).queryByRole('button', { name: sectionName('Launch', 1) })).toBeNull();
  });
});
