/** @jest-environment jsdom */
import '@/providers';

import {
  createHarness,
  releaseSideChatHarnesses,
  startSideChat,
} from '@test/helpers/features/chat/SideChatDOMHarness';
import { fireEvent, screen, waitFor, within } from '@testing-library/dom';
import { axe } from 'jest-axe';

import { createTabPlacementPort } from '@/features/chat/tabs/runtime/TabRuntimePorts';
import { ChatPresentationPlacement } from '@/features/chat/view/ChatPresentationPlacement';

afterEach(releaseSideChatHarnesses);

it('previews the side colour for a complete command token only', () => {
  const harness = createHarness();
  for (const partial of ['/sid', '/sideways ask', 'please use /side later']) {
    harness.inputEl.value = partial;
    harness.controller.handleComposerInput();
    expect(harness.inputWrapperEl.classList.contains('claudian-input-side-chat-preview')).toBe(false);
  }

  for (const complete of ['/side', '/btw', '/SIDE explore this', '/side line one\nline two']) {
    harness.inputEl.value = complete;
    harness.controller.handleComposerInput();
    expect(harness.inputWrapperEl.classList.contains('claudian-input-side-chat-preview')).toBe(true);
  }

  harness.inputEl.value = '/side';
  harness.controller.handleComposerInput();
  harness.inputEl.value = '';
  harness.controller.handleComposerInput();
  expect(harness.inputWrapperEl.classList.contains('claudian-input-side-chat-preview')).toBe(false);
  expect(harness.backend.sessions).toHaveLength(0);
});

it('opens expanded with a joined border, then collapses to an idle chip over the normal composer', async () => {
  const harness = createHarness();
  expect(harness.destinationChanges).toEqual([]);
  const { started } = await startSideChat(harness);
  harness.backend.latest.establishChild('child-session');
  harness.backend.latest.complete();
  await started;

  expect(harness.destinationChanges).toEqual(['side']);
  const panel = screen.getByRole('heading', { name: 'Side chat' }).closest('.claudian-side-chat-panel')!;
  expect(harness.composerEl.classList.contains('claudian-side-chat-expanded')).toBe(true);
  expect(harness.controller.destination).toBe('side');
  expect(harness.inputEl.placeholder).toBe('Ask a follow-up in the side chat');
  expect(harness.inputEl.getAttribute('aria-label')).toBe('Side chat message');
  expect(await axe(harness.composerEl)).toHaveNoViolations();

  const collapse = within(panel as HTMLElement).getByRole('button', { name: 'Collapse' });
  expect(collapse.textContent).toBe('');
  expect(collapse.hasAttribute('title')).toBe(false);
  expect(within(panel as HTMLElement).getByRole('button', { name: 'Discard' }).hasAttribute('title')).toBe(false);
  expect(collapse.getAttribute('aria-expanded')).toBe('true');
  expect(collapse.getAttribute('aria-controls')).toBe(panel.id);
  fireEvent.click(collapse);

  expect(harness.controller.destination).toBe('main');
  expect(harness.composerEl.classList.contains('claudian-side-chat-expanded')).toBe(false);
  expect(harness.inputEl.placeholder).toBe('Ask to make changes');
  expect(harness.inputEl.hasAttribute('aria-label')).toBe(false);
  expect(harness.destinationChanges).toEqual(['side', 'main']);
  const statusToggle = screen.getByRole('button', { name: 'Side chat' });
  expect(statusToggle.getAttribute('aria-expanded')).toBe('false');
  expect(statusToggle.closest('.claudian-side-chat-status')!.classList.contains('claudian-hidden')).toBe(false);
  expect(await axe(harness.composerEl)).toHaveNoViolations();

  fireEvent.keyDown(statusToggle, { key: 'Enter' });
  fireEvent.click(statusToggle);
  expect(harness.controller.destination).toBe('side');
});

it('keeps separate main and side drafts across expansion changes', async () => {
  const harness = createHarness();
  harness.inputEl.value = '/side Explore B';
  const { started } = await startSideChat(harness);
  expect(harness.inputEl.value).toBe('');
  harness.backend.latest.establishChild('child-session');
  harness.backend.latest.complete();
  await started;
  harness.inputEl.value = 'side follow-up draft';
  harness.controller.collapse();
  expect(harness.inputEl.value).toBe('');

  harness.inputEl.value = 'main draft';
  harness.controller.expand();
  expect(harness.inputEl.value).toBe('side follow-up draft');

  harness.controller.collapse();
  expect(harness.inputEl.value).toBe('main draft');
});

