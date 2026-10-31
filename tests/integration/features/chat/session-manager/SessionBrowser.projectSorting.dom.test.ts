/** @vitest-environment jsdom */
import { firePointer } from '@test/helpers/dom/pointer';
import { createPopoutDocument } from '@test/helpers/dom/popoutDocument';
import { createFeatureHostFixture } from '@test/helpers/FeatureHostFixture';
import { createProjectsFake, projectRecord } from '@test/helpers/features/chat/ProjectsFake';
import { createSessionBrowserHost } from '@test/helpers/features/chat/SessionBrowserTestHarness';
import { testDate } from '@test/helpers/testClock';
import { fireEvent, within } from '@testing-library/dom';
import { App, Notice } from 'obsidian';

import type { ConversationMeta } from '@/core/types';
import { SessionManagerSurface } from '@/features/chat/session-manager/SessionManagerSurface';
import { t } from '@/i18n/i18n';


const ROW_HEIGHT = 20;
const MEMBERS_HEIGHT = 40;
const LIST_TOP = 100;

function heightOf(el: Element): number {
  if (el.classList.contains('claudian-live-sort-folded')) return 0;
  if (el.classList.contains('claudian-live-sort-spacer')) return Number.parseFloat((el as HTMLElement).style.height);
  if (el.classList.contains('claudian-session-group-header')) return ROW_HEIGHT;
  return el.classList.contains('claudian-session-group-body') ? MEMBERS_HEIGHT : 0;
}

/**
 * jsdom has no layout. Project rows and member lists stack from the top of their scrolled list, as the sidebar lays
 * them out; a folded member list takes no space and transforms do not move layout.
 */
function installListLayout(): () => void {
  const original = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    const list = this.parentElement;
    if (!list || heightOf(this) === 0) return original.call(this);
    let top = LIST_TOP - list.scrollTop;
    for (const sibling of Array.from(list.children)) {
      if (sibling === this) break;
      top += heightOf(sibling);
    }
    return { top, bottom: top + heightOf(this), height: heightOf(this) } as DOMRect;
  };
  return () => { HTMLElement.prototype.getBoundingClientRect = original; };
}

/** Gives a list a viewport `clientHeight` tall; like a browser, its scroll position clamps to the content. */
function makeScrollable(list: HTMLElement, clientHeight: number): void {
  let requested = 0;
  Object.defineProperty(list, 'scrollTop', {
    configurable: true,
    get: () => {
      const content = Array.from(list.children).reduce((sum, child) => sum + heightOf(child), 0);
      return Math.max(0, Math.min(requested, content - clientHeight));
    },
    set: (value: number) => { requested = value; },
  });
}

function conversation(id: string, overrides: Partial<ConversationMeta> = {}): ConversationMeta {
  const at = testDate({ hours: -1 }).getTime();
  return {
    id, providerId: 'claude', title: `${id} session`, createdAt: at, lastActivityAt: at, messageCount: 1, preview: '',
    ...overrides,
  };
}

