/** @vitest-environment jsdom */

import { createChatFeatureHost } from '@test/helpers/features/chat/ChatFeatureHostFixture';
import { createProjectsFake } from '@test/helpers/features/chat/ProjectsFake';
import { createSessionRuntimePool } from '@test/helpers/features/chat/SessionRuntimePoolHarness';
import { waitFor, within } from '@testing-library/dom';
import { App, Component, MarkdownRenderer } from 'obsidian';

import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { registerProviderModules } from '@/core/providers/registerProviderModules';
import type { ClaudianSettings, Conversation } from '@/core/types';
import { SessionMessagingService } from '@/features/chat/session-messaging/SessionMessagingService';
import { activateTab, destroyTab } from '@/features/chat/tabs/TabLifecycle';
import { createTabRuntime } from '@/features/chat/tabs/TabRuntimeFactory';
import { formatActivityPreview } from '@/features/chat/zen/activityPreview';
import { claudeProviderRegistration } from '@/providers/claude/registration';
import { PiExecutionBackend, type PiExecutionKernel, type PiExecutionKernelCallbacks } from '@/providers/pi/execution';
import { piProviderRegistration } from '@/providers/pi/registration';
import { PiExtensionUIBridge } from '@/providers/pi/runtime/PiExtensionUIBridge';
import type { PiLaunchSpec } from '@/providers/pi/runtime/PiLaunchSpecBuilder';
import { VaultMentionDataProvider } from '@/shared/mention/VaultMentionDataProvider';

