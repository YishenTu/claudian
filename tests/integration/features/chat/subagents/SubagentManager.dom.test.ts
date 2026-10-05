/** @jest-environment jsdom */
import '@/providers';

import { testDate, testTime } from '@test/helpers/testClock';
import { fireEvent, screen, within } from '@testing-library/dom';
import fs from 'fs';
import { axe } from 'jest-axe';
import { Component } from 'obsidian';
import { tmpdir } from 'os';
import { join } from 'path';

import { NOOP_TASK_RESULT_INTERPRETER } from '@/core/providers/NoopTaskResultInterpreter';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import type { ProviderSubagentLifecycleAdapter } from '@/core/providers/types';
import { TOOL_SUBAGENT } from '@/core/tools/toolNames';
import type { ChatMessage, SubagentInfo, ToolCallInfo } from '@/core/types';
import { MessageRenderer } from '@/features/chat/rendering/MessageRenderer';
import { ChatState } from '@/features/chat/state/ChatState';
import { SubagentManager } from '@/features/chat/subagents/SubagentManager';
import { createAsyncSubagentBlock, createSubagentBlock, updateAsyncSubagentBlock, updateSubagentBlock } from '@/features/chat/subagents/SubagentRenderer';
import { StreamController } from '@/features/chat/turns/StreamController';
import { ClaudeTaskResultInterpreter } from '@/providers/claude/runtime/ClaudeTaskResultInterpreter';
import { CodexSubagentTracker } from '@/providers/codex/execution/CodexSubagentTracker';
import { parseCodexSessionContent } from '@/providers/codex/history/CodexHistoryStore';
import { codexSubagentLifecycleAdapter } from '@/providers/codex/normalization/codexSubagentNormalization';
import type { Thread } from '@/providers/codex/runtime/codexAppServerTypes';
import { CodexNotificationRouter } from '@/providers/codex/runtime/CodexNotificationRouter';

HTMLElement.prototype.empty = function () { this.replaceChildren(); };
HTMLElement.prototype.addClass = function (...classes) { this.classList.add(...classes); };
HTMLElement.prototype.removeClass = function (...classes) { this.classList.remove(...classes); };

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach(cleanup => cleanup());
  document.body.replaceChildren();
});

function createCodexLifecycleView() {
  const parent = document.body.createDiv();
  const manager = new SubagentManager(() => {}, NOOP_TASK_RESULT_INTERPRETER);
  const tools: ToolCallInfo[] = [];
  const plugin = { app: {}, settings: { mediaFolder: '', showMessageTimestamps: false } } as any;
  const renderer = new MessageRenderer(plugin,
    new Component(), parent,
    undefined, undefined, () => ProviderRegistry.getCapabilities('codex'));
  const state = new ChatState();
  const stream = new StreamController({ plugin, state, renderer, subagentManager: manager,
    getMessagesEl: () => parent, getProviderId: () => 'codex', updateQueueIndicator: () => {} });
  const message: ChatMessage = {
    id: 'response', role: 'assistant', timestamp: testDate().getTime(), content: '', contentBlocks: [], toolCalls: tools,
  };
  state.addMessage(message);
  state.currentContentEl = renderer.addMessage(message).querySelector('.claudian-message-content');
  let pending = Promise.resolve();
  const router = new CodexNotificationRouter(chunk => {
    pending = pending.then(() => stream.handleStreamChunk(chunk, message));
  }, '/workspace');
  cleanups.push(() => { stream.dispose(); manager.clear(); renderer.dispose(); });
  return { parent, manager, tools, router, renderer, message, stream, state, flush: () => pending };
}

