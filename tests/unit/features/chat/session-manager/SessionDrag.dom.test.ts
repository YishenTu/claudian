/** @vitest-environment jsdom */

import { axe } from '@test/helpers/accessibility';
import { createProjectsFake, projectRecord } from '@test/helpers/features/chat/ProjectsFake';
import { testDate } from '@test/helpers/testClock';
import { fireEvent, within } from '@testing-library/dom';
import { Notice } from 'obsidian';

import type { ConversationMeta } from '@/core/types';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import { SessionManagerSurface } from '@/features/chat/session-manager/SessionManagerSurface';
import { t } from '@/i18n/i18n';

HTMLElement.prototype.empty = function () { this.replaceChildren(); };
HTMLElement.prototype.addClass = function (...classes) { this.classList.add(...classes); };
HTMLElement.prototype.removeClass = function (...classes) { this.classList.remove(...classes); };
HTMLElement.prototype.hasClass = function (className) { return this.classList.contains(className); };
HTMLElement.prototype.toggleClass = function (classes, value) {
  for (const name of [classes].flat()) this.classList.toggle(name, value);
};

const ACTIVE_TARGET = 'claudian-session-drop-target--active';

function conversation(id: string, overrides: Partial<ConversationMeta> = {}): ConversationMeta {
  const at = testDate({ hours: -1 }).getTime();
  return {
    id, providerId: 'claude', title: `${id} session`, createdAt: at, lastActivityAt: at, messageCount: 1, preview: '',
    ...overrides,
  };
}

/** jsdom has no DataTransfer; this keeps the parts a drag uses. */
function createDataTransfer() {
  const data = new Map<string, string>();
  return {
    get types(): string[] { return [...data.keys()]; },
    setData: (type: string, value: string) => { data.set(type, value); },
    getData: (type: string) => data.get(type) ?? '',
    effectAllowed: 'uninitialized',
    dropEffect: 'none',
  };
}

const flushDragStart = () => new Promise(resolve => setTimeout(resolve, 0));

function setup(conversations: ConversationMeta[] = [
  conversation('member', { projectId: 'launch' }),
  conversation('loose'),
  conversation('pinned', { isPinned: true }),
  conversation('pinned-member', { isPinned: true, projectId: 'launch' }),
], options: { launchPinned?: boolean } = {}) {
  const lifecycle = {
    setPinned: vi.fn().mockResolvedValue(undefined),
    setPlacement: vi.fn().mockResolvedValue(undefined),
    archive: vi.fn(),
  };
  const projects = createProjectsFake([
    projectRecord({
      id: 'launch', name: 'Launch', createdAt: testDate({ days: -10 }).getTime(), isPinned: options.launchPinned ?? false,
    }),
    projectRecord({ id: 'empty', name: 'Empty', createdAt: testDate({ days: -2 }).getTime() }),
  ]);
  const plugin = {
    app: { vault: { getAbstractFileByPath: () => null } },
    settings: { enableAutoTitleGeneration: false, sessionManagerOrganization: 'list' },
    mutateSettings: vi.fn(async (mutation: (settings: Record<string, unknown>) => void) => {
      mutation(plugin.settings);
    }),
    getConversationList: () => conversations,
    conversationLifecycle: lifecycle,
    projects,
  };
  const surface = new SessionManagerSurface({
    plugin: plugin as unknown as ChatFeatureHost,
    navigation: {
      contentExists: () => true,
      getConversationStatus: () => ({ openState: 'closed', isRunning: false }),
      openConversation: vi.fn().mockResolvedValue(undefined),
      openSessionConversation: vi.fn().mockResolvedValue(undefined),
      startLinkedContentConversation: vi.fn().mockResolvedValue(undefined),
      startProjectConversation: vi.fn().mockResolvedValue(undefined),
    },
    getActiveTab: () => null,
    isWide: () => true,
    canCreateTab: () => true,
    requestNew: vi.fn(),
    notifyOtherViews: vi.fn(),
  });
  const host = document.body.createDiv();
  surface.mountSidebar(host);
  surface.renderSidebar();
  const view = within(host);
  const row = (title: string) => view.getByText(title).closest<HTMLElement>('.claudian-history-item')!;
  const projectToggle = (name: string) => view.getByRole('button', { name });
  const region = (name: string) => view.getByRole('region', { name });

  const dataTransfer = createDataTransfer();
  const startDrag = async (title: string) => {
    fireEvent.dragStart(row(title), { dataTransfer });
    await flushDragStart();
  };
  /** Hovers the target; returns whether it accepted the drop. */
  const hover = (target: HTMLElement): boolean => {
    fireEvent.dragEnter(target, { dataTransfer });
    return !fireEvent.dragOver(target, { dataTransfer });
  };
  const drop = (target: HTMLElement) => {
    hover(target);
    fireEvent.drop(target, { dataTransfer });
  };
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  return {
    dataTransfer, drop, host, hover, lifecycle, projectToggle, region, row, settle, startDrag, surface, view,
  };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.mocked(Notice).mockClear();
});

