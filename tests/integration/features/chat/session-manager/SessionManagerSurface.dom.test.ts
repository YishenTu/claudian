/** @vitest-environment jsdom */
import '@/providers';

import { axe } from '@test/helpers/accessibility';
import { claudeCatalogFixture } from '@test/helpers/claudeModels';
import { DesktopVault } from '@test/helpers/core/DesktopVault';
import { DEFAULT_CLAUDIAN_SETTINGS } from '@test/helpers/defaultSettings';
import { createFeatureHostFixture } from '@test/helpers/FeatureHostFixture';
import { createProjectsFake, projectRecord } from '@test/helpers/features/chat/ProjectsFake';
import { createSessionBrowserHost } from '@test/helpers/features/chat/SessionBrowserTestHarness';
import { createObsidianWorkspace } from '@test/helpers/ObsidianWorkspace';
import { testDate } from '@test/helpers/testClock';
import { fireEvent, waitFor, within } from '@testing-library/dom';
import { App, Menu, Notice, setIcon } from 'obsidian';

import { ClaudianSettingsStorage } from '@/app/settings/ClaudianSettingsStorage';
import type { TitleGenerationService } from '@/core/providers/types';
import type { Conversation, ConversationMeta, SessionManagerSort } from '@/core/types';
import { SessionBrowser } from '@/features/chat/session-manager/SessionBrowser';
import { SessionManagerSurface } from '@/features/chat/session-manager/SessionManagerSurface';
import type { HistoryConversationStatus } from '@/features/chat/session-manager/SessionStatusPresentation';
import { setLocale, t } from '@/i18n/i18n';
import type { Locale } from '@/i18n/types';



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

async function createSurface(options: {
  conversations?: ConversationMeta[];
  wide?: boolean;
  locale?: Locale;
  projects?: ReturnType<typeof projectRecord>[];
  beforePersist?: NonNullable<Parameters<typeof createFeatureHostFixture>[0]>['beforePersist'];
} = {}) {
  // Active rows carry their own Archive action; an archived-only list keeps navigation names unique.
  const conversations = options.conversations ?? [conversation('archived', { isArchived: true })];
  const workspace = createObsidianWorkspace(document.body);
  const app = new App();
  Object.assign(app.workspace, workspace);
  const fixture = await createFeatureHostFixture({
    app, settings: { enableAutoTitleGeneration: false, locale: options.locale ?? 'en' },
    beforePersist: options.beforePersist, afterPublish: () => surface.invalidate(),
  });
  const renameConversation = vi.fn(async (id: string, title: string) => {
    const record = conversations.find(record => record.id === id);
    if (record) record.title = title;
  });
  const { plugin } = await createSessionBrowserHost({ conversations, host: {
    fixture, renameConversation,
    projects: createProjectsFake(options.projects),
  } });
  const requestNew = vi.fn();
  const surface = new SessionManagerSurface({
    plugin,
    navigation: {
      contentExists: () => true,
      getConversationStatus: () => ({ openState: 'closed', isRunning: false }),
      openConversation: vi.fn().mockResolvedValue(undefined),
      openSessionConversation: vi.fn().mockResolvedValue(undefined),
      startLinkedContentConversation: vi.fn().mockResolvedValue(undefined),
      startProjectConversation: vi.fn().mockResolvedValue(undefined),
    },
    getActiveTab: () => null,
    isWide: () => options.wide ?? true,
    canCreateTab: () => true,
    requestNew,
    notifyOtherViews: vi.fn(),
  });
  const host = document.body.createDiv();
  onTestFinished(() => surface.dispose());
  surface.mountSidebar(host);
  surface.renderSidebar();
  return { host, requestNew, surface, workspace, plugin, renameConversation, fixture };
}

