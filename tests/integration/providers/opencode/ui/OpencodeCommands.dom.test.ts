// @test-ci {"inputs":["tests/helpers/providers/opencode/OpencodeNativePeer.cjs"]}
/** @vitest-environment jsdom */
import '@/providers';

import { writeFileSync } from 'node:fs';

import { axe } from '@test/helpers/accessibility';
import { fireEvent, waitFor, within } from '@testing-library/dom';

import { ProviderChatOptionsReconciler } from '@/app/settings/ProviderChatOptionsReconciler';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import type { FileContextManager } from '@/features/chat/composer/FileContextManager';
import { MainChatComposerDropdown } from '@/features/chat/composer/MainChatComposerDropdown';
import { TabCommandDiscovery } from '@/features/chat/tabs/TabCommandDiscovery';
import { deactivateTab } from '@/features/chat/tabs/TabLifecycle';
import { onProviderAvailabilityChanged } from '@/features/chat/tabs/tabProviderLifecycle';
import type { AssembledTabRuntime, TabMembershipView } from '@/features/chat/tabs/types';
import { OpencodeCommandLoader } from '@/providers/opencode/app/OpencodeCommandLoader';
import { OpencodeCommandCatalog } from '@/providers/opencode/commands/OpencodeCommandCatalog';
import { OpencodeMetadataService } from '@/providers/opencode/metadata/OpencodeMetadataService';
import { getOpencodeProviderSettings } from '@/providers/opencode/settings';

import { createOpencodeHTTPMetadataFixture } from '../metadata/OpencodeHTTPMetadataFixture';

