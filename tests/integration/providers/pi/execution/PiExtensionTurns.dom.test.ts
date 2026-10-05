/** @jest-environment jsdom */
import '@/providers';

import { waitFor, within } from '@testing-library/dom';
import { App, Component, MarkdownRenderer } from 'obsidian';

import { ProviderExecutionLifecycleRegistry } from '@/core/execution';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import type { ClaudianSettings, Conversation } from '@/core/types';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import { activateTab, destroyTab } from '@/features/chat/tabs/TabLifecycle';
import { createTabRuntime } from '@/features/chat/tabs/TabRuntimeFactory';
import { PiExecutionBackend, type PiExecutionKernel, type PiExecutionKernelCallbacks } from '@/providers/pi/execution';
import type { PiLaunchSpec } from '@/providers/pi/runtime/PiLaunchSpec';
import { VaultMentionDataProvider } from '@/shared/mention/VaultMentionDataProvider';

const MODEL = 'pi:anthropic/claude-sonnet-4';

/** Scripted `pi --mode rpc` process: the environment port below the Pi provider. */
class ScriptedPiKernel implements PiExecutionKernel {
  readonly prompts: string[] = [];

  constructor(readonly launchSpec: PiLaunchSpec, private readonly callbacks: PiExecutionKernelCallbacks) {}

  emit(event: Record<string, unknown>): void { this.callbacks.onEvent(event); }
  getStderrSnapshot(): string { return ''; }
  send(): void {}
  start(): void {}
  async shutdown(): Promise<void> {}

  async request<T>(type: string, payload: Record<string, unknown> = {}): Promise<T> {
    if (type === 'prompt') {
      this.prompts.push(String(payload.message));
      return { disposition: 'started' } as T;
    }
    if (type === 'get_state') return { sessionId: 'pi-session' } as T;
    if (type === 'get_session_stats') {
      // Native round trips finish while later events stream.
      await new Promise(resolve => setTimeout(resolve, 30));
      return { contextWindow: 200_000, inputTokens: 10, outputTokens: 5 } as T;
    }
    if (type === 'get_commands') return { commands: [] } as T;
    return {} as T;
  }

  /** One assistant message that thinks, then answers without calling tools. */
  answer(text: string): void {
    this.emit({ message: { role: 'assistant' }, type: 'message_start' });
    this.emit({ assistantMessageEvent: { delta: `Considering ${text}`, type: 'thinking_delta' }, type: 'message_update' });
    this.emit({ assistantMessageEvent: { delta: text, type: 'text_delta' }, type: 'message_update' });
    this.emit({ message: { role: 'assistant', stopReason: 'stop', timestamp: Date.now() }, type: 'message_end' });
  }

  /** A Peeps result delivered with `pi.sendMessage({ display: true })`. */
  result(runId: string, text: string): void {
    const message = {
      content: `[Peeps automated result — ${runId} — answer]\n${text}`,
      customType: 'peeps-result',
      details: { runId, status: 'answer' },
      display: true,
      role: 'custom',
    };
    this.emit({ message, type: 'message_start' });
    this.emit({ message, type: 'message_end' });
  }
}

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
  jest.mocked(MarkdownRenderer.render).mockImplementation(async (_app, markdown, el) => {
    (el as HTMLElement).createEl('p', { text: markdown });
  });
});
afterEach(() => {
  jest.restoreAllMocks();
  document.body.replaceChildren();
});

