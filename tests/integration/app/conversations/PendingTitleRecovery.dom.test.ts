/** @vitest-environment jsdom */

import '@/providers';

import { claudeCatalogFixture } from '@test/helpers/claudeModels';
import { DesktopVault } from '@test/helpers/core/DesktopVault';
import { DEFAULT_CLAUDIAN_SETTINGS } from '@test/helpers/defaultSettings';
import { testDate } from '@test/helpers/testClock';
import { fireEvent, waitFor, within } from '@testing-library/dom';

import { ConversationRepository } from '@/app/conversations/ConversationRepository';
import { SessionMetadataLoader } from '@/app/conversations/SessionMetadataLoader';
import { RuntimeSettingsCoordinator } from '@/app/settings/RuntimeSettingsCoordinator';
import { SettingsCoordinator } from '@/app/settings/SettingsCoordinator';
import { ConversationPersistenceStore } from '@/app/storage/ConversationPersistenceStore';
import { ProviderExecutionLifecycleRegistry } from '@/core/execution';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';
import type { TitleGenerationService } from '@/core/providers/types';
import type { SessionMetadata } from '@/core/types';
import { SessionBrowser, type SessionBrowserDeps } from '@/features/chat/session-manager/SessionBrowser';

HTMLElement.prototype.empty = function () { this.replaceChildren(); };
HTMLElement.prototype.addClass = function (...classes) { this.classList.add(...classes); };
HTMLElement.prototype.removeClass = function (...classes) { this.classList.remove(...classes); };
HTMLElement.prototype.hasClass = function (className) { return this.classList.contains(className); };

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

async function fixture() {
  const vault = await DesktopVault.create();
  const settings = structuredClone(DEFAULT_CLAUDIAN_SETTINGS);
  settings.enableAutoTitleGeneration = true;
  settings.titleGenerationModel = 'haiku';
  settings.providerConfigs.claude = claudeCatalogFixture(['haiku']);
  const persistence = new ConversationPersistenceStore(vault.files, `device-${'a'.repeat(64)}`);
  const repository = new ConversationRepository({
    providers: ProviderRegistry, providerSettings: ProviderSettingsCoordinator,
    getSettings: () => settings, getVaultPath: () => vault.root, persistence,
    onConversationDeleted: async () => undefined,
  });
  const executionLifecycle = new ProviderExecutionLifecycleRegistry();
  const runtimeSettings = new RuntimeSettingsCoordinator({
    settings: new SettingsCoordinator(settings, async () => undefined), conversations: repository,
    getSettings: () => settings, canCompleteInvalidations: () => false, executionLifecycle,
  });
  const loader = new SessionMetadataLoader({
    sessions: persistence.metadataReader, conversations: repository,
    providerSettings: ProviderSettingsCoordinator, runtimeSettings,
    isUnloading: () => false, whenLayoutReady: callback => callback(), onConversationListChanged: () => undefined,
  });
  const metadata: SessionMetadata = {
    id: 'interrupted-title', providerId: 'claude', title: 'Fallback title', selectedModel: 'haiku',
    createdAt: testDate().getTime(), lastActivityAt: testDate().getTime(), sessionId: null,
    titleGenerationStatus: 'pending',
  };
  await persistence.saveMetadata(metadata);
  const container = document.body.appendChild(document.createElement('div'));
  const service: TitleGenerationService = {
    generateTitle: async (id, _text, callback) => { callback(id, { success: true, title: 'Recovered title' }); },
    cancel: () => undefined,
  };
  const render = () => browser.renderHistoryDropdown(container, { onSelectConversation: vi.fn() });
  const browser = new SessionBrowser({
    plugin: {
      settings, getConversationList: () => repository.list(),
      getConversationById: repository.getById.bind(repository),
      updateConversation: repository.update.bind(repository),
      renameConversation: repository.rename.bind(repository),
      completeConversationTitleGeneration: repository.completeTitleGeneration.bind(repository),
    },
    getCurrentConversationId: () => null, getTitleGenerationService: () => service, onListChanged: render,
  } as unknown as SessionBrowserDeps);
  return { vault, persistence, repository, loader, metadata, container, browser, render,
    dispose: async () => { browser.dispose(); await loader.dispose(); await executionLifecycle.dispose(); await vault.dispose(); } };
}

it('offers and completes title retry after loading an interrupted job from disk', async () => {
  const f = await fixture();
  try {
    // Provider history is an external port; storage, metadata restoration, repository and title policy remain real.
    const history = ProviderRegistry.getConversationHistoryService('claude');
    vi.spyOn(ProviderRegistry, 'getConversationHistoryService').mockReturnValue({
      ...history,
      hydrateConversationHistory: async () => ({ messages: [{ id: 'user', role: 'user', content: 'Explain the code', timestamp: testDate().getTime() }] }),
    });
    await f.loader.ensureLoaded([f.metadata.id]);
    f.render();
    fireEvent.click(within(f.container).getByRole('button', { name: 'Regenerate title' }));
    await waitFor(() => expect(f.repository.list()[0]).toMatchObject({ title: 'Recovered title', titleGenerationStatus: 'success' }));
    expect(await f.persistence.metadataReader.loadMetadata(f.metadata.id)).toMatchObject({ title: 'Recovered title', titleGenerationStatus: 'success' });
    expect(f.container.querySelector('.claudian-action-loading')).toBeNull();
  } finally { await f.dispose(); }
});

it('keeps live pending jobs and completed persisted titles unchanged', async () => {
  const f = await fixture();
  try {
    f.repository.replaceAll([{ ...f.metadata, providerId: 'claude', sessionId: f.metadata.sessionId ?? null, messages: [] }]);
    await f.loader.ensureLoaded([f.metadata.id]);
    f.render();
    expect(f.repository.list()[0].titleGenerationStatus).toBe('pending');
    expect(f.container.querySelector('.claudian-action-loading')).not.toBeNull();
    expect(within(f.container).queryByRole('button', { name: 'Regenerate title' })).toBeNull();
    for (const status of ['success', 'failed'] as const) {
      await f.persistence.saveMetadata({ ...f.metadata, id: status, titleGenerationStatus: status });
    }
    await f.loader.ensureLoaded(['success', 'failed']);
    expect(f.repository.list().find(({ id }) => id === 'success')?.titleGenerationStatus).toBe('success');
    expect(f.repository.list().find(({ id }) => id === 'failed')?.titleGenerationStatus).toBe('failed');
  } finally { await f.dispose(); }
});
