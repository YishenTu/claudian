/** @jest-environment jsdom */
import '@/providers';

import { fireEvent, screen, waitFor } from '@testing-library/dom';

import { ClaudianView } from '@/features/chat/ClaudianView';
import { MessageRenderer } from '@/features/chat/rendering/MessageRenderer';

import {
  createHarness,
  releaseSideChatHarnesses,
  startSideChat,
} from './SideChatDOMHarness';

afterEach(releaseSideChatHarnesses);

it('passes global dynamic instructions to side chat execution', async () => {
  const dynamicSections = ['Use the active Collab project context.'];
  const harness = createHarness({ getMainAgentDynamicSystemPromptSections: async () => dynamicSections });
  const { started } = await startSideChat(harness);
  expect(harness.backend.latest.requests[0].configuration.systemInstructions).toEqual({
    kind: 'provider-default', dynamicSections,
  });
  harness.backend.latest.complete();
  await started;
});

it('delivers an admitted prompt to the child even when the panel collapses during preparation', async () => {
  const harness = createHarness();
  const started = harness.controller.handleCommandSubmission('Explore B', []);
  await waitFor(() => expect(harness.backend.sessions).toHaveLength(1));

  harness.controller.collapse();
  expect(harness.controller.destination).toBe('main');

  harness.backend.latest.establishChild('child-session');
  harness.backend.latest.complete();
  await started;

  expect(harness.backend.latest.requests[0].input).toEqual([{ text: 'Explore B', type: 'text' }]);
  // Late preparation cannot force the panel open again.
  expect(harness.controller.destination).toBe('main');
  expect(harness.composerEl.classList.contains('claudian-side-chat-expanded')).toBe(false);
  expect(screen.getByRole('button', { name: 'Side chat' })).toBeTruthy();
});

it('admits only one child per main conversation while startup is pending', async () => {
  const harness = createHarness();
  const first = harness.controller.handleCommandSubmission('Explore B', []);
  const second = harness.controller.handleCommandSubmission('Explore C', []);
  await waitFor(() => expect(harness.backend.sessions).toHaveLength(1));
  harness.backend.latest.establishChild('child-session');
  harness.backend.latest.complete();
  await Promise.all([first, second]);

  expect(harness.backend.sessions).toHaveLength(1);
  expect(screen.getAllByRole('heading', { name: 'Side chat' })).toHaveLength(1);
});

it('keeps one composer mounted and the collapsed status bar visible for every state', async () => {
  const harness = createHarness();
  const { started } = await startSideChat(harness);
  const composerCount = () => harness.composerEl.querySelectorAll('.claudian-input-wrapper').length;
  expect(composerCount()).toBe(1);

  harness.controller.collapse();
  const statusToggle = screen.getByRole('button', { name: 'Side chat' });
  expect(statusToggle.getAttribute('title')).toContain('Working');
  expect(composerCount()).toBe(1);

  harness.backend.latest.establishChild('child-session');
  harness.backend.latest.fail('Child history is gone', 'provider-session-missing');
  await started;

  expect(screen.getByRole('button', { name: 'Side chat' }).getAttribute('title'))
    .toContain('Child history is gone');
  // Errors never auto-expand the panel or change the destination.
  expect(harness.controller.destination).toBe('main');
  expect(composerCount()).toBe(1);
});

it('surfaces a collapsed side approval without changing the composer destination', async () => {
  const harness = createHarness();
  const { started } = await startSideChat(harness);
  harness.controller.collapse();

  const native = harness.backend.latest;
  const approval = native.config.interactionPort.requestApproval({
    description: 'Write a note', input: {}, interactionId: 'side-approval-1',
    kind: 'approval', sessionInstanceId: native.sessionInstanceId,
    toolName: 'Write', turnId: native.activeTurnId,
  }, new AbortController().signal);

  await waitFor(() => expect(
    screen.getByRole('button', { name: 'Side chat' }).getAttribute('title'),
  ).toContain('Needs input'));
  // The hidden approval never takes the composer target.
  expect(harness.controller.destination).toBe('main');

  harness.controller.expand();
  const allow = await screen.findByText('Allow once');
  fireEvent.click(allow);
  await expect(approval).resolves.toMatchObject({ decision: 'allow' });

  native.complete();
  await started;
  expect(harness.controller.destination).toBe('side');
});

