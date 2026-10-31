/** @vitest-environment jsdom */

import '@/providers';

import { axe } from '@test/helpers/accessibility';
import { claudeCatalogFixture } from '@test/helpers/claudeModels';
import { createSessionBrowserHost } from '@test/helpers/features/chat/SessionBrowserTestHarness';
import { fireEvent, waitFor, within } from '@testing-library/dom';
import { Notice } from 'obsidian';

import { RoutedTitleGenerationService } from '@/core/auxiliary/RoutedTitleGenerationService';
import type { Conversation } from '@/core/types';
import { SessionBrowser } from '@/features/chat/session-manager/SessionBrowser';


async function setup(status?: Conversation['titleGenerationStatus'], enabled = true) {
  const conversation: Conversation = {
    id: 'conversation', providerId: 'claude', sessionId: null, title: 'Fallback title', createdAt: 1, lastActivityAt: 2,
    titleGenerationStatus: status, messages: [{ id: 'message', role: 'user', content: 'Explain the code', timestamp: 1 }],
  };
  const initialSettings = {
    enableAutoTitleGeneration: enabled, titleGenerationModel: 'haiku',
    providerConfigs: { claude: claudeCatalogFixture(['haiku']) },
  };
  const generateTitle = vi.fn(async (id, _text, callback) => callback(id, { success: true, title: 'Code explained' }));
  const completeConversationTitleGeneration = vi.fn(async (_id, _expectedTitle, title) => {
    if (title !== null) conversation.title = title;
    conversation.titleGenerationStatus = title === null ? 'failed' : 'success';
  });
  const updateConversation = vi.fn(async (_id, patch) => { Object.assign(conversation, patch); });
  const container = document.body.appendChild(document.createElement('div'));
  const onSelectConversation = vi.fn();
  const { plugin } = await createSessionBrowserHost({ host: {
    settings: initialSettings, getConversationList: () => [{ ...conversation, messageCount: 1, preview: '' }],
    getConversationById: async () => conversation, completeConversationTitleGeneration, updateConversation,
  } });
  const settings = plugin.settings;
  const browser = new SessionBrowser({
    plugin,
    getCurrentConversationId: () => null,
    getTitleGenerationService: () => ({ generateTitle, cancel: vi.fn() }),
    onListChanged: () => browser.renderHistoryDropdown(container, { onSelectConversation }),
  });
  browser.renderHistoryDropdown(container, { onSelectConversation });
  return { browser, container, settings, plugin, conversation, generateTitle, completeConversationTitleGeneration, onSelectConversation };
}

afterEach(() => { document.body.replaceChildren(); vi.clearAllMocks(); });

it('generates a title for a previously skipped chat after selecting an available model', async () => {
  const fixture = await setup();
  await fixture.plugin.mutateSettings(settings => { settings.titleGenerationModel = 'removed-model'; });
  const button = within(fixture.container).getByRole('button', { name: 'Generate title' });
  expect(button.getAttribute('type')).toBe('button');
  fireEvent.click(button);
  await waitFor(() => expect(Notice).toHaveBeenCalledWith('Select an available title model in Claudian settings.'));
  expect(fixture.generateTitle).not.toHaveBeenCalled();
  expect(fixture.conversation.title).toBe('Fallback title');
  expect(fixture.conversation.titleGenerationStatus).toBeUndefined();
  await fixture.plugin.mutateSettings(settings => { settings.titleGenerationModel = 'haiku'; });
  fireEvent.click(button);
  await waitFor(() => expect(fixture.conversation.titleGenerationStatus).toBe('success'));
  expect(fixture.completeConversationTitleGeneration).toHaveBeenCalledWith('conversation', 'Fallback title', 'Code explained');
  expect(fixture.onSelectConversation).not.toHaveBeenCalled();
  fixture.browser.dispose();
});

it('offers an accessible native title action', async () => {
  const { browser, container } = await setup();
  const button = within(container).getByRole('button', { name: 'Generate title' });
  button.focus();
  expect(document.activeElement).toBe(button);
  expect((await axe(button)).violations).toEqual([]);
  browser.dispose();
});

it.each(['pending', 'success'] as const)('does not offer generation for %s titles', async status => {
  const { browser, container } = await setup(status);
  expect(within(container).queryByRole('button', { name: /Generate title|Regenerate title/ })).toBeNull();
  browser.dispose();
});

it('does not offer generation when automatic titles are disabled', async () => {
  const { browser, container } = await setup(undefined, false);
  expect(within(container).queryByRole('button', { name: 'Generate title' })).toBeNull();
  browser.dispose();
});

it('leaves pending and exposes retry when provider initialization fails', async () => {
  const fixture = await setup();
  const service = new RoutedTitleGenerationService({
    resolveProviderId: () => 'claude',
    initializeProvider: async () => { throw new Error('Initialization failed'); },
    createService: () => { throw new Error('Execution must not start'); },
  });
  fixture.generateTitle.mockImplementation((id, text, callback) => service.generateTitle(id, text, callback));
  fireEvent.click(within(fixture.container).getByRole('button', { name: 'Generate title' }));
  await waitFor(() => expect(fixture.conversation.titleGenerationStatus).toBe('failed'));
  expect(fixture.conversation.title).toBe('Fallback title');
  expect(fixture.completeConversationTitleGeneration).toHaveBeenCalledWith('conversation', 'Fallback title', null);
  expect(within(fixture.container).getByRole('button', { name: 'Regenerate title' }).getAttribute('type')).toBe('button');
  fixture.browser.dispose();
});
