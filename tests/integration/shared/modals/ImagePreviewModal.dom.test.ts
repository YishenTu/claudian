/** @vitest-environment jsdom */
import '@/providers';

import { axe } from '@test/helpers/accessibility';
import { claudeCatalogFixture } from '@test/helpers/claudeModels';
import { createChatFeatureHost } from '@test/helpers/features/chat/ChatFeatureHostFixture';
import { createClaudianView } from '@test/helpers/features/chat/ClaudianViewHarness';
import { createProjectsFake } from '@test/helpers/features/chat/ProjectsFake';
import { createSessionRuntimePool } from '@test/helpers/features/chat/SessionRuntimePoolHarness';
import { FakeSideBackend, type FakeSideSession } from '@test/helpers/features/chat/SideChatSessionHarness';
import { testDate } from '@test/helpers/testClock';
import { fireEvent, waitFor, within } from '@testing-library/dom';
import { App, Component, type Scope } from 'obsidian';

import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { type ChatMessage, type ClaudianSettings, type Conversation, type ImageAttachment } from '@/core/types';
import { SessionMessagingService } from '@/features/chat/session-messaging/SessionMessagingService';
import { activateTab, destroyTab } from '@/features/chat/tabs/TabLifecycle';
import { createTabRuntime } from '@/features/chat/tabs/TabRuntimeFactory';
import { VaultMentionDataProvider } from '@/shared/mention/VaultMentionDataProvider';

