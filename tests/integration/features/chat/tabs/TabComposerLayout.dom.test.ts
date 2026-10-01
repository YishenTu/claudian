/** @jest-environment jsdom */
import '@/providers';

import { createHarness, releaseSideChatHarnesses } from '@test/helpers/features/chat/SideChatDOMHarness';
import { fireEvent, within } from '@testing-library/dom';
import { axe } from 'jest-axe';
import { App, Component, TFile } from 'obsidian';

import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import type { Conversation, UsageInfo } from '@/core/types';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import { destroyTab } from '@/features/chat/tabs/TabLifecycle';
import { createTabRuntime } from '@/features/chat/tabs/TabRuntimeFactory';
import type { AssembledTabRuntime } from '@/features/chat/tabs/types';

const originalResizeObserver = globalThis.ResizeObserver;
beforeEach(() => {
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
});
afterEach(async () => {
  globalThis.ResizeObserver = originalResizeObserver;
  jest.restoreAllMocks();
  await releaseSideChatHarnesses();
});

const note = Object.assign(new TFile(), {
  path: 'Notes/Plan.md', name: 'Plan.md', basename: 'Plan', extension: 'md',
});

async function createTab(linkedContentPath?: string): Promise<AssembledTabRuntime> {
  const harness = createHarness();
  const app = new App();
  Object.assign(app.vault.adapter, { basePath: '/vault' });
  Object.assign(app.vault, {
    on: () => ({}),
    offref: () => undefined,
    getAbstractFileByPath: (path: string) => (path === note.path ? note : null),
  });
  const conversation = {
    id: 'conversation-1', providerId: 'claude', selectedModel: 'claude-sonnet-4-5',
    sessionId: 'main-session', messages: harness.tab.state.messages,
    ...(linkedContentPath ? { linkedContentPath } : {}),
  } as Conversation;
  const plugin = {
    ...(harness.plugin as ChatFeatureHost),
    app,
    getCommittedSettings: () => plugin.settings,
    settings: {
      model: 'claude-sonnet-4-5', effortLevel: 'high', permissionMode: 'normal',
      providerConfigs: { claude: { enabled: true, visibleModels: ['claude-sonnet-4-5'],
        discoveredModels: [{ value: 'claude-sonnet-4-5', label: 'Sonnet', supportedEffortLevels: ['low', 'high'] }] } },
    },
    getActiveEnvironmentVariables: () => '',
    getConversationSummary: () => conversation,
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
  return tab;
}

function infoRowOf(tab: AssembledTabRuntime): HTMLElement {
  // The info row is the composer's last row, directly under the bordered input box.
  const row = tab.dom.inputWrapper.nextElementSibling as HTMLElement | null;
  expect(row?.parentElement).toBe(tab.dom.inputContainerEl);
  return row!;
}

const usage = (percentage: number): UsageInfo => ({
  model: 'claude-sonnet-4-5', inputTokens: percentage * 2000, cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
  contextTokens: percentage * 2000, contextWindow: 200000, percentage,
});

it('attaches a queued follow-up to the top of the input box, under the tab bar', async () => {
  const tab = await createTab();
  try {
    const box = within(tab.dom.inputWrapper);
    expect(box.queryByRole('button', { name: 'Discard queued message' })).toBeNull();

    jest.spyOn(ProviderRegistry, 'getCapabilities').mockReturnValue({
      ...ProviderRegistry.getCapabilities('claude'), supportsTurnSteer: true,
    });
    tab.state.isStreaming = true;
    tab.state.queuedMessage = {
      content: 'also add a created date', images: undefined, editorContext: null, canvasContext: null,
    };
    tab.controllers.inputController.updateQueueIndicator();

    const strip = tab.dom.queueIndicatorEl;
    expect(strip.parentElement).toBe(tab.dom.inputWrapper);
    expect(tab.dom.inputWrapper.firstElementChild).toBe(strip);
    expect(tab.dom.navRowEl.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(strip.classList.contains('claudian-hidden')).toBe(false);
    expect(within(strip).getByText('Queued')).toBeDefined();
    expect(within(strip).getByText('also add a created date')).toBeDefined();
    expect(box.getByRole('button', { name: 'Steer Now' })).toBeDefined();
    expect(box.getByRole('button', { name: 'Discard queued message' })).toBeDefined();
    expect(await axe(strip)).toHaveNoViolations();

    fireEvent.click(box.getByRole('button', { name: 'Edit queued message' }));
    expect(tab.state.queuedMessage).toBeNull();
    expect(strip.classList.contains('claudian-hidden')).toBe(true);
    expect(box.queryByRole('button', { name: 'Edit queued message' })).toBeNull();
    expect(tab.dom.inputEl.value).toBe('also add a created date');
    tab.state.isStreaming = false;
  } finally {
    await destroyTab(tab);
  }
});

it('shows the linked note in an info row under the input box', async () => {
  const tab = await createTab(note.path);
  try {
    const row = infoRowOf(tab);
    const info = within(row);
    const linked = info.getByRole('button', { name: 'Linked content: Notes/Plan.md' });
    expect(linked.textContent).toBe('Plan');
    // Locked after the first message: shown, activatable, not removable.
    expect(info.queryByRole('button', { name: /^Remove/ })).toBeNull();
    // The in-box tray is left to per-turn context.
    expect(within(tab.dom.inputWrapper).queryByRole('button', { name: /Linked content/ })).toBeNull();

    tab.state.usage = usage(42);
    expect(info.queryByRole('progressbar')).toBeNull();
    expect(await axe(row)).toHaveNoViolations();
  } finally {
    await destroyTab(tab);
  }
});

it('shows context usage in the toolbar next to the model picker', async () => {
  const tab = await createTab();
  try {
    // Without a linked note the row still holds its place, so the composer does not shift.
    const row = infoRowOf(tab);
    expect(row.classList.contains('claudian-hidden')).toBe(false);

    tab.state.usage = usage(42);
    const toolbar = tab.dom.inputWrapper.querySelector<HTMLElement>(':scope > .claudian-input-toolbar')!;
    const meter = within(toolbar).getByRole('progressbar', { name: 'Context usage: 42% · 84k / 200k' });
    const modelAnchor = toolbar.querySelector('.claudian-toolbar-chip-anchor--model');
    expect(modelAnchor?.nextElementSibling).toBe(meter);
    expect(within(row).queryByRole('progressbar')).toBeNull();
  } finally {
    await destroyTab(tab);
  }
});
