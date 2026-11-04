// @test-ci {"inputs":["tests/fixtures/providers/antigravity/history/**"]}
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { ChatMessage } from '@/core/types';
import { loadAntigravityHistory } from '@/providers/antigravity/history/AntigravityHistoryStore';

const FIXTURES = path.resolve('tests/fixtures/providers/antigravity/history');
const SESSION_ID = 'session-fixture';
let storeRoot: string;

beforeEach(async () => {
  storeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'claudian-antigravity-history-'));
});

afterEach(async () => {
  await fs.rm(storeRoot, { force: true, recursive: true });
});

async function installTranscripts(...names: string[]): Promise<void> {
  const logs = path.join(storeRoot, 'brain', SESSION_ID, '.system_generated', 'logs');
  await fs.mkdir(logs, { recursive: true });
  for (const name of names) await fs.copyFile(path.join(FIXTURES, name), path.join(logs, name));
}

function summarize(messages: ChatMessage[]) {
  return messages.map(message => ({
    automatic: message.isAutomaticResponse ?? false,
    content: message.content,
    role: message.role,
    tools: (message.toolCalls ?? []).map(tool => ({
      hasDiff: Boolean(tool.diffData),
      input: tool.input,
      name: tool.name,
      result: tool.result,
      status: tool.status,
    })),
  }));
}

