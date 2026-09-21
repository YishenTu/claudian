/** @jest-environment jsdom */
import { fireEvent, screen } from '@testing-library/dom';
import fs from 'fs';
import { axe } from 'jest-axe';
import { tmpdir } from 'os';
import { join } from 'path';

import { NOOP_TASK_RESULT_INTERPRETER } from '@/core/providers/NoopTaskResultInterpreter';
import type { SubagentInfo } from '@/core/types';
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