async function setup(options: {
  launchPinned?: boolean;
  /** The document showing the sidebar, such as a popout window's. */
  doc?: Document;
} = {}) {
  const conversations = [conversation('member', { projectId: 'launch' })];
  // Newest first without a saved order: Empty, Website, Launch.
  const projects = createProjectsFake([
    projectRecord({
      id: 'launch', name: 'Launch', createdAt: testDate({ days: -10 }).getTime(), isPinned: options.launchPinned ?? false,
    }),
    projectRecord({ id: 'website', name: 'Website', createdAt: testDate({ days: -5 }).getTime() }),
    projectRecord({ id: 'empty', name: 'Empty', createdAt: testDate({ days: -2 }).getTime() }),
  ]);
  let saveResult: Promise<void> = Promise.resolve();
  const fixture = await createFeatureHostFixture({
    app: new App(), settings: { enableAutoTitleGeneration: false, sessionManagerOrganization: 'list' },
    beforePersist: () => saveResult,
    afterPublish: () => surface.invalidate(),
  });
  const { plugin } = await createSessionBrowserHost({ conversations, host: { fixture, projects } });
  vi.spyOn(plugin, 'mutateSettings');
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
    isWide: () => true,
    canCreateTab: () => true,
    requestNew: vi.fn(),
    notifyOtherViews: vi.fn(),
  });
  const host = (options.doc ?? document).body.createDiv();
  onTestFinished(() => {
    // End held pointers, including Escape's pending release, before the next test can deliver one.
    fireEvent.pointerCancel(host.ownerDocument);
    surface.dispose();
  });
  surface.mountSidebar(host);
  surface.renderSidebar();
  const view = within(host);
  const toggle = (name: string) => view.getByRole('button', { name });
  const projectRow = (name: string) => toggle(name).closest<HTMLElement>('.claudian-session-group-header')!;
  const projectsRegion = () => view.getByRole('region', { name: t('chat.projects.header') });
  /** Project names in list order, without the section header's own toggle. */
  const order = () => within(projectsRegion())
    .getAllByRole('button')
    .filter(button => button.hasAttribute('aria-expanded') && button.textContent !== t('chat.projects.header'))
    .map(button => button.textContent);
  const offsetOf = (el: HTMLElement) => el.style.transform;
  /** Presses a project row at its middle and moves the pointer to `toY`. */
  const press = (name: string) => {
    const startY = projectRow(name).getBoundingClientRect().top + ROW_HEIGHT / 2;
    firePointer('pointerDown', toggle(name), startY);
    return startY;
  };
  const moveTo = (clientY: number) => firePointer('pointerMove', document, clientY);
  const release = (clientY: number) => firePointer('pointerUp', document, clientY);
  const settle = async () => {
    await Promise.allSettled(vi.mocked(plugin.mutateSettings).mock.results.map(result => result.value));
    await vi.advanceTimersByTimeAsync(0);
  };
  return {
    host, moveTo, offsetOf, order, plugin, press, projectRow, release, settle, surface, toggle, view,
    failNextSave: () => { saveResult = Promise.reject(new Error('write failed')); },
  };
}

let restoreLayout: () => void;
beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); restoreLayout = installListLayout(); });
afterEach(() => {
  restoreLayout();
  vi.useRealTimers();
  document.body.replaceChildren();
  vi.mocked(Notice).mockClear();
});

it('lifts a project and slides the others aside while it moves, saving the order on release', async () => {
  const { moveTo, offsetOf, order, plugin, press, projectRow, release, settle, toggle } = await setup();
  expect(order()).toEqual(['Empty', 'Website', 'Launch']);

  // Launch sits at 140–160; a small wobble is still a click, not a drag.
  press('Launch');
  moveTo(148);
  expect(projectRow('Launch').classList.contains('claudian-live-sort-lifted')).toBe(false);

  // Dragged 15px up, its top covers most of Website (120–140) but none of Empty (100–120).
  moveTo(135);
  expect(projectRow('Launch').classList.contains('claudian-live-sort-lifted')).toBe(true);
  expect(offsetOf(projectRow('Launch'))).toBe('translateY(-15px)');
  expect(offsetOf(projectRow('Website'))).toBe(`translateY(${ROW_HEIGHT}px)`);
  expect(offsetOf(projectRow('Empty'))).toBe('');
  // Back down past Website, which returns to its place.
  moveTo(150);
  expect(offsetOf(projectRow('Website'))).toBe('');
  moveTo(135);
  expect(plugin.mutateSettings).not.toHaveBeenCalled();

  release(135);
  // The release does not also toggle the project.
  fireEvent.click(toggle('Launch'));
  await settle();

  expect(plugin.settings.projectOrder).toEqual(['empty', 'launch', 'website']);
  expect(order()).toEqual(['Empty', 'Launch', 'Website']);
  expect(toggle('Launch').getAttribute('aria-expanded')).toBe('false');
  expect(projectRow('Launch').style.transform).toBe('');
});

it('moves a neighbour away as soon as the dragged card starts covering it', async () => {
  const { moveTo, offsetOf, press, projectRow } = await setup();
  // Launch (140–160) raised 8px covers 40% of Website (120–140).
  press('Launch');
  moveTo(150 - 8);
  moveTo(150 - 8);
  expect(projectRow('Launch').classList.contains('claudian-live-sort-lifted')).toBe(true);
  expect(offsetOf(projectRow('Website'))).toBe(`translateY(${ROW_HEIGHT}px)`);
  expect(offsetOf(projectRow('Empty'))).toBe('');
});