const originalResizeObserver = globalThis.ResizeObserver;
beforeEach(() => {
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => null });
});
afterEach(() => {
  globalThis.ResizeObserver = originalResizeObserver;
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

/** One real tab runtime with real controllers, session pool, and the fake provider boundary. */
async function createView() {
  const backend = new FakeSideBackend();
  vi.spyOn(ProviderRegistry, 'createExecutionBackend').mockReturnValue(backend);
  const app = new App();
  const scopes: Scope[] = [];
  Object.assign(app, { keymap: {
    pushScope: (scope: Scope) => { scopes.push(scope); },
    popScope: (scope: Scope) => {
      const index = scopes.indexOf(scope);
      if (index >= 0) scopes.splice(index, 1);
    },
  } });
  Object.assign(app.vault.adapter, { basePath: '/vault' });
  const settings = {
    model: 'claude-sonnet-4-5', effortLevel: 'high', permissionMode: 'manual',
    enableAutoTitleGeneration: false, excludedTags: [], mediaFolder: '', systemPrompt: '', userName: '',
    keyboardNavigation: { scrollUpKey: 'w', scrollDownKey: 's', focusInputKey: 'i' },
    providerConfigs: { claude: {
      ...claudeCatalogFixture(['claude-sonnet-4-5'], ['low', 'high']), promptSuggestions: true,
    } },
  } satisfies Partial<ClaudianSettings>;
  const conversation: Conversation = {
    id: 'conversation-1', providerId: 'claude', selectedModel: 'claude-sonnet-4-5',
    sessionId: 'main-session', messages: [], title: 'Existing conversation',
    createdAt: testDate().getTime(), lastActivityAt: testDate().getTime(),
  };
  const conversations = new Map([[conversation.id, conversation]]);
  const pool = createSessionRuntimePool(() => plugin);
  const messaging = new SessionMessagingService({
    getHost: () => plugin, getActiveConversationId: () => conversation.id, refreshModelControls: () => {},
  });
  onTestFinished(() => messaging.dispose());
  const plugin = await createChatFeatureHost({
    app, settings, sessionRuntimes: pool,
    bindSessionTools: id => messaging.bindSessionTools(id),
    executionPersistence: {
      registerExecutionBinding() {}, releaseExecutionBinding() {},
      assertConversationExecutionAuthority: async () => {},
      persistExecutionSnapshot: async () => true,
      recordConversationActivity: async () => {},
    },
    getConversationSummary: id => conversations.get(id) ?? null,
    projects: createProjectsFake(),
    getConversationSync: id => conversations.get(id) ?? null,
    getCachedConversation: id => conversations.get(id) ?? null,
    getConversationById: async id => conversations.get(id) ?? null,
    getConversationList: () => [{ ...conversation, messageCount: 0, preview: '' }],
    renameConversation: async () => {}, updateConversation: async () => {},
    chatModelSelection: { beginIntent: () => 1, commitIntent: async () => true },
  });
  plugin.providerHost.getResolvedProviderCliPath = async () => '/bin/claude';
  const component = new Component();
  const containerEl = document.body.createDiv();
  const tab = await createTabRuntime({
    plugin, conversation, component, containerEl,
    mentionDataProvider: new VaultMentionDataProvider(app), getProviderCatalogConfig: () => null,
    isRuntimeLive: () => true, lifecycleState: 'open',
    openConversation: async () => {}, startNewConversation: async () => {},
  });
  tab.hydrationState = 'ready';
  await tab.executionCoordinator.bindConversation({ conversationId: conversation.id, providerId: 'claude' });
  await tab.executionCoordinator.prepare();
  vi.spyOn(tab.dom.messagesEl, 'getClientRects').mockImplementation(() =>
    (tab.dom.contentEl.classList.contains('claudian-hidden') ? [] : [{}]) as unknown as DOMRectList);
  activateTab(tab);
  tab.dom.inputEl.focus();
  // The real view Scope is the host keymap's destination; only its delivery is external.
  const root = await createClaudianView({ host: plugin, containerEl: tab.dom.contentEl,
    contentEl: tab.dom.contentEl, tabManager: { getActiveTab: () => tab } });
  root.wireEventHandlers();
  return { get tab() { return tab; }, backend, conversation, plugin, root, scopes,
    dispose: async () => { await destroyTab(tab); await pool.dispose(); await messaging.dispose(); await plugin.providerHost.executionLifecycleRegistry.dispose(); } };
}

type View = Awaited<ReturnType<typeof createView>>;

/** External Obsidian keymap stand-in: delivers real DOM events to the actual registered Scope. */
function installHostKeymap(view: View): { deliveries: number[]; remove: () => void } {
  const deliveries: number[] = [];
  const deliver = (event: KeyboardEvent) => {
    // Obsidian installs this listener on window capture before any preview is opened.
    const scope = view.scopes.at(-1) ?? view.root.scope;
    const handlers = (scope as unknown as { handlers: Array<{
      key: string | null;
      modifiers: string[] | null;
      func: (event: KeyboardEvent) => unknown;
    }> }).handlers;
    const modifiers = [
      ...(event.ctrlKey ? ['Ctrl'] : []), ...(event.metaKey ? ['Meta'] : []),
      ...(event.altKey ? ['Alt'] : []), ...(event.shiftKey ? ['Shift'] : []),
    ];
    const handler = handlers.find(entry => entry.key === event.key && (
      entry.modifiers === null || (entry.modifiers.length === modifiers.length &&
        entry.modifiers.every(modifier => modifiers.includes(modifier)))
    ));
    if (!handler) return;
    if (scope === view.root.scope) deliveries.push(1);
    if (handler.func(event) === false) {
      event.preventDefault();
      event.stopPropagation();
    }
  };
  window.addEventListener('keydown', deliver, true);
  return { deliveries, remove: () => window.removeEventListener('keydown', deliver, true) };
}

function textbox(view: View): HTMLElement { return within(view.tab.dom.inputEl).getByRole('textbox'); }

function type(view: View, text: string): void {
  fireEvent.paste(textbox(view), { clipboardData: { getData: () => text, files: [] } });
}

const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3xoAAAAASUVORK5CYII=';
const IMAGE: ImageAttachment = {
  id: 'pixel', name: 'pixel.png', mediaType: 'image/png', data: TINY_PNG, size: 68, source: 'file',
};

function userMessageWithImages(id: string, images: ImageAttachment[]): ChatMessage {
  return { id, role: 'user', content: '', timestamp: testDate().getTime(), images };
}

function renderMessageImage(view: View, images: ImageAttachment[] = [IMAGE]): HTMLElement {
  view.tab.renderer.addMessage(userMessageWithImages('image-message', images));
  return within(view.tab.dom.messagesEl).getByRole('button', { name: `Preview ${images[0].name}` });
}

function openPreview(trigger: HTMLElement): HTMLElement {
  trigger.focus();
  fireEvent.click(trigger);
  return within(document.body).getByRole('dialog', { name: 'Image preview: pixel.png' });
}

/** A real bubbling, cancelable Escape from the focused element. */
function pressEscape(target: HTMLElement): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

interface ActiveWork {
  session: FakeSideSession;
  pending: Promise<void> | undefined;
  /** The scenario's fake-backend work is still owned and running. */
  assertWorking(): void;
}

async function startSelectedMainWork(view: View): Promise<ActiveWork> {
  type(view, 'Running prompt');
  const pending = view.tab.controllers.inputController.sendMessage();
  await waitFor(() => expect(view.backend.latest.getStatus()).toBe('executing'));
  const session = view.backend.latest;
  return {
    session, pending,
    assertWorking: () => {
      expect(view.tab.state.isStreaming).toBe(true);
      expect(session.getStatus()).toBe('executing');
    },
  };
}

async function startSelectedSideWork(view: View): Promise<ActiveWork> {
  type(view, 'Parent prompt');
  const parentTurn = view.tab.controllers.inputController.sendMessage();
  await waitFor(() => expect(view.backend.latest.getStatus()).toBe('executing'));
  const parent = view.backend.latest;
  parent.emitText('Parent answer');
  parent.complete();
  await parentTurn;
  type(view, '/side Independent child prompt');
  const pending = view.tab.controllers.inputController.sendMessage();
  await waitFor(() => expect(view.backend.sessions).toHaveLength(2));
  const session = view.backend.sessions[1];
  await waitFor(() => expect(session.getStatus()).toBe('executing'));
  expect(view.tab.controllers.sideChatController.destination).toBe('side');
  return {
    session, pending,
    assertWorking: () => {
      expect(view.tab.controllers.sideChatController.destination).toBe('side');
      expect(session.getStatus()).toBe('executing');
    },
  };
}

async function startMainBackgroundWork(view: View): Promise<ActiveWork> {
  type(view, 'Running prompt');
  const sent = view.tab.controllers.inputController.sendMessage();
  await waitFor(() => expect(view.backend.latest.getStatus()).toBe('executing'));
  const session = view.backend.latest;
  session.emitText('Completed answer');
  session.complete();
  await sent;
  session.emitBackgroundEvent({ type: 'background_turn_started' });
  await waitFor(() => expect(view.tab.session.hasMainBackgroundWork).toBe(true));
  return {
    session, pending: undefined,
    assertWorking: () => {
      expect(view.tab.session.hasMainBackgroundWork).toBe(true);
    },
  };
}

const workScenarios: Array<{ title: string; start(view: View): Promise<ActiveWork> }> = [
  { title: 'selected main turn', start: startSelectedMainWork },
  { title: 'selected side turn', start: startSelectedSideWork },
  { title: 'main background work', start: startMainBackgroundWork },
];

it.each(workScenarios)(
  'dismisses the message-image preview with Escape without stopping $title',
  async ({ start }) => {
    const view = await createView();
    const host = installHostKeymap(view);
    let pending: Promise<void> | undefined;
    try {
      const work = await start(view);
      pending = work.pending;
      const trigger = renderMessageImage(view);
      const dialog = openPreview(trigger);
      const closeButton = within(dialog).getByRole('button', { name: 'Close image preview' });
      expect(dialog.getAttribute('aria-modal')).toBe('true');
      expect(closeButton).toBeInstanceOf(HTMLButtonElement);
      expect(closeButton.getAttribute('type')).toBe('button');
      const image = within(dialog).getByRole('img', { name: 'pixel.png' });
      expect(image.getAttribute('src')).toBe(`data:image/png;base64,${TINY_PNG}`);
      expect(document.activeElement).toBe(closeButton);
      expect(await axe(dialog)).toHaveNoViolations();

      const escape = pressEscape(closeButton);

      expect(work.session.cancelCalls).toBe(0);
      expect(within(document.body).queryByRole('dialog', { name: 'Image preview: pixel.png' })).toBeNull();
      expect(document.activeElement).toBe(trigger);
      work.assertWorking();
      expect(host.deliveries).toHaveLength(0);
      expect(escape.defaultPrevented).toBe(true);

      // The next Escape resumes ordinary selected-destination cancellation.
      pressEscape(trigger);
      await waitFor(() => expect(work.session.cancelCalls).toBe(1));
      expect(host.deliveries).toHaveLength(1);
    } finally {
      host.remove();
      // Release runtime and pool first so a fault swallowing the cancellation cannot hang cleanup;
      // the pending send is still awaited after disposal, and assertions never observe cleanup.
      try {
        await view.dispose();
      } finally {
        await pending;
      }
    }
  },
);

it.each(['close button', 'backdrop'] as const)('releases the preview scope after dismissal by %s', async method => {
  const view = await createView();
  const host = installHostKeymap(view);
  try {
    const trigger = renderMessageImage(view);
    const dialog = openPreview(trigger);
    fireEvent.click(within(dialog).getByRole('img', { name: 'pixel.png' }));
    expect(within(document.body).getByRole('dialog', { name: 'Image preview: pixel.png' })).toBe(dialog);
    fireEvent.click(method === 'close button'
      ? within(dialog).getByRole('button', { name: 'Close image preview' })
      : dialog.parentElement!);
    expect(within(document.body).queryByRole('dialog', { name: 'Image preview: pixel.png' })).toBeNull();
    expect(document.activeElement).toBe(trigger);
    pressEscape(trigger);
    expect(host.deliveries).toHaveLength(1);
  } finally {
    host.remove();
    await view.dispose();
  }
});

it('opens from the composer attachment action and closes with its owner on destroy', async () => {
  const view = await createView();
  const host = installHostKeymap(view);
  try {
    type(view, 'Running prompt');
    const pending = view.tab.controllers.inputController.sendMessage();
    await waitFor(() => expect(view.backend.latest.getStatus()).toBe('executing'));
    const session = view.backend.latest;
    view.tab.ui.imageContextManager.setImages([IMAGE]);
    const attachment = within(view.tab.dom.contentEl)
      .getByRole('button', { name: 'Image attachment: pixel.png \u00B7 68 B' });
    attachment.focus();
    fireEvent.click(attachment);
    const dialog = within(document.body).getByRole('dialog', { name: 'Image preview: pixel.png' });
    const closeButton = within(dialog).getByRole('button', { name: 'Close image preview' });
    expect(document.activeElement).toBe(closeButton);
    expect(await axe(dialog)).toHaveNoViolations();

    const escape = pressEscape(closeButton);

    expect(within(document.body).queryByRole('dialog', { name: 'Image preview: pixel.png' })).toBeNull();
    expect(document.activeElement).toBe(attachment);
    expect(session.cancelCalls).toBe(0);
    expect(host.deliveries).toHaveLength(0);
    expect(escape.defaultPrevented).toBe(true);

    pressEscape(attachment);
    await waitFor(() => expect(session.cancelCalls).toBe(1));

    fireEvent.click(attachment);
    expect(within(document.body).getByRole('dialog', { name: 'Image preview: pixel.png' })).toBeDefined();
    view.tab.ui.imageContextManager.destroy();
    expect(within(document.body).queryByRole('dialog', { name: 'Image preview: pixel.png' })).toBeNull();
    pressEscape(document.body);
    expect(host.deliveries).toHaveLength(2);
    await pending;
  } finally {
    host.remove();
    await view.dispose();
  }
});

it('contains Tab and Shift+Tab on its single named close control', async () => {
  const view = await createView();
  const host = installHostKeymap(view);
  try {
    const trigger = renderMessageImage(view);
    const dialog = openPreview(trigger);
    const closeButton = within(dialog).getByRole('button', { name: 'Close image preview' });
    expect(document.activeElement).toBe(closeButton);
    for (const shiftKey of [false, true]) {
      const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true });
      closeButton.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(closeButton);
    }
  } finally {
    host.remove();
    await view.dispose();
  }
});

