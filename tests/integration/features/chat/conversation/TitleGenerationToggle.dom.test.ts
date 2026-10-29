/** @vitest-environment jsdom */

import '@/providers';

import { claudeCatalogFixture } from '@test/helpers/claudeModels';
import { DesktopVault } from '@test/helpers/core/DesktopVault';
import { DEFAULT_CLAUDIAN_SETTINGS } from '@test/helpers/defaultSettings';
import { testDate } from '@test/helpers/testClock';
import { fireEvent, waitFor, within } from '@testing-library/dom';
import type { MockedFunction } from 'vitest';

import { ConversationRepository } from '@/app/conversations/ConversationRepository';
import { SettingsCoordinator } from '@/app/settings/SettingsCoordinator';
import { ConversationPersistenceStore } from '@/app/storage/ConversationPersistenceStore';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';
import type { TitleGenerationService } from '@/core/providers/types';
import type { Conversation } from '@/core/types';
import { SessionBrowser, type SessionBrowserDeps } from '@/features/chat/session-manager/SessionBrowser';
import { ChatViewPublisher } from '@/features/chat/workspace/ChatViewPublisher';



HTMLElement.prototype.empty = function () { this.replaceChildren(); };
HTMLElement.prototype.addClass = function (...classes) { this.classList.add(...classes); };
HTMLElement.prototype.removeClass = function (...classes) { this.classList.remove(...classes); };
HTMLElement.prototype.hasClass = function (className) { return this.classList.contains(className); };

afterEach(() => { document.body.replaceChildren(); });

it('hides failed-title retry while title generation is disabled and restores working retry when enabled', async () => {
  const vault = await DesktopVault.create();
  const settings = structuredClone(DEFAULT_CLAUDIAN_SETTINGS);
  settings.enableAutoTitleGeneration = false;
  settings.titleGenerationModel = 'haiku';
  settings.providerConfigs.claude = claudeCatalogFixture(['haiku']);
  const coordinator = new SettingsCoordinator(settings, async () => undefined,
    (current, previous) => publisher.publishSettings(current, previous));
  const persistence = new ConversationPersistenceStore(vault.files, `device-${'a'.repeat(64)}`);
  const repository = new ConversationRepository({
    providers: ProviderRegistry, providerSettings: ProviderSettingsCoordinator,
    getSettings: () => settings, getVaultPath: () => vault.root, persistence,
    onConversationDeleted: async () => undefined,
  });
  const conversation: Conversation = {
    id: 'failed-title', providerId: 'claude', title: 'Fallback title', selectedModel: 'haiku',
    createdAt: testDate().getTime(), lastActivityAt: testDate().getTime(), sessionId: null,
    titleGenerationStatus: 'failed', messages: [{ id: 'user', role: 'user', content: 'Explain the code', timestamp: testDate().getTime() }],
  };
  repository.replaceAll([conversation, { ...conversation, id: 'skipped-title', titleGenerationStatus: undefined }]);
  const generateTitle: MockedFunction<TitleGenerationService['generateTitle']> = vi.fn(async (id, _text, callback) => { callback(id, { success: true, title: 'Code explained' }); });
  const container = document.body.appendChild(document.createElement('div'));
  const render = () => browser.renderHistoryDropdown(container, { onSelectConversation: vi.fn() });
  const browser = new SessionBrowser({
    plugin: {
      settings, getConversationList: () => repository.list(),
      getConversationById: repository.getById.bind(repository), updateConversation: repository.update.bind(repository),
      renameConversation: repository.rename.bind(repository),
      completeConversationTitleGeneration: repository.completeTitleGeneration.bind(repository),
    },
    getCurrentConversationId: () => null,
    getTitleGenerationService: () => ({ generateTitle, cancel: () => undefined }), onListChanged: render,
  } as unknown as SessionBrowserDeps);
  const publisher = new ChatViewPublisher({
    views: { getAllViews: () => [{ notifyConversationListChanged: render } as never] },
    zenMode: { reconcile() {} }, inactiveSessions: { request() {} }, hasLoadedAllSessionMetadata: () => true,
  });
  try {
    render();
    // On the old source this action is visible, but the real title policy returns without generating anything.
    const deadButton = within(container).queryByRole('button', { name: 'Regenerate title' });
    if (deadButton) fireEvent.click(deadButton);
    await Promise.resolve();
    expect(generateTitle).not.toHaveBeenCalled();
    expect(repository.getSync(conversation.id)?.titleGenerationStatus).toBe('failed');
    expect(within(container).queryByRole('button', { name: 'Generate title' })).toBeNull();
    expect(deadButton).toBeNull();

    await coordinator.mutate(draft => { draft.enableAutoTitleGeneration = true; });
    expect(within(container).getByRole('button', { name: 'Generate title' })).toBeTruthy();
    expect(within(container).getByRole('button', { name: 'Regenerate title' })).toBeTruthy();
    await coordinator.mutate(draft => { draft.enableAutoTitleGeneration = false; });
    expect(within(container).queryByRole('button', { name: /Generate title|Regenerate title/ })).toBeNull();
    await coordinator.mutate(draft => { draft.enableAutoTitleGeneration = true; });
    fireEvent.click(within(container).getByRole('button', { name: 'Regenerate title' }));
    await waitFor(() => expect(repository.getSync(conversation.id)).toMatchObject({ title: 'Code explained', titleGenerationStatus: 'success' }));
    expect(generateTitle).toHaveBeenCalledTimes(1);
    expect(await persistence.metadataReader.loadMetadata(conversation.id)).toMatchObject({ title: 'Code explained', titleGenerationStatus: 'success' });
  } finally { browser.dispose(); await vault.dispose(); }
});