it('moves a project to the end of the list', async () => {
  const { moveTo, order, press, release, settle } = await setup();
  // Dragged as far down as it goes, Empty stops level with Launch, the last project.
  press('Empty');
  moveTo(500);
  release(500);
  await settle();

  expect(order()).toEqual(['Website', 'Launch', 'Empty']);
});

it('keeps a press without movement a click on the project toggle', async () => {
  const { plugin, press, release, settle, toggle } = await setup();
  const startY = press('Website');
  release(startY);
  fireEvent.click(toggle('Website'));
  await settle();

  expect(toggle('Website').getAttribute('aria-expanded')).toBe('true');
  expect(plugin.settings.projectOrder).toBeUndefined();
});

it('keeps a dragged expanded project under the pointer when folding it pulls a scrolled list back', async () => {
  const { moveTo, press, projectRow, settle, toggle } = await setup();
  fireEvent.click(toggle('Website'));
  await settle();
  {
    // 100px of content in a 50px viewport, scrolled to the bottom.
    const list = projectRow('Website').parentElement!;
    makeScrollable(list, 50);
    list.scrollTop = 50;
    const rowTop = projectRow('Website').getBoundingClientRect().top;

    press('Website');
    moveTo(rowTop + ROW_HEIGHT / 2 + 5);
    // Folding its 40px of members would leave only 10px to scroll; the list keeps its scroll instead.
    expect(list.scrollTop).toBe(50);
    const offset = Number(/translateY\((-?\d+(?:\.\d+)?)px\)/.exec(projectRow('Website').style.transform)?.[1] ?? 0);
    expect(projectRow('Website').getBoundingClientRect().top + offset).toBe(rowTop + 5);

    // Cancelling unfolds it with the list still where it was scrolled.
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(list.querySelector('.claudian-live-sort-spacer')).toBeNull();
    expect(list.scrollTop).toBe(50);
  }
});

it('leaves the row actions to their own clicks in a popout window', async () => {
  const popout = createPopoutDocument();
  const { host } = await setup({ doc: popout });
  const rowOf = (name: string) => [...host.querySelectorAll<HTMLElement>('.claudian-session-group-header')]
    .find(row => row.textContent?.includes(name))!;
  const actions = rowOf('Website').querySelector<HTMLElement>('.claudian-session-group-menu-action')!;

  firePointer('pointerDown', actions, 130);
  firePointer('pointerMove', popout, 160);
  expect(rowOf('Website').classList.contains('claudian-live-sort-lifted')).toBe(false);
  firePointer('pointerUp', popout, 160);

  // Pressing the row itself still sorts there.
  firePointer('pointerDown', rowOf('Website').querySelector('.claudian-session-group-toggle')!, 130);
  firePointer('pointerMove', popout, 160);
  expect(rowOf('Website').classList.contains('claudian-live-sort-lifted')).toBe(true);
  fireEvent.keyDown(popout, { key: 'Escape' });
});

it('cancels with Escape, restoring every project in place', async () => {
  const { moveTo, offsetOf, plugin, press, projectRow, release, settle, toggle } = await setup();
  press('Empty');
  moveTo(150);
  expect(offsetOf(projectRow('Website'))).toBe(`translateY(-${ROW_HEIGHT}px)`);

  fireEvent.keyDown(document, { key: 'Escape' });
  expect(projectRow('Empty').classList.contains('claudian-live-sort-lifted')).toBe(false);
  expect([projectRow('Empty'), projectRow('Website')].map(offsetOf)).toEqual(['', '']);
  // The button is still held; its release ends the cancelled drag rather than toggling the project.
  release(110);
  fireEvent.click(toggle('Empty'));
  await settle();
  expect(toggle('Empty').getAttribute('aria-expanded')).toBe('false');
  expect(plugin.mutateSettings).not.toHaveBeenCalled();
  // The next press is an ordinary click again.
  fireEvent.click(toggle('Website'));
  await settle();
  expect(toggle('Website').getAttribute('aria-expanded')).toBe('true');
});