it.each(['native', 'raw-first', 'canonical-first'])('renders %s Codex identity, progress, and final output without losing the answer on close', async source => {
  const { parent, tools, router, flush } = createCodexLifecycleView();
  const notify = (id: string, tool: string, status: string, message: string | null) => {
    router.handleNotification('item/completed', {
      threadId: 'main', turnId: 'turn', item: {
        type: 'collabAgentToolCall', id, tool, status: 'completed', senderThreadId: 'main',
        receiverThreadIds: ['child'], prompt: tool === 'spawnAgent' ? 'Review the storage code.' : null,
        model: tool === 'spawnAgent' ? 'test-model' : null, reasoningEffort: tool === 'spawnAgent' ? 'high' : null,
        agentsStates: { child: { status, message } },
      },
    });
  };

  const rawSpawn = () => {
    router.handleNotification('rawResponseItem/completed', {
      threadId: 'main', turnId: 'turn', item: {
        type: 'function_call', call_id: 'spawn', name: 'spawn_agent',
        arguments: JSON.stringify({ message: 'Review the storage code.', agent_type: 'explorer', task_name: 'reviewer' }),
      },
    });
  };
  if (source === 'raw-first') rawSpawn();
  router.handleNotification('item/started', {
    threadId: 'main', turnId: 'turn', item: {
      type: 'collabAgentToolCall', id: 'spawn', tool: 'spawnAgent', status: 'inProgress',
      prompt: 'Review the storage code.', model: 'test-model', reasoningEffort: 'high', receiverThreadIds: [], agentsStates: {},
    },
  });
  if (source === 'canonical-first') rawSpawn();
  notify('spawn', 'spawnAgent', 'running', null);
  await flush();
  expect(tools[0].subagent).toMatchObject({ agentId: 'child', prompt: 'Review the storage code.' });
  expect(tools[0].input.agent_type).toBe(source === 'native' ? undefined : 'explorer');
  expect(tools[0].input.task_name).toBe(source === 'native' ? undefined : 'reviewer');
  const header = within(parent).getByRole('button', { name: /Subagent task:.*test-model.*high/ });
  fireEvent.click(header);
  fireEvent.click(within(parent).getByRole('button', { name: /^Prompt/ }));
  expect(within(parent).getByText('Review the storage code.')).toBeDefined();

  notify('list', 'listAgents', 'running', 'Checking storage invariants.');
  await flush();
  expect(within(parent).getByText('Checking storage invariants.')).toBeDefined();
  expect(tools[0].subagent?.result).toBeUndefined();
  expect(tools[0].subagent).not.toHaveProperty('progress');

  notify('wait', 'wait', 'completed', 'Storage invariants hold.');
  await flush();
  expect(within(parent).queryByText('Checking storage invariants.')).toBeNull();
  const result = within(parent).getByRole('button', { name: /^Result/ });
  fireEvent.click(result);
  result.focus();
  notify('close', 'closeAgent', 'shutdown', null);
  await flush();
  expect(tools[0].subagent).toMatchObject({ status: 'completed', result: 'Storage invariants hold.' });
  expect(within(parent).getByText('Storage invariants hold.')).toBeDefined();
  expect(document.activeElement).toBe(result);
  notify('followup', 'followupTask', 'running', 'Checking the follow-up.');
  await flush();
  expect(tools[0].subagent).toMatchObject({ status: 'running', result: undefined });
  expect(within(parent).getByText('Checking the follow-up.')).toBeDefined();
  notify('cancel-followup', 'closeAgent', 'shutdown', null);
  await flush();
  expect(tools[0].subagent).toMatchObject({ status: 'error', result: 'Agent shut down' });
  expect(within(parent).queryByText('Checking the follow-up.')).toBeNull();
  expect(await axe(parent)).toHaveNoViolations();
});

it.each(['native', 'raw'])('matches %s lifecycle updates to an agent with a task name and thread ID', async source => {
  const { parent, tools, router, renderer, message, flush } = createCodexLifecycleView();
  for (const item of [
    { type: 'function_call', call_id: 'spawn', name: 'spawn_agent', arguments: '{"task_name":"reviewer","message":"Review"}' },
    { type: 'function_call_output', call_id: 'spawn', output: '{"task_name":"reviewer"}' },
  ]) router.handleNotification('rawResponseItem/completed', { threadId: 'main', turnId: 'turn', item });
  router.handleNotification('item/completed', {
    threadId: 'main', turnId: 'turn', item: {
      type: 'collabAgentToolCall', id: 'spawn', tool: 'spawnAgent', status: 'completed',
      receiverThreadIds: ['child-thread'], agentsStates: { 'child-thread': { status: 'running', message: null } },
    },
  });
  await flush();
  expect(tools[0].subagent).toMatchObject({ agentId: 'child-thread', description: 'reviewer' });
  if (source === 'raw') {
    for (const item of [
      { type: 'function_call', call_id: 'wait', name: 'wait_agent', arguments: '{"targets":["reviewer"]}' },
      { type: 'function_call_output', call_id: 'wait', output: '{"status":{"reviewer":{"completed":"Review complete"}}}' },
    ]) router.handleNotification('rawResponseItem/completed', { threadId: 'main', turnId: 'turn', item });
  }
  router.handleNotification('item/completed', {
    threadId: 'main', turnId: 'turn', item: {
      type: 'collabAgentToolCall', id: 'wait', tool: 'wait', status: 'completed',
      receiverThreadIds: source === 'raw' ? [] : ['child-thread'],
      agentsStates: source === 'raw' ? {} : { 'child-thread': { status: 'completed', message: 'Review complete' } },
    },
  });
  await flush();
  expect(tools[0].subagent).toMatchObject({ status: 'completed', result: 'Review complete' });
  parent.replaceChildren();
  const retained = { ...message, contentBlocks: tools.map(tool => ({ type: 'tool_use' as const, toolId: tool.id })) };
  renderer.renderStoredMessage(retained, [retained], 0);
  expect(within(parent).queryByRole('button', { name: /^wait(?:_agent)? - click to expand$/i, hidden: true })).toBeNull();
  fireEvent.click(within(parent).getByRole('button', { name: /Subagent task: reviewer/ }));
  fireEvent.click(within(parent).getByRole('button', { name: /^Result/ }));
  expect(within(parent).getByText('Review complete')).toBeDefined();
});