registerProviderModules([claudeProviderRegistration, piProviderRegistration]);

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

  /** Extension notifications pass through the real native-UI bridge into this session. */
  notify(notifyType: string | undefined): void {
    const transport = { send: () => { throw new Error('A notification must not request a native response'); } };
    new PiExtensionUIBridge(transport, null, this.callbacks.onExtensionChunk)
      .handleRequest({ type: 'extension_ui_request', method: 'notify', message: 'Extension policy message', notifyType });
  }

  /** One assistant message that thinks, then answers without calling tools. */
  answer(text: string): void {
    this.emit({ message: { role: 'assistant' }, type: 'message_start' });
    this.emit({ assistantMessageEvent: { delta: `Considering ${text}`, type: 'thinking_delta' }, type: 'message_update' });
    this.emit({ assistantMessageEvent: { delta: text, type: 'text_delta' }, type: 'message_update' });
    this.emit({ message: { role: 'assistant', stopReason: 'stop', timestamp: Date.now() }, type: 'message_end' });
  }

  /** A completed native tool call, as Pi reports extension tools such as Peeps. */
  tool(toolCallId: string, toolName: string, args: Record<string, unknown>, details: Record<string, unknown>): void {
    this.emit({ args, toolCallId, toolName, type: 'tool_execution_start' });
    this.emit({
      isError: false,
      result: { content: [{ text: JSON.stringify(details), type: 'text' }], details },
      toolCallId,
      toolName,
      type: 'tool_execution_end',
    });
  }

  /** A Peeps result delivered with `pi.sendMessage({ display: true })`. */
  result(runId: string, text: string): void {
    const message = {
      content: `[Peeps automated result — ${runId} — answer]\n${text}`,
      customType: 'peeps-result',
      details: { owner: 'pi-session', results: [{ runId, seq: 1, status: 'answer' }] },
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
  vi.mocked(MarkdownRenderer.render).mockImplementation(async (_app, markdown, el) => {
    (el as HTMLElement).createEl('p', { text: markdown });
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

async function createPiView() {
  const app = new App();
  Object.assign(app.vault.adapter, { basePath: '/vault' });
  Object.assign(app.vault, { on: () => ({}), offref() {} });
  Object.assign(app.workspace, { getActiveViewOfType: () => null });
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
  } satisfies Partial<ClaudianSettings>;
  const conversation = {
    id: 'conversation-1', providerId: 'pi', selectedModel: MODEL, messages: [],
    title: 'Pi extension', createdAt: 1, lastActivityAt: 1, sessionId: null,
  } satisfies Conversation;
  const pool = createSessionRuntimePool(() => plugin);
  const messaging = new SessionMessagingService({ getHost: () => plugin, getActiveConversationId: () => conversation.id, refreshModelControls: () => undefined });
  const plugin = await createChatFeatureHost({
    sessionRuntimes: pool,
    bindSessionTools: id => messaging.bindSessionTools(id),
    app, settings,
    executionPersistence: {
      registerExecutionBinding() {}, releaseExecutionBinding() {},
      assertConversationExecutionAuthority: async () => {},
      persistExecutionSnapshot: async () => true,
      recordConversationActivity: async () => {},
    },
    getConversationSummary: () => conversation,
    projects: createProjectsFake(),
    getConversationSync: () => conversation,
    getConversationById: async () => conversation,
    getConversationList: () => [{ ...conversation, messageCount: 0, preview: '' }],
    renameConversation: async () => {},
    updateConversation: async () => {},
    chatModelSelection: { beginIntent: () => 1, commitIntent: async () => true },
  });
  vi.spyOn(plugin.providerHost, 'getResolvedProviderCliPath').mockResolvedValue('/bin/pi');
  const kernels: ScriptedPiKernel[] = [];
  const backend = new PiExecutionBackend(plugin.providerHost.getRuntimeHost('pi'), {
    createKernel: (spec, callbacks) => {
      const kernel = new ScriptedPiKernel(spec, callbacks);
      kernels.push(kernel);
      return kernel;
    },
  });
  vi.spyOn(ProviderRegistry, 'createExecutionBackend').mockReturnValue(backend);
  const tab = await createTabRuntime({
    plugin, conversation, component: new Component(),
    containerEl: document.body.createDiv(),
    mentionDataProvider: new VaultMentionDataProvider(plugin.app),
    getProviderCatalogConfig: () => null, isRuntimeLive: () => true,
    openConversation: async () => {}, startNewConversation: async () => {},
  });
  await tab.session.runtime.model.hydrate();
  await tab.executionCoordinator.bindConversation({ conversationId: conversation.id, providerId: 'pi' });
  await tab.executionCoordinator.prepare();
  activateTab(tab);
  return {
    tab, kernels,
    dispose: async () => { await destroyTab(tab); await messaging.dispose(); await plugin.providerHost.executionLifecycleRegistry.dispose(); },
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

it.each([
  ['warning', 'Warning'], ['error', 'Warning'], ['info', 'Notice'], [undefined, 'Notice'],
])('renders extension notification severity %s as %s without terminating the turn', async (notifyType, label) => {
  const view = await createPiView();
  try {
    await sendPrompt(view, 'Check policy', async kernel => {
      kernel.emit({ type: 'agent_start' });
      kernel.notify(notifyType);
      await waitFor(() => expect(view.tab.dom.messagesEl.textContent).toContain(`**${label}:** Extension policy message`));
      expect(view.tab.state.isStreaming).toBe(true);
      kernel.answer('The turn continued.');
      kernel.emit({ messages: [], type: 'agent_end' });
      kernel.emit({ type: 'agent_settled' });
    });
    expect(view.tab.state.isStreaming).toBe(false);
    expectVisibleAnswer(responseElements(view)[0], 'The turn continued.');
  } finally {
    await view.dispose();
  }
});

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
      await view.tab.session.runtime.awaitBackgroundWork();

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

  // Pi streams each call inside the assistant message (start, then complete arguments) before running it.
  it.each([false, true])('renders a Peeps child as a subagent card that its later result completes (calls streamed: %s)', async streamed => {
    const view = await createPiView();
    try {
      await sendPrompt(view, 'Delegate the probe', async (kernel) => {
        kernel.emit({ type: 'agent_start' });
        kernel.emit({ message: { role: 'assistant' }, type: 'message_start' });
        const calls = [
          ['spawn-1', 'peeps_spawn', { label: 'vault probe', task: 'List the vault root.' }],
          ['inspect-1', 'peeps_inspect', { id: 'run-1' }],
        ] as const;
        calls.forEach(([id, toolName, args], contentIndex) => {
          if (!streamed) return;
          kernel.emit({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_start', contentIndex, id, toolName } });
          kernel.emit({ type: 'message_update', assistantMessageEvent: {
            type: 'toolcall_end', contentIndex, toolCall: { type: 'toolCall', id, name: toolName, arguments: args },
          } });
        });
        kernel.emit({ message: { role: 'assistant', stopReason: 'toolUse', timestamp: Date.now() }, type: 'message_end' });
        kernel.tool('spawn-1', 'peeps_spawn', { label: 'vault probe', task: 'List the vault root.' }, {
          id: 'run-1', label: 'vault probe', status: 'starting',
        });
        kernel.tool('inspect-1', 'peeps_inspect', { id: 'run-1' }, { id: 'run-1', status: 'working' });
        await later();
        kernel.answer('Spawned.');
        kernel.emit({ messages: [], type: 'agent_end' });
        kernel.emit({ type: 'agent_settled' });
      });
      // Work before the answer collapses into its disclosure.
      await waitFor(() => within(view.tab.dom.messagesEl)
        .getByRole('button', { hidden: true, name: /^Subagent task: vault probe - Status: running/ }));
      // The card replaces the spawn's generic tool card; status tools keep theirs.
      expect(within(view.tab.dom.messagesEl).queryByText('peeps_spawn')).toBeNull();
      expect(within(view.tab.dom.messagesEl).getByText('peeps_inspect')).toBeTruthy();

      const kernel = view.kernels[0];
      kernel.emit({ type: 'agent_start' });
      await later();
      kernel.result('run-1', 'Inbox, Work, Template.');
      await later();
      kernel.answer('The probe finished.');
      kernel.emit({ messages: [], type: 'agent_end' });
      kernel.emit({ type: 'agent_settled' });
      await waitFor(() => expect(view.tab.executionCoordinator.hasBackgroundWork).toBe(false));
      await view.tab.session.runtime.awaitBackgroundWork();

      const completed = within(view.tab.dom.messagesEl)
        .getByRole('button', { hidden: true, name: /^Subagent task: vault probe - Status: completed/ });
      const [prompted] = responseElements(view);
      expect(prompted.contains(completed)).toBe(true);
      const content = completed.closest<HTMLElement>('[data-subagent-id]')!;
      expect(within(content).getByText('List the vault root.')).toBeTruthy();
      expect(within(content).getByText('Inbox, Work, Template.')).toBeTruthy();
      expect(view.tab.dom.messagesEl.querySelectorAll('[data-subagent-id="spawn-1"]')).toHaveLength(1);
    } finally {
      await view.dispose();
    }
  });

  // The chat holds tool cards until its buffer flushes; the activity preview names a call as soon as Pi streams it.
  it('previews a streamed call while its arguments are still streaming', async () => {
    const view = await createPiView();
    try {
      await sendPrompt(view, 'Write the note', async (kernel) => {
        kernel.emit({ type: 'agent_start' });
        kernel.emit({ message: { role: 'assistant' }, type: 'message_start' });
        kernel.emit({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_start', contentIndex: 0, id: 'write-1', toolName: 'write' } });
        kernel.emit({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 0, delta: '{"path":"note.md","content":"' } });
        await waitFor(() => expect(formatActivityPreview(view.tab.state)).toMatchObject({ tone: 'working', toolName: 'Write' }));
        kernel.emit({ message: { role: 'assistant', stopReason: 'aborted', timestamp: Date.now() }, type: 'message_end' });
        kernel.emit({ messages: [], type: 'agent_end' });
        kernel.emit({ type: 'agent_settled' });
      });
    } finally {
      await view.dispose();
    }
  });

  // Pi never runs a spawn streamed in a reply that failed, so no child starts and the retry answers without it.
  it('fails the subagent card of a streamed spawn whose reply failed', async () => {
    const view = await createPiView();
    try {
      await sendPrompt(view, 'Delegate the probe', async (kernel) => {
        kernel.emit({ type: 'agent_start' });
        kernel.emit({ message: { role: 'assistant' }, type: 'message_start' });
        kernel.emit({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_start', contentIndex: 0, id: 'spawn-1', toolName: 'peeps_spawn' } });
        kernel.emit({ type: 'message_update', assistantMessageEvent: {
          type: 'toolcall_end', contentIndex: 0, toolCall: { type: 'toolCall', id: 'spawn-1', name: 'peeps_spawn', arguments: { label: 'vault probe', task: 'List the vault root.' } },
        } });
        kernel.emit({ message: { role: 'assistant', stopReason: 'error', errorMessage: '529 overloaded', timestamp: Date.now() }, type: 'message_end' });
        kernel.emit({ messages: [], type: 'agent_end', willRetry: true });
        kernel.emit({ attempt: 1, maxAttempts: 3, delayMs: 0, errorMessage: '529 overloaded', type: 'auto_retry_start' });
        kernel.emit({ type: 'agent_start' });
        kernel.answer('Recovered.');
        kernel.emit({ attempt: 1, success: true, type: 'auto_retry_end' });
        kernel.emit({ messages: [], type: 'agent_end' });
        kernel.emit({ type: 'agent_settled' });
      });
      expect(within(view.tab.dom.messagesEl).getAllByRole('button', { hidden: true, name: /^Subagent task: vault probe - Status:/ })
        .map(button => button.getAttribute('aria-label'))).toEqual([expect.stringMatching(/^Subagent task: vault probe - Status: error/)]);
    } finally {
      await view.dispose();
    }
  });

  // A call streamed in a reply that failed never runs; the retry streams and runs the call again under a new id.
  it('leaves no running tool card for a streamed call whose attempt failed and was retried', async () => {
    const view = await createPiView();
    try {
      await sendPrompt(view, 'Read the note', async (kernel) => {
        const streamCall = (id: string) => {
          kernel.emit({ message: { role: 'assistant' }, type: 'message_start' });
          kernel.emit({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_start', contentIndex: 0, id, toolName: 'read' } });
          kernel.emit({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 0, delta: '{"path":' } });
        };
        kernel.emit({ type: 'agent_start' });
        streamCall('call-1');
        kernel.emit({ message: { role: 'assistant', stopReason: 'error', errorMessage: '529 overloaded', timestamp: Date.now() }, type: 'message_end' });
        kernel.emit({ messages: [], type: 'agent_end', willRetry: true });
        kernel.emit({ attempt: 1, maxAttempts: 3, delayMs: 0, errorMessage: '529 overloaded', type: 'auto_retry_start' });
        kernel.emit({ type: 'agent_start' });
        streamCall('call-2');
        kernel.emit({ type: 'message_update', assistantMessageEvent: {
          type: 'toolcall_end', contentIndex: 0, toolCall: { type: 'toolCall', id: 'call-2', name: 'read', arguments: { path: 'note.md' } },
        } });
        kernel.emit({ message: { role: 'assistant', stopReason: 'toolUse', timestamp: Date.now() }, type: 'message_end' });
        kernel.emit({ args: { path: 'note.md' }, toolCallId: 'call-2', toolName: 'read', type: 'tool_execution_start' });
        kernel.emit({ isError: false, result: { content: [{ text: 'Note body', type: 'text' }] }, toolCallId: 'call-2', toolName: 'read', type: 'tool_execution_end' });
        kernel.answer('Recovered.');
        kernel.emit({ attempt: 1, success: true, type: 'auto_retry_end' });
        kernel.emit({ messages: [], type: 'agent_end' });
        kernel.emit({ type: 'agent_settled' });
      });
      // The failed attempt's card ends failed with its reply; the retried call completes; neither spins after the turn.
      const status = (id: string) => view.tab.state.messages.flatMap(message => message.toolCalls ?? []).find(call => call.id === id)?.status;
      expect([status('call-1'), status('call-2')]).toEqual(['error', 'completed']);
      expect(view.tab.dom.messagesEl.querySelectorAll('.claudian-tool-call')).toHaveLength(2);
      expect(view.tab.dom.messagesEl.querySelectorAll('.claudian-tool-status.status-running')).toHaveLength(0);
      expect(view.tab.dom.messagesEl.querySelectorAll('.claudian-tool-status.status-error')).toHaveLength(1);
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
      await view.tab.session.runtime.awaitBackgroundWork();

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