it('folds a dragged expanded project and moves expanded neighbours as a whole', async () => {
  const { moveTo, offsetOf, order, press, projectRow, release, settle, toggle } = await setup();
  fireEvent.click(toggle('Launch'));
  await settle();
  fireEvent.click(toggle('Empty'));
  await settle();
  const launchMembers = projectRow('Launch').nextElementSibling as HTMLElement;
  const emptyMembers = projectRow('Empty').nextElementSibling as HTMLElement;

  // Empty (100–120, members to 160) folds to its row; Launch (140–160 after the fold) has members to 200.
  press('Empty');
  moveTo(185);
  expect(emptyMembers.classList.contains('claudian-live-sort-folded')).toBe(true);
  expect(offsetOf(projectRow('Launch'))).toBe(`translateY(-${ROW_HEIGHT}px)`);
  expect(offsetOf(launchMembers)).toBe(`translateY(-${ROW_HEIGHT}px)`);
  release(185);
  await settle();

  expect(order()).toEqual(['Website', 'Launch', 'Empty']);
  expect(toggle('Empty').getAttribute('aria-expanded')).toBe('true');
});

it('keeps the dragged rows through list updates until the order is saved', async () => {
  const { moveTo, order, press, projectRow, release, settle, surface, view } = await setup();
  // Empty (100–120) lowered 25px passes Website (120–140) but barely reaches Launch (140–160).
  press('Empty');
  moveTo(135);
  const lifted = projectRow('Empty');
  surface.invalidate();
  expect(lifted.isConnected).toBe(true);

  release(135);
  surface.invalidate();
  expect(lifted.isConnected).toBe(true);
  await settle();
  expect(lifted.isConnected).toBe(false);
  expect(order()).toEqual(['Website', 'Empty', 'Launch']);
  // The held render is the whole sidebar's, so its controls come back with the list.
  expect(['New', 'Search', 'Archive'].map(name => view.getAllByRole('button', { name }).length)).toEqual([1, 1, 1]);
});

it('discards a held render when the surface is disposed mid-drag', async () => {
  const { moveTo, plugin, press, projectRow, surface } = await setup();
  press('Empty');
  moveTo(135);
  const lifted = projectRow('Empty');
  expect(lifted.classList.contains('claudian-live-sort-lifted')).toBe(true);
  surface.invalidate();

  surface.dispose();
  // Teardown does not render the sidebar again.
  expect(lifted.isConnected).toBe(true);
  expect(lifted.classList.contains('claudian-live-sort-lifted')).toBe(false);
  expect(plugin.mutateSettings).not.toHaveBeenCalled();
});

it('restores the list and reports a reorder that fails to save', async () => {
  const { failNextSave, moveTo, offsetOf, order, plugin, press, projectRow, release, settle, toggle } = await setup();
  fireEvent.click(toggle('Empty'));
  await settle();
  const members = projectRow('Empty').nextElementSibling as HTMLElement;
  failNextSave();
  press('Empty');
  moveTo(150);
  expect(members.classList.contains('claudian-live-sort-folded')).toBe(true);
  release(150);
  await settle();

  expect(Notice).toHaveBeenLastCalledWith(t('chat.projects.errors.reorder'));
  expect(plugin.settings.projectOrder).toBeUndefined();
  expect(order()).toEqual(['Empty', 'Website', 'Launch']);
  // Nothing else re-rendered the list, so the sorter itself puts every row back.
  expect([projectRow('Empty'), members, projectRow('Website'), projectRow('Launch')].map(offsetOf))
    .toEqual(['', '', '', '']);
  expect(members.classList.contains('claudian-live-sort-folded')).toBe(false);
  expect(projectRow('Empty').parentElement!.classList.contains('claudian-live-sorting')).toBe(false);
});

it('sorts a project only among projects of its pin state', async () => {
  const { moveTo, offsetOf, press, projectRow, view } = await setup({ launchPinned: true });
  expect(within(view.getByRole('region', { name: 'Pinned' })).getByText('Launch')).toBeTruthy();

  // Pulled far up, Website stops at the top of the unpinned projects and Launch stays put.
  press('Website');
  moveTo(0);
  expect(offsetOf(projectRow('Website'))).toBe(`translateY(-${ROW_HEIGHT}px)`);
  expect(offsetOf(projectRow('Launch'))).toBe('');
});
