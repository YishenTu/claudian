/** @jest-environment jsdom */
import '@/providers';

import { createHarness, releaseSideChatHarnesses, startSideChat } from '@test/helpers/features/chat/SideChatDOMHarness';
import { fireEvent, waitFor, within } from '@testing-library/dom';
import { App, Component } from 'obsidian';

import type { Conversation } from '@/core/types';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import { destroyTab } from '@/features/chat/tabs/TabLifecycle';
import { createTabRuntime } from '@/features/chat/tabs/TabRuntimeFactory';

const originalResizeObserver = globalThis.ResizeObserver;
beforeEach(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});
afterEach(async () => {
  globalThis.ResizeObserver = originalResizeObserver;
  await releaseSideChatHarnesses();
});

it('refreshes destination settings when the side panel collapses, expands, and is discarded', async () => {
  const harness = createHarness();
  const app = new App();
  Object.assign(app.vault.adapter, { basePath: '/vault' });
  Object.assign(app.vault, { on: () => ({}), offref: () => undefined });
  const conversation = {
    id: 'conversation-1', providerId: 'claude', selectedModel: 'claude-sonnet-4-5',
    sessionId: 'main-session', messages: harness.tab.state.messages,
  } as Conversation;
  const plugin = {
    ...(harness.plugin as ChatFeatureHost),
    app,
    getCommittedSettings: () => plugin.settings,
    settings: {
      model: 'claude-opus-4-6', effortLevel: 'medium', permissionMode: 'manual',
      savedProviderModel: { claude: 'claude-opus-4-6' }, savedProviderEffort: { claude: 'medium' },
      providerConfigs: { claude: { enabled: true, visibleModels: ['claude-sonnet-4-5', 'claude-opus-4-6'],
        discoveredModels: [
          { value: 'claude-sonnet-4-5', label: 'Sonnet', supportedEffortLevels: ['low', 'high'] },
          { value: 'claude-opus-4-6', label: 'Opus', supportedEffortLevels: ['medium', 'high'] },
        ] } },
    },
    getActiveEnvironmentVariables: () => '',
    getConversationSummary(id: string) { return (this as unknown as { getConversationSync: (id: string) => any }).getConversationSync(id); },
    getConversationSync: () => conversation,
    getConversationList: () => [conversation],
  } as unknown as ChatFeatureHost;
  const tab = await createTabRuntime({
    plugin,
    component: Object.assign(new Component(), { registerDomEvent: () => undefined, registerEvent: () => undefined }) as never,
    containerEl: document.body.appendChild(document.createElement('div')),
    conversation,
    getProviderCatalogConfig: () => null,
    isRuntimeLive: () => true,
  });
  tab.state.messages = conversation.messages;
  const side = tab.controllers.sideChatController;
  try {
    const started = side.handleCommandSubmission('Explore settings', []);
    await waitFor(() => expect(harness.backend.sessions).toHaveLength(1));
    expect(harness.backend.latest.requests[0].configuration).toMatchObject({ model: 'claude-code/claude-sonnet-4-5', reasoning: 'high' });
    harness.backend.latest.establishChild('child-session');
    harness.backend.latest.complete();
    await started;
    const ui = within(tab.dom.inputComposerEl);
    side.updateSideSettings({ permissionMode: 'yolo', reasoning: 'low' });
    side.collapse();
    fireEvent.click(ui.getByRole('button', { name: 'Side chat' }));
    expect(ui.queryByRole('button', { name: 'Permission mode: YOLO' })).not.toBeNull();
    expect(ui.getByText('Low', { selector: '.claudian-thinking-current' })).toBeDefined();
    expect(ui.queryByRole('button', { name: 'Permission mode: Manual' })).toBeNull();

    fireEvent.click(ui.getByRole('button', { name: 'Collapse' }));
    expect(ui.queryByRole('button', { name: 'Permission mode: Manual' })).not.toBeNull();
    expect(ui.getByText('High', { selector: '.claudian-thinking-current' })).toBeDefined();
    expect(ui.queryByRole('button', { name: 'Permission mode: YOLO' })).toBeNull();

    fireEvent.click(ui.getByRole('button', { name: 'Side chat' }));
    expect(ui.queryByRole('button', { name: 'Permission mode: YOLO' })).not.toBeNull();
    expect(ui.getByText('Low', { selector: '.claudian-thinking-current' })).toBeDefined();
    expect(ui.queryByRole('button', { name: 'Permission mode: Manual' })).toBeNull();

    let finishDisposal!: () => void;
    const disposalGate = new Promise<void>(resolve => { finishDisposal = resolve; });
    const native = harness.backend.latest;
    const disposeNative = native.dispose.bind(native);
    native.dispose = async () => {
      await disposalGate;
      await disposeNative();
    };
    const discarded = side.discard();
    try {
      expect(side.destination).toBe('main');
      expect(ui.queryByRole('button', { name: 'Permission mode: Manual' })).not.toBeNull();
    expect(ui.getByText('High', { selector: '.claudian-thinking-current' })).toBeDefined();
      expect(ui.queryByRole('button', { name: 'Permission mode: YOLO' })).toBeNull();
    } finally {
      finishDisposal();
      await discarded;
    }
  } finally {
    await destroyTab(tab);
  }
});

it('side usage must carry the side model when native usage omits model', async () => {
  const harness = createHarness({ settings: {
    model: 'claude-opus-4-6', settingsProvider: 'claude',
    savedProviderModel: { claude: 'claude-opus-4-6' },
    providerConfigs: { claude: { enabled: true, visibleModels: ['claude-sonnet-4-5', 'claude-opus-4-6'] } },
  } });
  const { started } = await startSideChat(harness);
  harness.backend.latest.complete();
  await started;
  harness.controller.updateSideSettings({ model: 'claude-code/claude-sonnet-4-5', reasoning: 'high', permissionMode: 'normal', serviceTier: 'default' });
  const pending = harness.controller.submitToSide('second turn', []);
  await waitFor(() => expect(harness.backend.latest.requests).toHaveLength(2));
  expect(harness.backend.latest.requests[1].configuration.model).toBe('claude-code/claude-sonnet-4-5');
  harness.backend.latest.emitOutput({ type: 'usage_updated', usage: {
    inputTokens: 100, contextTokens: 100, contextWindow: 200000, percentage: 0,
  } });
  harness.backend.latest.complete();
  await pending;
  expect(harness.controller.runtime?.state.usage?.model).toBe('claude-code/claude-sonnet-4-5');
});