async function createPiView() {
  const app = new App();
  Object.assign(app.vault.adapter, { basePath: '/vault' });
  Object.assign(app.vault, { on: () => ({}), offref() {} });
  Object.assign(app.workspace, { getActiveViewOfType: () => null });
  const lifecycleRegistry = new ProviderExecutionLifecycleRegistry();
  const settings = {
    model: MODEL, effortLevel: 'off', permissionMode: 'normal',
    enableAutoTitleGeneration: false, excludedTags: [], mediaFolder: '', systemPrompt: '', userName: '',
    providerConfigs: { pi: {
      discoveredModels: [{
        encodedId: MODEL, id: 'claude-sonnet-4', input: ['text'], label: 'Claude Sonnet 4',
        provider: 'anthropic', reasoning: true, thinkingLevels: ['off', 'high'],
      }],
      enabled: true,
      visibleModels: [MODEL],
    } },
  } as unknown as ClaudianSettings;
  const conversation = {
    id: 'conversation-1', providerId: 'pi', selectedModel: MODEL, messages: [],
  } as unknown as Conversation;
  const providerHost = {
    app, settings, executionLifecycleRegistry: lifecycleRegistry,
    getResolvedProviderCliPath: async () => '/bin/pi',
    getActiveEnvironmentVariables: () => '',
  };
  const kernels: ScriptedPiKernel[] = [];
  const backend = new PiExecutionBackend(providerHost as never, {
    commandCatalog: { setCommandSnapshot() {} } as never,
  }, {
    createKernel: (spec, callbacks) => {
      const kernel = new ScriptedPiKernel(spec, callbacks);
      kernels.push(kernel);
      return kernel;
    },
  });
  jest.spyOn(ProviderRegistry, 'createExecutionBackend').mockReturnValue(backend);
  const plugin = {
    app, settings, providerHost,
    executionPersistence: {
      registerExecutionBinding() {}, releaseExecutionBinding() {},
      assertConversationExecutionAuthority: async () => {},
      persistExecutionSnapshot: async () => true,
      recordConversationActivity: async () => {},
    },
    getSessionSnapshotDirectory: () => '/tmp/claudian-sessions',
    getCommittedSettings: () => settings,
    getActiveEnvironmentVariables: () => '',
    getConversationSummary: () => conversation,
    getConversationSync: () => conversation,
    getConversationById: async () => conversation,
    getConversationList: () => [conversation],
    renameConversation: async () => {},
    updateConversation: async () => {},
    mutateSettings: async (mutate: (settings: ClaudianSettings) => void) => mutate(settings),
    chatModelSelection: { beginIntent: () => 1, commitIntent: async () => true },
  } as unknown as ChatFeatureHost;
  const tab = await createTabRuntime({
    plugin, conversation, component: new Component(),
    containerEl: document.body.createDiv(),
    mentionDataProvider: new VaultMentionDataProvider(plugin.app),
    getProviderCatalogConfig: () => null, isRuntimeLive: () => true,
  });
  tab.hydrationState = 'ready';
  await tab.executionCoordinator.bindConversation({ conversationId: conversation.id, providerId: 'pi' });
  await tab.executionCoordinator.prepare();
  activateTab(tab);
  return {
    tab, kernels,
    dispose: async () => { await destroyTab(tab); await lifecycleRegistry.dispose(); },
  };
}

type PiView = Awaited<ReturnType<typeof createPiView>>;

function responseElements(view: PiView): HTMLElement[] {
  return Array.from(view.tab.dom.messagesEl.querySelectorAll<HTMLElement>('.claudian-message-assistant'))
    .filter(element => !element.hidden);
}

function disclosures(element: HTMLElement): string[] {
  return within(element).queryAllByRole('button', { hidden: true })
    .filter(button => button.classList.contains('claudian-work-header'))
    .map(button => button.textContent ?? '');
}

/** An answer is visible outside every collapsed disclosure. */
function expectVisibleAnswer(element: HTMLElement, text: string): void {
  const answer = within(element).getByText(text);
  expect(answer.closest('[hidden]')).toBeNull();
}

async function sendPrompt(view: PiView, text: string, script: (kernel: ScriptedPiKernel) => Promise<void>): Promise<void> {
  view.tab.dom.inputEl.value = text;
  const pending = view.tab.controllers.inputController.sendMessage();
  await waitFor(() => expect(view.kernels[0]?.prompts).toContain(text));
  await script(view.kernels[0]);
  await pending;
}

/** Native events arrive over time while the chat view processes earlier ones. */
function later(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 20));
}

