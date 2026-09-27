/** @jest-environment jsdom */
import { fireEvent, screen, within } from '@testing-library/dom';
import fs from 'fs';
import { axe } from 'jest-axe';
import { tmpdir } from 'os';
import { join } from 'path';

import { NOOP_TASK_RESULT_INTERPRETER } from '@/core/providers/NoopTaskResultInterpreter';
import type { SubagentInfo } from '@/core/types';
import { createAsyncSubagentBlock, createSubagentBlock, updateAsyncSubagentBlock, updateSubagentBlock } from '@/features/chat/rendering/SubagentRenderer';
import { SubagentManager } from '@/features/chat/services/SubagentManager';
import { ClaudeTaskResultInterpreter } from '@/providers/claude/runtime/ClaudeTaskResultInterpreter';

HTMLElement.prototype.empty = function () { this.replaceChildren(); };
HTMLElement.prototype.addClass = function (...classes) { this.classList.add(...classes); };
HTMLElement.prototype.removeClass = function (...classes) { this.classList.remove(...classes); };

afterEach(() => document.body.replaceChildren());

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

  expect(manager.finalizeSyncSubagent('sync', `${answer}\n${metadata}`, false, {
    status: 'completed', agentId: 'agent-sync',
    content: [{ type: 'text', text: answer }, { type: 'text', text: metadata }],
  })).toMatchObject({ status: 'completed', result: answer });
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
