/** @vitest-environment jsdom */
import { DesktopVault } from '@test/helpers/core/DesktopVault';
import { useNextTaskAnimationFrames } from '@test/helpers/dom/animationFrames';
import { createFeatureHostFixture } from '@test/helpers/FeatureHostFixture';
import { registerChatTestProvider } from '@test/helpers/features/chat/ChatProviderFixture';
import { conversationRecord, createManager, createPlugin, deferred } from '@test/helpers/features/chat/TabManagerIntegrationHarness';

import { RuntimeCommandCatalog } from '@/core/providers/commands/RuntimeCommandCatalog';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import type { ProviderCommandLoader } from '@/core/providers/types';
import type { Conversation, SlashCommand } from '@/core/types';
import type { AssembledTabRuntime } from '@/features/chat/tabs/types';

let provider: ReturnType<typeof registerChatTestProvider>;
beforeEach(() => {
  useNextTaskAnimationFrames();
  provider = registerChatTestProvider('claude', { models: [{ value: 'claude-default', label: 'Claude' }] });
});

function discoveryFor(tab: AssembledTabRuntime) { return tab.providerCatalogResolver()!.discovery; }
function reloadDiscovery(tab: AssembledTabRuntime) {
  const discovery = discoveryFor(tab);
  discovery.invalidate();
  return discovery.load();
}
const command = (name: string): SlashCommand => ({ id: name, name, description: name, content: '', source: 'sdk' });

it('validates cached workspace ownership during command lookup', async () => {
  const { manager } = await createManager();
  const tab = (await manager.createTab())!;
  await ProviderWorkspaceRegistry.disposeInitialized();
  const vaultA = await DesktopVault.create();
  onTestFinished(() => vaultA.dispose());
  const hostA = await createFeatureHostFixture({ vault: vaultA });
  await ProviderWorkspaceRegistry.ensureInitialized(hostA.providerHost, 'claude', 'host-a');
  await expect(reloadDiscovery(tab)).resolves.toMatchObject({ status: 'error' });
  expect(provider.loadCommands).not.toHaveBeenCalled();
});

it('uses each live provider session command snapshot instead of unrelated discovery state', async () => {
  const { manager } = await createManager();
  const first = (await manager.createTab('first'))!;
  const second = (await manager.createTab('second', 'second', { activate: false }))!;
  expect(await first.session.runtime.model.ensureExecutionInitialized()).toBe(true);
  expect(await second.session.runtime.model.ensureExecutionInitialized()).toBe(true);
  provider.sessions[0].commands = [command('first-live')];
  provider.sessions[1].commands = [command('second-live')];
  expect(await reloadDiscovery(first)).toMatchObject({ status: 'ready', items: [{ name: 'first-live' }] });
  expect(await reloadDiscovery(second)).toMatchObject({ status: 'ready', items: [{ name: 'second-live' }] });
  provider.sessions[0].commands = [];
  expect(await reloadDiscovery(first)).toEqual({ status: 'empty' });
  expect(provider.loadCommands).not.toHaveBeenCalled();
});

it('runs on-demand command discovery without creating a provider session', async () => {
  const { manager } = await createManager();
  const tab = (await manager.createTab())!;
  expect(provider.loadCommands).not.toHaveBeenCalled();
  await expect(reloadDiscovery(tab)).resolves.toMatchObject({ status: 'ready', items: [{ name: 'review' }] });
  expect(provider.loadCommands).toHaveBeenCalledWith(expect.objectContaining({ allowIsolatedMetadataCreation: true, conversation: null }));
  expect(provider.sessions).toEqual([]);
});

it('does not permit isolated command metadata for a background tab', async () => {
  const { manager } = await createManager();
  await manager.createTab();
  const background = (await manager.createTab('background-conversation', 'background', { activate: false }))!;
  await reloadDiscovery(background);
  expect(provider.loadCommands).toHaveBeenCalledTimes(1);
  expect(provider.loadCommands).toHaveBeenCalledWith(expect.objectContaining({ allowIsolatedMetadataCreation: false }));
  expect(provider.sessions).toEqual([]);
});

it('does not admit command observation after its tab becomes inactive during initialization', async () => {
  const { manager, plugin } = await createManager();
  const first = (await manager.createTab())!;
  const second = (await manager.createTab(null, 'second', { activate: false }))!;
  const discovery = discoveryFor(first);
  const initializing = deferred<void>();
  const initialized = deferred<void>();
  const watchCommands = vi.fn<NonNullable<ProviderCommandLoader['watchCommands']>>(async () => undefined);
  await ProviderWorkspaceRegistry.disposeInitialized();
  provider.workspace.commandLoader = { ...provider.commandLoader, watchCommands };
  provider.initialize.mockImplementationOnce(async () => { initializing.resolve(); await initialized.promise; return provider.workspace; });
  const controller = new AbortController();
  discovery.watch!(controller.signal);
  await initializing.promise;
  const switching = manager.switchToTab(second.id);
  initialized.resolve();
  await switching;
  // Joining the same initializer and a discovery request also joins observer admission.
  await ProviderWorkspaceRegistry.ensureInitialized(plugin.providerHost, 'claude', 'verify');
  await reloadDiscovery(second);
  expect(watchCommands).not.toHaveBeenCalled();
  controller.abort();
});