it.each([false, true])('updates an open command menu while preserving focus and its active command (eventless: %s)', async eventless => {
  const fixture = createOpencodeHTTPMetadataFixture();
  if (eventless) { fixture.environment.NO_CATALOG_EVENTS = '1'; fixture.environment.EMPTY_INITIAL_READS = '2'; }
  const { host } = await fixture.createHostFixture();
  const service = new OpencodeMetadataService(host.getRuntimeHost('opencode'), host.executionLifecycleRegistry);
  const subscriptionSignals: AbortSignal[] = [];
  const subscriptions: Promise<void>[] = [];
  const watchCommands = service.watchCommands.bind(service);
  vi.spyOn(service, 'watchCommands').mockImplementation((onChange, signal) => {
    subscriptionSignals.push(signal);
    const subscription = watchCommands(onChange, signal);
    subscriptions.push(subscription);
    return subscription;
  });
  const catalog = new OpencodeCommandCatalog();
  ProviderWorkspaceRegistry.clear();
  ProviderWorkspaceRegistry.register('opencode', { initialize: async () => ({ commandCatalog: catalog, commandLoader: new OpencodeCommandLoader(service) }) });
  await ProviderWorkspaceRegistry.ensureInitialized(host, 'opencode', 'command-picker');
  const tab = { id: 'tab', draftModel: 'opencode:deepseek/chat', providerId: 'opencode', conversationId: null, lifecycleState: 'ready', executionCoordinator: { getCommandSnapshot: () => undefined } } as unknown as AssembledTabRuntime;
  let alive = true;
  let activeTabId = tab.id;
  const membership = {
    getTab: () => tab, getAllTabs: () => [tab], getActiveTabId: () => activeTabId,
    isTabAlive: () => alive, isTabStateMutable: () => alive, isDestroyed: () => !alive,
  } as unknown as TabMembershipView;
  const chatHost = { providerHost: host, settings: host.settings, getCommittedSettings: () => host.settings } as ChatFeatureHost;
  const discovery = new TabCommandDiscovery(chatHost, membership);
  discovery.registerTab(tab.id);
  const provider = discovery.getProviderCatalogConfig(tab)!;
  const container = document.body.createDiv();
  const input = container.createEl('textarea', { attr: { 'aria-label': 'Message' } });
  const controller = new MainChatComposerDropdown(container, input, {
    getMentionSource: () => ({ id: 'mentions', match: () => null, load: () => [] }),
  } as unknown as FileContextManager, { providerId: 'opencode', providerConfig: provider.config, providerDiscovery: provider.discovery });
  controller.setBuiltInsEnabled(false);
  input.addEventListener('input', () => controller.handleInputChange());
  input.addEventListener('keydown', event => controller.handleKeydown(event));
  Object.assign(tab, {
    dom: { contentEl: container },
    providerCatalogResolver: () => discovery.getProviderCatalogConfig(tab),
    services: { subagentManager: { setTaskResultInterpreter: () => undefined } },
    session: { runtime: { ...tab, reasoningSelections: new Map(), providerSelections: new Map() } },
    state: { usage: null },
    ui: {
      composerDropdown: controller, promptSuggestion: { discard: () => undefined },
      modelSelector: { updateDisplay: () => undefined, renderOptions: () => undefined },
      modeSelector: { updateDisplay: () => undefined, renderOptions: () => undefined },
      effortSelector: { updateDisplay: () => undefined }, serviceTierToggle: { updateDisplay: () => undefined },
      permissionToggle: { updateDisplay: () => undefined, setVisible: () => undefined },
      imageContextManager: { setEnabled: () => undefined }, contextUsageMeter: { update: () => undefined },
    },
    controllers: { streamController: { setTabActive: () => undefined }, sideChatController: { setTabActive: () => undefined }, composerSelections: { stop: () => undefined } },
  });
  const otherTab = document.body.createEl('button', { text: 'Other tab', attr: { type: 'button' } });
  otherTab.addEventListener('click', () => { deactivateTab(tab); activeTabId = 'other'; });
  let reconciliation = Promise.resolve();
  const reconciler = new ProviderChatOptionsReconciler({
    settings: { mutateConditionally: host.mutateSettingsConditionally },
    providers: ProviderRegistry, providerSettings: ProviderSettingsCoordinator,
    reconcileConversationModels: async () => [], onSettingsReconciled: () => undefined, onConversationsChanged: () => undefined,
    onReconciled: () => { onProviderAvailabilityChanged(tab, chatHost); },
  });
  host.notifyProviderChatOptionsChanged = (id: string) => { reconciliation = reconciler.notifyChanged(id); };
  const ui = within(container);
  try {
    input.focus();
    fireEvent.input(input, { target: { value: '/' } });
    await waitFor(() => expect(ui.getByRole('option', { name: /review/ })).toBeTruthy(), { timeout: 40_000 });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).toBe(ui.getByRole('option', { name: /writing/ }).id);
    // Model publications take the real app reconciliation path into the blank-tab lifecycle.
    await service.loadCatalog();
    fixture.writeCatalog('Background model update');
    await waitFor(() => expect(getOpencodeProviderSettings(host.settings).discoveredModels)
      .toContainEqual({ rawId: 'deepseek/chat', label: 'deepseek/Background model update' }));
    await reconciliation;
    await waitFor(() => expect(ui.getByRole('option', { name: /writing/ })).toBeTruthy());
    expect(input.getAttribute('aria-activedescendant')).toBe(ui.getByRole('option', { name: /writing/ }).id);
    expect(document.activeElement).toBe(input);
    writeFileSync(fixture.environment.CATALOG_FILE! + '.commands', JSON.stringify([
      { name: 'alpha', description: 'New native command' }, { name: 'review', description: 'Review changes' },
    ]));
    await waitFor(() => expect(ui.getByRole('option', { name: /alpha/ })).toBeTruthy());
    expect(document.activeElement).toBe(input);
    expect(input.getAttribute('aria-activedescendant')).toBe(ui.getByRole('option', { name: /writing/ }).id);
    expect(ui.getByRole('option', { name: /writing/ }).getAttribute('aria-selected')).toBe('true');
    expect(await axe(container)).toHaveNoViolations();
    writeFileSync(fixture.environment.CATALOG_FILE! + '.skills', '[]');
    await waitFor(() => expect(ui.queryByRole('option', { name: /writing/ })).toBeNull());
    expect(document.activeElement).toBe(input);
    expect(input.getAttribute('aria-activedescendant')).toBe(ui.getByRole('option', { name: /alpha/ }).id);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).toBe(ui.getByRole('option', { name: /review/ }).id);
    expect(await axe(container)).toHaveNoViolations();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input.value).toBe('/review ');
    expect(controller.isVisible()).toBe(false);
    expect(subscriptionSignals.at(-1)!.aborted).toBe(true);
    await Promise.all(subscriptions);
    const closedSubscriptionCount = subscriptions.length;
    await host.executionLifecycleRegistry.runTransition(['opencode'], async () => {
      discovery.invalidateProviders('opencode');
      await reconciler.notifyChanged('opencode');
    });
    expect(subscriptions).toHaveLength(closedSubscriptionCount);
    writeFileSync(fixture.environment.CATALOG_FILE! + '.commands', JSON.stringify([{ name: 'reopened', description: 'After menu close' }]));
    fireEvent.input(input, { target: { value: '/' } });
    await waitFor(() => expect(ui.getByRole('option', { name: /reopened/ })).toBeTruthy());
    // An environment transition ends metadata observation without changing this draft's identity.
    const oldSubscription = subscriptions.at(-1)!;
    await host.executionLifecycleRegistry.runTransition(['opencode'], async () => {
      discovery.invalidateProviders('opencode');
      await reconciler.notifyChanged('opencode');
    });
    await oldSubscription;
    expect(tab.providerId).toBe('opencode');
    expect(tab.draftModel).toBe('opencode:deepseek/chat');
    expect(controller.isVisible()).toBe(true);
    await waitFor(() => expect(ui.getByRole('option', { name: /reopened/ })).toBeTruthy());
    writeFileSync(fixture.environment.CATALOG_FILE! + '.commands', JSON.stringify([{ name: 'after-transition', description: 'After provider transition' }]));
    await waitFor(() => expect(ui.getByRole('option', { name: /after-transition/ })).toBeTruthy());
    expect(document.activeElement).toBe(input);
    // Keyboard activation delivers click without the mousedown that dismisses a menu.
    fireEvent.click(otherTab, { detail: 0 });
    expect(controller.isVisible()).toBe(false);
    expect(subscriptionSignals.at(-1)!.aborted).toBe(true);
    await Promise.all(subscriptions);
    activeTabId = tab.id;
    container.removeClass('claudian-hidden');
    fireEvent.input(input, { target: { value: '/' } });
    await waitFor(() => expect(ui.getByRole('option', { name: /after-transition/ })).toBeTruthy());
    // Tab release must stop observation even before the presentation finishes its teardown.
    alive = false;
    discovery.releaseTab(tab.id);
    expect(subscriptionSignals.at(-1)!.aborted).toBe(true);
    await Promise.all(subscriptions);
  } finally {
    controller.destroy(); alive = false; discovery.releaseAll(); vi.restoreAllMocks();
    await service.dispose(); await reconciliation; ProviderWorkspaceRegistry.clear(); fixture.dispose(); container.remove(); otherTab.remove();
  }
});