it.each(['live', 'history'] as const)('keeps raw Codex identity and completion details in %s cards', async mode => {
  const { parent, manager, tools, router, flush } = createCodexLifecycleView();
  const calls = [
    { id: 'spawn', name: 'spawn_agent', input: { message: 'Review storage.', model: 'test-model-with-a-long-name', reasoning_effort: 'high', agent_type: 'explorer' },
      output: { agent_id: 'child', nickname: 'Ada' } },
    { id: 'wait', name: 'wait', input: { ids: ['child'] }, output: { status: { child: { completed: 'Storage is correct.' } } } },
    { id: 'close', name: 'close_agent', input: { id: 'child' }, output: { previous_status: { completed: 'Storage is correct.' } } },
  ];
  const payloads = calls.flatMap(call => [
    { type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.input) },
    { type: 'function_call_output', call_id: call.id, output: JSON.stringify(call.output) },
  ]);
  if (mode === 'live') {
    for (const item of payloads) {
      router.handleNotification('rawResponseItem/completed', { threadId: 'main', turnId: 'turn', item });
      if (item.type === 'function_call_output') {
        // Canonical snapshots must not replace richer raw output (including the nickname).
        router.handleNotification('item/completed', {
          threadId: 'main', turnId: 'turn', item: {
            type: 'collabAgentToolCall', id: item.call_id,
            tool: item.call_id === 'spawn' ? 'spawnAgent' : item.call_id === 'close' ? 'closeAgent' : 'wait',
            status: 'completed', receiverThreadIds: ['child'],
            agentsStates: { child: { status: item.call_id === 'spawn' ? 'running' : item.call_id === 'close' ? 'shutdown' : 'completed', message: null } },
          },
        });
      }
    }
    await flush();
  } else {
    const messages = parseCodexSessionContent(payloads.map((payload, index) => JSON.stringify({
      type: 'response_item', timestamp: testTime({ seconds: index }), payload,
    })).join('\n'));
    tools.push(...messages.flatMap(message => message.toolCalls ?? []));
    manager.updateLifecycleSpawn(tools[0], tools, codexSubagentLifecycleAdapter, parent);
  }
  expect(tools[0].subagent).toMatchObject({
    agentId: 'child', description: 'Ada (explorer, test-model-with-a-long-name, high)', prompt: 'Review storage.',
    result: 'Storage is correct.', status: 'completed',
  });
  const header = within(parent).getByRole('button', { name: /Subagent task: Ada.*test-model-with-a-long-name, high/ });
  expect(header.title).toBe('Ada (explorer, test-model-with-a-long-name, high)');
  fireEvent.click(header);
  fireEvent.click(within(parent).getByRole('button', { name: /^Result/ }));
  expect(within(parent).getByText('Storage is correct.')).toBeDefined();
});

it.each(['raw-output', 'item-result', 'text-output'])(
  'combines %s acknowledgements with native follow-up state', async source => {
    const { parent, tools, router, flush } = createCodexLifecycleView();
    const complete = (id: string, tool: string, status: string, message: string | null, result?: unknown) => {
      router.handleNotification('item/completed', {
        threadId: 'main', turnId: 'turn', item: {
          type: 'collabAgentToolCall', id, tool, status: 'completed',
          receiverThreadIds: ['child'], agentsStates: { child: { status, message } }, result,
        },
      });
    };
    complete('spawn', 'spawnAgent', 'running', null);
    complete('wait', 'wait', 'completed', 'First answer');
    await flush();
    expect(tools[0].subagent).toMatchObject({ status: 'completed', result: 'First answer' });

    const acknowledgement = source === 'text-output' ? 'Queued follow-up' : { submission_id: 'submission' };
    if (source !== 'item-result') {
      for (const item of [
        { type: 'function_call', call_id: 'followup', name: 'send_input', arguments: '{"id":"child","message":"Check again"}' },
        { type: 'function_call_output', call_id: 'followup', output: typeof acknowledgement === 'string' ? acknowledgement : JSON.stringify(acknowledgement) },
      ]) router.handleNotification('rawResponseItem/completed', { threadId: 'main', turnId: 'turn', item });
    }
    complete('followup', 'sendInput', 'running', 'Checking the follow-up', source === 'item-result' ? acknowledgement : undefined);
    await flush();
    expect(tools[0].subagent).toMatchObject({ status: 'running', result: undefined });
    expect(within(parent).queryByText('First answer')).toBeNull();
    expect(within(parent).getByText('Checking the follow-up')).toBeDefined();
    expect(tools.find(tool => tool.id === 'followup')?.result).toContain(source === 'text-output' ? 'Queued follow-up' : 'submission');
    complete('wait-again', 'wait', 'completed', 'Second answer');
    await flush();
    expect(tools[0].subagent).toMatchObject({ status: 'completed', result: 'Second answer' });
    expect(within(parent).queryByText('Checking the follow-up')).toBeNull();
  },
);

it('honors provider lifecycle state and ignores late progress after completion', () => {
  const parent = document.body.createDiv();
  const manager = new SubagentManager(() => {}, NOOP_TASK_RESULT_INTERPRETER);
  const spawn: ToolCallInfo = { id: 'spawn', name: 'launch', input: {}, status: 'completed' };
  const close: ToolCallInfo = { id: 'close', name: 'close', input: { target: 'alias' }, status: 'running' };
  const tools = [spawn, close];
  const adapter: ProviderSubagentLifecycleAdapter = {
    protocol: 'lifecycle', isHiddenTool: () => true,
    isToolCallFullyOwned: (tool, identities) => identities.has(String(tool.input.target)),
    isSpawnTool: name => name === 'launch', isWaitTool: () => false, isCloseTool: name => name === 'close',
    resolveSpawnToolIds: (tool, identities) => {
      const id = identities.get(String(tool.input.target));
      return id ? [id] : [];
    },
    extractSpawnResult: () => ({ agentId: 'child', aliases: ['alias'] }),
    extractWaitResult: () => ({ statuses: {}, timedOut: false }),
    buildSubagentInfo: () => ({
      id: 'spawn', description: 'Provider task', agentId: 'child', isExpanded: false, toolCalls: [],
      status: close.status === 'completed' ? 'completed' : 'running',
      result: close.status === 'completed' ? 'Provider answer' : undefined,
    }),
    getProgress: () => ({ toolCallId: 'spawn', summary: 'Provider activity' }),
  };
  manager.updateLifecycleSpawn(spawn, tools, adapter, parent);
  expect(within(parent).getByText('Provider activity')).toBeDefined();
  manager.handleLifecycleResult(close, 'Closed', false, tools, adapter);
  manager.applyProgress({ toolCallId: 'spawn', summary: 'Late activity' });
  expect(within(parent).queryByText('Provider activity')).toBeNull();
  expect(within(parent).queryByText('Late activity')).toBeNull();
  expect(spawn.subagent).toMatchObject({ status: 'completed', result: 'Provider answer' });
});