it('lets provider-owned command discovery outlive the shared deadline', async () => {
  const catalog = new RuntimeCommandCatalog({
    dropdownConfig: { providerId: 'claude', triggerChars: ['/'], builtInPrefix: '/', skillPrefix: '/', commandPrefix: '/', discoveryTimeoutMs: 'provider-owned' },
    projectEntry: entry => ({ ...entry, providerId: 'claude', kind: 'command', scope: 'runtime', source: 'sdk', isEditable: false, isDeletable: false, displayPrefix: '/', insertPrefix: '/' }),
  });
  provider.workspace.commandCatalog = catalog;
  const { manager } = await createManager();
  const tab = (await manager.createTab())!;
  const started = deferred<void>();
  const reply = deferred<Awaited<ReturnType<ProviderCommandLoader['loadCommands']>>>();
  provider.loadCommands.mockImplementationOnce(() => { started.resolve(); return reply.promise; });
  vi.useFakeTimers();
  try {
    const discovery = discoveryFor(tab);
    const load = discovery.load();
    await started.promise;
    await vi.advanceTimersByTimeAsync(8_000);
    expect(discovery.getSnapshot()).toEqual({ status: 'loading' });
    reply.resolve({ status: 'ready', items: [command('review')] });
    await expect(load).resolves.toMatchObject({ status: 'ready', items: [{ name: 'review' }] });
  } finally { vi.useRealTimers(); }
});

it('rejects command context loaded for a conversation rebound during lookup', async () => {
  const plugin = await createPlugin();
  const { manager } = await createManager(plugin);
  const tab = (await manager.createTab('conversation-a'))!;
  const lookup = deferred<void>();
  const firstLookup = deferred<Conversation | null>();
  const conversationB = conversationRecord('conversation-b');
  vi.spyOn(plugin, 'getConversationById').mockImplementationOnce(() => { lookup.resolve(); return firstLookup.promise; }).mockResolvedValue(conversationB);
  const staleDiscovery = reloadDiscovery(tab);
  await lookup.promise;
  await manager.openConversation('conversation-b');
  firstLookup.resolve(conversationRecord('conversation-a'));
  await expect(staleDiscovery).resolves.toMatchObject({ status: 'error', retryable: true });
  expect(provider.loadCommands).not.toHaveBeenCalled();
  await expect(reloadDiscovery(manager.getActiveTab()!)).resolves.toMatchObject({ status: 'ready', items: [{ name: 'review' }] });
  expect(provider.loadCommands).toHaveBeenCalledWith(expect.objectContaining({ conversation: conversationB }));
});

it('reloads cached commands after the provider lifecycle generation advances', async () => {
  const { manager, plugin } = await createManager();
  const tab = (await manager.createTab())!;
  await expect(reloadDiscovery(tab)).resolves.toMatchObject({ status: 'ready' });
  await expect(reloadDiscovery(tab)).resolves.toMatchObject({ status: 'ready' });
  expect(provider.loadCommands).toHaveBeenCalledTimes(1);
  await plugin.providerHost.executionLifecycleRegistry.runTransition(['claude'], async () => undefined);
  await expect(reloadDiscovery(tab)).resolves.toMatchObject({ status: 'ready' });
  expect(provider.loadCommands).toHaveBeenCalledTimes(2);
});

it('rejects an old command result from the cache across a provider lifecycle transition', async () => {
  const started = deferred<void>();
  const reply = deferred<Awaited<ReturnType<ProviderCommandLoader['loadCommands']>>>();
  provider.loadCommands.mockImplementationOnce(() => { started.resolve(); return reply.promise; });
  const { manager, plugin } = await createManager();
  const tab = (await manager.createTab())!;
  const oldLoad = reloadDiscovery(tab);
  await started.promise;
  await plugin.providerHost.executionLifecycleRegistry.runTransition(['claude'], async () => undefined);
  reply.resolve({ status: 'ready', items: [command('old')] });
  await expect(oldLoad).resolves.toMatchObject({ status: 'ready', items: [{ name: 'old' }] });
  provider.loadCommands.mockResolvedValueOnce({ status: 'ready', items: [command('fresh')] });
  await expect(reloadDiscovery(tab)).resolves.toMatchObject({ status: 'ready', items: [{ name: 'fresh' }] });
  expect(provider.loadCommands).toHaveBeenCalledTimes(2);
});

it('does not start command discovery after its tab begins closing', async () => {
  const { manager } = await createManager();
  await manager.createTab();
  const closing = (await manager.createTab())!;
  const discovery = discoveryFor(closing);
  const load = reloadDiscovery(closing);
  const close = manager.closeTab(closing.id);
  await close;
  await expect(load).resolves.toEqual({ status: 'empty' });
  expect(provider.loadCommands).not.toHaveBeenCalled();
  expect(discovery.getSnapshot()).toEqual({ status: 'idle' });
  expect(manager.getTab(closing.id)).toBeNull();
  expect(closing.providerCatalogResolver()).toBeNull();
});
