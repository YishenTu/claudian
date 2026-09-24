/** @jest-environment jsdom */

import '@/providers';

import { claudeCatalogFixture } from '@test/helpers/claudeModels';
import { fireEvent, waitFor, within } from '@testing-library/dom';
import { axe } from 'jest-axe';
import { Notice } from 'obsidian';

import { RoutedTitleGenerationService } from '@/core/auxiliary/RoutedTitleGenerationService';
import type { Conversation } from '@/core/types';
import { SessionBrowser, type SessionBrowserDeps } from '@/features/chat/session-manager/SessionBrowser';

HTMLElement.prototype.empty = function () { this.replaceChildren(); };
HTMLElement.prototype.addClass = function (...classes) { this.classList.add(...classes); };
HTMLElement.prototype.removeClass = function (...classes) { this.classList.remove(...classes); };
HTMLElement.prototype.hasClass = function (className) { return this.classList.contains(className); };

function setup(status?: Conversation['titleGenerationStatus'], enabled = true) {
  const conversation = {
    id: 'conversation', title: 'Fallback title', createdAt: 1, lastActivityAt: 2,
    titleGenerationStatus: status, messages: [{ role: 'user', content: 'Explain the code' }],
  };
  const settings = {
    enableAutoTitleGeneration: enabled, titleGenerationModel: 'haiku',
    providerConfigs: { claude: claudeCatalogFixture(['haiku']) },
  };
  const generateTitle = jest.fn(async (id, _text, callback) => callback(id, { success: true, title: 'Code explained' }));
  const renameConversation = jest.fn(async (_id, title) => { conversation.title = title; });
  const updateConversation = jest.fn(async (_id, patch) => { Object.assign(conversation, patch); });
  const container = document.body.appendChild(document.createElement('div'));
  const onSelectConversation = jest.fn();
  const browser = new SessionBrowser({
    plugin: {
      settings, getConversationList: () => [conversation],
      getConversationById: async () => conversation, renameConversation, updateConversation,
    },
    getCurrentConversationId: () => null,
    isStreaming: () => false,
    getTitleGenerationService: () => ({ generateTitle, cancel: jest.fn() }),
    onListChanged: () => browser.renderHistoryDropdown(container, { onSelectConversation }),
  } as unknown as SessionBrowserDeps);
  browser.renderHistoryDropdown(container, { onSelectConversation });
  return { browser, container, settings, conversation, generateTitle, renameConversation, onSelectConversation };
}

afterEach(() => { document.body.replaceChildren(); jest.clearAllMocks(); });

it('generates a title for a previously skipped chat after selecting an available model', async () => {
  const fixture = setup();
  fixture.settings.titleGenerationModel = 'removed-model';
  const button = within(fixture.container).getByRole('button', { name: 'Generate title' });
  expect(button.getAttribute('type')).toBe('button');
  fireEvent.click(button);
  await waitFor(() => expect(Notice).toHaveBeenCalledWith('Select an available title model in Claudian settings.'));
  expect(fixture.generateTitle).not.toHaveBeenCalled();
  expect(fixture.conversation.title).toBe('Fallback title');
  expect(fixture.conversation.titleGenerationStatus).toBeUndefined();
  fixture.settings.titleGenerationModel = 'haiku';
  fireEvent.click(button);
  await waitFor(() => expect(fixture.conversation.titleGenerationStatus).toBe('success'));
  expect(fixture.renameConversation).toHaveBeenCalledWith('conversation', 'Code explained');
  expect(fixture.onSelectConversation).not.toHaveBeenCalled();
  fixture.browser.dispose();
});

it('offers an accessible native title action', async () => {
  const { browser, container } = setup();
  const button = within(container).getByRole('button', { name: 'Generate title' });
  button.focus();
  expect(document.activeElement).toBe(button);
  expect((await axe(button)).violations).toEqual([]);
  browser.dispose();
});

it.each(['pending', 'success'] as const)('does not offer generation for %s titles', status => {
  const { browser, container } = setup(status);
  expect(within(container).queryByRole('button', { name: /Generate title|Regenerate title/ })).toBeNull();
  browser.dispose();
});

it('does not offer generation when automatic titles are disabled', () => {
  const { browser, container } = setup(undefined, false);
  expect(within(container).queryByRole('button', { name: 'Generate title' })).toBeNull();
  browser.dispose();
});

it('leaves pending and exposes retry when provider initialization fails', async () => {
  const fixture = setup();
  const service = new RoutedTitleGenerationService({
    resolveProviderId: () => 'claude',
    initializeProvider: async () => { throw new Error('Initialization failed'); },
    createService: () => { throw new Error('Execution must not start'); },
  });
  fixture.generateTitle.mockImplementation((id, text, callback) => service.generateTitle(id, text, callback));
  fireEvent.click(within(fixture.container).getByRole('button', { name: 'Generate title' }));
  await waitFor(() => expect(fixture.conversation.titleGenerationStatus).toBe('failed'));
  expect(fixture.conversation.title).toBe('Fallback title');
  expect(fixture.renameConversation).not.toHaveBeenCalled();
  expect(within(fixture.container).getByRole('button', { name: 'Regenerate title' }).getAttribute('type')).toBe('button');
  fixture.browser.dispose();
});
