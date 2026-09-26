/** @jest-environment jsdom */
import '@/providers';

import { deserialize, serialize } from 'node:v8';

import { createHarness, releaseSideChatHarnesses } from '@test/helpers/features/chat/SideChatDOMHarness';
import { FakeSideSession } from '@test/helpers/features/chat/SideChatSessionHarness';
import { modelCatalogCases } from '@test/helpers/providerModelCatalogs';
import { fireEvent, waitFor, within } from '@testing-library/dom';
import { App, Notice } from 'obsidian';

import { ChatModelSelectionCoordinator } from '@/app/settings/ChatModelSelectionCoordinator';
import { DEFAULT_CLAUDIAN_SETTINGS } from '@/app/settings/defaultSettings';
import { SettingsCoordinator } from '@/app/settings/SettingsCoordinator';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import { formatReasoningValueLabel } from '@/core/providers/reasoning';
import type { ProviderId } from '@/core/providers/types';
import type { ClaudianSettings, Conversation } from '@/core/types';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import { getChatSettingsSnapshot } from '@/features/chat/ChatSettings';
import { destroyTab } from '@/features/chat/tabs/TabLifecycle';
import { refreshTabProviderUI } from '@/features/chat/tabs/TabProviderState';
import { createTabRuntime } from '@/features/chat/tabs/TabRuntimeFactory';
import type { AssembledTabRuntime } from '@/features/chat/tabs/types';
import { getCodexProviderSettings, updateCodexProviderSettings } from '@/providers/codex/settings';
import { updateCurrentGrokCatalog } from '@/providers/grok/settings';

const originalResizeObserver = globalThis.ResizeObserver;
const originalStructuredClone = globalThis.structuredClone;
beforeEach(() => {
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  globalThis.structuredClone = value => deserialize(serialize(value));
});
afterEach(async () => {
  globalThis.ResizeObserver = originalResizeObserver;
  globalThis.structuredClone = originalStructuredClone;
  ProviderWorkspaceRegistry.clear();
  jest.restoreAllMocks();
  await releaseSideChatHarnesses();
});

function createSettings({ id, populate }: typeof modelCatalogCases[number], advertisesHigh = true): ClaudianSettings {
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
  return settings;
}

function createChatHarness(settings: ClaudianSettings, id: ProviderId, selected: string) {
  const harness = createHarness({ settings });
  ProviderWorkspaceRegistry.setServices(id, {});
  const app = new App();
  Object.assign(app.vault.adapter, { basePath: '/vault' });
  Object.assign(app.vault, { on: () => ({}), offref: () => undefined });
  const conversations: Conversation[] = [];
  const tabs: AssembledTabRuntime[] = [];
  const sessions: FakeSideSession[] = [];
  const persist = jest.fn(async () => undefined);
  const settingsCoordinator = new SettingsCoordinator(settings, persist);
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
    chatModelSelection: new ChatModelSelectionCoordinator(settingsCoordinator),
    executionPersistence: {
      registerExecutionBinding: () => undefined,
      releaseExecutionBinding: () => undefined,
      persistExecutionSnapshot: async () => true,
      assertConversationExecutionAuthority: async () => undefined,
      recordConversationActivity: async () => undefined,
    },
    getActiveEnvironmentVariables: () => '',
    getConversationSync: (conversationId: string) => conversations.find(entry => entry.id === conversationId),
    getConversationById: async (conversationId: string) => conversations.find(entry => entry.id === conversationId),
    getConversationList: () => conversations,
    updateConversation: async (conversationId: string, patch: Partial<Conversation>) =>
      Object.assign(conversations.find(entry => entry.id === conversationId)!, patch),
    mutateSettings: settingsCoordinator.mutate.bind(settingsCoordinator),
    getCommittedSettings: settingsCoordinator.getCommittedSettings.bind(settingsCoordinator),
  } as unknown as ChatFeatureHost;
  const createTab = async () => {
    const conversation = {
      id: `conversation-${conversations.length}`, providerId: id, selectedModel: selected,
      messages: [...harness.tab.state.messages], sessionId: `session-${conversations.length}`,
    } as unknown as Conversation;
    conversations.push(conversation);
    const tab = await createTabRuntime({
      plugin,
      component: { addChild: () => undefined, register: () => undefined, registerDomEvent: () => undefined, registerEvent: () => undefined } as never,
      containerEl: document.body.appendChild(document.createElement('div')),
      conversation, getProviderCatalogConfig: () => null, isRuntimeLive: () => true,
    });
    tab.state.currentConversationId = conversation.id;
    tab.state.messages = conversation.messages;
    tabs.push(tab);
    return tab;
  };
  return { createTab, tabs, sessions, persist, plugin };
}