it('replaces an open preview and releases the replaced dialog scope', async () => {
  const view = await createView();
  const host = installHostKeymap(view);
  try {
    const first = renderMessageImage(view, [IMAGE, { ...IMAGE, id: 'second', name: 'second.png' }]);
    first.focus();
    fireEvent.click(first);
    expect(within(document.body).getByRole('dialog', { name: 'Image preview: pixel.png' })).toBeDefined();
    const second = within(view.tab.dom.messagesEl).getByRole('button', { name: 'Preview second.png' });
    second.focus();
    fireEvent.click(second);
    expect(within(document.body).getAllByRole('dialog')).toHaveLength(1);
    const closeButton = within(document.body).getByRole('button', { name: 'Close image preview' });
    expect(within(document.body).getByRole('dialog', { name: 'Image preview: second.png' })).toBeDefined();
    expect(document.activeElement).toBe(closeButton);

    pressEscape(closeButton);
    expect(within(document.body).queryByRole('dialog', { name: 'Image preview: second.png' })).toBeNull();
    // Preserved original behavior: open() closes the previous preview before sampling the trigger to
    // restore, so the replacement captured the first trigger its predecessor had just restored.
    expect(document.activeElement).toBe(first);

    // The replacement released the old preview's scope together with its dialog; the next Escape
    // leaves no preview scope and reaches the host keymap from the restored first trigger.
    pressEscape(first);
    expect(host.deliveries).toHaveLength(1);
  } finally {
    host.remove();
    await view.dispose();
  }
});

