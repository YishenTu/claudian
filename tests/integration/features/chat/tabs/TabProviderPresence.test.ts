/** @vitest-environment jsdom */
import { useNextTaskAnimationFrames } from '@test/helpers/dom/animationFrames';
import { registerChatTestProvider } from '@test/helpers/features/chat/ChatProviderFixture';
import { conversationRecord, createManager, createPlugin, deferred } from '@test/helpers/features/chat/TabManagerIntegrationHarness';
import { Notice } from 'obsidian';

import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import type { ProviderId } from '@/core/providers/types';

function providerFixture(provider: ProviderId, startRuntime: () => Promise<void>) {
  const primary = registerChatTestProvider('claude', { models: [{ value: 'claude-default', label: 'Claude' }] });
  const other = registerChatTestProvider(provider, {
    models: [{ value: `${provider}:model`, label: provider }], workspace: { startRuntime },
  });
  return { primary, other };
}

it.each((['codex', 'opencode'] as const).flatMap(provider => [
  { provider, restored: { conversationId: `${provider}-history` } },
  { provider, restored: { conversationId: null, providerId: provider, draftModel: `${provider}:model` } },
]))('starts a shared runtime for an inactive restored tab without creating execution: %o', async ({ provider, restored }) => {
  const started = deferred<void>();
  const startRuntime = vi.fn(async () => { started.resolve(); });
  const { primary, other } = providerFixture(provider, startRuntime);
  const plugin = await createPlugin({
    getCachedConversation: id => conversationRecord(id, { providerId: id === `${provider}-history` ? provider : 'claude' }),
  });
  ProviderRegistry.setEnabled(provider, plugin.settings, true);
  const { manager } = await createManager(plugin);
  await manager.restoreState({
    openTabs: [{ tabId: 'visible', conversationId: 'claude-history' }, { tabId: 'hidden', ...restored }],
    activeTabId: 'visible',
  });
  await started.promise;
  expect(startRuntime).toHaveBeenCalledTimes(1);
  expect(manager.getTab('hidden')).toBeNull();
  expect(primary.sessions).toEqual([]);
  expect(other.sessions).toEqual([]);
});

it.each(['codex', 'opencode'] as const)('starts a shared runtime when a blank tab changes to %s without preparing execution', async provider => {
  const started = deferred<void>();
  const startRuntime = vi.fn(async () => { started.resolve(); });
  const { primary, other } = providerFixture(provider, startRuntime);
  const plugin = await createPlugin();
  ProviderRegistry.setEnabled(provider, plugin.settings, true);
  const { manager } = await createManager(plugin);
  const tab = (await manager.createTab())!;
  expect(startRuntime).not.toHaveBeenCalled();
  tab.session.selectDraft(provider, `${provider}:model`);
  manager.reconcileProviderAvailability();
  await started.promise;
  expect(startRuntime).toHaveBeenCalledTimes(1);
  expect(primary.sessions).toEqual([]);
  expect(other.sessions).toEqual([]);
  expect(tab.executionCoordinator.state).toBe('absent');
});

it('keeps repeated passive runtime startup failures silent', async () => {
  const failed = deferred<void>();
  let nextAttempt = failed;
  const startRuntime = vi.fn(async () => { nextAttempt.resolve(); throw new Error('Codex missing'); });
  const { other } = providerFixture('codex', startRuntime);
  const plugin = await createPlugin();
  ProviderRegistry.setEnabled('codex', plugin.settings, true);
  const { manager } = await createManager(plugin);
  const tab = (await manager.createTab())!;
  tab.session.selectDraft('codex', 'codex:model');
  manager.reconcileProviderAvailability();
  await failed.promise;
  // A later tab action retries passive startup after the failed attempt.
  await manager.createTab();
  nextAttempt = deferred<void>();
  manager.reconcileProviderAvailability();
  await nextAttempt.promise;
  expect(startRuntime).toHaveBeenCalledTimes(2);
  expect(Notice).not.toHaveBeenCalled();
  expect(other.sessions).toEqual([]);
});

beforeEach(() => { useNextTaskAnimationFrames(); });