afterEach(() => {
  setLocale('en');
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

it('follows the left sidebar theme token through theme changes and releases its listener', async () => {
  const navigation = document.body.createDiv({ cls: 'mod-left-split' });
  navigation.style.setProperty('--nav-item-background-active', 'rgba(100, 100, 100, 0.2)');
  const { host, surface, workspace } = await createSurface();
  const background = () => host.style.getPropertyValue('--claudian-session-background-active');
  try {
    expect(background()).toBe('rgba(100, 100, 100, 0.2)');
    navigation.style.setProperty('--nav-item-background-active', 'transparent');
    workspace.trigger('css-change');
    expect(background()).toBe('transparent');
    navigation.style.setProperty('--nav-item-background-active', 'rgb(30, 30, 30)');
    workspace.trigger('css-change');
    expect(background()).toBe('rgb(30, 30, 30)');
    navigation.remove();
    workspace.trigger('css-change');
    expect(background()).toBe('');
  } finally {
    surface.dispose();
  }
  expect(workspace.listenerCount()).toBe(0);
});

it.each(['editing query', 'list invalidation'])('preserves the search caret and selection while %s', async action => {
  const { host, surface } = await createSurface();
  const ui = within(host);
  try {
    fireEvent.click(ui.getByRole('button', { name: 'Search' }));
    fireEvent.input(ui.getByRole('searchbox', { name: 'Search sessions' }), { target: { value: 'abcdef' } });
    const input = ui.getByRole('searchbox', { name: 'Search sessions' }) as HTMLInputElement;
    if (action === 'editing query') {
      input.value = 'abXcdef';
      input.setSelectionRange(3, 3);
      fireEvent.input(input);
    } else {
      input.setSelectionRange(1, 4, 'backward');
      surface.invalidate();
    }
    const current = ui.getByRole('searchbox', { name: 'Search sessions' }) as HTMLInputElement;
    expect(document.activeElement).toBe(current);
    expect([current.selectionStart, current.selectionEnd, current.selectionDirection]).toEqual(
      action === 'editing query' ? [3, 3, 'none'] : [1, 4, 'backward'],
    );
    expect(current.value).toBe(action === 'editing query' ? 'abXcdef' : 'abcdef');
    expect(await axe(host)).toHaveNoViolations();
  } finally {
    surface.dispose();
  }
});

it.each([false, true])('opens selectable history rows by keyboard (metadata popovers: %s)', async showMetadataPopover => {
  const onSelectConversation = vi.fn().mockResolvedValue(undefined);
  const browser = new SessionBrowser({
    plugin: (await createSessionBrowserHost({ conversations: [conversation('Keyboard session'), conversation('current', { title: 'Active conversation' })], host: { settings: { enableAutoTitleGeneration: false } } })).plugin,
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
  const { host, requestNew, surface } = await createSurface();
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
  const folderIcon = (toggle: HTMLElement) => vi.mocked(setIcon).mock.calls
    .filter(([element]) => toggle.contains(element)).at(-1)?.[1];

  async function createProjectSurface({ wide = true, vault }: {
    wide?: boolean;
    vault?: DesktopVault;
  } = {}) {
    const conversations = [
      conversation('member', { title: 'Member session', projectId: 'launch', lastActivityAt: testDate({ hours: -1 }).getTime() }),
      conversation('loose', { title: 'Loose session' }),
      conversation('pinned', { title: 'Pinned session', isPinned: true }),
    ];
    const settings = vault
      ? await new ClaudianSettingsStorage(vault.files, DEFAULT_CLAUDIAN_SETTINGS).load()
      : { ...structuredClone(DEFAULT_CLAUDIAN_SETTINGS), enableAutoTitleGeneration: false };
    const fixture = await createFeatureHostFixture({
      app: new App(), vault, settings, afterPublish: () => surface.invalidate(),
    });
    const { plugin } = await createSessionBrowserHost({ conversations, host: {
      fixture,
      projects: createProjectsFake([
        projectRecord({ id: 'launch', name: 'Launch', createdAt: testDate({ days: -10 }).getTime() }),
        projectRecord({ id: 'empty', name: 'Empty', icon: 'lucide-rocket', createdAt: testDate({ days: -2 }).getTime() }),
      ]),
    } });
    vi.spyOn(plugin, 'mutateSettings');
    const navigation = {
      contentExists: () => true,
      getConversationStatus: () => ({ openState: 'closed', isRunning: false }) as const,
      openConversation: vi.fn().mockResolvedValue(undefined),
      openSessionConversation: vi.fn().mockResolvedValue(undefined),
      startLinkedContentConversation: vi.fn().mockResolvedValue(undefined),
      startProjectConversation: vi.fn().mockResolvedValue(undefined),
    };
    const surface = new SessionManagerSurface({
      plugin,
      navigation,
      getActiveTab: () => null,
      isWide: () => wide,
      canCreateTab: () => true,
      requestNew: vi.fn(),
      notifyOtherViews: vi.fn(),
    });
    const host = document.body.createDiv();
    onTestFinished(() => surface.dispose());
  surface.mountSidebar(host);
    surface.renderSidebar();
    const region = () => within(host).getByRole('region', { name: t('chat.projects.header') });
    return { host, navigation, plugin, region, settings: plugin.settings, surface, view: within(host) };
  }

  afterEach(() => {
    menus().length = 0;
  });

  it.each([true, false])('restores project expansion after reloading persisted settings (wide: %s)', async wide => {
    const vault = await DesktopVault.create();
    onTestFinished(() => vault.dispose());
    const reload = async () => {
      const ui = await createProjectSurface({ wide, vault });
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

  it('heads the projects with New project only, without a By project organization', async () => {
    const { host, region, view } = await createProjectSurface();
    const projectToggles = () => within(region()).getAllByRole('button', { expanded: false })
      .map(toggle => toggle.textContent);
    // Projects start collapsed, above the sessions, newest first until the user reorders them.
    expect(projectToggles()).toEqual([sectionName('Empty', 0), sectionName('Launch', 1)]);
    expect(within(view.getByRole('region', { name: 'Sessions' })).queryByText('Member session')).toBeNull();

    const newProject = within(region()).getByRole('button', { name: t('chat.projects.newProjectAction') });
    expect(newProject.tagName).toBe('BUTTON');
    expect(newProject.getAttribute('type')).toBe('button');
    fireEvent.click(newProject);
    const dialog = within(document.body).getByRole('dialog', { name: t('chat.projects.editor.titleNew') });
    expect(within(dialog).getByRole('textbox', { name: t('chat.projects.editor.name') })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect((await axe(host)).violations).toEqual([]);

    // Projects keep the user's dragged order, so the header has no sort menu.
    const header = region().querySelector<HTMLElement>('.claudian-session-projects-header')!;
    expect(within(header).getAllByRole('button').map(button => button.getAttribute('aria-label') ?? button.textContent))
      .toEqual([t('chat.projects.header'), t('chat.projects.newProjectAction')]);

    fireEvent.click(view.getByRole('button', { name: 'Session options' }));
    const sessionMenu = menus().at(-1)!;
    expect(sessionMenu.items.map(entry => entry.title)).toEqual(expect.arrayContaining(['In one list', 'By linked content']));
    expect(sessionMenu.items.map(entry => entry.title)).not.toContain('By project');
  });

  it('lists projects in the compact history menu as the sidebar does, with membership moves and New in a project', async () => {
    const { host, navigation, plugin, surface } = await createProjectSurface({ wide: false });
    surface.mountHistoryControl(host);
    // The view dismisses the drop-up on any click that reaches the document.
    const dismissOnDocumentClick = (event: Event) => surface.dismissDropdownFor(event);
    document.addEventListener('click', dismissOnDocumentClick);
    onTestFinished(() => document.removeEventListener('click', dismissOnDocumentClick));
    fireEvent.click(within(host).getByRole('button', { name: 'Chat history' }));
    const menuEl = host.querySelector<HTMLElement>('.claudian-history-menu')!;
    const history = () => within(menuEl);
    const projects = () => within(history().getByRole('region', { name: t('chat.projects.header') }));
    const titles = () => menus().at(-1)!.items.map(entry => entry.title);

    // Same header actions and collapsed project rows as the sidebar.
    expect(projects().getAllByRole('button', { expanded: false }).map(toggle => toggle.textContent))
      .toEqual([sectionName('Empty', 0), sectionName('Launch', 1)]);
    fireEvent.click(projects().getByRole('button', { name: t('chat.projects.newProjectAction') }));
    const dialog = within(document.body).getByRole('dialog', { name: t('chat.projects.editor.titleNew') });
    expect(within(dialog).getByRole('textbox', { name: t('chat.projects.editor.name') })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(menuEl.hasClass('visible')).toBe(false);
    fireEvent.click(within(host).getByRole('button', { name: 'Chat history' }));
    // Members leave the session list; without a Pinned section, pinned sessions stay in it.
    const sessions = () => within(history().getByRole('region', { name: 'Sessions' }));
    expect(sessions().queryByText('Member session')).toBeNull();
    expect(sessions().getByText('Pinned session')).toBeTruthy();
    expect((await axe(menuEl)).violations).toEqual([]);

    fireEvent.click(projects().getByRole('button', { name: sectionName('Launch', 1) }));
    await vi.mocked(plugin.mutateSettings).mock.results.at(-1)!.value;
    expect(projects().getByRole('button', { name: sectionName('Launch', 1) }).getAttribute('aria-expanded')).toBe('true');
    // Toggles inside the drop-up keep it open; only a click outside dismisses it.
    expect(menuEl.hasClass('visible')).toBe(true);
    fireEvent.click(history().getByRole('button', { name: 'Sessions' }));
    fireEvent.click(history().getByRole('button', { name: 'Sessions' }));
    expect(menuEl.hasClass('visible')).toBe(true);
    fireEvent.contextMenu(projects().getByText('Member session'));
    expect(titles()).toEqual(expect.arrayContaining([t('chat.projects.menu.moveTo'), t('chat.projects.menu.removeFrom')]));
    fireEvent.contextMenu(sessions().getByText('Loose session'));
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

  it('keeps an expanded project header in place in the compact menu, which scrolls as one list', async () => {
    const { host, plugin, surface } = await createProjectSurface({ wide: false });
    surface.mountHistoryControl(host);
    fireEvent.click(within(host).getByRole('button', { name: 'Chat history' }));
    const menuEl = host.querySelector<HTMLElement>('.claudian-history-menu')!;
    // jsdom has no layout: stack every row 40px tall in document order inside a 400px list.
    const rowSelector = '.claudian-history-item, .claudian-session-group-header, .claudian-history-header, .claudian-history-archive-control';
    const rect = (top: number, height: number) => ({ top, bottom: top + height, height, left: 0, right: 300, width: 300 }) as DOMRect;
    const layout = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
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
      await vi.mocked(plugin.mutateSettings).mock.results.at(-1)!.value;
      expect(within(menuEl).getByText('Member session')).toBeTruthy();
      expect(launchHeader().getBoundingClientRect().top).toBe(before);
    } finally {
      layout.mockRestore();
    }
  });

  it('keeps the wide session list at the top when newer sessions load above it, as after startup', async () => {
    const { host, plugin, surface } = await createProjectSurface();
    const sessionList = () => host.querySelector<HTMLElement>('.claudian-session-list-items')!;
    // jsdom has no layout: stack every session row 40px tall in document order.
    const layout = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const list = sessionList();
      const index = Array.from(list.querySelectorAll<HTMLElement>('.claudian-history-item, .claudian-session-group-header')).indexOf(this);
      const top = this === list ? 0 : index * 40 - list.scrollTop;
      const height = this === list ? 400 : index < 0 ? 0 : 40;
      return { top, bottom: top + height, height, left: 0, right: 300, width: 300 } as DOMRect;
    });
    try {
      const newer = (minutes: number) => conversation(`newer-${minutes}`, { lastActivityAt: testDate({ minutes }).getTime() });
      plugin.getConversationList().push(...Array.from({ length: 20 }, (_, index) => newer(-index)));
      surface.invalidate();
      expect(sessionList().scrollTop).toBe(0);

      // A scrolled list keeps its first visible row in place instead.
      sessionList().scrollTop = 80;
      plugin.getConversationList().push(newer(1));
      surface.invalidate();
      expect(sessionList().scrollTop).toBe(120);
    } finally {
      layout.mockRestore();
    }
  });

  it('keeps a project expanded across re-renders and the archive, which hides the section', async () => {
    const { host, plugin, region, surface, view } = await createProjectSurface();

    const emptyToggle = () => within(region()).getByRole('button', { name: sectionName('Empty', 0) });
    // A chosen icon stays in both states; the default folder swaps (Launch, below).
    expect(folderIcon(emptyToggle())).toBe('lucide-rocket');
    fireEvent.click(emptyToggle());
    await vi.mocked(plugin.mutateSettings).mock.results.at(-1)!.value;
    expect(within(region()).getByText(t('chat.projects.noSessions'))).toBeTruthy();
    expect(folderIcon(emptyToggle())).toBe('lucide-rocket');
    surface.invalidate();
    expect(emptyToggle().getAttribute('aria-expanded')).toBe('true');
    expect(folderIcon(emptyToggle())).toBe('lucide-rocket');
    fireEvent.click(emptyToggle());
    await vi.mocked(plugin.mutateSettings).mock.results.at(-1)!.value;
    expect(folderIcon(emptyToggle())).toBe('lucide-rocket');
    fireEvent.click(emptyToggle());
    await vi.mocked(plugin.mutateSettings).mock.results.at(-1)!.value;

    fireEvent.click(host.querySelector('.claudian-session-archive-control')!);
    expect(view.queryByRole('region', { name: t('chat.projects.header') })).toBeNull();
    fireEvent.click(host.querySelector('.claudian-session-archive-control')!);
    expect(within(region()).getByRole('button', { name: sectionName('Empty', 0) }).getAttribute('aria-expanded'))
      .toBe('true');
  });

  it('finds project members by search under their expanded project, then restores the collapsed projects', async () => {
    const { host, region, view } = await createProjectSurface();
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
    const { host, region, plugin, surface, view } = await createProjectSurface();
    await plugin.mutateSettings(settings => { settings.sessionManagerOrganization = 'linked-content'; });
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

  it('shows matches in collapsed sections while searching, then restores the collapse', async () => {
    const { host, region, view } = await createProjectSurface();
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


describe('selected interface language in the session manager', () => {
  type MenuEntry = { title: string; checked: boolean | null; clickHandler: (() => void) | null };
  const menu = () => (Menu as unknown as { instances: Array<{ items: MenuEntry[] }> }).instances.at(-1)!;
  const titles = () => menu().items.map(item => item.title);
  const choose = (title: string) => {
    const entry = menu().items.find(item => item.title === title);
    expect(titles()).toContain(title);
    entry!.clickHandler?.();
  };

  it('uses the current locale for fresh wide and compact navigation without translating data', async () => {
    for (const [locale, labels] of [
      ['en', ['New', 'Search', 'Archive', 'Sessions', 'Archived', 'Search sessions', 'Search archived sessions', 'Chat history']],
      ['zh-CN', ['新建', '搜索', '归档', '会话', '已归档', '搜索会话', '搜索已归档会话', '聊天记录']],
      ['en', ['New', 'Search', 'Archive', 'Sessions', 'Archived', 'Search sessions', 'Search archived sessions', 'Chat history']],
    ] as const) {
      setLocale(locale);
      const [newLabel, search, archive, sessions, archived, activeSearch, archiveSearch, history] = labels;
      const ui = await createSurface({ locale, projects: [projectRecord({ id: 'native-project', name: 'Unlinked' })], conversations: [
        conversation('native:Archive/Created', { title: 'Archive' }),
        conversation('native-archived', { title: 'Created', isArchived: true }),
      ] });
      const view = within(ui.host);
      expect(view.getByRole('region', { name: sessions })).toBeTruthy();
      expect(view.getByText('Archive', { selector: '.claudian-history-item-title' })).toBeTruthy();
      expect(view.getByRole('button', { name: 'Unlinked' })).toBeTruthy();
      fireEvent.click(view.getByRole('button', { name: search }));
      const query = view.getByRole('searchbox', { name: activeSearch }) as HTMLInputElement;
      expect(query.placeholder).toBe(activeSearch);
      fireEvent.input(query, { target: { value: 'Archive' } });
      expect((view.getByRole('searchbox') as HTMLInputElement).value).toBe('Archive');
      expect(view.getByText('Archive', { selector: '.claudian-history-item-title' })).toBeTruthy();
      fireEvent.keyDown(view.getByRole('searchbox'), { key: 'Escape' });
      fireEvent.click(view.getAllByRole('button', { name: archive }).find(button => button.classList.contains('claudian-session-archive-control'))!);
      expect(view.getByRole('region', { name: archived })).toBeTruthy();
      expect(view.getByText('Created')).toBeTruthy();
      fireEvent.click(view.getByRole('button', { name: search }));
      expect((view.getByRole('searchbox', { name: archiveSearch }) as HTMLInputElement).placeholder).toBe(archiveSearch);
      fireEvent.click(view.getByRole('button', { name: sessions }));
      fireEvent.click(view.getByRole('button', { name: newLabel }));
      expect(ui.requestNew).toHaveBeenCalledTimes(1);
      expect(await axe(ui.host)).toHaveNoViolations();
      ui.surface.dispose();
      ui.host.remove();

      const compact = await createSurface({ wide: false, conversations: [conversation('native-archived', { title: 'Created', isArchived: true })] });
      compact.surface.mountHistoryControl(compact.host);
      fireEvent.click(within(compact.host).getByRole('button', { name: history }));
      fireEvent.click(within(compact.host).getByRole('button', { name: archive }));
      expect(within(compact.host).getByText(archived)).toBeTruthy();
      expect(within(compact.host).getByText('Created')).toBeTruthy();
      fireEvent.click(within(compact.host).getByRole('button', { name: sessions }));
      expect(within(compact.host).getByRole('button', { name: archive })).toBeTruthy();
      compact.surface.dispose();
      compact.host.remove();
    }
  });

  it('localizes options and collapse controls while persisting the original enum values', async () => {
    setLocale('zh-CN');
    const { host, plugin } = await createSurface({ conversations: [conversation('native-id', { title: 'Created' })] });
    const view = within(host);
    const openOptions = () => fireEvent.click(view.getByRole('button', { name: '会话选项' }));
    openOptions();
    expect(titles()).toEqual(['组织会话', '单一列表', '按关联内容', '会话排序依据', '最近活动', '创建时间']);
    expect(menu().items.filter(item => item.checked).map(item => item.title)).toEqual(['单一列表', '最近活动']);
    choose('按关联内容');
    await waitFor(() => expect(view.getByRole('button', { name: '折叠所有分组' })).toBeTruthy());
    expect(plugin.getCommittedSettings().sessionManagerOrganization).toBe('linked-content');
    expect(view.getByRole('button', { name: '未关联' })).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: '折叠所有分组' }));
    expect(view.queryByText('Created')).toBeNull();
    fireEvent.click(view.getByRole('button', { name: '展开所有分组' }));
    expect(view.getByText('Created')).toBeTruthy();
    openOptions();
    choose('创建时间');
    await waitFor(() => expect(plugin.getCommittedSettings().sessionManagerSort).toBe('created'));
    openOptions();
    expect(menu().items.filter(item => item.checked).map(item => item.title)).toEqual(['按关联内容', '创建时间']);
    choose('最近活动');
    await waitFor(() => expect(plugin.getCommittedSettings().sessionManagerSort).toBe('last-updated'));
    openOptions();
    choose('单一列表');
    await waitFor(() => expect(view.getByText('过去一周')).toBeTruthy());
    expect(plugin.getCommittedSettings().sessionManagerOrganization).toBe('list');
  });

  it.each([
    ['organization', '按关联内容', '无法更新会话组织方式'],
    ['sort', '创建时间', '无法更新会话排序'],
    ['expansion', 'Unlinked', '无法保存项目文件夹展开状态'],
  ])('reports the localized %s persistence failure through the real settings coordinator', async (kind, choice, message) => {
    setLocale('zh-CN');
    const { host, plugin } = await createSurface({ locale: 'zh-CN', projects: [projectRecord({ id: 'native-project', name: 'Unlinked' })], beforePersist: () => { throw new Error('raw storage diagnostic'); } });
    const view = within(host);
    if (kind === 'expansion') fireEvent.click(view.getByRole('button', { name: choice }));
    else {
      fireEvent.click(view.getByRole('button', { name: '会话选项' }));
      choose(choice);
    }
    await waitFor(() => expect(Notice).toHaveBeenCalledWith(message));
    expect(plugin.getCommittedSettings().sessionManagerOrganization).toBe('list');
    expect(plugin.getCommittedSettings().sessionManagerSort).toBe('last-updated');
    expect(view.getByRole('button', { name: 'Unlinked' }).getAttribute('aria-expanded')).toBe('false');
  });

  it('keeps native titles in the real inline editor and preserves cancel, trim and rename failures', async () => {
    setLocale('zh-CN');
    const id = 'native:Archive/Created';
    const { host, renameConversation } = await createSurface({ conversations: [conversation(id, { title: 'Archive' })] });
    const view = within(host);
    const begin = async () => {
      fireEvent.contextMenu(view.getByText('Archive', { selector: '.claudian-history-item-title' }));
      choose('重命名');
      return await waitFor(() => view.getByRole('textbox', { name: '会话标题' }) as HTMLInputElement);
    };
    let input = await begin();
    expect(input.value).toBe('Archive');
    fireEvent.input(input, { target: { value: 'Do not save' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    await waitFor(() => expect(view.queryByRole('textbox')).toBeNull());
    expect(renameConversation).not.toHaveBeenCalled();
    input = await begin();
    fireEvent.input(input, { target: { value: '  Created  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(view.getByText('Created')).toBeTruthy());
    expect(renameConversation.mock.calls).toEqual([[id, 'Created']]);
    renameConversation.mockRejectedValueOnce(new Error('raw rename diagnostic'));
    fireEvent.contextMenu(view.getByText('Created'));
    choose('重命名');
    input = await waitFor(() => view.getByRole('textbox', { name: '会话标题' }) as HTMLInputElement);
    fireEvent.input(input, { target: { value: 'Rejected' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(Notice).toHaveBeenCalledWith('无法重命名会话'));
    expect(input.isConnected).toBe(true);
  });

  async function renderBrowser(records: ConversationMeta[], options: Parameters<SessionBrowser['renderHistoryDropdown']>[1]) {
    const { plugin } = await createSessionBrowserHost({ conversations: records });
    const browser = new SessionBrowser({ plugin, getCurrentConversationId: () => null, getTitleGenerationService: () => null, onListChanged: () => undefined });
    onTestFinished(() => browser.dispose());
    const host = document.body.createDiv();
    browser.renderHistoryDropdown(host, options);
    return { host, browser };
  }

  it.each(['created', 'last-updated'] as const)('localizes categories after %s ordering and keeps raw linked-title ties and membership', async (sort: SessionManagerSort) => {
    const records = ['Archive', 'Created', 'Unlinked', 'zzzz'].map(title => conversation(`native:${title}`, { title: `Session ${title}`, linkedContentPath: `Projects/${title}.md` }));
    records.push(conversation('native:ungrouped', { title: 'Native ungrouped' }));
    const render = async (locale: Locale) => {
      setLocale(locale);
      const { host, browser } = await renderBrowser(records, {
        onSelectConversation: vi.fn(), organization: 'linked-content', sort,
        contentExists: () => true, contentIsNote: () => false,
      });
      const sequence = [...host.querySelectorAll<HTMLElement>('[data-group-key]')].map(group => ({
        key: group.dataset.groupKey,
        ids: [...group.querySelectorAll<HTMLElement>('[data-conversation-id]')].map(row => row.dataset.conversationId),
      }));
      return { host, browser, sequence };
    };
    const english = await render('en');
    const original = english.sequence;
    expect(original.filter(group => group.ids.length).flatMap(group => group.ids)).toHaveLength(5);
    english.browser.dispose(); english.host.remove();
    const chinese = await render('zh-CN');
    expect(chinese.sequence).toEqual(original);
    expect(within(chinese.host).getByRole('button', { name: '未关联' })).toBeTruthy();
    for (const title of ['Archive', 'Created', 'Unlinked', 'zzzz']) expect(within(chinese.host).getByRole('button', { name: title })).toBeTruthy();
  });

  it('localizes recency, pinned, missing and paging chrome while routing the native linked path', async () => {
    setLocale('zh-CN');
    const onSelectConversation = vi.fn().mockResolvedValue(undefined);
    const records = [1, 10, 20, 60].map(days => conversation(`native:${days}`, { lastActivityAt: testDate({ days: -days }).getTime() }));
    records.push(conversation('native:pinned', { isPinned: true }));
    const recency = await renderBrowser(records, { onSelectConversation, showPinnedSection: true, groupByRecency: true, sessionActionMode: 'active' });
    for (const label of ['已置顶', '过去一周', '过去两周', '过去一个月', '更早']) expect(within(recency.host).getByText(label)).toBeTruthy();
    fireEvent.click(within(recency.host).getByRole('button', { name: '过去一周 的操作' }));
    expect(titles()).toEqual(['归档所有会话']);
    const onStartLinkedContentConversation = vi.fn().mockResolvedValue(undefined);
    const linked = await renderBrowser([
      conversation('native:Archive', { title: 'Created', linkedContentPath: 'Projects/Archive.md' }),
      conversation('native:missing', { linkedContentPath: 'Projects/Gone.md' }),
    ], {
      onSelectConversation, onStartLinkedContentConversation,
      organization: 'linked-content', contentExists: path => path !== 'Projects/Gone.md', contentIsNote: () => false,
    });
    expect(within(linked.host).getByText('缺失')).toBeTruthy();
    fireEvent.click(within(linked.host).getByRole('button', { name: '为 Archive 新建聊天' }));
    await waitFor(() => expect(onStartLinkedContentConversation).toHaveBeenCalledWith('Projects/Archive.md'));
    onStartLinkedContentConversation.mockRejectedValueOnce(new Error('raw linked diagnostic'));
    fireEvent.click(within(linked.host).getByRole('button', { name: '为 Archive 新建聊天' }));
    await waitFor(() => expect(Notice).toHaveBeenCalledWith('无法为此关联内容开始聊天'));
    const paging = await renderBrowser(records.slice(0, 2), { onSelectConversation, pageSize: 1 });
    const more = within(paging.host).getByRole('button', { name: '加载更多（剩余 1 个）' });
    fireEvent.click(more);
    expect(paging.host.querySelectorAll('[data-conversation-id]')).toHaveLength(2);
  });

  it('translates real status sentences and badge alternatives from native status data', async () => {
    setLocale('zh-CN');
    const since = testDate().getTime();
    const cases: Array<[HistoryConversationStatus, string]> = [
      [{ openState: 'closed', isRunning: false, attention: { kind: 'action-required', since } }, '需要输入'],
      [{ openState: 'open', isRunning: true, location: 'other-view' }, '正在另一个窗格中运行'],
      [{ openState: 'open', isRunning: false, location: 'other-view' }, '已在另一个窗格中打开'],
      [{ openState: 'open', isRunning: true, tabIndex: 3 }, '正在标签页 3 中运行'],
      [{ openState: 'current', isRunning: true }, '正在当前标签页中运行'],
      [{ openState: 'open', isRunning: true }, '正在标签页中运行'],
      [{ openState: 'closed', isRunning: true }, '运行中'],
      [{ openState: 'current', isRunning: false, tabIndex: 3 }, '当前标签页 3'],
      [{ openState: 'current', isRunning: false }, '当前会话'],
      [{ openState: 'open', isRunning: false, tabIndex: 3 }, '已在标签页 3 中打开'],
      [{ openState: 'open', isRunning: false }, '已在标签页中打开'],
    ];
    for (const [status, label] of cases) {
      const { host, browser } = await renderBrowser([conversation('native-id', { title: 'Archive' })], {
        onSelectConversation: vi.fn(), showMetadataPopover: false, getConversationStatus: () => status,
      });
      expect(within(host).getByText(label)).toBeTruthy();
      expect(within(host).getByText('Archive')).toBeTruthy();
      browser.dispose(); host.remove();
    }
    for (const [status, label] of [
      [{ openState: 'closed', isRunning: false, attention: { kind: 'action-required', since } }, '需要您输入'],
      [{ openState: 'closed', isRunning: false, attention: { kind: 'review', outcome: 'error', since } }, '因错误而停止'],
      [{ openState: 'closed', isRunning: true }, '运行中'],
      [{ openState: 'closed', isRunning: false, attention: { kind: 'review', outcome: 'completed', since } }, '未读'],
    ] satisfies Array<[HistoryConversationStatus, string]>) {
      const { host, browser } = await renderBrowser([conversation('native-id')], {
        onSelectConversation: vi.fn(), showAttentionState: true, showOpenStateLabels: false, getConversationStatus: () => status,
      });
      expect(within(host).getByLabelText(label)).toBeTruthy();
      browser.dispose(); host.remove();
    }
  });

  it('localizes title generation controls without changing the real owner request or native result', async () => {
    setLocale('zh-CN');
    const record: Conversation = {
      id: 'native:Archive/Created', providerId: 'claude', sessionId: null, title: 'Archive',
      createdAt: testDate({ days: -1 }).getTime(), lastActivityAt: testDate().getTime(),
      messages: [{ id: 'native-message', role: 'user', content: 'Explain Created', timestamp: testDate().getTime() }],
    };
    const generateTitle = vi.fn<TitleGenerationService['generateTitle']>(async (id, _text, callback) => callback(id, { success: true, title: 'Native Created' }));
    const completeConversationTitleGeneration = vi.fn(async (_id, _expectedTitle, title) => {
      if (title !== null) record.title = title;
      record.titleGenerationStatus = title === null ? 'failed' : 'success';
    });
    const { plugin } = await createSessionBrowserHost({ host: {
      settings: { enableAutoTitleGeneration: true, titleGenerationModel: 'haiku', providerConfigs: { claude: claudeCatalogFixture(['haiku']) } },
      getConversationList: () => [{ ...record, messageCount: 1, preview: '' }],
      getConversationById: async () => record,
      updateConversation: async (_id, patch) => { Object.assign(record, patch); },
      completeConversationTitleGeneration,
    } });
    const host = document.body.createDiv();
    const render = () => browser.renderHistoryDropdown(host, { onSelectConversation: vi.fn() });
    const browser = new SessionBrowser({ plugin, getCurrentConversationId: () => null, getTitleGenerationService: () => ({ generateTitle, cancel: vi.fn() }), onListChanged: render });
    onTestFinished(() => browser.dispose());
    record.titleGenerationStatus = 'pending'; render();
    expect(within(host).getByLabelText('正在生成标题…')).toBeTruthy();
    record.titleGenerationStatus = 'failed'; render();
    expect(within(host).getByRole('button', { name: '重新生成标题' })).toBeTruthy();
    record.titleGenerationStatus = undefined; render();
    fireEvent.click(within(host).getByRole('button', { name: '生成标题' }));
    await waitFor(() => expect(record.title).toBe('Native Created'));
    expect(generateTitle).toHaveBeenCalledWith(record.id, 'Explain Created', expect.any(Function));
    expect(completeConversationTitleGeneration).toHaveBeenCalledWith(record.id, 'Archive', 'Native Created');
    expect(within(host).getByText('Native Created')).toBeTruthy();
    generateTitle.mockRejectedValueOnce(new Error('raw title diagnostic'));
    record.titleGenerationStatus = 'failed'; render();
    fireEvent.click(within(host).getByRole('button', { name: '重新生成标题' }));
    await waitFor(() => expect(Notice).toHaveBeenCalledWith('无法生成标题'));
  });
});