it('preserves a saved side draft when a slash follow-up resumes the collapsed child', async () => {
  const harness = createHarness();
  const { started } = await startSideChat(harness);
  harness.backend.latest.establishChild('child-session');
  harness.backend.latest.complete();
  await started;

  harness.inputEl.value = 'Unsent side draft';
  harness.controller.collapse();
  harness.inputEl.value = '/side Quick follow-up';
  const sent = harness.controller.handleCommandSubmission('Quick follow-up', []);
  await waitFor(() => expect(harness.backend.latest.requests).toHaveLength(2));
  harness.backend.latest.complete();
  await sent;

  expect(harness.backend.sessions).toHaveLength(1);
  expect(harness.controller.destination).toBe('side');
  expect(harness.inputEl.value).toBe('Unsent side draft');
  harness.controller.collapse();
  expect(harness.inputEl.value).toBe('');
  harness.controller.expand();
  expect(harness.inputEl.value).toBe('Unsent side draft');
  expect(harness.backend.latest.requests[1].input).toEqual([
    { text: 'Quick follow-up', type: 'text' },
  ]);
});

it('discards the side chat, releases its session and restores the main composer', async () => {
  const harness = createHarness();
  const { started } = await startSideChat(harness);
  harness.backend.latest.establishChild('child-session');
  harness.backend.latest.complete();
  await started;
  const native = harness.backend.latest;

  fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
  await waitFor(() => expect(native.disposeCalls).toBe(1));
  expect(screen.queryByRole('heading', { name: 'Side chat' })).toBeNull();
  expect(harness.controller.destination).toBe('main');
  expect(harness.controller.hasSideChat).toBe(false);
  expect(harness.composerEl.classList.contains('claudian-side-chat-expanded')).toBe(false);
});

it('rejects a nested side command and an empty prompt without creating anything', async () => {
  const harness = createHarness();
  const { started } = await startSideChat(harness);
  harness.backend.latest.establishChild('child-session');
  harness.backend.latest.complete();
  await started;

  await harness.controller.handleCommandSubmission('Nested', []);
  expect(harness.backend.sessions).toHaveLength(1);
  expect(harness.backend.latest.requests).toHaveLength(1);

  const fresh = createHarness();
  await fresh.controller.handleCommandSubmission('', []);
  expect(fresh.backend.sessions).toHaveLength(0);
  expect(fresh.controller.hasSideChat).toBe(false);
});

it('reports an unavailable provider and a missing checkpoint without starting native work', async () => {
  const unsupported = createHarness({ supportsFork: false });
  await unsupported.controller.handleCommandSubmission('Explore B', []);
  expect(unsupported.backend.sessions).toHaveLength(0);
  expect(unsupported.controller.hasSideChat).toBe(false);

  const withoutCheckpoint = createHarness({ checkpoint: null });
  await withoutCheckpoint.controller.handleCommandSubmission('Explore B', []);
  expect(withoutCheckpoint.backend.sessions).toHaveLength(0);
  expect(withoutCheckpoint.controller.hasSideChat).toBe(false);
});


it('updates the collapsed chip as queued prompts begin and finish', async () => {
  const harness = createHarness();
  const { started } = await startSideChat(harness);
  const native = harness.backend.latest;
  native.establishChild('child-session');
  harness.controller.collapse();
  expect(screen.getByRole('button', { name: 'Side chat' }).getAttribute('title')).toBe('Side chat · Working');
  await harness.controller.handleCommandSubmission('First queued prompt', []);
  await harness.controller.handleCommandSubmission('Second queued prompt', []);
  expect(screen.getByRole('button', { name: 'Side chat' }).getAttribute('title')).toBe('Side chat · 2 queued');

  native.complete();
  await waitFor(() => expect(native.requests).toHaveLength(2));
  expect(screen.getByRole('button', { name: 'Side chat' }).getAttribute('title')).toBe('Side chat · 1 queued');
  native.complete();
  await waitFor(() => expect(native.requests).toHaveLength(3));
  expect(screen.getByRole('button', { name: 'Side chat' }).getAttribute('title')).toBe('Side chat · Working');
  native.complete();
  await started;
  const chip = screen.getByRole('button', { name: 'Side chat' });
  expect(chip.getAttribute('aria-expanded')).toBe('false');
  expect(await axe(harness.composerEl)).toHaveNoViolations();
  fireEvent.click(chip);
  expect(harness.controller.destination).toBe('side');
});


