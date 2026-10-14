/** @jest-environment jsdom */
import '@/providers';

import { claudeCatalogFixture } from '@test/helpers/claudeModels';
import { installSessionRuntimePool } from '@test/helpers/features/chat/SessionRuntimePoolHarness';
import { FakeSideBackend } from '@test/helpers/features/chat/SideChatSessionHarness';
import { testDate } from '@test/helpers/testClock';
import { waitFor } from '@testing-library/dom';
import { App, Component } from 'obsidian';

import { ProviderExecutionLifecycleRegistry } from '@/core/execution';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import type { ClaudianSettings, Conversation } from '@/core/types';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import { TabManager } from '@/features/chat/tabs/TabManager';
import { VaultMentionDataProvider } from '@/shared/mention/VaultMentionDataProvider';

const originalResizeObserver = globalThis.ResizeObserver;
beforeEach(() => {
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  Object.assign(HTMLElement.prototype, {
    hasClass(this: HTMLElement, name: string) { return this.classList.contains(name); },
    addClass(this: HTMLElement, ...names: string[]) { this.classList.add(...names); },
    removeClass(this: HTMLElement, ...names: string[]) { this.classList.remove(...names); },
    empty(this: HTMLElement) { this.replaceChildren(); },
    setText(this: HTMLElement, text: string) { this.textContent = text; },
    appendText(this: HTMLElement, text: string) { this.appendChild(this.ownerDocument.createTextNode(text)); },
    setCssProps(this: HTMLElement, props: Record<string, string>) {
      for (const [key, value] of Object.entries(props)) this.style.setProperty(key, value);
    },
    toggleClass(this: HTMLElement, name: string, enabled: boolean) { this.classList.toggle(name, enabled); },
    scrollIntoView() {},
  });
});
afterEach(() => {
  globalThis.ResizeObserver = originalResizeObserver;
  ProviderWorkspaceRegistry.clear();
  jest.restoreAllMocks();
  document.body.replaceChildren();
});

function setup() {
  const app = new App();
  Object.assign(app.vault.adapter, { basePath: '/vault' });
  Object.assign(app.vault, { on: () => ({}), offref() {} });
  const backend = new FakeSideBackend();
  jest.spyOn(ProviderRegistry, 'createExecutionBackend').mockReturnValue(backend);
  jest.spyOn(ProviderRegistry.getConversationHistoryService('claude'), 'buildForkProviderState').mockResolvedValue({});
  ProviderWorkspaceRegistry.setServices('claude', {});
  const settings = {
    model: 'claude-sonnet-4-5', permissionMode: 'normal', effortLevel: 'high', excludedTags: [],
    providerConfigs: { claude: claudeCatalogFixture(['claude-sonnet-4-5'], ['low', 'high']) },
  } as unknown as ClaudianSettings;
  const conversation = {
    id: 'conversation', providerId: 'claude', selectedModel: settings.model, sessionId: 'native',
    title: 'Conversation', messages: [], createdAt: testDate().getTime(), lastActivityAt: testDate().getTime(),
  } as Conversation;
  const registry = new ProviderExecutionLifecycleRegistry();
  const plugin = {
    app, settings,
    providerHost: { app, settings, executionLifecycleRegistry: registry },
    getCommittedSettings: () => settings, getActiveEnvironmentVariables: () => '',
    getConversationSummary: () => conversation, getConversationSync: () => conversation,
    getCachedConversation: () => conversation,
    getConversationById: async () => structuredClone(conversation),
    getConversationList: () => [conversation],
    findConversationAcrossViews: () => null,
    updateConversation: async () => undefined,
    mutateSettings: async (mutate: (settings: ClaudianSettings) => void) => mutate(settings),
    executionPersistence: {
      registerExecutionBinding() {}, releaseExecutionBinding() {},
      assertConversationExecutionAuthority: async () => undefined,
      persistExecutionSnapshot: async () => true, recordConversationActivity: async () => undefined,
    },
  } as unknown as ChatFeatureHost;
  installSessionRuntimePool(plugin);
  const view = Object.assign(new Component(), { leaf: {}, getTabManager: () => manager });
  const onTabAttentionChanged = jest.fn();
  const manager: TabManager = new TabManager(
    plugin, document.body.createDiv(), view as never, { onTabAttentionChanged }, new VaultMentionDataProvider(app),
  );
  return { backend, manager, onTabAttentionChanged };
}

it('badges the tab and notifies the tab bar while its side chat awaits approval', async () => {
  const { backend, manager, onTabAttentionChanged } = setup();
  try {
    const tab = (await manager.createTab('conversation'))!;
    await waitFor(() => expect(tab.hydrationState).toBe('ready'));
    tab.state.messages = [
      { id: 'user', role: 'user', content: 'Parent task', timestamp: testDate().getTime() },
      { id: 'answer', role: 'assistant', content: 'Parent answer', assistantMessageId: 'checkpoint', timestamp: testDate().getTime() },
    ];
    const starting = tab.controllers.sideChatController.handleCommandSubmission('Explain the answer', []);
    await waitFor(() => expect(backend.sessions[0]?.requests).toHaveLength(1));
    const native = backend.latest;
    expect(manager.getTabBarItems()[0].attention).toBeNull();

    const approval = native.config.interactionPort.requestApproval({
      interactionId: 'side-approval', sessionInstanceId: native.sessionInstanceId, turnId: native.activeTurnId,
      kind: 'approval', toolName: 'Read', input: {}, description: 'Read note',
    }, new AbortController().signal);
    void approval.catch(() => undefined);

    await waitFor(() => expect(tab.controllers.sideChatController.runtime?.state.requiresAction).toBe(true));
    expect(tab.state.attention).toBeNull();
    expect(manager.getTabBarItems()[0].attention).toMatchObject({ kind: 'action-required' });
    expect(onTabAttentionChanged).toHaveBeenLastCalledWith(tab.id, expect.objectContaining({ kind: 'action-required' }));

    native.config.interactionPort.dismissInteraction('side-approval', 'superseded');
    native.complete();
    await starting;
    await waitFor(() => expect(manager.getTabBarItems()[0].attention).toBeNull());
    expect(onTabAttentionChanged).toHaveBeenLastCalledWith(tab.id, null);
  } finally {
    await manager.destroy();
  }
});