it('moves a loose session into a project by dropping it on the project row, highlighting the target', async () => {
  const { dataTransfer, hover, lifecycle, projectToggle, row, settle, startDrag } = setup();
  expect(row('loose session').getAttribute('draggable')).toBe('true');
  // The metadata popover works until a drag starts.
  fireEvent.mouseEnter(row('pinned session'));
  expect(within(document.body).getByRole('tooltip')).toBeTruthy();

  await startDrag('loose session');
  expect(within(document.body).queryByRole('tooltip')).toBeNull();
  fireEvent.mouseEnter(row('pinned session'));
  expect(within(document.body).queryByRole('tooltip')).toBeNull();

  const projectRow = projectToggle('Launch').closest<HTMLElement>('.claudian-session-group-header')!;
  expect(hover(projectToggle('Launch'))).toBe(true);
  expect(projectRow.classList.contains(ACTIVE_TARGET)).toBe(true);
  fireEvent.drop(projectToggle('Launch'), { dataTransfer });
  await settle();

  expect(lifecycle.setPlacement).toHaveBeenCalledWith(['loose'], { projectId: 'launch', isPinned: false });
  expect(lifecycle.setPinned).not.toHaveBeenCalled();
  expect(document.querySelector(`.${ACTIVE_TARGET}`)).toBeNull();
});

it('drops on a pinned project listed under Pinned, highlighting the project rather than Pinned', async () => {
  const { dataTransfer, hover, lifecycle, projectToggle, region, settle, startDrag } = setup(undefined, {
    launchPinned: true,
  });
  await startDrag('loose session');

  const projectRow = projectToggle('Launch').closest<HTMLElement>('.claudian-session-group-header')!;
  expect(region('Pinned').contains(projectRow)).toBe(true);
  expect(hover(projectToggle('Launch'))).toBe(true);
  expect(projectRow.classList.contains(ACTIVE_TARGET)).toBe(true);
  expect(region('Pinned').classList.contains(ACTIVE_TARGET)).toBe(false);
  fireEvent.drop(projectToggle('Launch'), { dataTransfer });
  await settle();

  expect(lifecycle.setPlacement).toHaveBeenCalledWith(['loose'], { projectId: 'launch', isPinned: false });
});

it('joins the project and unpins a pinned session in one placement write', async () => {
  const { drop, lifecycle, projectToggle, settle, startDrag } = setup();
  await startDrag('pinned session');
  drop(projectToggle('Empty'));
  await settle();

  expect(lifecycle.setPlacement.mock.calls).toEqual([[['pinned'], { projectId: 'empty', isPinned: false }]]);
  expect(lifecycle.setPinned).not.toHaveBeenCalled();
});

it('reports a placement that fails', async () => {
  const { drop, lifecycle, projectToggle, region, settle, startDrag } = setup();
  lifecycle.setPlacement.mockRejectedValue(new Error('write failed'));
  await startDrag('pinned session');
  drop(projectToggle('Empty'));
  await settle();
  expect(Notice).toHaveBeenLastCalledWith(t('chat.projects.errors.move'));

  await startDrag('pinned session');
  drop(region('Sessions'));
  await settle();
  expect(Notice).toHaveBeenLastCalledWith('Failed to move sessions');
});

it('clears the project, and unpins, when a session is dropped on Sessions', async () => {
  const { drop, lifecycle, projectToggle, region, settle, startDrag } = setup();
  fireEvent.click(projectToggle('Launch'));
  await startDrag('member session');
  drop(region('Sessions'));
  await settle();
  await startDrag('pinned-member session');
  drop(region('Sessions'));
  await settle();

  expect(lifecycle.setPlacement.mock.calls).toEqual([
    [['member'], { projectId: null, isPinned: false }],
    [['pinned-member'], { projectId: null, isPinned: false }],
  ]);
  expect(lifecycle.setPinned).not.toHaveBeenCalled();
});

it('pins a project member dropped on Pinned without leaving its project', async () => {
  const { drop, lifecycle, projectToggle, region, settle, startDrag } = setup();
  fireEvent.click(projectToggle('Launch'));
  await startDrag('member session');
  drop(region('Pinned'));
  await settle();

  expect(lifecycle.setPinned).toHaveBeenCalledWith(['member'], true);
  expect(lifecycle.setPlacement).not.toHaveBeenCalled();
});