it('places the collapsed active chip before navigation in single pane and restores it in dual pane', async () => {
  const harness = createHarness();
  let activeController = harness.controller;
  let isWide = false;
  const { placement, footer, navHost } = mountChipPlacement({
    getActiveTab: () => chipTabFor(activeController),
    isWide: () => isWide,
    getTabCount: () => 1,
  });
  const host = footer.querySelector<HTMLElement>('.claudian-side-chat-chip-slot')!;
  const nav = navHost.appendChild(document.createElement('button'));
  nav.textContent = 'Tab 1';
  footer.querySelector('.claudian-active-input-slot')!.appendChild(harness.composerEl);
  placement.updateChip();
  const { started } = await startSideChat(harness);
  harness.backend.latest.establishChild('child-session');
  harness.backend.latest.complete();
  await started;
  fireEvent.click(screen.getByRole('button', { name: 'Collapse' }));
  const chip = screen.getByRole('button', { name: 'Side chat' });
  expect(host.contains(chip)).toBe(true);
  expect(chip.compareDocumentPosition(nav) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  activeController = createHarness().controller;
  placement.updateChip();
  expect(host.childElementCount).toBe(0);
  expect(harness.composerEl.contains(chip)).toBe(true);
  activeController = harness.controller;
  placement.updateChip();
  expect(host.contains(chip)).toBe(true);
  chip.focus();
  fireEvent.click(chip);
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Collapse' }));
  expect(harness.composerEl.contains(screen.getByRole('heading', { name: 'Side chat' }))).toBe(true);
  expect(host.childElementCount).toBe(0);

  fireEvent.click(screen.getByRole('button', { name: 'Collapse' }));
  isWide = true;
  placement.updateChip();
  expect(harness.composerEl.contains(chip)).toBe(true);
  expect(host.childElementCount).toBe(0);
  await harness.controller.discard();
  expect(screen.queryByRole('button', { name: 'Side chat' })).toBeNull();
});


it('uses the navigation row for a single-tab chip and moves it above navigation when more tabs exist', async () => {
  const harness = createHarness();
  let tabCount = 1;
  const { placement, footer, navHost } = mountChipPlacement({
    getActiveTab: () => chipTabFor(harness.controller),
    isWide: () => false,
    getTabCount: () => tabCount,
  });
  const host = footer.querySelector<HTMLElement>('.claudian-side-chat-chip-slot')!;
  const navContent = document.createElement('div');
  navContent.appendChild(document.createElement('div'));
  const newTab = navContent.appendChild(document.createElement('button'));
  newTab.textContent = 'New tab';
  placement.attachNavRow(navContent);
  footer.appendChild(harness.composerEl);
  placement.updateChip();
  const { started } = await startSideChat(harness);
  harness.backend.latest.establishChild('child-session');
  harness.backend.latest.complete();
  await started;
  harness.controller.collapse();
  const chip = screen.getByRole('button', { name: 'Side chat' });
  expect(navContent.contains(chip)).toBe(true);
  expect(chip.compareDocumentPosition(newTab) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

  tabCount = 2;
  placement.updateChip();
  expect(host.parentElement).toBe(footer);
  expect(host.nextElementSibling).toBe(navHost);
  expect(host.contains(chip)).toBe(true);

  tabCount = 1;
  placement.updateChip();
  expect(navContent.contains(chip)).toBe(true);
  fireEvent.click(chip);
  expect(harness.composerEl.contains(screen.getByRole('heading', { name: 'Side chat' }))).toBe(true);
  expect(host.childElementCount).toBe(0);
});

/** Mounts the view footer placement over a fake active tab whose chip host is the real side chat. */
function mountChipPlacement(context: {
  getActiveTab(): { placement: ReturnType<typeof createTabPlacementPort> };
  isWide(): boolean;
  getTabCount(): number;
}) {
  const chatPanelEl = document.body.appendChild(document.createElement('div'));
  const placement = new ChatPresentationPlacement({
    getActiveTab: () => context.getActiveTab() as never,
    getTab: () => null,
    isWide: () => context.isWide(),
    getTabCount: () => context.getTabCount(),
  });
  placement.mount(chatPanelEl);
  const footer = chatPanelEl.querySelector<HTMLElement>('.claudian-input-footer')!;
  const navHost = footer.querySelector<HTMLElement>('.claudian-view-input-nav-row')!;
  return { placement, footer, navHost };
}

const chipTabs = new WeakMap<object, { placement: ReturnType<typeof createTabPlacementPort> }>();

/** A stable tab per side chat controller whose placement routes the chip like an assembled tab. */
function chipTabFor(controller: { setCollapsedHost(host: HTMLElement | null): void }) {
  let tab = chipTabs.get(controller);
  if (!tab) {
    tab = { placement: createTabPlacementPort({} as never, host => controller.setCollapsedHost(host)) };
    chipTabs.set(controller, tab);
  }
  return tab;
}
