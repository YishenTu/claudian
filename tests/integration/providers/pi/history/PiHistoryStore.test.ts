import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { testDate, testTime } from '@test/helpers/testClock';

import {
  createPiForkSessionFile,
  parsePiSessionContent,
  rollbackCreatedPiForkSessionFile,
} from '@/providers/pi/history/PiHistoryStore';

const temporaryDirectories: string[] = [];

async function createTempDirectory(prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory =>
    fs.rm(directory, { recursive: true, force: true })));
});

it('creates a self-contained Pi fork session file at the assistant checkpoint', async () => {
  const dir = await createTempDirectory('pi-fork-');
  const sourceFile = path.join(dir, 'source.jsonl');
  await fs.writeFile(sourceFile, [
    JSON.stringify({ type: 'session', version: 3, id: 'source-session', timestamp: testTime({ days: -238 }), cwd: '/source-cwd' }),
    JSON.stringify({ id: 'u1', parentId: null, type: 'message', message: { role: 'user', content: 'First' } }),
    JSON.stringify({ id: 'a1', parentId: 'u1', type: 'message', message: { role: 'assistant', content: 'Done' } }),
    JSON.stringify({ id: 'u2', parentId: 'a1', type: 'message', message: { role: 'user', content: 'Do not copy' } }),
  ].join('\n'));

  const forked = await createPiForkSessionFile(sourceFile, 'a1', {
    now: testDate({ days: -205, hours: 4, minutes: 5, seconds: 6, milliseconds: 789 }),
    sessionId: 'fork-session',
    targetCwd: '/target-cwd',
  });
  const forkedContent = await fs.readFile(forked.sessionFile, 'utf-8');
  const forkedLines = forkedContent.trim().split('\n').map(line => JSON.parse(line));

  expect(forked).toEqual({
    leafEntryId: 'a1',
    parentSession: sourceFile,
    sessionFile: path.join(dir, `${testTime({ days: -205, hours: 4, minutes: 5, seconds: 6, milliseconds: 789 }).replace(/[:.]/g, '-')}_fork-session.jsonl`),
    sessionId: 'fork-session',
  });
  expect(forkedLines).toEqual([
    {
      cwd: '/target-cwd',
      id: 'fork-session',
      parentSession: sourceFile,
      timestamp: testTime({ days: -205, hours: 4, minutes: 5, seconds: 6, milliseconds: 789 }),
      type: 'session',
      version: 3,
    },
    { id: 'u1', parentId: null, type: 'message', message: { role: 'user', content: 'First' } },
    { id: 'a1', parentId: 'u1', type: 'message', message: { role: 'assistant', content: 'Done' } },
  ]);
});

// Pending forks saved before this checkpoint rule still name the assistant entry that made the calls.
it.each(['current', 'legacy assistant'])('forks a reply that ended on tool results from its last result (%s checkpoint)', async checkpoint => {
  const dir = await createTempDirectory('pi-fork-tool-end-');
  const sourceFile = path.join(dir, 'source.jsonl');
  const records = [
    { type: 'session', version: 3, id: 'source-session', timestamp: testTime({ days: -238 }), cwd: '/source-cwd' },
    { id: 'u1', parentId: null, type: 'message', message: { role: 'user', content: 'Read both notes' } },
    { id: 'a1', parentId: 'u1', type: 'message', message: { role: 'assistant', stopReason: 'toolUse', content: [
      { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'one.md' } },
      { type: 'toolCall', id: 'c2', name: 'read', arguments: { path: 'two.md' } },
    ] } },
    // Extensions record state between a batch's results, as Peeps does for its runs.
    { id: 'k1', parentId: 'a1', type: 'custom', customType: 'peeps/run', data: {} },
    // A terminating tool batch ends the run without another assistant message.
    { id: 'r1', parentId: 'k1', type: 'message', message: { role: 'toolResult', toolCallId: 'c1', toolName: 'read', content: [{ type: 'text', text: 'one' }] } },
    { id: 'r2', parentId: 'r1', type: 'message', message: { role: 'toolResult', toolCallId: 'c2', toolName: 'read', content: [{ type: 'text', text: 'two' }] } },
  ];
  await fs.writeFile(sourceFile, records.map(record => JSON.stringify(record)).join('\n'));

  const reply = parsePiSessionContent(await fs.readFile(sourceFile, 'utf-8'))[1];
  expect(reply.assistantMessageId).toBe('r2');

  const forked = await createPiForkSessionFile(sourceFile, checkpoint === 'current' ? reply.assistantMessageId! : 'a1', { sessionId: 'fork-session' });
  const forkedContent = await fs.readFile(forked.sessionFile, 'utf-8');
  expect(forked.leafEntryId).toBe('r2');
  expect(forkedContent.trim().split('\n').map(line => JSON.parse(line).id)).toEqual(['fork-session', 'u1', 'a1', 'k1', 'r1', 'r2']);
  expect(parsePiSessionContent(forkedContent)[1].toolCalls?.map(call => [call.id, call.result])).toEqual([['c1', 'one'], ['c2', 'two']]);
});

