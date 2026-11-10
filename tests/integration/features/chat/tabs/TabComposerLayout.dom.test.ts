/** @vitest-environment jsdom */
import '@/providers';

import { axe } from '@test/helpers/accessibility';
import { holdResponse } from '@test/helpers/ConversationPorts';
import { createChatFeatureHost } from '@test/helpers/features/chat/ChatFeatureHostFixture';
import { createSessionRuntimePool } from '@test/helpers/features/chat/SessionRuntimePoolHarness';
import { createHarness, releaseSideChatHarnesses, type SideChatDOMHarness } from '@test/helpers/features/chat/SideChatDOMHarness';
import { fireEvent, within } from '@testing-library/dom';
import { App, Component, TFile } from 'obsidian';

import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import type { Conversation, ImageAttachment, UsageInfo } from '@/core/types';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import { renderQueueStrip } from '@/features/chat/composer/QueueStrip';
import { destroyTab } from '@/features/chat/tabs/TabLifecycle';
import { createTabRuntime } from '@/features/chat/tabs/TabRuntimeFactory';
import type { AssembledTabRuntime } from '@/features/chat/tabs/types';
import { setLocale } from '@/i18n/i18n';
import { VaultMentionDataProvider } from '@/shared/mention/VaultMentionDataProvider';

afterEach(async () => {
  vi.restoreAllMocks();
  await releaseSideChatHarnesses();
});

const note = Object.assign(new TFile(), {
  path: 'Notes/Plan.md', name: 'Plan.md', basename: 'Plan', extension: 'md',
});

let backend: SideChatDOMHarness['backend'];

