/** @vitest-environment jsdom */
import { axe } from '@test/helpers/accessibility';
import { createSessionBrowserHost } from '@test/helpers/features/chat/SessionBrowserTestHarness';
import { testDate } from '@test/helpers/testClock';
import { fireEvent, within } from '@testing-library/dom';
import { Menu } from 'obsidian';

import type { ConversationMeta } from '@/core/types';
import { SessionBrowser } from '@/features/chat/session-manager/SessionBrowser';
import { SessionGroupCollapse } from '@/features/chat/session-manager/SessionGroupCollapse';
import type { HistoryConversationStatus } from '@/features/chat/session-manager/SessionStatusPresentation';

type MockMenuItem = { title: string; icon: string; clickHandler: ((event?: unknown) => void) | null };
type MockMenu = { items: MockMenuItem[] };
const menus = (): MockMenu[] => (Menu as unknown as { instances: MockMenu[] }).instances;
const titles = (menu: MockMenu): string[] => menu.items.map(item => item.title);

function session(id: string, hoursAgo: number, extra: Partial<ConversationMeta> = {}): ConversationMeta {
  return {
    id, providerId: 'claude', title: `${id} session`, messageCount: 1, preview: '',
    createdAt: testDate({ days: -5 }).getTime(), lastActivityAt: testDate({ hours: -hoursAgo }).getTime(), ...extra,
  };
}

const NOTE = 'Notes/Plan.md';
const lineage = (): ConversationMeta[] => [
  session('parent', 3, { linkedContentPath: NOTE }),
  session('agent', 1, { origin: { kind: 'session-tool', conversationId: 'parent' } }),
  session('fork', 2, { linkedContentPath: NOTE, origin: { kind: 'fork', conversationId: 'parent' } }),
  session('orphan', 4, { origin: { kind: 'fork', conversationId: 'deleted' } }),
];

async function setup(
  conversations = lineage(),
  renderOptions: Record<string, unknown> = {},
  currentId: string | null = null,
) {
  const { plugin, records } = await createSessionBrowserHost({
    conversations, host: { settings: { enableAutoTitleGeneration: false } },
  });
  const browser = new SessionBrowser({
    plugin, getCurrentConversationId: () => null, getTitleGenerationService: () => null, onListChanged: () => undefined,
  });
  onTestFinished(() => browser.dispose());
  const container = document.body.createDiv();
  const collapse = new SessionGroupCollapse();
  const onSelectConversation = vi.fn().mockResolvedValue(undefined);
  const render = (): void => browser.renderHistoryDropdown(container, {
    onSelectConversation,
    onRerender: render,
    showLineageFolds: true,
    showMetadataPopover: true,
    showOpenStateLabels: false,
    showPinnedSection: true,
    sessionScope: 'active',
    sessionActionMode: 'active',
    organization: 'linked-content',
    language: 'en',
    contentExists: () => true,
    contentIsNote: () => true,
    isGroupCollapsed: (key, defaultCollapsed) => collapse.isCollapsed(key, defaultCollapsed),
    onGroupCollapseChange: (key, collapsed) => collapse.setCollapsed(key, collapsed),
    getConversationStatus: (id: string): HistoryConversationStatus => ({
      openState: id === currentId ? 'current' : 'closed', isRunning: id === 'agent',
    }),
    ...renderOptions,
  });
  render();
  return { container, onSelectConversation, records, render, view: within(container) };
}

const row = (view: ReturnType<typeof within>, title: string) => view.getByRole('button', { name: title });

afterEach(() => {
  document.body.replaceChildren();
  menus().length = 0;
});