// After pi branched at the calling entry, which results belong to the saved checkpoint is ambiguous.
it('keeps a saved assistant checkpoint whose tool results branch', async () => {
  const dir = await createTempDirectory('pi-fork-branched-results-');
  const sourceFile = path.join(dir, 'source.jsonl');
  const records = [
    { type: 'session', version: 3, id: 'source-session', timestamp: testTime({ days: -238 }), cwd: '/source-cwd' },
    { id: 'u1', parentId: null, type: 'message', message: { role: 'user', content: 'Read the note' } },
    { id: 'a1', parentId: 'u1', type: 'message', message: { role: 'assistant', stopReason: 'toolUse', content: [
      { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'one.md' } },
    ] } },
    { id: 'r1', parentId: 'a1', type: 'message', message: { role: 'toolResult', toolCallId: 'c1', toolName: 'read', content: [{ type: 'text', text: 'one' }] } },
    { id: 'r1b', parentId: 'a1', type: 'message', message: { role: 'toolResult', toolCallId: 'c1', toolName: 'read', content: [{ type: 'text', text: 'other' }] } },
  ];
  await fs.writeFile(sourceFile, records.map(record => JSON.stringify(record)).join('\n'));

  const forked = await createPiForkSessionFile(sourceFile, 'a1', { sessionId: 'fork-session' });
  expect(forked.leafEntryId).toBe('a1');
  expect((await fs.readFile(forked.sessionFile, 'utf-8')).trim().split('\n').map(line => JSON.parse(line).id))
    .toEqual(['fork-session', 'u1', 'a1']);
});

it('rolls back the created fork file and keeps the source session', async () => {
  const dir = await createTempDirectory('pi-fork-rollback-');
  const sourceFile = path.join(dir, 'source.jsonl');
  await fs.writeFile(sourceFile, [
    JSON.stringify({ id: 'source', type: 'session', version: 3 }),
    JSON.stringify({ id: 'a1', type: 'message', message: { role: 'assistant', content: 'Done' } }),
  ].join('\n'));
  const forked = await createPiForkSessionFile(sourceFile, 'a1', { sessionId: 'fork-session' });

  await rollbackCreatedPiForkSessionFile(forked);

  await expect(fs.access(sourceFile)).resolves.toBeUndefined();
  await expect(fs.access(forked.sessionFile)).rejects.toThrow();
  await fs.rm(dir, { force: true, recursive: true });
});

it('includes active id-less tool results when creating linear Pi fork files', async () => {
  const dir = await createTempDirectory('pi-fork-linear-');
  const sourceFile = path.join(dir, 'source.jsonl');
  await fs.writeFile(sourceFile, [
    JSON.stringify({ type: 'session', version: 3, id: 'source-session', timestamp: testTime({ days: -238 }), cwd: '/source-cwd' }),
    JSON.stringify({ id: 'u1', type: 'message', message: { role: 'user', content: 'Read a file' } }),
    JSON.stringify({
      id: 'a1',
      type: 'message',
      message: {
        role: 'assistant',
        content: [
          { id: 'tool-1', input: { path: 'a.md' }, name: 'read', type: 'toolCall' },
        ],
      },
    }),
    JSON.stringify({
      result: { content: [{ text: 'file contents', type: 'text' }] },
      toolCallId: 'tool-1',
      type: 'toolResult',
    }),
    JSON.stringify({ id: 'u2', type: 'message', message: { role: 'user', content: 'Do not copy' } }),
  ].join('\n'));

  const forked = await createPiForkSessionFile(sourceFile, 'a1', {
    now: testDate({ days: -205, hours: 4, minutes: 5, seconds: 6, milliseconds: 789 }),
    sessionId: 'fork-session',
  });
  const forkedContent = await fs.readFile(forked.sessionFile, 'utf-8');
  const forkedLines = forkedContent.trim().split('\n').map(line => JSON.parse(line));

  expect(forkedLines.map(line => line.id)).toEqual(['fork-session', 'u1', 'a1', undefined]);
  expect(forkedLines[3]).toMatchObject({
    toolCallId: 'tool-1',
    type: 'toolResult',
  });
  expect(parsePiSessionContent(forkedContent)[1].toolCalls).toEqual([{
    id: 'tool-1',
    input: { file_path: 'a.md', path: 'a.md' },
    name: 'Read',
    result: 'file contents',
    resultFormat: 'plain',
    status: 'completed',
  }]);
});
