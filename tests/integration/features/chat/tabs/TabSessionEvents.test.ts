/** @jest-environment jsdom */

import '@/providers';

import { FakeSideBackend } from '@test/helpers/features/chat/SideChatSessionHarness';
import { testDate } from '@test/helpers/testClock';
import { Component, MarkdownRenderer } from 'obsidian';

import { ProviderExecutionLifecycleRegistry } from '@/core/execution';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import type { ChatMessage, ConversationMutablePatch } from '@/core/types';
import { ConversationController } from '@/features/chat/conversation/ConversationController';
import { ChatExecutionCoordinator } from '@/features/chat/execution/ChatExecutionCoordinator';
import { MessageRenderer } from '@/features/chat/rendering/MessageRenderer';
import { ChatState } from '@/features/chat/state/ChatState';
import { SubagentManager } from '@/features/chat/subagents/SubagentManager';
import { TabSession } from '@/features/chat/tabs/TabSession';
import { enqueueTabSessionEvent } from '@/features/chat/tabs/TabSessionEvents';
import { StreamController } from '@/features/chat/turns/StreamController';
import { CodexSubagentTracker } from '@/providers/codex/execution/CodexSubagentTracker';
import { CodexNotificationRouter } from '@/providers/codex/runtime/CodexNotificationRouter';

HTMLElement.prototype.empty = function () { this.replaceChildren(); };
HTMLElement.prototype.addClass = function (...classes) { this.classList.add(...classes); };
HTMLElement.prototype.removeClass = function (...classes) { this.classList.remove(...classes); };

/** Longer than any progress-coalescing window; persistence must not depend on its exact value. */
const QUIET_PERIOD_MS = 60_000;

beforeEach(() => {
  document.body.replaceChildren();
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'performance', 'Date'] });
  jest.mocked(MarkdownRenderer.render).mockImplementation(async (_app, markdown, el) => {
    (el as HTMLElement).createEl('p', { text: markdown });
  });
});

afterEach(() => {
  jest.useRealTimers();
});

async function createCodexChildTab() {
  const messagesEl = document.body.createDiv();
  const saves: ChatMessage[][] = [];
  const plugin = {
    app: {}, settings: { mediaFolder: '', showMessageTimestamps: false },
    updateConversation: jest.fn(async (_id: string, patch: ConversationMutablePatch) => {
      saves.push(structuredClone(patch.messages ?? []));
    }),
  } as any;
  const renderer = new MessageRenderer(plugin,
    new Component(), messagesEl,
    undefined, undefined, () => ProviderRegistry.getCapabilities('codex'));
  const state = new ChatState();
  const subagents = new SubagentManager(() => undefined);
  const stream = new StreamController({ plugin, state, renderer, subagentManager: subagents,
    getMessagesEl: () => messagesEl, getProviderId: () => 'codex', updateQueueIndicator: () => undefined });
  const lifecycleRegistry = new ProviderExecutionLifecycleRegistry();
  const backend = new FakeSideBackend();
  const workChanges: boolean[] = [];
  const coordinator = new ChatExecutionCoordinator({
    lifecycleRegistry, resolveBackend: () => backend,
    persistence: { persistExecutionSnapshot: async () => true, registerExecutionBinding: () => undefined, releaseExecutionBinding: () => undefined } as any,
    interactionPort: {} as any, vaultWorkingDirectory: '/vault', createId: () => 'binding',
    resolveMissingProviderSession: async () => 'not_found',
    onSessionEvent: (event, context) => enqueueTabSessionEvent(tab, plugin, event, context),
    onBackgroundWorkChanged: working => workChanges.push(working),
  });
  const session = new TabSession({ id: 'tab', conversationId: 'conversation', draftModel: null,
    providerId: 'codex', lifecycleState: 'ready' } as any, coordinator);
  const conversationController = new ConversationController({
    plugin, state, renderer, subagentManager: subagents,
    getExecutionCoordinator: () => coordinator,
    isConversationHydrated: () => true,
  } as any);
  const tab: any = { state, renderer, session, executionCoordinator: coordinator, lifecycleState: 'ready',
    dom: { contentEl: messagesEl }, services: { subagentManager: subagents },
    controllers: { streamController: stream, conversationController } };

  await coordinator.bindConversation({ conversationId: 'conversation', providerId: 'claude' });
  await coordinator.prepare();
  const tracker = new CodexSubagentTracker(
    subagent => backend.latest.emitSessionEvent({ type: 'subagent_updated', subagent }),
    async () => { throw new Error('Child read unavailable'); },
  );
  Object.assign(backend.latest, { hasBackgroundWork: () => tracker.hasBackgroundWork() });

  state.currentConversationId = 'conversation';
  const message: ChatMessage = {
    id: 'response', role: 'assistant', timestamp: testDate().getTime(), content: '', contentBlocks: [], toolCalls: [],
  };
  state.addMessage(message);
  state.currentContentEl = renderer.addMessage(message).querySelector('.claudian-message-content');
  let parentOutput = Promise.resolve();
  new CodexNotificationRouter(chunk => {
    parentOutput = parentOutput.then(() => stream.handleStreamChunk(chunk, message));
  }, '/workspace').handleNotification('rawResponseItem/completed', { threadId: 'parent', turnId: 'parent-turn', item: {
    type: 'function_call', call_id: 'spawn', name: 'spawn_agent', arguments: JSON.stringify({ task_name: 'helper', message: 'Run tests' }),
  } });
  await parentOutput;

  const child = (method: string, params: Record<string, unknown>) => {
    tracker.handleNotification('child', 'child-turn', method, { threadId: 'child', turnId: 'child-turn', ...params });
  };
  const settle = () => session.awaitBackgroundWork();
  const childTool = () => message.toolCalls![0].subagent?.toolCalls[0];
  const savedChildTool = () => saves.at(-1)?.[0].toolCalls?.[0].subagent?.toolCalls[0];
  const savedStatus = () => saves.at(-1)?.[0].toolCalls?.[0].subagent?.status;
  const dispose = async () => {
    await coordinator.dispose();
    await lifecycleRegistry.dispose();
    stream.dispose(); subagents.clear(); renderer.dispose();
  };
  return {
    messagesEl, saves, workChanges, tracker, conversationController, child, settle,
    childTool, savedChildTool, savedStatus, dispose,
  };
}