it('targets the place a dropped session already is, which the conversation owner leaves alone', async () => {
  const { drop, lifecycle, projectToggle, region, row, settle, startDrag } = setup();
  fireEvent.click(projectToggle('Launch'));
  await startDrag('pinned session');
  drop(region('Pinned'));
  await startDrag('member session');
  // Dropped on another member row inside the expanded project.
  drop(row('member session'));
  await startDrag('loose session');
  drop(region('Sessions'));
  await settle();

  expect(lifecycle.setPinned.mock.calls).toEqual([[['pinned'], true]]);
  expect(lifecycle.setPlacement.mock.calls).toEqual([
    [['member'], { projectId: 'launch', isPinned: false }],
    [['loose'], { projectId: null, isPinned: false }],
  ]);
});

it('shows a temporary Pinned drop zone while dragging when nothing is pinned', async () => {
  const { dataTransfer, drop, host, lifecycle, region, row, settle, startDrag, surface, view } = setup([
    conversation('loose'), conversation('other'),
  ]);
  expect(view.queryByRole('region', { name: 'Pinned' })).toBeNull();

  await startDrag('loose session');
  expect(region('Pinned')).toBeTruthy();
  expect((await axe(host)).violations).toEqual([]);
  // A list update during the drag keeps the zone.
  surface.invalidate();
  expect(region('Pinned')).toBeTruthy();
  fireEvent.dragEnd(row('loose session'), { dataTransfer });
  expect(view.queryByRole('region', { name: 'Pinned' })).toBeNull();

  await startDrag('other session');
  drop(region('Pinned'));
  await settle();
  expect(lifecycle.setPinned).toHaveBeenCalledWith(['other'], true);
  expect(view.queryByRole('region', { name: 'Pinned' })).toBeNull();
});

it('drags the whole multi-selection when the dragged row is selected', async () => {
  const { drop, lifecycle, projectToggle, row, settle, startDrag } = setup();
  fireEvent.click(row('loose session').querySelector('.claudian-history-item-content')!, { altKey: true });
  fireEvent.click(row('pinned session').querySelector('.claudian-history-item-content')!, { altKey: true });
  await startDrag('loose session');
  drop(projectToggle('Empty'));
  await settle();

  expect(lifecycle.setPlacement).toHaveBeenCalledTimes(1);
  expect([...lifecycle.setPlacement.mock.calls[0][0]].sort()).toEqual(['loose', 'pinned']);
  // The drop ends the selection it moved.
  expect(row('loose session').classList.contains('claudian-history-item--selected')).toBe(false);
});

it('drags only the row when it is outside the selection', async () => {
  const { drop, lifecycle, projectToggle, row, settle, startDrag } = setup();
  fireEvent.click(row('pinned session').querySelector('.claudian-history-item-content')!, { altKey: true });
  fireEvent.click(row('pinned-member session').querySelector('.claudian-history-item-content')!, { altKey: true });
  await startDrag('loose session');
  drop(projectToggle('Empty'));
  await settle();

  expect(lifecycle.setPlacement).toHaveBeenCalledWith(['loose'], { projectId: 'empty', isPinned: false });
});

it('clears the highlight when the drag ends or leaves, and ignores foreign drags', async () => {
  const { dataTransfer, hover, region, row, startDrag, view } = setup();
  const foreign = createDataTransfer();
  foreign.setData('text/plain', 'note');
  fireEvent.dragEnter(region('Sessions'), { dataTransfer: foreign });
  expect(fireEvent.dragOver(region('Sessions'), { dataTransfer: foreign })).toBe(true);

  await startDrag('pinned-member session');
  expect(hover(region('Sessions'))).toBe(true);
  expect(region('Sessions').classList.contains(ACTIVE_TARGET)).toBe(true);
  fireEvent.dragLeave(region('Sessions'), { dataTransfer, relatedTarget: document.body });
  expect(region('Sessions').classList.contains(ACTIVE_TARGET)).toBe(false);

  hover(region('Pinned'));
  expect(region('Pinned').classList.contains(ACTIVE_TARGET)).toBe(true);
  fireEvent.dragEnd(row('pinned-member session'), { dataTransfer });
  expect(view.getByRole('region', { name: 'Pinned' }).classList.contains(ACTIVE_TARGET)).toBe(false);
  // The ended drag no longer accepts drops.
  expect(fireEvent.dragOver(region('Sessions'), { dataTransfer })).toBe(true);
});

it('does not make archived rows draggable', () => {
  const { host, row, view } = setup([conversation('active'), conversation('old', { isArchived: true })]);
  expect(row('active session').getAttribute('draggable')).toBe('true');
  fireEvent.click(host.querySelector('.claudian-session-archive-control')!);
  expect(within(view.getByRole('region', { name: 'Archived' })).getByText('old session')).toBeTruthy();
  expect(row('old session').getAttribute('draggable')).not.toBe('true');
});