it('disposes the child when its bound main conversation is replaced but keeps it on tab switching', async () => {
  const harness = createHarness();
  const { started } = await startSideChat(harness);
  harness.backend.latest.establishChild('child-session');
  harness.backend.latest.complete();
  await started;
  const native = harness.backend.latest;

  harness.controller.setTabActive(false);
  harness.controller.setTabActive(true);
  harness.controller.handleConversationChanged('conversation-1');
  expect(harness.controller.hasSideChat).toBe(true);
  expect(native.disposeCalls).toBe(0);

  harness.controller.handleConversationChanged('conversation-2');
  await waitFor(() => expect(native.disposeCalls).toBe(1));
  expect(harness.controller.hasSideChat).toBe(false);
  expect(screen.queryByRole('heading', { name: 'Side chat' })).toBeNull();
});

it('is safe to discard repeatedly and cannot be resurrected by late events', async () => {
  const harness = createHarness();
  const { started } = await startSideChat(harness);
  const native = harness.backend.latest;

  await harness.controller.discard();
  await harness.controller.discard();
  expect(native.disposeCalls).toBe(1);
  expect(await started).toBe(true);

  native.emitSessionEvent({ type: 'commands_changed' });
  expect(harness.controller.hasSideChat).toBe(false);
  expect(screen.queryByRole('heading', { name: 'Side chat' })).toBeNull();
});

it('shows completed side work duration and the completion timestamp using the main renderer', async () => {
  const harness = createHarness({ settings: { showMessageTimestamps: true } });
  const elapsed = jest.spyOn(performance, 'now').mockReturnValue(1000);
  const clock = jest.spyOn(Date, 'now').mockReturnValue(new Date('2026-09-20T10:00:00Z').getTime());
  try {
    const { started } = await startSideChat(harness);
    harness.backend.latest.establishChild('child-session');
    harness.backend.latest.emitText('A completed side answer.');
    elapsed.mockReturnValue(67000);
    const completedAt = new Date('2026-09-20T10:01:06Z');
    clock.mockReturnValue(completedAt.getTime());
    harness.backend.latest.complete();
    await started;

    expect(screen.getByRole('button', { name: 'Worked for 01:06' })).toBeTruthy();
    expect(screen.getByLabelText(completedAt.toLocaleString(undefined, { hourCycle: 'h23' }))).toBeTruthy();
  } finally {
    elapsed.mockRestore();
    clock.mockRestore();
  }
});

it('refreshes side completion timestamps when the view timestamp setting changes', async () => {
  const settings = { showMessageTimestamps: false };
  const harness = createHarness({ settings });
  const mainRenderer = new MessageRenderer(harness.plugin, {} as never, document.createElement('div'));
  const tab = {
    ...harness.tab,
    controllers: { ...harness.tab.controllers, sideChatController: harness.controller },
    renderer: mainRenderer,
  };
  const view = Object.assign(Object.create(ClaudianView.prototype), {
    tabManager: { getAllTabs: () => [tab] },
  }) as ClaudianView;
  const clock = jest.spyOn(Date, 'now').mockReturnValue(new Date('2026-09-20T10:00:00Z').getTime());
  try {
    const { started } = await startSideChat(harness);
    harness.backend.latest.emitText('A side answer.');
    const completedAt = new Date('2026-09-20T10:00:03Z');
    clock.mockReturnValue(completedAt.getTime());
    harness.backend.latest.complete();
    await started;
    harness.controller.collapse();
    const label = completedAt.toLocaleString(undefined, { hourCycle: 'h23' });
    expect(screen.queryByLabelText(label)).toBeNull();
    settings.showMessageTimestamps = true;
    view.refreshMessageTimestamps();
    expect(screen.getByLabelText(label)).toBeTruthy();
    settings.showMessageTimestamps = false;
    view.refreshMessageTimestamps();
    expect(screen.queryByLabelText(label)).toBeNull();
  } finally {
    clock.mockRestore();
    mainRenderer.dispose();
  }
});

it('keeps the side answer completed when cancellation follows native completion', async () => {
  const harness = createHarness();
  const { started } = await startSideChat(harness);
  harness.backend.latest.emitText('Completed answer');
  harness.backend.latest.complete();
  harness.controller.cancelSide();
  await started;
  expect(screen.getByRole('button', { name: /Worked for/ })).toBeTruthy();
  expect(screen.queryByText('Interrupted')).toBeNull();
});
