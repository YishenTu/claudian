/** @jest-environment jsdom */
import '@/providers';

import { claudeCatalogFixture } from '@test/helpers/claudeModels';
import { screen, waitFor } from '@testing-library/dom';

import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';

import { createHarness, releaseSideChatHarnesses, startSideChat } from './SideChatDOMHarness';

beforeEach(() => ProviderWorkspaceRegistry.setServices('claude', {}));
afterEach(async () => {
  await releaseSideChatHarnesses();
  ProviderWorkspaceRegistry.clear();
});

it('generates a side title from its initial prompt without blocking chat or changing destination', async () => {
  const harness = createHarness({ settings: {
    enableAutoTitleGeneration: true,
    titleGenerationModel: 'haiku',
    providerConfigs: { claude: claudeCatalogFixture(['haiku']) },
  } });
  const titles = {
    get sessions() {
      return harness.backend.sessions.filter(session => session.requests[0]?.toolPolicy.kind === 'passive');
    },
  };
  const { started } = await startSideChat(harness, 'Explain the alternate design');
  await waitFor(() => expect(titles.sessions[0]?.requests).toHaveLength(1));
  expect(titles.sessions[0].requests[0].input).toEqual([
    { type: 'text', text: expect.stringContaining('Explain the alternate design') },
  ]);
  expect(titles.sessions[0].requests[0].input).not.toEqual([
    { type: 'text', text: expect.stringContaining('Remember A') },
  ]);
  expect(titles.sessions[0].requests[0].toolPolicy).toEqual({ kind: 'passive' });
  expect(screen.getByRole('heading', { name: 'Explain the alternate design' })).toBeTruthy();
  harness.controller.collapse();
  titles.sessions[0].emitText('Alternative design');
  titles.sessions[0].complete();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Alternative design' })).toBeTruthy());
  expect(harness.controller.destination).toBe('main');
  harness.backend.latest.establishChild('child-session');
  harness.backend.latest.complete();
  await started;
  harness.controller.expand();
  expect(screen.getByRole('heading', { name: 'Alternative design' })).toBeTruthy();

  const followup = harness.controller.submitToSide('A different question', []);
  await waitFor(() => expect(harness.backend.latest.requests).toHaveLength(2));
  harness.backend.latest.complete();
  await followup;
  expect(screen.getByRole('heading', { name: 'Alternative design' })).toBeTruthy();
  expect(titles.sessions).toHaveLength(1);
});

it('keeps the generic title without launching title generation when disabled', async () => {
  const harness = createHarness({ settings: { enableAutoTitleGeneration: false } });
  const titles = {
    get sessions() {
      return harness.backend.sessions.filter(session => session.requests[0]?.toolPolicy.kind === 'passive');
    },
  };
  const { started } = await startSideChat(harness);
  harness.backend.latest.complete();
  await started;
  expect(screen.getByRole('heading', { name: 'Side chat' })).toBeTruthy();
  expect(titles.sessions).toHaveLength(0);
});

it('retains the initial prompt fallback if the title request fails', async () => {
  const harness = createHarness({ settings: {
    enableAutoTitleGeneration: true,
    titleGenerationModel: 'haiku',
    providerConfigs: { claude: claudeCatalogFixture(['haiku']) },
  } });
  const titles = {
    get sessions() {
      return harness.backend.sessions.filter(session => session.requests[0]?.toolPolicy.kind === 'passive');
    },
  };
  const { started } = await startSideChat(harness, 'Explore storage. Consider a log.');
  await waitFor(() => expect(titles.sessions[0]?.requests).toHaveLength(1));
  titles.sessions[0].fail('Title provider unavailable');
  await waitFor(() => expect(titles.sessions[0].getStatus()).toBe('disposed'));
  expect(screen.getByRole('heading', { name: 'Explore storage' })).toBeTruthy();
  harness.backend.latest.complete();
  await started;
});

it('cancels a discarded side title without disturbing its replacement', async () => {
  const harness = createHarness({ settings: {
    enableAutoTitleGeneration: true,
    titleGenerationModel: 'haiku',
    providerConfigs: { claude: claudeCatalogFixture(['haiku']) },
  } });
  const titles = {
    get sessions() {
      return harness.backend.sessions.filter(session => session.requests[0]?.toolPolicy.kind === 'passive');
    },
  };
  const { started } = await startSideChat(harness, 'First question');
  await waitFor(() => expect(titles.sessions[0]?.requests).toHaveLength(1));
  await harness.controller.discard();
  await started;
  await waitFor(() => expect(titles.sessions[0].getStatus()).toBe('disposed'));
  const next = harness.controller.handleCommandSubmission('Replacement question', []);
  await waitFor(() => expect(titles.sessions[1]?.requests).toHaveLength(1));
  titles.sessions[0].emitText('Obsolete title');
  titles.sessions[0].complete();
  titles.sessions[1].emitText('Replacement title');
  titles.sessions[1].complete();
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Replacement title' })).toBeTruthy());
  harness.backend.latest.complete();
  await next;
});

it('keeps the prompt title without a provider request until a title model is selected', async () => {
  const harness = createHarness({ settings: {
    enableAutoTitleGeneration: true,
    titleGenerationModel: '',
    providerConfigs: { claude: claudeCatalogFixture(['haiku']) },
  } });
  const { started } = await startSideChat(harness, 'Explore storage. Consider a log.');
  harness.backend.latest.complete();
  await started;
  expect(screen.getByRole('heading', { name: 'Explore storage' })).toBeTruthy();
  expect(harness.backend.sessions.flatMap(session => session.requests)
    .filter(request => request.toolPolicy.kind === 'passive')).toHaveLength(0);
});