it('normalizes a completed synchronous answer containing not-ready prose', () => {
  const manager = new SubagentManager(() => {}, new ClaudeTaskResultInterpreter());
  const parent = document.createElement('div');
  document.body.append(parent);
  manager.handleTaskToolUse('sync', { run_in_background: false, description: 'Deployment check' }, parent);
  manager.addSyncToolCall('sync', { id: 'read', name: 'Read', input: { file_path: 'note.md' }, status: 'running' });
  manager.addSyncToolCall('sync', { id: 'read', name: 'Read', input: { limit: 10 }, status: 'running' });
  manager.updateSyncToolResult('sync', 'read', {
    ...manager.getSyncSubagent('sync')!.info.toolCalls[0], status: 'completed', result: 'The note.',
  });
  expect(manager.getSyncSubagent('sync')?.info.toolCalls).toEqual([
    expect.objectContaining({ input: { file_path: 'note.md', limit: 10 }, status: 'completed', result: 'The note.' }),
  ]);
  expect(parent.querySelectorAll('.claudian-subagent-tool-item')).toHaveLength(1);
  const answer = 'Deployment is not ready.';
  const metadata = 'agentId: agent-sync\n<usage>total_tokens: 500</usage>';

  expect(manager.finalizeSyncSubagent('sync', `${answer}\n${metadata}`, false, { rawOutput: {
    status: 'completed', agentId: 'agent-sync',
    content: [{ type: 'text', text: answer }],
  } })).toMatchObject({ status: 'completed', result: answer });
  fireEvent.click(screen.getByRole('button', { name: /Subagent task: Deployment check - Status: completed/ }));
  fireEvent.click(screen.getByRole('button', { name: /^Result/ }));
  expect(screen.getByText(answer)).toBeDefined();
});

