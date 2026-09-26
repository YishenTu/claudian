/** @jest-environment jsdom */
import '@/providers';

import { createHarness, releaseSideChatHarnesses } from '@test/helpers/features/chat/SideChatDOMHarness';
import { FakeSideSession } from '@test/helpers/features/chat/SideChatSessionHarness';
import { modelCatalogCases } from '@test/helpers/providerModelCatalogs';
import { fireEvent, waitFor, within } from '@testing-library/dom';
import { App } from 'obsidian';

import { DEFAULT_CLAUDIAN_SETTINGS } from '@/app/settings/defaultSettings';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import { formatReasoningValueLabel } from '@/core/providers/reasoning';
import type { Conversation } from '@/core/types';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import { getChatSettingsSnapshot } from '@/features/chat/ChatSettings';
import { destroyTab } from '@/features/chat/tabs/TabLifecycle';
import { createTabRuntime } from '@/features/chat/tabs/TabRuntimeFactory';
import { updateCurrentGrokCatalog } from '@/providers/grok/settings';

const originalResizeObserver = globalThis.ResizeObserver;
beforeEach(() => {
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
});
afterEach(async () => {
  globalThis.ResizeObserver = originalResizeObserver;
  ProviderWorkspaceRegistry.clear();
  jest.restoreAllMocks();
  await releaseSideChatHarnesses();
});

it.each(modelCatalogCases.flatMap(entry => [true, false].map(advertisesHigh => ({ ...entry, advertisesHigh }))))(
  '$id displays and submits the same settings (native High advertised: $advertisesHigh)', async ({ id, populate, selected, advertisesHigh }) => {
  const settings = JSON.parse(JSON.stringify(DEFAULT_CLAUDIAN_SETTINGS)) as typeof DEFAULT_CLAUDIAN_SETTINGS;
  populate(settings);
  const config = settings.providerConfigs[id]!;
  const levels = advertisesHigh ? ['low', 'medium', 'high'] : ['low', 'medium'];
  if (id === 'claude') (config.discoveredModels as Array<Record<string, unknown>>)[0].supportedEffortLevels = levels;
  if (id === 'codex' && !advertisesHigh) Object.assign((config.discoveredModels as Array<Record<string, unknown>>)[0], {
    supportedReasoningEfforts: levels.map(value => ({ value, description: value })), defaultReasoningEffort: 'medium',
  });
  if (id === 'pi') (config.discoveredModels as Array<Record<string, unknown>>)[0].thinkingLevels = ['off', ...levels];
  if (id === 'opencode') config.thinkingOptionsByModel = {
    'anthropic/selected': [{ value: 'default', label: 'Default' }, ...levels.map(value => ({ value, label: formatReasoningValueLabel(value) }))],
  };
  if (id === 'grok') updateCurrentGrokCatalog(settings, {
    defaultModelId: 'selected', fingerprint: 'test', refreshedAt: 10,
    models: [{ rawId: 'selected', displayName: 'Selected label', reasoningMetadataResolved: true,
      defaultReasoningEffort: 'medium', supportsReasoning: true,
      reasoningEfforts: levels.map(value => ({ value, label: formatReasoningValueLabel(value) })) }],
  });
  settings.savedProviderModel = { [id]: 'old-model' };
  settings.savedProviderEffort = { [id]: id === 'opencode' ? 'low' : 'high' };
  if (id === 'opencode') config.preferredThinkingByModel = { 'anthropic/selected': 'high' };
  const harness = createHarness({ settings });
  ProviderWorkspaceRegistry.setServices(id, {});
  const app = new App();
  Object.assign(app.vault.adapter, { basePath: '/vault' });
  Object.assign(app.vault, { on: () => ({}), offref: () => undefined });
  const conversation = { id: 'conversation-1', providerId: id, selectedModel: selected,
    messages: harness.tab.state.messages, sessionId: 'main-session' } as unknown as Conversation;
  const sessions: FakeSideSession[] = [];
  jest.spyOn(ProviderRegistry, 'createExecutionBackend').mockImplementation((_host, providerId = 'claude') => ({
    providerId,
    createSession: config => {
      const session = new FakeSideSession(config);
      Object.defineProperty(session, 'providerId', { value: providerId });
      sessions.push(session);
      return session;
    },
  }));
  const plugin = {
    ...(harness.plugin as ChatFeatureHost), app, settings,
    executionPersistence: {
      registerExecutionBinding: () => undefined,
      releaseExecutionBinding: () => undefined,
      persistExecutionSnapshot: async () => true,
      assertConversationExecutionAuthority: async () => undefined,
      recordConversationActivity: async () => undefined,
    },
    getActiveEnvironmentVariables: () => '',
    getConversationSync: () => conversation,
    getConversationById: async () => conversation,
    getConversationList: () => [conversation],
    updateConversation: async (_id: string, patch: Partial<Conversation>) => Object.assign(conversation, patch),
    mutateSettings: async (mutation: (value: typeof settings) => void) => mutation(settings),
  } as unknown as ChatFeatureHost;
  const tab = await createTabRuntime({
    plugin,
    component: { addChild: () => undefined, register: () => undefined, registerDomEvent: () => undefined, registerEvent: () => undefined } as never,
    containerEl: document.body.appendChild(document.createElement('div')),
    conversation, getProviderCatalogConfig: () => null, isRuntimeLive: () => true,
  });
  tab.state.currentConversationId = conversation.id;
  tab.state.messages = conversation.messages;
  try {
    expect(getChatSettingsSnapshot(settings, id, selected).reasoning).toBe('high');
    expect(settings).not.toHaveProperty('reasoning');
    const ui = within(tab.dom.inputComposerEl);
    expect(ui.getByText('High', { selector: '.claudian-thinking-current' })).toBeDefined();
    for (const reasoning of id === 'opencode' ? ['high', 'low', 'default'] : ['high', 'low']) {
      const label = formatReasoningValueLabel(reasoning);
      if (reasoning !== 'high') {
        fireEvent.click(ui.getByText(label, { selector: '.claudian-thinking-gear' }));
      }
      await waitFor(() => expect(ui.getByText(label, { selector: '.claudian-thinking-current' })).toBeDefined());
      const input = ui.getByRole('textbox') as HTMLTextAreaElement;
      input.value = `Use ${reasoning}`;
      const send = tab.controllers.inputController.sendMessage();
      await waitFor(() => expect(sessions.at(-1)?.requests.at(-1)?.input).toContainEqual({ type: 'text', text: `Use ${reasoning}` }));
      const sent = sessions.at(-1)!;
      expect(sent.requests.at(-1)?.configuration).toMatchObject({
        model: getChatSettingsSnapshot(settings, id, selected).model, reasoning,
      });
      sent.complete();
      await send;
      expect(settings).not.toHaveProperty('reasoning');
      expect(ui.getByText(label, { selector: '.claudian-thinking-current' })).toBeDefined();
    }
  } finally {
    await destroyTab(tab);
  }
});