describe('Pi extension-initiated turns in the chat view', () => {
  it('ends the prompt at its answer and renders each later result as a notification with its reply', async () => {
    const view = await createPiView();
    try {
      await sendPrompt(view, 'Delegate the probes', async (kernel) => {
        kernel.emit({ type: 'agent_start' });
        kernel.emit({ message: { role: 'assistant' }, type: 'message_start' });
        kernel.emit({ assistantMessageEvent: { delta: 'Spawning probes.', type: 'text_delta' }, type: 'message_update' });
        kernel.emit({ message: { role: 'assistant', stopReason: 'toolUse', timestamp: Date.now() }, type: 'message_end' });
        await later();
        // Mid-work: steered after a tool call, so it belongs to the prompted response.
        kernel.result('run-0', 'Result 0.');
        await later();
        kernel.answer('Prompt answer.');
        await later();
        // Pi drains results steered after the final answer within the same native run.
        kernel.result('run-a', 'Result A.');
        await later();
        kernel.answer('Reply A.');
        await later();
        kernel.result('run-b', 'Result B.');
        await later();
        kernel.answer('Reply B.');
        await later();
        kernel.emit({ messages: [], type: 'agent_end' });
        kernel.emit({ type: 'agent_settled' });
      });
      await waitFor(() => expect(within(view.tab.dom.messagesEl)
        .getAllByRole('button', { name: 'Task notification' })).toHaveLength(2));
      await waitFor(() => expect(view.tab.executionCoordinator.hasBackgroundWork).toBe(false));
      await view.tab.session.awaitBackgroundWork();

      const [prompted, replyA, replyB] = responseElements(view);
      expect(responseElements(view)).toHaveLength(3);
      expect(disclosures(prompted)).toEqual([expect.stringMatching(/^Worked for \d\d:\d\d$/), 'Task notification']);
      expectVisibleAnswer(prompted, 'Prompt answer.');
      const worked = within(prompted).getByRole('button', { name: /^Worked for/ });
      const work = document.getElementById(worked.getAttribute('aria-controls')!)!;
      expect(work.contains(within(prompted).getByText('Result 0.'))).toBe(true);
      expect(within(prompted).queryByText('Reply A.')).toBeNull();
      expect(disclosures(replyA)).toEqual(['Task notification']);
      expectVisibleAnswer(replyA, 'Reply A.');
      expect(within(replyA).getByText('Result A.')).toBeTruthy();
      expect(disclosures(replyB)).toEqual(['Task notification']);
      expectVisibleAnswer(replyB, 'Reply B.');
      expect(within(replyB).getByText('Result B.')).toBeTruthy();
      expect(view.tab.dom.messagesEl.textContent).not.toContain('Peeps automated result');
    } finally {
      await view.dispose();
    }
  });

  it('renders an idle wake-up as a notification with its reply', async () => {
    const view = await createPiView();
    try {
      await sendPrompt(view, 'Start the probe', async (kernel) => {
        kernel.emit({ type: 'agent_start' });
        kernel.answer('Started.');
        kernel.emit({ messages: [], type: 'agent_end' });
        kernel.emit({ type: 'agent_settled' });
      });
      const kernel = view.kernels[0];
      kernel.emit({ type: 'entry_appended' });
      kernel.emit({ type: 'agent_start' });
      await later();
      kernel.result('run-c', 'Result C.');
      await later();
      kernel.answer('Reply C.');
      await later();
      kernel.emit({ messages: [], type: 'agent_end' });
      kernel.emit({ type: 'agent_settled' });
      await waitFor(() => expect(within(view.tab.dom.messagesEl)
        .getAllByRole('button', { name: 'Task notification' })).toHaveLength(1));
      await waitFor(() => expect(view.tab.executionCoordinator.hasBackgroundWork).toBe(false));
      await view.tab.session.awaitBackgroundWork();

      const [prompted, wake] = responseElements(view);
      expect(responseElements(view)).toHaveLength(2);
      expect(disclosures(prompted)).toEqual([expect.stringMatching(/^Worked for \d\d:\d\d$/)]);
      expectVisibleAnswer(prompted, 'Started.');
      expect(disclosures(wake)).toEqual(['Task notification']);
      expectVisibleAnswer(wake, 'Reply C.');
    } finally {
      await view.dispose();
    }
  });
});