it.each(['unrelated', 'running'] as const)('defers output-file recovery for %s results until an owned task completes', (state) => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'claudian-managed-output-'));
  const outputPath = join(directory, 'task.output');
  fs.writeFileSync(outputPath, JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'Recovered task answer' }] } }));
  const read = jest.spyOn(fs, 'readFileSync');
  const manager = new SubagentManager(() => {}, new ClaudeTaskResultInterpreter());
  const parent = document.createElement('div');
  document.body.append(parent);
  const launch = () => {
    manager.handleTaskToolUse('spawn', { run_in_background: true, description: 'Recovery job' }, parent);
    manager.handleTaskToolResult('spawn', 'agent_id: native-job');
    manager.handleAgentOutputToolUse({ id: 'output', name: 'TaskOutput', input: { task_id: 'native-job' }, status: 'running' });
  };
  const output = `<output>[Truncated. Full output: ${outputPath}]</output>`;

  try {
    if (state === 'running') launch();
    const result = manager.handleAgentOutputToolResult('output', `<status>${state}</status>${output}`, false);
    expect(result?.asyncStatus).toBe(state === 'running' ? 'running' : undefined);
    expect(read.mock.calls.some(([path]) => path === outputPath)).toBe(false);

    if (state === 'unrelated') launch();
    manager.handleAgentOutputToolUse({ id: 'completed-output', name: 'TaskOutput', input: { task_id: 'native-job' }, status: 'running' });
    expect(manager.handleAgentOutputToolResult('completed-output', output, false))
      .toMatchObject({ asyncStatus: 'completed', result: 'Recovered task answer' });
    fireEvent.click(screen.getByRole('button', { name: /Background task: Recovery job - Completed/ }));
    expect(screen.getByText('Recovered task answer')).toBeDefined();
  } finally {
    read.mockRestore();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it('renders and settles a managed task using provider-normalized mode, identity, and output', async () => {
  const interpreter = {
    ...NOOP_TASK_RESULT_INTERPRETER,
    describeTask: () => ({ mode: 'async' as const, description: 'Provider job', prompt: 'Find details' }),
    interpretLaunch: () => ({ mode: 'async' as const, agentId: 'native-job', result: 'Started' }),
    getOutputTaskId: () => 'native-job',
    interpretResult: () => ({ status: 'completed' as const, result: 'Provider answer' }),
  };
  const updates: SubagentInfo[] = [];
  const manager = new SubagentManager(info => updates.push({ ...info }), interpreter);
  const parent = document.createElement('div');
  document.body.append(parent);

  expect(manager.handleTaskToolUse('spawn', { opaqueLaunch: true }, parent).action).toBe('created_async');
  manager.handleTaskToolResult('spawn', { opaqueResult: true });
  manager.handleAgentOutputToolUse({ id: 'output', name: 'ProviderOutput', input: { opaqueIdentity: true }, status: 'running' });
  manager.handleAgentOutputToolResult('output', { opaqueOutput: true }, false);

  expect(updates.at(-1)).toMatchObject({ id: 'spawn', agentId: 'native-job', description: 'Provider job', result: 'Provider answer', asyncStatus: 'completed' });
  fireEvent.click(screen.getByRole('button', { name: /Background task: Provider job - Completed/ }));
  expect(screen.getByText('Provider answer')).toBeDefined();
  expect(await axe(parent)).toHaveNoViolations();
});


it.each(['sync', 'async'] as const)('renders %s snapshots without changing their model or expansion state', async mode => {
  const initial: SubagentInfo = {
    id: 'snapshot', description: 'Snapshot task', mode, status: 'running', asyncStatus: 'running',
    isExpanded: false, toolCalls: [{ id: 'read', name: 'Read', input: {}, status: 'running', isExpanded: false }],
  };
  Object.freeze(initial.toolCalls[0]);
  Object.freeze(initial.toolCalls);
  Object.freeze(initial);
  const parent = document.body.createDiv();
  const view = mode === 'sync' ? createSubagentBlock(parent, initial) : createAsyncSubagentBlock(parent, initial);
  fireEvent.click(within(parent).getByRole('button', { name: /Snapshot task/ }));
  fireEvent.click(within(parent).getByRole('button', { name: /^Read/ }));
  const completed = Object.freeze({ ...initial, status: 'completed' as const, asyncStatus: 'completed' as const, result: 'Snapshot result' });
  if ('statusTextEl' in view) updateAsyncSubagentBlock(view as ReturnType<typeof createAsyncSubagentBlock>, completed);
  else updateSubagentBlock(view, completed);
  expect(within(parent).getByText('Snapshot result')).toBeDefined();
  expect(initial.status).toBe('running');
  expect(initial.isExpanded).toBe(false);
  expect(initial.toolCalls[0].isExpanded).toBe(false);
  expect(completed.isExpanded).toBe(false);
  expect(await axe(parent)).toHaveNoViolations();
});

it('preserves focus in a completed child result when a sibling tool updates', () => {
  const manager = new SubagentManager(() => {}, new ClaudeTaskResultInterpreter());
  const parent = document.body.createDiv();
  manager.handleTaskToolUse('sync', { run_in_background: false, description: 'Search task' }, parent);
  manager.addSyncToolCall('sync', { id: 'search', name: 'WebSearch', input: { query: 'Docs' }, status: 'completed',
    result: 'Links: [{"title":"Docs","url":"https://example.com"}]' });
  fireEvent.click(within(parent).getByRole('button', { name: /Subagent task: Search task/ }));
  fireEvent.click(within(parent).getByRole('button', { name: /^WebSearch/ }));
  const link = within(parent).getByRole('link', { name: 'Docs' });
  link.focus();
  manager.addSyncToolCall('sync', { id: 'read', name: 'Read', input: { file_path: 'note.md' }, status: 'running' });
  expect(document.activeElement).toBe(link);
  expect(within(parent).getByRole('link', { name: 'Docs' })).toBe(link);
});

it('preserves async prompt expansion and focus on repeated tool snapshots', () => {
  const parent = document.body.createDiv();
  const manager = new SubagentManager(() => {}, new ClaudeTaskResultInterpreter());
  const input = {run_in_background: true, description: 'Research', prompt: 'Find details'};
  try {
    manager.handleTaskToolUse('async', input, parent);
    fireEvent.click(within(parent).getByRole('button', {name: /Background task: Research/}));
    const prompt = within(parent).getByRole('button', {name: /^Prompt/});
    fireEvent.click(prompt); prompt.focus();
    expect(prompt.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(prompt);
    manager.handleTaskToolUse('async', input, parent);
    const updated = within(parent).getByRole('button', {name: /^Prompt/});
    expect(updated).toBe(prompt);
    expect(document.activeElement).toBe(prompt);
    expect(updated.getAttribute('aria-expanded')).toBe('true');
  } finally { manager.clear(); }
});


it.each(['before spawn', 'after spawn', 'native only'])('keeps the native Codex card updated with session events %s, parent settlement, and a follow-up', async timing => {
  const view = createCodexLifecycleView();
  let tracker = new CodexSubagentTracker(info => view.stream.subagents.handleSubagentUpdate(info), async () => {
    throw new Error('Child read unavailable');
  });
  const started = { type: 'subAgentActivity' as const, id: 'spawn', kind: 'started' as const,
    agentThreadId: 'child', agentPath: '/root/helper' };
  if (timing === 'before spawn') tracker.activity(started, 'parent-turn');
  view.router.handleNotification('rawResponseItem/completed', { threadId: 'parent', turnId: 'parent-turn', item: {
    type: 'function_call', call_id: 'spawn', name: 'spawn_agent',
    arguments: JSON.stringify({ task_name: 'helper', message: 'gAAAAAEncryptedPrompt==' }),
  } });
  await view.flush();
  if (timing !== 'before spawn') tracker.activity(started, 'parent-turn');
  view.router.handleNotification('item/completed', { threadId: 'parent', turnId: 'parent-turn', item: started });
  await view.flush();
  expect(view.parent.querySelectorAll('.claudian-subagent-list')).toHaveLength(1);
  expect(view.parent.textContent).not.toContain('gAAAAA');
  expect(within(view.parent).queryByRole('button', { name: /^Prompt/ })).toBeNull();
  expect(view.parent.textContent).not.toContain('No prompt provided');
  expect(view.tools).toHaveLength(1);
  view.stream.resetStreamingState();
  view.renderer.renderMessages(view.state.messages, () => 'Hello');
  tracker.turnStarted('child', 'child-turn');
  for (const item of [
    { type: 'custom_tool_call', call_id: 'clock-call', name: 'exec', input: 'const t = await tools.clock__curr_time({}); text(t.current_time);' },
    { type: 'custom_tool_call_output', call_id: 'clock-call', output: [{ type: 'input_text', text: 'Clock result' }] },
  ]) tracker.handleNotification('child', 'child-turn', 'rawResponseItem/completed', { threadId: 'child', turnId: 'child-turn', item });
  tracker.turnCompleted('child', { id: 'child-turn', status: 'completed', error: null, items: [
    { type: 'agentMessage', id: 'answer', text: 'Ready.', phase: 'final_answer', memoryCitation: null },
  ] });
  expect(view.tools[0].subagent).toMatchObject({ status: 'completed', result: 'Ready.' });
  expect(view.parent.textContent).toContain('Ready.');
  expect(view.parent.querySelectorAll('.claudian-subagent-tool-item')).toHaveLength(1);
  expect(view.parent.textContent).toContain('clock__curr_time');
  expect(view.parent.textContent).toContain('Clock result');
  // A reopened conversation already has raw-only child tools from history.
  tracker = new CodexSubagentTracker(info => view.stream.subagents.handleSubagentUpdate(info), async () => ({
    id: 'child', turns: [{ id: 'child-turn', status: 'completed', error: null, items: [
      { type: 'agentMessage', id: 'answer', phase: 'final_answer', text: 'Ready.', memoryCitation: null },
    ] }],
  } as Thread));
  tracker.seed({ id: 'parent', turns: [{ id: 'parent-turn', status: 'completed', error: null,
    items: [started, { ...started, id: 'completed', kind: 'completed' }],
  }] } as Thread);
  tracker.activity({ ...started, id: 'idle-message', kind: 'interacted' }, 'later-parent-turn');
  await Promise.resolve();
  expect(view.parent.querySelectorAll('.claudian-subagent-tool-item')).toHaveLength(1);
  expect(view.parent.textContent).toContain('Ready.');
  const laterMessage: ChatMessage = { id: 'later', role: 'assistant', content: '', timestamp: testDate().getTime(), toolCalls: [] };
  view.state.addMessage(laterMessage);
  view.state.currentContentEl = view.renderer.addMessage(laterMessage).querySelector('.claudian-message-content');
  const followup = { type: 'tool_use' as const, id: 'followup', name: 'followup_task', input: { target: 'helper', message: 'Run bash date' } };
  let followupWork = Promise.resolve();
  const followupRouter = new CodexNotificationRouter(chunk => {
    followupWork = followupWork.then(() => view.stream.handleStreamChunk(chunk, laterMessage));
  }, '/workspace');
  const emitFollowupRaw = () => {
    followupRouter.handleNotification('rawResponseItem/completed', { threadId: 'parent', turnId: 'later-parent-turn', item: {
      type: 'function_call', call_id: followup.id, name: followup.name, arguments: JSON.stringify(followup.input),
    } });
    return followupWork;
  };
  if (timing === 'after spawn') await emitFollowupRaw();
  const interaction = { ...started, id: 'followup', kind: 'interacted' as const };
  tracker.activity(interaction, 'later-parent-turn');
  followupRouter.handleNotification('item/completed', { threadId: 'parent', turnId: 'later-parent-turn', item: interaction });
  await followupWork;
  tracker.turnStarted('child', 'child-turn-2');
  if (timing === 'before spawn') await emitFollowupRaw();
  expect(view.tools[0].subagent).toMatchObject({ status: 'completed', result: 'Ready.' });
  expect(laterMessage.toolCalls![0].subagent).toMatchObject({ id: 'followup', status: 'running', toolCalls: [] });
  followupRouter.handleNotification('item/started', { threadId: 'parent', turnId: 'later-parent-turn', item: {
    type: 'collabAgentToolCall', id: 'native-wait', tool: 'wait', status: 'inProgress', senderThreadId: 'parent',
    receiverThreadIds: [], agentsStates: {},
  } });
  await followupWork;
  await view.stream.handleStreamChunk({ type: 'done' }, laterMessage);
  expect(view.state.currentContentEl!.querySelector('[data-tool-id="native-wait"]')).toBeNull();
  const liveHistory = within(view.state.currentContentEl!).getByRole('button', { name: 'Previous runs (1)' });
  liveHistory.focus();
  const dateItems = timing === 'native only' ? [
    { type: 'commandExecution', id: 'date-call', command: "bash -lc 'date'", cwd: '/workspace',
      commandActions: [{ type: 'unknown', command: "bash -lc 'date'" }], status: 'completed',
      aggregatedOutput: 'Date result', exitCode: 0, durationMs: 1 },
  ] : [
    { type: 'custom_tool_call', call_id: 'date-call', name: 'exec', input: "text(await tools.exec_command({cmd: \"bash -lc 'date'\"}));" },
    { type: 'custom_tool_call_output', call_id: 'date-call', output: [{ type: 'input_text', text: 'Date result' }] },
  ];
  for (const item of dateItems) tracker.handleNotification('child', 'child-turn-2',
    item.type === 'commandExecution' ? 'item/completed' : 'rawResponseItem/completed',
    { threadId: 'child', turnId: 'child-turn-2', item });
  expect(view.state.currentContentEl!.textContent).toContain('Date result');
  tracker.turnCompleted('child', { id: 'child-turn-2', status: 'completed', error: null, items: [
    { type: 'agentMessage', id: 'answer-2', text: 'Two.', phase: 'final_answer', memoryCitation: null },
  ] });
  expect(document.activeElement).toBe(liveHistory);
  await view.stream.handleStreamChunk({ type: 'tool_result', id: 'followup', content: '' }, laterMessage);
  await view.stream.handleStreamChunk({ type: 'tool_use', id: 'wait', name: 'wait_agent', input: { targets: ['helper'] } }, laterMessage);
  await view.stream.handleStreamChunk({ type: 'tool_result', id: 'wait', content: 'aborted by user', isError: true }, laterMessage);
  const finalMessage: ChatMessage = { id: 'final-run', role: 'assistant', content: '', timestamp: testDate().getTime(), toolCalls: [] };
  view.state.addMessage(finalMessage);
  view.state.currentContentEl = view.renderer.addMessage(finalMessage).querySelector('.claudian-message-content');
  await view.stream.handleStreamChunk({ type: 'tool_use', id: 'followup-2', name: 'followup_task', input: { target: 'helper', message: 'One more run' } }, finalMessage);
  tracker.activity({ ...started, id: 'followup-2', kind: 'interacted' }, 'final-parent-turn');
  tracker.turnStarted('child', 'child-turn-3');
  tracker.turnCompleted('child', { id: 'child-turn-3', status: 'completed', error: null, items: [
    { type: 'agentMessage', id: 'answer-3', text: 'Three.', phase: 'final_answer', memoryCitation: null },
  ] });
  const savedMessages = JSON.stringify(view.state.messages);
  for (const reload of [false, true]) {
    if (reload) view.renderer.renderMessages(view.state.messages, () => 'Hello');
    const original = view.parent.querySelector('[data-message-id="response"]')! as HTMLElement;
    const later = view.parent.querySelector('[data-message-id="later"]')! as HTMLElement;
    expect(original.querySelectorAll('.claudian-subagent-list')).toHaveLength(1);
    expect(original.textContent).toContain('Ready.');
    expect(original.textContent).toContain('Clock result');
    expect(original.textContent).not.toContain('Date result');
    expect(later.querySelectorAll('.claudian-subagent-list')).toHaveLength(1);
    expect(later.textContent).toContain('Two.');
    expect(later.textContent).toContain('Date result');
    expect(later.textContent).not.toContain('Clock result');
    expect(view.parent.textContent).not.toContain('aborted by user');
    expect(within(original).queryByRole('button', { name: /^Previous runs/ })).toBeNull();
    const history = within(later).getByRole('button', { name: 'Previous runs (1)' });
    expect(history.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(history);
    const run = within(later).getByRole('button', { name: 'Run 1 · Completed' });
    expect(run.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(run);
    const runBody = document.getElementById(run.getAttribute('aria-controls')!)!;
    expect(within(runBody).getByRole('button', { name: /^Result/ }).getAttribute('aria-expanded')).toBe('true');
    expect(later.textContent).toContain('Clock result');
    expect(later.textContent).toContain('Ready.');
    expect(later.textContent).not.toContain('Three.');
    expect(later.querySelectorAll('[data-subagent-id="spawn"]')).toHaveLength(0);
    expect(within(later).queryByRole('button', { name: 'Go to original turn' })).toBeNull();
    const final = view.parent.querySelector('[data-message-id="final-run"]')! as HTMLElement;
    fireEvent.click(within(final).getByRole('button', { name: 'Previous runs (2)' }));
    expect(within(final).getAllByRole('button', { name: /^Run \d/ }).map(button => button.textContent))
      .toEqual(['Run 1 · Completed', 'Run 2 · Completed']);
    fireEvent.click(within(final).getByRole('button', { name: 'Run 2 · Completed' }));
    expect(final.textContent!.includes('Run bash date')).toBe(timing !== 'native only');
    expect(final.textContent).toContain('Date result');
    expect(final.textContent).toContain('Two.');
    expect(final.textContent).not.toContain('Clock result');
    expect(JSON.stringify(view.state.messages)).toBe(savedMessages);
    expect(await axe(view.parent)).toHaveNoViolations();
  }
});


it('shows previous runs after completed-turn regrouping without navigation or other agents', async () => {
  const view = createCodexLifecycleView();
  const tool = (id: string, agentId: string): ToolCallInfo => ({
    id, name: 'spawn_agent', input: {}, status: 'completed',
    subagent: { id, agentId, lifecycleSource: 'session', description: 'Helper', status: 'completed',
      prompt: `${id} prompt`, result: `${id} result`, isExpanded: false, toolCalls: [] },
  });
  const messages: ChatMessage[] = [
    { id: 'intro', role: 'assistant', content: 'Starting', timestamp: testDate().getTime() },
    { id: 'original', role: 'assistant', content: 'First answer', timestamp: testDate().getTime(), durationSeconds: 1,
      responseContinuationOf: 'intro', toolCalls: [tool('other', 'other-child'), tool('first', 'child')],
      contentBlocks: [{ type: 'tool_use', toolId: 'other' }, { type: 'tool_use', toolId: 'first' }, { type: 'text', content: 'First answer' }] },
    { id: 'request', role: 'user', content: 'Continue', timestamp: testDate().getTime() },
    { id: 'next', role: 'assistant', content: 'Next answer', timestamp: testDate().getTime(), durationSeconds: 2,
      toolCalls: [tool('second', 'child')], contentBlocks: [{ type: 'tool_use', toolId: 'second' }, { type: 'text', content: 'Next answer' }] },
  ];
  view.renderer.renderMessages(messages, () => 'Hello');
  const previousWork = within(view.parent).getByRole('button', { name: 'Worked for 00:01' });
  expect(previousWork.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(within(view.parent).getByRole('button', { name: 'Worked for 00:02' }));
  fireEvent.click(within(view.parent).getByRole('button', { name: 'Previous runs (1)' }));
  fireEvent.click(within(view.parent).getByRole('button', { name: 'Run 1 · Completed' }));
  const history = view.parent.querySelector<HTMLElement>('.claudian-subagent-history')!;
  expect(history.textContent).toContain('first prompt');
  expect(history.textContent).toContain('first result');
  expect(history.textContent).not.toContain('other result');
  expect(within(history).queryByRole('button', { name: 'Go to original turn' })).toBeNull();
  expect(previousWork.getAttribute('aria-expanded')).toBe('false');
  expect(await axe(view.parent)).toHaveNoViolations();
});


it.each([undefined, '', '   '])('hides an unavailable prompt (%s) and reveals a later readable prompt', prompt => {
  const parent = document.body.createDiv();
  const info: SubagentInfo = { id: 'empty-prompt', description: 'Helper', prompt, status: 'running', isExpanded: true, toolCalls: [] };
  const state = createSubagentBlock(parent, info);
  fireEvent.click(within(parent).getByRole('button', { name: /Subagent task: Helper/ }));
  expect(within(parent).queryByRole('button', { name: /^Prompt/ })).toBeNull();
  updateSubagentBlock(state, { ...info, prompt: 'Read this file.' });
  expect(within(parent).getByRole('button', { name: /^Prompt/ })).toBeTruthy();
  expect(parent.textContent).toContain('Read this file.');
  updateSubagentBlock(state, { ...info, prompt: undefined });
  expect(within(parent).queryByRole('button', { name: /^Prompt/ })).toBeNull();
});

function createOpencodeView() {
  const parent = document.body.createDiv();
  const manager = new SubagentManager(() => {}, ProviderRegistry.getTaskResultInterpreter('opencode'));
  const plugin = { app: {}, settings: { mediaFolder: '', showMessageTimestamps: false } } as any;
  const renderer = new MessageRenderer(plugin,
    new Component(), parent,
    undefined, undefined, () => ProviderRegistry.getCapabilities('opencode'));
  const state = new ChatState();
  const stream = new StreamController({ plugin, state, renderer, subagentManager: manager,
    getMessagesEl: () => parent, getProviderId: () => 'opencode', updateQueueIndicator: () => {} });
  const addMessage = (id: string): ChatMessage => {
    const message: ChatMessage = { id, role: 'assistant', timestamp: testDate().getTime(), content: '', contentBlocks: [], toolCalls: [] };
    state.addMessage(message);
    state.currentContentEl = renderer.addMessage(message).querySelector('.claudian-message-content');
    return message;
  };
  cleanups.push(() => { stream.dispose(); manager.clear(); renderer.dispose(); });
  return { parent, renderer, state, stream, addMessage };
}

it('shows previous runs of reused OpenCode subagents live and after reload', async () => {
  const view = createOpencodeView();
  const runs = [
    { message: 'first', sync: 'Answer A', background: 'Survey A' },
    { message: 'second', sync: 'Answer B', background: 'Survey B' },
  ];
  for (const [index, run] of runs.entries()) {
    const message = view.addMessage(run.message);
    await view.stream.handleStreamChunk({ type: 'tool_use', id: `sync-${index}`, name: TOOL_SUBAGENT, input: { description: 'Worker', prompt: `Task ${index}` } }, message);
    await view.stream.handleStreamChunk({ type: 'tool_result', id: `sync-${index}`, content: `<subagent sessionID="ses_worker" state="completed">\n${run.sync}\n</subagent>` }, message);
    await view.stream.handleStreamChunk({ type: 'tool_use', id: `bg-${index}`, name: TOOL_SUBAGENT, input: { description: 'Surveyor', prompt: `Survey ${index}`, run_in_background: true } }, message);
    await view.stream.handleStreamChunk({ type: 'tool_result', id: `bg-${index}`, content: 'The subagent is working in the background (sessionID: ses_background)' }, message);
    await view.stream.handleStreamChunk({ type: 'done' }, message);
  }
  for (const reload of [false, true]) {
    if (reload) view.renderer.renderMessages(view.state.messages, () => 'Hello');
    const first = view.parent.querySelector<HTMLElement>('[data-message-id="first"]')!;
    const second = view.parent.querySelector<HTMLElement>('[data-message-id="second"]')!;
    expect(within(first).queryByRole('button', { name: /^Previous runs/ })).toBeNull();
    const [syncHistory, backgroundHistory] = within(second).getAllByRole('button', { name: 'Previous runs (1)' });
    fireEvent.click(syncHistory);
    fireEvent.click(backgroundHistory);
    const [syncRun, backgroundRun] = within(second).getAllByRole('button', { name: /^Run 1 · / });
    fireEvent.click(syncRun);
    fireEvent.click(backgroundRun);
    const histories = second.querySelectorAll<HTMLElement>('.claudian-subagent-history');
    expect(histories[0].textContent).toContain('Answer A');
    expect(histories[0].textContent).not.toContain('Answer B');
    expect(histories[1].textContent).toContain('Survey 0');
    expect(histories[1].textContent).not.toContain('Answer A');
    expect(await axe(view.parent)).toHaveNoViolations();
  }
});
