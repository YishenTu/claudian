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

/** Writes a full transcript of steps shaped as agy 1.5.0 records them. */
async function installSteps(steps: Record<string, unknown>[]): Promise<void> {
  const logs = path.join(storeRoot, 'brain', SESSION_ID, '.system_generated', 'logs');
  await fs.mkdir(logs, { recursive: true });
  await fs.writeFile(path.join(logs, 'transcript_full.jsonl'), steps.map(step => JSON.stringify(step)).join('\n') + '\n');
}

function userStep(index: number, request: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { content: `<USER_REQUEST>\n${request}\n</USER_REQUEST>`, created_at: '2026-01-01T00:00:00Z',
    source: 'USER_EXPLICIT', status: 'DONE', step_index: index, type: 'USER_INPUT', ...extra };
}

function replyStep(index: number, extra: Record<string, unknown>): Record<string, unknown> {
  return { created_at: '2026-01-01T00:00:01Z', source: 'MODEL', status: 'DONE', step_index: index, type: 'PLANNER_RESPONSE', ...extra };
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
            // agy keeps the launch step RUNNING after the task ends; its outcome is the later task report.
            status: 'completed',
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

  it('restores images the user uploaded from the session store', async () => {
    const uploads = path.join(storeRoot, 'brain', SESSION_ID, '.user_uploaded');
    await fs.mkdir(uploads, { recursive: true });
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    await fs.writeFile(path.join(uploads, 'uploaded_media_1.png'), png);
    const outside = path.join(storeRoot, 'outside.png');
    await fs.writeFile(outside, png);
    await installSteps([
      userStep(0, 'What color is this?', { media: [
        { mime_type: 'image/png', uri: path.join(uploads, 'uploaded_media_1.png') },
        { mime_type: 'image/png', uri: outside },
        { mime_type: 'image/png', uri: path.join(uploads, 'missing.png') },
      ] }),
      replyStep(1, { content: 'Blue.' }),
    ]);

    const messages = await loadAntigravityHistory(storeRoot, SESSION_ID);

    expect(messages[0].images).toEqual([{
      data: png.toString('base64'),
      id: `${SESSION_ID}:0:image:0`,
      mediaType: 'image/png',
      name: 'uploaded_media_1.png',
      size: png.length,
      source: 'file',
    }]);
  });

  it('marks a completed compaction with a context boundary', async () => {
    await installSteps([
      userStep(0, 'Remember ASTRA_COMPACT, reply OK.'),
      replyStep(1, { content: 'OK' }),
      userStep(2, '/compact'),
      { content: '# Resuming from a compaction\n...', created_at: '2026-01-01T00:00:03Z', source: 'SYSTEM', status: 'DONE',
        step_index: 3, type: 'CHECKPOINT' },
    ]);

    const messages = await loadAntigravityHistory(storeRoot, SESSION_ID);

    expect(messages.map(message => [message.role, message.content, message.contentBlocks])).toEqual([
      ['user', 'Remember ASTRA_COMPACT, reply OK.', undefined],
      ['assistant', 'OK', [{ content: 'OK', type: 'text' }]],
      ['user', '/compact', undefined],
      ['assistant', '', [{ type: 'context_compacted' }]],
    ]);
  });

  it('shows background task reports, not agy system notices, as task notifications', async () => {
    const report = 'Task id "s/task-2" finished with result:\nCommand exited with code 0.\n\nCommand output:\nDONE\n'
      + 'Log: file:///store/tasks/task-2.log';
    const system = (index: number, body: string) => ({ content: 'The following is a <SYSTEM_MESSAGE> not actually sent by the user.'
      + `\n\n<SYSTEM_MESSAGE>\n${body}\n</SYSTEM_MESSAGE>`, created_at: '2026-01-01T00:00:05Z', source: 'SYSTEM', status: 'DONE',
    step_index: index, type: 'SYSTEM_MESSAGE' });
    await installSteps([
      userStep(0, 'Run it in the background.'),
      replyStep(1, { content: 'LAUNCHED' }),
      system(2, `[Message] timestamp=2026-01-01T00:00:05Z sender=s/task-2 priority=MESSAGE_PRIORITY_HIGH content=${report}`),
      replyStep(3, { content: 'It finished.' }),
      userStep(4, 'Continue.'),
      system(5, '[Message] timestamp=2026-01-01T00:00:06Z sender=system priority=MESSAGE_PRIORITY_LOW content=[Notice] All your '
        + 'subagents and background tasks have been stopped'),
      replyStep(6, { content: 'Continuing.' }),
    ]);

    const messages = await loadAntigravityHistory(storeRoot, SESSION_ID);

    expect(messages.map(message => [message.role, message.isAutomaticResponse ?? false, message.contentBlocks])).toEqual([
      ['user', false, undefined],
      ['assistant', false, [{ content: 'LAUNCHED', type: 'text' }]],
      ['assistant', true, [{ content: report, type: 'task_notification' }, { content: 'It finished.', type: 'text' }]],
      ['user', false, undefined],
      ['assistant', false, [{ content: 'Continuing.', type: 'text' }]],
    ]);
  });

  it('keeps a turn whole when an earlier task report and the restart notice open it', async () => {
    const system = (index: number, body: string) => ({ content: `<SYSTEM_MESSAGE>\n${body}\n</SYSTEM_MESSAGE>`,
      created_at: '2026-01-01T00:00:00Z', source: 'SYSTEM', status: 'DONE', step_index: index, type: 'SYSTEM_MESSAGE' });
    await installSteps([
      userStep(0, 'Try again.'),
      system(1, '[Message] sender=s/task-1 priority=MESSAGE_PRIORITY_LOW content=Task id "s/task-1" was canceled'),
      system(2, '[Message] sender=system priority=MESSAGE_PRIORITY_LOW content=[Notice] All your subagents and background tasks have been stopped'),
      replyStep(3, { tool_calls: [{ args: { Action: 'list' }, name: 'manage_task' }] }),
      { content: 'No tasks.', created_at: '2026-01-01T00:00:04Z', source: 'MODEL', status: 'DONE', step_index: 4, type: 'GENERIC' },
      { ...replyStep(5, { content: 'Done.' }), created_at: '2026-01-01T00:01:03Z' },
    ]);

    const messages = await loadAntigravityHistory(storeRoot, SESSION_ID);

    expect(messages.map(message => [message.role, message.isAutomaticResponse ?? false, message.durationSeconds,
      message.contentBlocks?.map(block => block.type)])).toEqual([
      ['user', false, undefined, undefined],
      ['assistant', false, 63, ['task_notification', 'tool_use', 'text']],
    ]);
  });

  it('shows a background launch without agy\'s instructions to the model', async () => {
    const launch = 'Tool is running as a background task with task id: s/task-2\nLog output:\nstarted';
    await installSteps([
      userStep(0, 'Start it.'),
      replyStep(1, { tool_calls: [{ args: { CommandLine: 'sleep 30', IsDaemon: true }, name: 'run_command' }] }),
      { content: `Created At: 2026-01-01T00:00:02+00:00\n${launch}\n\nYOU MUST TAKE ONE OF THE FOLLOWING TWO ACTIONS: A) either `
        + 'proceed or, B) end the turn.\n DO NOTHING ELSE.\n When updating the user, always respond in the language of the user.',
      created_at: '2026-01-01T00:00:02Z', source: 'MODEL', status: 'RUNNING', step_index: 2, type: 'GENERIC' },
    ]);

    const messages = await loadAntigravityHistory(storeRoot, SESSION_ID);

    expect(messages[1].toolCalls?.[0].result).toBe(launch);
  });

  it('pairs ask_question answers with their questions', async () => {
    const args = { questions: [
      { is_multi_select: false, options: ['Red', 'Green'], question: 'Color?' },
      { is_multi_select: true, options: ['Apple', 'Cherry'], question: 'Fruit?' },
      { is_multi_select: false, options: ['Yes', 'No'], question: 'Skip me?' },
    ] };
    await installSteps([
      userStep(0, 'Ask me.'),
      replyStep(1, { tool_calls: [{ args, name: 'ask_question' }] }),
      { content: 'Created At: 2026-01-01T00:00:02+00:00\nCompleted At: 2026-01-01T00:00:03+00:00\nA1: Green, my own\nsecond line\nA2: Apple, Cherry',
        created_at: '2026-01-01T00:00:03Z', source: 'MODEL', status: 'DONE', step_index: 2, type: 'GENERIC' },
    ]);

    const messages = await loadAntigravityHistory(storeRoot, SESSION_ID);

    expect(messages[1].toolCalls?.[0].resolvedAnswers).toEqual({ 'Color?': 'Green, my own\nsecond line', 'Fruit?': 'Apple, Cherry' });
  });

  it('returns no messages for a session without a transcript', async () => {
    await expect(loadAntigravityHistory(storeRoot, 'session-unknown')).resolves.toEqual([]);
  });
});
