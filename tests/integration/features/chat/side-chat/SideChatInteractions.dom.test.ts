/** @jest-environment jsdom */
import '@/providers';

import { createHarness, releaseSideChatHarnesses, startSideChat } from '@test/helpers/features/chat/SideChatDOMHarness';
import { fireEvent, screen, waitFor } from '@testing-library/dom';
import { axe } from 'jest-axe';

afterEach(releaseSideChatHarnesses);

it.each(['approval', 'question'] as const)('dismisses only the named overlapping %s', async kind => {
  const harness = createHarness();
  const { started } = await startSideChat(harness);
  harness.controller.expand();
  const native = harness.backend.latest;
  const port = native.config.interactionPort;
  const request = (interactionId: string) => {
    const common = { interactionId, sessionInstanceId: native.sessionInstanceId, turnId: native.activeTurnId };
    return kind === 'approval'
      ? port.requestApproval({ ...common, kind, toolName: interactionId, description: `${interactionId} details`, input: {} }, new AbortController().signal)
      : port.askUserQuestion({ ...common, kind, input: { questions: [{ question: `${interactionId} question`, options: [{ label: 'Yes', description: '' }] }] } }, new AbortController().signal);
  };
  const first = request('first').catch(() => null);
  const second = request('second').catch(() => null);
  await waitFor(() => expect(screen.getByText(kind === 'approval' ? 'second details' : 'second question')).toBeTruthy());
  port.dismissInteraction('first', 'native-rejected');
  expect(screen.queryByText(kind === 'approval' ? 'first details' : 'first question')).toBeNull();
  expect(screen.getByText(kind === 'approval' ? 'second details' : 'second question')).toBeTruthy();
  port.dismissInteraction('second', 'native-rejected');
  await Promise.all([first, second]);
  expect(screen.queryByText(kind === 'approval' ? 'second details' : 'second question')).toBeNull();
  native.complete();
  await started;
});

it('completing one approval leaves the other reachable for cancellation', async () => {
  const harness = createHarness();
  const { started } = await startSideChat(harness);
  harness.controller.expand();
  const native = harness.backend.latest;
  const port = native.config.interactionPort;
  const request = (interactionId: string) => port.requestApproval({
    interactionId, sessionInstanceId: native.sessionInstanceId, turnId: native.activeTurnId,
    kind: 'approval', toolName: interactionId, description: `${interactionId} details`, input: {},
  }, new AbortController().signal);
  const first = request('first');
  const second = request('second').catch(() => null);
  await waitFor(() => expect(screen.getAllByText('Allow once', { exact: true })).toHaveLength(2));
  const prompt = screen.getByRole('region', { name: 'first approval details' }).closest<HTMLElement>('.claudian-ask-question-inline')!;
  expect(await axe(prompt)).toHaveNoViolations();
  fireEvent.click(screen.getAllByText('Allow once', { exact: true })[0]);
  await expect(first).resolves.toMatchObject({ decision: 'allow', interactionId: 'first' });
  port.dismissInteraction('second', 'cancelled');
  expect(screen.queryByRole('region', { name: 'second approval details' })).toBeNull();
  await second;
  native.complete();
  await started;
});