describe('loadAntigravityHistory', () => {
  it('rebuilds turns, tool results and background responses from the full transcript', async () => {
    await installTranscripts('transcript_full.jsonl', 'transcript.jsonl');

    const messages = await loadAntigravityHistory(storeRoot, SESSION_ID);

    expect(summarize(messages)).toEqual([
      { automatic: false, content: 'Uppercase alpha and beta in notes.md.', role: 'user', tools: [] },
      {
        automatic: false,
        content: 'Uppercased alpha; beta was not found.',
        role: 'assistant',
        tools: [
          {
            hasDiff: false,
            input: expect.objectContaining({ file_path: '/vault/notes.md' }),
            name: 'Read',
            result: 'Showing lines 1-2 of 2\n1: alpha\n2: beta',
            status: 'completed',
          },
          {
            hasDiff: true,
            input: expect.objectContaining({ file_path: '/vault/notes.md', new_string: 'ALPHA', old_string: 'alpha' }),
            name: 'Edit',
            result: 'Made 1 replacement in /vault/notes.md starting at line 1 (+1/-1 lines).',
            status: 'completed',
          },
          {
            hasDiff: false,
            input: expect.objectContaining({ new_string: 'BETA', old_string: 'beta' }),
            name: 'Edit',
            result: 'target content not found in /vault/notes.md',
            status: 'error',
          },
        ],
      },
      { automatic: false, content: 'Run the tests.', role: 'user', tools: [] },
      {
        automatic: false,
        content: 'One test fails; the sleep runs in the background.',
        role: 'assistant',
        tools: [
          {
            hasDiff: false,
            input: expect.objectContaining({ command: 'npm test', description: 'Run tests' }),
            name: 'Bash',
            result: 'exit: 1\n1 failing',
            status: 'error',
          },
          {
            hasDiff: false,
            input: expect.objectContaining({ command: 'sleep 6; echo finished' }),
            name: 'Bash',
            result: 'Tool is running as a background task with task id: session-fixture/task-10',
            status: 'running',
          },
        ],
      },
      { automatic: true, content: 'The background command finished.', role: 'assistant', tools: [] },
      { automatic: false, content: 'Run three commands in one batch.', role: 'user', tools: [] },
      {
        automatic: false,
        content: 'The write was denied.',
        role: 'assistant',
        tools: [
          { hasDiff: false, input: expect.objectContaining({ command: 'true' }), name: 'Bash', result: undefined, status: 'completed' },
          {
            hasDiff: false,
            input: expect.objectContaining({ command: 'printf DENIED > denied.txt' }),
            name: 'Bash',
            result: expect.stringContaining('user denied permission'),
            status: 'error',
          },
          // agy records no result for a call the denial aborted.
          {
            hasDiff: false,
            input: expect.objectContaining({ command: 'printf AFTER' }),
            name: 'Bash',
            result: 'Antigravity did not run this tool.',
            status: 'error',
          },
        ],
      },
      { automatic: false, content: 'Check the task, stop it, and draw a square.', role: 'user', tools: [] },
      {
        automatic: false,
        content: 'Stopped the task and drew the square.',
        role: 'assistant',
        tools: [
          {
            hasDiff: false,
            input: expect.objectContaining({ TaskId: 'session-fixture/task-10' }),
            name: 'BashOutput',
            result: expect.stringContaining('Status: RUNNING'),
            status: 'completed',
          },
          {
            hasDiff: false,
            input: expect.objectContaining({ TaskId: 'session-fixture/task-10' }),
            name: 'KillShell',
            result: 'Task "session-fixture/task-10" cancelled.',
            status: 'completed',
          },
          {
            hasDiff: false,
            input: expect.objectContaining({ prompt: 'A tiny solid blue square' }),
            name: 'GenerateImage',
            result: 'Generated image is saved at /home/user/.gemini/antigravity-cli/brain/session-fixture/blue_square_1.jpg.',
            status: 'completed',
          },
        ],
      },
      // agy's restart notice arrives right after the request; the reply still answers the user.
      { automatic: false, content: 'Are you back?', role: 'user', tools: [] },
      { automatic: false, content: 'Yes.', role: 'assistant', tools: [] },
      { automatic: false, content: 'Check tasks, resources and my notes server.', role: 'user', tools: [] },
      {
        automatic: false,
        content: 'One note matches.',
        role: 'assistant',
        tools: [
          {
            hasDiff: false,
            input: expect.objectContaining({ Action: 'list' }),
            name: 'ManageTasks',
            result: 'No background tasks are currently running.',
            status: 'completed',
          },
          {
            hasDiff: false,
            input: expect.objectContaining({ server: 'claudian_sessions' }),
            name: 'ListMcpResources',
            result: 'MCP server claudian_sessions does not have any resources',
            status: 'completed',
          },
          { hasDiff: false, input: { query: 'alpha' }, name: 'mcp__notes_server__search_notes', result: '{"hits":1}', status: 'completed' },
        ],
      },
    ]);
    expect(messages[1].contentBlocks?.map(block => block.type)).toEqual(['thinking', 'tool_use', 'tool_use', 'tool_use', 'text']);
    // "Worked for" spans the request to the turn's last step; automatic background responses carry none.
    const assistants = messages.filter(message => message.role === 'assistant');
    expect(assistants.map(message => [message.durationSeconds, message.completedAt])).toEqual([
      [6, Date.parse('2026-01-01T00:00:06Z')],
      [4, Date.parse('2026-01-01T00:01:04Z')],
      [undefined, undefined],
      [4, Date.parse('2026-01-01T00:02:04Z')],
      [13, Date.parse('2026-01-01T00:03:13Z')],
      [2, Date.parse('2026-01-01T00:04:02Z')],
      [4, Date.parse('2026-01-01T00:05:04Z')],
    ]);
    expect(messages[1].toolCalls?.[0].resultFormat).toBe('plain');
  });

  it('decodes JSON-encoded arguments when only the short transcript exists', async () => {
    await installTranscripts('transcript.jsonl');

    const messages = await loadAntigravityHistory(storeRoot, SESSION_ID);

    expect(messages[1].toolCalls?.map(tool => tool.input)).toEqual([
      expect.objectContaining({ Path: '/vault/notes.md', file_path: '/vault/notes.md' }),
    ]);
  });

  it('returns no messages for a session without a transcript', async () => {
    await expect(loadAntigravityHistory(storeRoot, 'session-unknown')).resolves.toEqual([]);
  });
});