it('skips restoring focus to a removed trigger and still releases its scope', async () => {
  const view = await createView();
  const host = installHostKeymap(view);
  try {
    const trigger = renderMessageImage(view);
    const dialog = openPreview(trigger);
    const closeButton = within(dialog).getByRole('button', { name: 'Close image preview' });
    trigger.remove();
    const restoreFocus = vi.spyOn(trigger, 'focus');

    pressEscape(closeButton);

    expect(within(document.body).queryByRole('dialog', { name: 'Image preview: pixel.png' })).toBeNull();
    expect(trigger.isConnected).toBe(false);
    expect(restoreFocus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(document.body);
    pressEscape(document.body);
    expect(host.deliveries).toHaveLength(1);
  } finally {
    host.remove();
    await view.dispose();
  }
});

it('closes the preview and releases its scope when the renderer is disposed', async () => {
  const view = await createView();
  const host = installHostKeymap(view);
  try {
    const trigger = renderMessageImage(view);
    openPreview(trigger);
    expect(within(document.body).getByRole('dialog', { name: 'Image preview: pixel.png' })).toBeDefined();

    view.tab.renderer.dispose();

    expect(within(document.body).queryByRole('dialog', { name: 'Image preview: pixel.png' })).toBeNull();
    pressEscape(document.body);
    expect(host.deliveries).toHaveLength(1);
  } finally {
    host.remove();
    await view.dispose();
  }
});