async function selectReasoning(tab: AssembledTabRuntime, reasoning: string) {
  const ui = within(tab.dom.inputComposerEl);
  const label = formatReasoningValueLabel(reasoning);
  const gear = ui.getByText(label, { selector: '.claudian-thinking-gear' });
  fireEvent.click(gear);
  await waitFor(() => expect(gear.isConnected).toBe(false));
  expect(ui.getByText(label, { selector: '.claudian-thinking-current' })).toBeDefined();
}

async function expectSubmission(
  tab: AssembledTabRuntime,
  sessions: FakeSideSession[],
  model: string,
  reasoning: string,
) {
  const ui = within(tab.dom.inputComposerEl);
  const label = formatReasoningValueLabel(reasoning);
  expect(ui.getByText(label, { selector: '.claudian-thinking-current' })).toBeDefined();
  const text = `Send ${tab.state.messages.length} with ${reasoning}`;
  (ui.getByRole('textbox') as HTMLTextAreaElement).value = text;
  const previousRequests = new Set(sessions.flatMap(session => session.requests));
  const pending = tab.controllers.inputController.sendMessage();
  const findSession = () => sessions.find(session => {
    const request = session.requests.at(-1);
    return request && !previousRequests.has(request)
      && request.input.some(part => part.type === 'text' && part.text === text);
  });
  await waitFor(() => expect(findSession()).toBeDefined());
  const session = findSession()!;
  try {
    expect(session.requests.at(-1)?.configuration).toMatchObject({ model, reasoning });
  } finally {
    session.complete();
    await pending;
  }
  expect(ui.getByText(label, { selector: '.claudian-thinking-current' })).toBeDefined();
}

it.each(modelCatalogCases.flatMap(entry => [true, false].map(advertisesHigh => ({ ...entry, advertisesHigh }))))(
  '$id displays and submits the same settings (native High advertised: $advertisesHigh)', async (entry) => {
    const { id, selected, advertisesHigh } = entry;
    const settings = createSettings(entry, advertisesHigh);
    const { createTab, sessions, tabs } = createChatHarness(settings, id, selected);
    try {
      const tab = await createTab();
      expect(getChatSettingsSnapshot(settings, id, selected).reasoning).toBe('high');
      expect(settings).not.toHaveProperty('reasoning');
      for (const reasoning of id === 'opencode' ? ['high', 'low', 'default'] : ['high', 'low']) {
        if (reasoning !== 'high') await selectReasoning(tab, reasoning);
        await expectSubmission(tab, sessions, getChatSettingsSnapshot(settings, id, selected).model, reasoning);
        expect(settings).not.toHaveProperty('reasoning');
      }
    } finally {
      for (const tab of tabs) await destroyTab(tab);
    }
  },
);

it.each(modelCatalogCases)('$id keeps displayed and submitted reasoning independent across tabs', async (entry) => {
  const { id, selected } = entry;
  const settings = createSettings(entry);
  const { createTab, sessions, tabs } = createChatHarness(settings, id, selected);
  const model = getChatSettingsSnapshot(settings, id, selected).model;
  const otherReasoning = id === 'codex' ? 'medium' : 'low';
  try {
    const tabA = await createTab();
    const tabB = await createTab();
    await selectReasoning(tabA, 'high');
    await selectReasoning(tabB, otherReasoning);
    expect(within(tabA.dom.inputComposerEl).getByText('High', { selector: '.claudian-thinking-current' })).toBeDefined();
    await expectSubmission(tabA, sessions, model, 'high');
    await expectSubmission(tabB, sessions, model, otherReasoning);
    const tabC = await createTab();
    await expectSubmission(tabC, sessions, model, otherReasoning);
    await selectReasoning(tabA, 'high');
    // Ordinary refreshes must not replace a tab's selection with the future-tab seed.
    refreshTabProviderUI(tabB);
    refreshTabProviderUI(tabC);
    await expectSubmission(tabA, sessions, model, 'high');
    await expectSubmission(tabB, sessions, model, otherReasoning);
    await expectSubmission(tabC, sessions, model, otherReasoning);
  } finally {
    for (const tab of tabs) await destroyTab(tab);
  }
});

it('restores the tab effort when returning to a previously selected model', async () => {
  const entry = modelCatalogCases.find(candidate => candidate.id === 'codex')!;
  const settings = createSettings(entry);
  const catalog = getCodexProviderSettings(settings).discoveredModels;
  updateCodexProviderSettings(settings, {
    visibleModels: [entry.selected, 'gpt-alternate'],
    discoveredModels: [catalog[0], { ...catalog[0], model: 'gpt-alternate', displayName: 'Alternate' }],
  });
  const { createTab, sessions, tabs } = createChatHarness(settings, entry.id, entry.selected);
  try {
    const tab = await createTab();
    const ui = within(tab.dom.inputComposerEl);
    const selectModel = async (label: string) => {
      fireEvent.click(ui.getByText(label, { selector: '.claudian-model-option span' }));
      await waitFor(() => expect(ui.getByText(label, { selector: '.claudian-model-label' })).toBeDefined());
    };
    await selectReasoning(tab, 'low');
    await selectModel('Alternate');
    await selectReasoning(tab, 'high');
    await expectSubmission(tab, sessions, 'openai-codex/gpt-alternate', 'high');
    await selectModel('GPT-5.5');
    await expectSubmission(tab, sessions, 'openai-codex/gpt-5.5', 'low');
  } finally {
    for (const tab of tabs) await destroyTab(tab);
  }
});