async function createTab(linkedContentPath?: string): Promise<AssembledTabRuntime> {
  const harness = await createHarness();
  backend = harness.backend;
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
  const pool = createSessionRuntimePool(() => plugin);
  const plugin: ChatFeatureHost = await createChatFeatureHost({
    executionPersistence: {
      registerExecutionBinding() {}, releaseExecutionBinding() {},
      assertConversationExecutionAuthority: async () => undefined,
      persistExecutionSnapshot: async () => true, recordConversationActivity: async () => undefined,
    },
    providerHost: harness.plugin.providerHost, bindSessionTools: harness.plugin.bindSessionTools, projects: harness.plugin.projects, sessionRuntimes: pool,
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
    getConversationById: async () => conversation,
    getConversationList: () => [{ ...conversation, messageCount: conversation.messages.length, preview: '' }],
  });
  const tab = await createTabRuntime({
    plugin,
    component: Object.assign(new Component(), { registerDomEvent: () => undefined, registerEvent: () => undefined }) as never,
    containerEl: document.body.appendChild(document.createElement('div')),
    conversation,
    getProviderCatalogConfig: () => null,
    isRuntimeLive: () => true,
    openConversation: async () => {}, startNewConversation: async () => {},
    mentionDataProvider: new VaultMentionDataProvider(app),
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

it('attaches localized queued follow-ups above the input and preserves composer actions', async () => {
  const tab = await createTab();
  let sending: Promise<void> | undefined;
  try {
    const box = within(tab.dom.inputWrapper);
    expect(box.queryByRole('button', { name: 'Discard queued message' })).toBeNull();

    vi.spyOn(ProviderRegistry, 'getCapabilities').mockReturnValue({
      ...ProviderRegistry.getCapabilities('claude'), supportsTurnSteer: true,
    });
    // A real provider handoff gives the coordinator the active execution that admits steering.
    const handoff = backend.nextRequest(() => true);
    sending = tab.controllers.inputController.sendMessage({ content: 'draft the plan' });
    await handoff;
    tab.controllers.inputController.queue.enqueue({
      content: 'also add a created date', turnRequest: { text: 'also add a created date' },
    });

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

    tab.controllers.drafts.consume('main');
    setLocale('zh-CN');
    const image: ImageAttachment = {
      id: 'image', name: 'image.png', mediaType: 'image/png', data: 'aGVsbG8=', size: 5, source: 'paste',
    };
    const content = 'User [images] stays literal';
    tab.controllers.inputController.queue.enqueue({
      content, turnRequest: { text: content, images: [image] },
    });
    const queue = within(strip);
    expect(queue.getByText('排队中')).toBeDefined();
    expect(queue.getByText('User [images] stays literal [图片]')).toBeDefined();
    expect(queue.getByRole('button', { name: '立即引导' })).toBeDefined();
    expect(queue.getByRole('button', { name: '丢弃排队消息' })).toBeDefined();
    expect(await axe(strip)).toHaveNoViolations();

    fireEvent.click(queue.getByRole('button', { name: '编辑排队消息' }));
    expect(tab.state.queuedMessage).toBeNull();
    expect(strip.classList.contains('claudian-hidden')).toBe(true);
    expect(queue.queryByRole('button', { name: '编辑排队消息' })).toBeNull();
    expect(tab.dom.inputEl.value).toBe(content);
    expect(tab.controllers.drafts.capture('main').images).toEqual([image]);

    const longContent = '[images] 1234567890123456789012345678901234567890';
    tab.controllers.inputController.queue.enqueue({
      content: longContent, turnRequest: { text: longContent, images: [image] },
    });
    expect(queue.getByText('[images] 1234567890123456789012345678901... [图片]')).toBeDefined();
    fireEvent.click(queue.getByRole('button', { name: '丢弃排队消息' }));
    expect(tab.state.queuedMessage).toBeNull();
    expect(strip.classList.contains('claudian-hidden')).toBe(true);
    expect(backend.latest.getStatus()).toBe('executing');
    expect(backend.latest.cancelCalls).toBe(0);
  } finally {
    setLocale('en');
    try {
      tab.controllers.inputController.queue.clear();
      backend.latest.complete();
      await sending;
    } finally {
      await destroyTab(tab);
    }
  }
});

it.each([
  ['zh-CN', '引导中'],
  ['en', 'Steering'],
] as const)('renders the %s steering label without queued actions', (locale, label) => {
  const strip = document.body.appendChild(document.createElement('div'));
  try {
    setLocale(locale);
    renderQueueStrip(strip, {
      kind: 'steering', message: { content: 'User [images] stays literal', turnRequest: { text: 'follow-up' } },
    }, { steer() {}, edit() {}, discard() {} });
    expect(within(strip).getByText(label)).toBeDefined();
    expect(within(strip).getByText('User [images] stays literal')).toBeDefined();
    expect(within(strip).queryAllByRole('button')).toHaveLength(0);
  } finally {
    setLocale('en');
    strip.remove();
  }
});

it.each(['Edit queued message', 'Discard queued message'])(
  'keeps the focused %s action usable when the queue refreshes', async label => {
    const tab = await createTab();
    const release = holdResponse(tab.session.runtime.turns);
    try {
      const queue = tab.controllers.inputController.queue;
      queue.enqueue({ content: 'First follow-up', turnRequest: { text: 'First follow-up' } });
      const strip = within(tab.dom.queueIndicatorEl);
      tab.dom.inputEl.focus();
      queue.updateIndicator();
      expect(tab.dom.inputEl.contains(document.activeElement)).toBe(true);
      strip.getByRole('button', { name: label }).focus();
      queue.enqueue({ content: 'Second follow-up', turnRequest: { text: 'Second follow-up' } });
      const updated = strip.getByRole('button', { name: label });
      expect(document.activeElement).toBe(updated);
      expect(strip.getByText('First follow-up Second follow-up')).toBeDefined();
      expect(await axe(tab.dom.queueIndicatorEl)).toHaveNoViolations();
      fireEvent.click(updated);
      expect(queue.message).toBeNull();
      expect(tab.dom.inputEl.value).toBe(label === 'Edit queued message' ? 'First follow-up\n\nSecond follow-up' : '');
    } finally {
      tab.controllers.inputController.queue.clear();
      await release();
      await destroyTab(tab);
    }
  },
);

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