it('folds sessions a session started under it, collapsed behind a toggle that carries their status', async () => {
  const { container, view } = await setup();
  const toggle = view.getByRole('button', { name: /^1 Agent Session · 1 Fork/ });

  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  const running = within(toggle).getByLabelText('Running');
  expect(running.hasClass('claudian-session-group-running-indicator--visible')).toBe(true);
  expect(view.queryByText('agent session')).toBeNull();
  expect(view.queryByText('fork session')).toBeNull();
  // A child whose parent is gone keeps its own row in Unlinked.
  expect(row(view, 'orphan session').closest('.claudian-session-group-body')?.previousElementSibling?.textContent)
    .toContain('Unlinked');
  expect(row(view, 'parent session').compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

  fireEvent.click(toggle);
  const expanded = view.getByRole('button', { name: /^1 Agent Session · 1 Fork/ });
  expect(expanded.getAttribute('aria-expanded')).toBe('true');
  // The rows show their own status once open.
  expect(running.hasClass('claudian-session-group-running-indicator--visible')).toBe(false);
  const children = [row(view, 'agent session'), row(view, 'fork session')];
  for (const child of children) {
    expect(expanded.compareDocumentPosition(child) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(child.closest('.claudian-session-group-body')).toBe(row(view, 'parent session').closest('.claudian-session-group-body'));
  }
  expect(await axe(container)).toHaveNoViolations();

  fireEvent.click(expanded);
  expect(view.queryByText('agent session')).toBeNull();
});

it('keeps keyboard focus on the disclosure while it opens and closes in place', async () => {
  const { view } = await setup();
  const toggle = view.getByRole('button', { name: /^1 Agent Session · 1 Fork/ });
  toggle.focus();

  fireEvent.click(toggle);
  expect(toggle.isConnected).toBe(true);
  expect(document.activeElement).toBe(toggle);
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  expect(row(view, 'agent session')).toBeTruthy();

  fireEvent.click(toggle);
  expect(document.activeElement).toBe(toggle);
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(view.queryByText('agent session')).toBeNull();
});

it('shows the folded running child on its collapsed Linked content group', async () => {
  const { view } = await setup();
  const groupHeader = view.getByText('Plan').closest<HTMLElement>('.claudian-session-group-header')!;

  fireEvent.click(groupHeader);

  expect(groupHeader.getAttribute('aria-expanded')).toBe('false');
  expect(within(groupHeader).getByLabelText('Running')).toBeTruthy();
});

it('describes lineage in the row popover', async () => {
  const { view } = await setup();
  fireEvent.click(view.getByRole('button', { name: /^1 Agent Session · 1 Fork/ }));
  // The popover is reused across rows, so only its shown rows describe the focused one.
  const popoverText = (title: string): string => {
    fireEvent.focusIn(row(view, title));
    const popover = document.getElementById(row(view, title).getAttribute('aria-describedby')!)!;
    return [...popover.querySelectorAll<HTMLElement>('.claudian-session-metadata-row:not(.claudian-hidden)')]
      .map(shown => shown.textContent).join('\n');
  };

  expect(popoverText('agent session')).toContain('Started byparent session');
  expect(popoverText('fork session')).toContain('Forked fromparent session');
  expect(popoverText('parent session')).toContain('Started1 agent session');
  expect(popoverText('parent session')).toContain('Forked1 session');
  const orphan = popoverText('orphan session');
  expect(orphan).not.toContain('Forked from');
  expect(orphan).not.toContain('Started');
});

it('opens the parent session from a child row menu, and offers it only while the parent exists', async () => {
  const { onSelectConversation, view } = await setup();
  fireEvent.click(view.getByRole('button', { name: /^1 Agent Session · 1 Fork/ }));

  fireEvent.contextMenu(row(view, 'agent session'));
  const menu = menus().at(-1)!;
  const openParent = menu.items.find(item => item.title === 'Open parent session')!;
  expect(openParent.icon).toBe('corner-left-up');
  openParent.clickHandler!();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(onSelectConversation).toHaveBeenCalledWith('parent');

  fireEvent.contextMenu(row(view, 'orphan session'));
  expect(titles(menus().at(-1)!)).not.toContain('Open parent session');
  fireEvent.contextMenu(row(view, 'parent session'));
  expect(titles(menus().at(-1)!)).not.toContain('Open parent session');
});

it('archives the sessions folded into a recency group with the group', async () => {
  const conversations = [
    session('parent', 3),
    session('child', 24 * 40, { origin: { kind: 'session-tool', conversationId: 'parent' } }),
    session('older', 24 * 40),
  ];
  const { records, view } = await setup(conversations, { organization: 'list', groupByRecency: true });
  expect(view.queryByText('child session')).toBeNull();

  fireEvent.click(view.getByRole('button', { name: 'Actions for Past week' }));
  menus().at(-1)!.items.find(item => item.title === 'Archive all sessions')!.clickHandler!();
  await vi.waitFor(() => expect(records.find(({ id }) => id === 'parent')!.isArchived).toBe(true));

  expect(records.find(({ id }) => id === 'child')!.isArchived).toBe(true);
  expect(records.find(({ id }) => id === 'older')!.isArchived).toBeFalsy();
});

it('archives a parent with the idle sessions folded under it, leaving running ones', async () => {
  const conversations = [...lineage(), session('loose', 5)];
  const { records, view } = await setup(conversations);

  // The running agent session stays, so the action names only the idle fork.
  expect(view.getByRole('button', { name: 'Archive with 1 folded session' })).toBeTruthy();
  fireEvent.contextMenu(row(view, 'parent session'));
  menus().at(-1)!.items.find(item => item.title === 'Archive with 1 folded session')!.clickHandler!();
  await vi.waitFor(() => expect(records.find(({ id }) => id === 'parent')!.isArchived).toBe(true));

  const archived = Object.fromEntries(records.map(({ id, isArchived }) => [id, !!isArchived]));
  expect(archived).toEqual({ parent: true, fork: true, agent: false, orphan: false, loose: false });
});

it('restores an archived parent with the archived sessions folded under it', async () => {
  const conversations = lineage().map(conversation => ({ ...conversation, isArchived: conversation.id !== 'orphan' }));
  const { records, view } = await setup(conversations, {
    sessionScope: 'archived', sessionActionMode: 'archived', showArchivedSection: true, showPinnedSection: false,
  });

  fireEvent.contextMenu(row(view, 'parent session'));
  menus().at(-1)!.items.find(item => item.title === 'Restore with 2 folded sessions')!.clickHandler!();
  await vi.waitFor(() => expect(records.find(({ id }) => id === 'parent')!.isArchived).toBe(false));

  const archived = Object.fromEntries(records.map(({ id, isArchived }) => [id, !!isArchived]));
  expect(archived).toEqual({ parent: false, agent: false, fork: false, orphan: false });
});

it('opens a fold that holds the current session until the user collapses it', async () => {
  const { render, view } = await setup(lineage(), {}, 'fork');
  const toggle = () => view.getByRole('button', { name: /^1 Agent Session · 1 Fork/ });

  expect(toggle().getAttribute('aria-expanded')).toBe('true');
  // The current session's row is not a selectable button.
  expect(view.getByText('fork session')).toBeTruthy();
  fireEvent.click(toggle());
  render();

  expect(toggle().getAttribute('aria-expanded')).toBe('false');
  expect(view.queryByText('fork session')).toBeNull();
});

it('lists every session as its own row on a surface that does not fold lineage', async () => {
  const { view } = await setup(lineage(), { showLineageFolds: false });

  expect(view.queryByRole('button', { name: /^1 Agent Session · 1 Fork/ })).toBeNull();
  for (const title of ['parent session', 'agent session', 'fork session', 'orphan session']) {
    expect(row(view, title)).toBeTruthy();
  }
});

it('archives the folded sessions a Linked content group shows with the group', async () => {
  const conversations = lineage().map(conversation => ({ ...conversation, isArchived: false }));
  const { records, view } = await setup(conversations, {
    getConversationStatus: (): HistoryConversationStatus => ({ openState: 'closed', isRunning: false }),
  });

  fireEvent.contextMenu(view.getByText('Plan').closest<HTMLElement>('.claudian-session-group-header')!);
  menus().at(-1)!.items.find(item => item.title === 'Archive all sessions')!.clickHandler!();
  await vi.waitFor(() => expect(records.find(({ id }) => id === 'parent')!.isArchived).toBe(true));

  const archived = Object.fromEntries(records.map(({ id, isArchived }) => [id, !!isArchived]));
  expect(archived).toEqual({ parent: true, agent: true, fork: true, orphan: false });
});

it('offers the parent only while it is active, and never in the archive', async () => {
  const archivedParent = lineage().map(conversation => (
    conversation.id === 'parent' ? { ...conversation, isArchived: true } : conversation
  ));
  const active = await setup(archivedParent);
  fireEvent.contextMenu(row(active.view, 'agent session'));
  expect(titles(menus().at(-1)!)).not.toContain('Open parent session');
  document.body.replaceChildren();

  const archive = await setup(lineage().map(conversation => ({ ...conversation, isArchived: true })), {
    sessionScope: 'archived', sessionActionMode: 'archived', showArchivedSection: true, showPinnedSection: false,
  });
  fireEvent.click(archive.view.getByRole('button', { name: /^1 Agent Session · 1 Fork/ }));
  fireEvent.contextMenu(row(archive.view, 'agent session'));
  expect(titles(menus().at(-1)!)).toEqual(expect.arrayContaining(['Restore']));
  expect(titles(menus().at(-1)!)).not.toContain('Open parent session');
});

it('counts only the children of the shown scope in the parent popover', async () => {
  const { view } = await setup([
    ...lineage(),
    session('archived-agent', 5, { isArchived: true, origin: { kind: 'session-tool', conversationId: 'parent' } }),
  ]);

  fireEvent.focusIn(row(view, 'parent session'));
  const popover = document.getElementById(row(view, 'parent session').getAttribute('aria-describedby')!)!;
  const shown = [...popover.querySelectorAll<HTMLElement>('.claudian-session-metadata-row:not(.claudian-hidden)')]
    .map(entry => entry.textContent);
  expect(shown).toEqual(expect.arrayContaining(['Started1 agent session', 'Forked1 session']));
});
