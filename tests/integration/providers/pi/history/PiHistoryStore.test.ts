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