function startChild(view: Awaited<ReturnType<typeof createCodexChildTab>>): void {
  view.tracker.activity({ type: 'subAgentActivity', id: 'spawn', kind: 'started', agentThreadId: 'child', agentPath: '/root/helper' }, 'parent-turn');
  view.tracker.turnStarted('child', 'child-turn');
  view.child('item/started', { item: {
    type: 'commandExecution', id: 'command', command: 'npm test', cwd: '/workspace', status: 'inProgress',
    commandActions: [{ type: 'unknown', command: 'npm test' }], aggregatedOutput: null, exitCode: null, durationMs: null,
  } });
}

function streamOutput(view: Awaited<ReturnType<typeof createCodexChildTab>>, lines: readonly string[]): void {
  for (const delta of lines) view.child('item/commandExecution/outputDelta', { itemId: 'command', delta });
}

it('coalesces Codex child progress saves between immediate lifecycle saves and keeps live output', async () => {
  const view = await createCodexChildTab();
  try {
    // The spawn card is already running, so attaching the child and streaming its output is progress.
    startChild(view);
    const lines = Array.from({ length: 20 }, (_, index) => `line ${index}\n`);
    streamOutput(view, lines);
    await view.settle();
    // Live rendering sees every chunk while persistence waits for the progress window.
    expect(view.childTool()?.result).toBe(lines.join(''));
    expect(view.messagesEl.textContent).toContain('line 19');
    expect(view.saves).toHaveLength(0);
    expect(view.workChanges).toEqual([true]);

    await jest.advanceTimersByTimeAsync(QUIET_PERIOD_MS);
    await view.settle();
    expect(view.saves).toHaveLength(1);
    expect(view.savedStatus()).toBe('running');
    expect(view.savedChildTool()?.result).toBe(lines.join(''));

    streamOutput(view, ['tail\n']);
    view.tracker.turnCompleted('child', { id: 'child-turn', status: 'completed', error: null, items: [
      { type: 'agentMessage', id: 'answer', text: 'Ready.', phase: 'final_answer', memoryCitation: null },
    ] } as any);
    await view.settle();
    // The terminal transition persists immediately and supersedes the pending progress save.
    expect(view.saves).toHaveLength(2);
    expect(view.saves.at(-1)![0].toolCalls![0].subagent).toMatchObject({ status: 'completed', result: 'Ready.' });
    expect(view.savedChildTool()?.result).toContain('tail\n');
    expect(view.workChanges).toEqual([true, false]);
    await jest.advanceTimersByTimeAsync(QUIET_PERIOD_MS);
    await view.settle();
    expect(view.saves).toHaveLength(2);
  } finally {
    await view.dispose();
  }
});

it('flushes pending Codex child progress with the next direct save and does not save it again', async () => {
  const view = await createCodexChildTab();
  try {
    startChild(view);
    streamOutput(view, ['before close\n', 'still running\n']);
    await view.settle();
    expect(view.saves).toHaveLength(0);

    // Close, teardown, and navigation all persist through a direct save.
    await view.conversationController.save();
    expect(view.saves).toHaveLength(1);
    expect(view.savedStatus()).toBe('running');
    expect(view.savedChildTool()?.result).toBe('before close\nstill running\n');
    await jest.advanceTimersByTimeAsync(QUIET_PERIOD_MS);
    await view.settle();
    expect(view.saves).toHaveLength(1);
  } finally {
    await view.dispose();
  }
});
