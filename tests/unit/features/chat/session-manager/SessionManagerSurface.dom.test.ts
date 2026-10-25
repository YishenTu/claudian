/** @jest-environment jsdom */

import '@/providers';

import { DEFAULT_CLAUDIAN_SETTINGS } from '@test/helpers/defaultSettings';
import { createProjectsFake, projectRecord } from '@test/helpers/features/chat/ProjectsFake';
import { testDate } from '@test/helpers/testClock';
import { fireEvent, waitFor, within } from '@testing-library/dom';
import { axe } from 'jest-axe';
import { Menu, setIcon } from 'obsidian';

import { ClaudianSettingsStorage } from '@/app/settings/ClaudianSettingsStorage';
import { SettingsCoordinator } from '@/app/settings/SettingsCoordinator';
import type { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';
import type { ClaudianSettings, ConversationMeta } from '@/core/types';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import { createProject } from '@/features/chat/projects/projectActions';
import { SessionBrowser } from '@/features/chat/session-manager/SessionBrowser';
import { SessionManagerSurface } from '@/features/chat/session-manager/SessionManagerSurface';
import { ChatViewPublisher } from '@/features/chat/workspace/ChatViewPublisher';
import { t } from '@/i18n/i18n';

jest.mock('@/features/chat/projects/projectActions', () => ({
  ...jest.requireActual('@/features/chat/projects/projectActions'),
  createProject: jest.fn(),
}));

HTMLElement.prototype.empty = function () { this.replaceChildren(); };
HTMLElement.prototype.addClass = function (...classes) { this.classList.add(...classes); };
HTMLElement.prototype.removeClass = function (...classes) { this.classList.remove(...classes); };
HTMLElement.prototype.hasClass = function (className) { return this.classList.contains(className); };
HTMLElement.prototype.setCssProps = function (props) {
  for (const [name, value] of Object.entries(props)) this.style.setProperty(name, value);
};
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

  function createProjectSurface({ wide = true, persisted }: {
    wide?: boolean;
    persisted?: { settings: ClaudianSettings; storage: ClaudianSettingsStorage };
  } = {}) {
    const conversations = [
      conversation('member', { title: 'Member session', projectId: 'launch', lastActivityAt: testDate({ hours: -1 }).getTime() }),
      conversation('loose', { title: 'Loose session' }),
      conversation('pinned', { title: 'Pinned session', isPinned: true }),
    ];
    const settings = persisted?.settings ?? { ...structuredClone(DEFAULT_CLAUDIAN_SETTINGS), enableAutoTitleGeneration: false };
    const views: { surface?: SessionManagerSurface } = {};
    const publisher = new ChatViewPublisher({
      views: { getAllViews: () => [{ notifyConversationListChanged: () => views.surface?.invalidate() }] },
    } as unknown as ConstructorParameters<typeof ChatViewPublisher>[0]);
    const coordinator = persisted && new SettingsCoordinator(
      settings,
      value => persisted.storage.save(value),
      (value, previous) => publisher.publishSettings(value, previous),
    );
    const plugin = {
      app: { vault: { getAbstractFileByPath: () => null } },
      settings,
      getConversationList: () => conversations,
      projects: createProjectsFake([
        projectRecord({ id: 'launch', name: 'Launch', createdAt: testDate({ days: -10 }).getTime() }),
        projectRecord({ id: 'empty', name: 'Empty', createdAt: testDate({ days: -2 }).getTime() }),
      ]),
      mutateSettings: jest.fn(async (mutation: (value: ClaudianSettings) => void) => {
        if (coordinator) return coordinator.mutate(mutation);
        mutation(settings);
        views.surface?.invalidate();
      }),
    };
    const navigation = {
      contentExists: () => true,
      getConversationStatus: () => ({ openState: 'closed', isRunning: false }) as const,
      openConversation: jest.fn().mockResolvedValue(undefined),
      openSessionConversation: jest.fn().mockResolvedValue(undefined),
      startLinkedContentConversation: jest.fn().mockResolvedValue(undefined),
      startProjectConversation: jest.fn().mockResolvedValue(undefined),
    };
    const surface = new SessionManagerSurface({
      plugin: plugin as unknown as ChatFeatureHost,
      navigation,
      getActiveTab: () => null,
      isWide: () => wide,
      canCreateTab: () => true,
      requestNew: jest.fn(),
      notifyOtherViews: jest.fn(),
    });
    views.surface = surface;
    const host = document.body.createDiv();
    surface.mountSidebar(host);
    surface.renderSidebar();
    const region = () => within(host).getByRole('region', { name: t('chat.projects.header') });
    return { host, navigation, plugin, region, settings, surface, view: within(host) };
  }

  afterEach(() => {
    menus().length = 0;
    jest.mocked(createProject).mockReset();
  });

  it.each([true, false])('restores project expansion after reloading persisted settings (wide: %s)', async wide => {
    const files = new Map<string, string>();
    const adapter = {
      exists: async (path: string) => files.has(path),
      read: async (path: string) => files.get(path)!,
      write: async (path: string, content: string) => { files.set(path, content); },
    } as unknown as VaultFileAdapter;
    const reload = async () => {
      const storage = new ClaudianSettingsStorage(adapter, DEFAULT_CLAUDIAN_SETTINGS);
      const ui = createProjectSurface({ wide, persisted: { settings: await storage.load(), storage } });
      if (!wide) {
        ui.surface.mountHistoryControl(ui.host);
        fireEvent.click(ui.view.getByRole('button', { name: 'Chat history' }));
      }
      return ui;
    };
    let ui = await reload();
    const toggle = () => ui.view.getByRole('button', { name: 'Launch' });
    const expectExpanded = async (expanded: boolean) => {
      await waitFor(() => expect(toggle().getAttribute('aria-expanded')).toBe(String(expanded)));
      expect(ui.view.queryByText('Member session') !== null).toBe(expanded);
    };
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle());
    await expectExpanded(true);
    if (wide) {
      fireEvent.click(ui.view.getByRole('button', { name: 'Search' }));
      fireEvent.input(ui.view.getByRole('searchbox'), { target: { value: 'member' } });
      fireEvent.click(toggle());
      await expectExpanded(false);
      fireEvent.keyDown(ui.view.getByRole('searchbox'), { key: 'Escape' });
      await expectExpanded(true);
    }
    ui.surface.dispose();
    ui.host.remove();

    ui = await reload();
    await expectExpanded(true);
    expect(ui.view.getByRole('button', { name: 'Empty' }).getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle());
    await expectExpanded(false);
    ui.surface.dispose();
    ui.host.remove();

    ui = await reload();
    await expectExpanded(false);
    ui.surface.dispose();
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

  it('lists projects in the compact history menu as the sidebar does, with membership moves and New in a project', async () => {
    const { host, navigation, plugin, surface } = createProjectSurface({ wide: false });
    surface.mountHistoryControl(host);
    // The view dismisses the drop-up on any click that reaches the document.
    const dismissOnDocumentClick = (event: Event) => surface.dismissDropdownFor(event);
    document.addEventListener('click', dismissOnDocumentClick);
    fireEvent.click(within(host).getByRole('button', { name: 'Chat history' }));
    const menuEl = host.querySelector<HTMLElement>('.claudian-history-menu')!;
    const history = () => within(menuEl);
    const projects = () => within(history().getByRole('region', { name: t('chat.projects.header') }));
    const titles = () => menus().at(-1)!.items.map(entry => entry.title);

    // Same header actions and collapsed project rows as the sidebar.
    expect(projects().getAllByRole('button', { expanded: false }).map(toggle => toggle.textContent))
      .toEqual([sectionName('Launch', 1), sectionName('Empty', 0)]);
    fireEvent.click(projects().getByRole('button', { name: t('chat.projects.newProjectAction') }));
    expect(createProject).toHaveBeenCalledWith(plugin);
    fireEvent.click(projects().getByRole('button', { name: t('chat.projects.options') }));
    expect(titles()[0]).toBe(t('chat.projects.sortBy'));
    // Members leave the session list; without a Pinned section, pinned sessions stay in it.
    const sessions = within(history().getByRole('region', { name: 'Sessions' }));
    expect(sessions.queryByText('Member session')).toBeNull();
    expect(sessions.getByText('Pinned session')).toBeTruthy();
    expect((await axe(menuEl)).violations).toEqual([]);

    fireEvent.click(projects().getByRole('button', { name: sectionName('Launch', 1) }));
    expect(projects().getByRole('button', { name: sectionName('Launch', 1) }).getAttribute('aria-expanded')).toBe('true');
    // Toggles inside the drop-up keep it open; only a click outside dismisses it.
    expect(menuEl.hasClass('visible')).toBe(true);
    fireEvent.click(history().getByRole('button', { name: 'Sessions' }));
    fireEvent.click(history().getByRole('button', { name: 'Sessions' }));
    expect(menuEl.hasClass('visible')).toBe(true);
    fireEvent.contextMenu(projects().getByText('Member session'));
    expect(titles()).toEqual(expect.arrayContaining([t('chat.projects.menu.moveTo'), t('chat.projects.menu.removeFrom')]));
    fireEvent.contextMenu(sessions.getByText('Loose session'));
    expect(titles()).toContain(t('chat.projects.menu.moveTo'));

    fireEvent.click(projects().getByRole('button', { name: t('chat.projects.newSessionIn', { name: 'Launch' }) }));
    await Promise.resolve();
    await Promise.resolve();
    expect(navigation.startProjectConversation).toHaveBeenCalledWith('launch');
    expect(menuEl.hasClass('visible')).toBe(false);

    fireEvent.click(within(host).getByRole('button', { name: 'Chat history' }));
    expect(menuEl.hasClass('visible')).toBe(true);
    fireEvent.click(document.body);
    expect(menuEl.hasClass('visible')).toBe(false);
    document.removeEventListener('click', dismissOnDocumentClick);
  });

  it('keeps an expanded project header in place in the compact menu, which scrolls as one list', () => {
    const { host, surface } = createProjectSurface({ wide: false });
    surface.mountHistoryControl(host);
    fireEvent.click(within(host).getByRole('button', { name: 'Chat history' }));
    const menuEl = host.querySelector<HTMLElement>('.claudian-history-menu')!;
    // jsdom has no layout: stack every row 40px tall in document order inside a 400px list.
    const rowSelector = '.claudian-history-item, .claudian-session-group-header, .claudian-history-header, .claudian-history-archive-control';
    const rect = (top: number, height: number) => ({ top, bottom: top + height, height, left: 0, right: 300, width: 300 }) as DOMRect;
    const layout = jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const list = menuEl.querySelector<HTMLElement>('.claudian-history-list')!;
      if (this === list) return rect(0, 400);
      const rows = Array.from(list.querySelectorAll<HTMLElement>(rowSelector));
      const index = rows.indexOf(this);
      return index < 0 ? rect(0, 0) : rect(index * 40 - list.scrollTop, 40);
    });
    try {
      const launchHeader = () => menuEl.querySelector<HTMLElement>('[data-project-id="launch"]')!;
      const before = launchHeader().getBoundingClientRect().top;
      fireEvent.click(within(menuEl).getByRole('button', { name: sectionName('Launch', 1) }));
      expect(within(menuEl).getByText('Member session')).toBeTruthy();
      expect(launchHeader().getBoundingClientRect().top).toBe(before);
    } finally {
      layout.mockRestore();
    }
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