it('keeps the previous tab effort and future-tab seed when saving a selection fails', async () => {
  const entry = modelCatalogCases.find(candidate => candidate.id === 'codex')!;
  const settings = createSettings(entry);
  const { createTab, sessions, tabs, persist } = createChatHarness(settings, entry.id, entry.selected);
  try {
    const tab = await createTab();
    await selectReasoning(tab, 'medium');
    persist.mockRejectedValueOnce(new Error('disk full'));
    fireEvent.click(within(tab.dom.inputComposerEl).getByText('High', { selector: '.claudian-thinking-gear' }));
    await waitFor(() => expect(Notice).toHaveBeenCalledWith('Failed to change effort level'));
    refreshTabProviderUI(tab);
    await expectSubmission(tab, sessions, 'openai-codex/gpt-5.5', 'medium');
    await expectSubmission(await createTab(), sessions, 'openai-codex/gpt-5.5', 'medium');
  } finally {
    for (const tab of tabs) await destroyTab(tab);
  }
});

it('refreshes a cached effort when provider settings remove it from the available choices', async () => {
  const entry = modelCatalogCases.find(candidate => candidate.id === 'codex')!;
  const settings = createSettings(entry);
  const catalog = getCodexProviderSettings(settings).discoveredModels;
  updateCodexProviderSettings(settings, {
    enableUltraEffort: true,
    discoveredModels: [{
      ...catalog[0],
      supportedReasoningEfforts: [...catalog[0].supportedReasoningEfforts, { value: 'ultra', description: 'Ultra' }],
    }],
  });
  const { createTab, sessions, tabs } = createChatHarness(settings, entry.id, entry.selected);
  try {
    const tab = await createTab();
    await selectReasoning(tab, 'ultra');
    const peer = await createTab();
    await selectReasoning(peer, 'medium');
    updateCodexProviderSettings(settings, { enableUltraEffort: false });
    refreshTabProviderUI(tab);
    expect(within(tab.dom.inputComposerEl).queryByText('Ultra', { selector: '.claudian-thinking-gear' })).toBeNull();
    // Losing a supported choice uses the model default, not another tab's saved effort.
    await expectSubmission(tab, sessions, 'openai-codex/gpt-5.5', 'high');
    await expectSubmission(peer, sessions, 'openai-codex/gpt-5.5', 'medium');
  } finally {
    for (const tab of tabs) await destroyTab(tab);
  }
});

it.each([true, false])('seeds tabs from committed reasoning while a save is pending (succeeds: %s)', async (succeeds) => {
  const entry = modelCatalogCases.find(candidate => candidate.id === 'codex')!;
  const settings = createSettings(entry);
  const { createTab, sessions, tabs, persist, plugin } = createChatHarness(settings, entry.id, entry.selected);
  let resolveSave!: (value: undefined) => void;
  let rejectSave!: (error: Error) => void;
  const save = new Promise<undefined>((resolve, reject) => {
    resolveSave = resolve;
    rejectSave = reject;
  });
  const mutate = jest.spyOn(plugin, 'mutateSettings');
  const saveError = new Error('disk full');
  try {
    const source = await createTab();
    persist.mockImplementationOnce(() => save);
    fireEvent.click(within(source.dom.inputComposerEl).getByText('Medium', { selector: '.claudian-thinking-gear' }));
    await waitFor(() => expect(persist).toHaveBeenCalled());

    const duringSave = await createTab();
    await expectSubmission(duringSave, sessions, 'openai-codex/gpt-5.5', 'high');
    if (succeeds) {
      resolveSave(undefined);
    } else {
      rejectSave(saveError);
    }
    const result = await Promise.allSettled([mutate.mock.results[0].value]);
    expect(result).toEqual([succeeds
      ? { status: 'fulfilled', value: undefined }
      : { status: 'rejected', reason: saveError }]);
    refreshTabProviderUI(duringSave);
    await expectSubmission(duringSave, sessions, 'openai-codex/gpt-5.5', 'high');
    await expectSubmission(await createTab(), sessions, 'openai-codex/gpt-5.5', succeeds ? 'medium' : 'high');
  } finally {
    resolveSave(undefined);
    await mutate.mock.results[0]?.value.catch(() => undefined);
    for (const tab of tabs) await destroyTab(tab);
  }
});
