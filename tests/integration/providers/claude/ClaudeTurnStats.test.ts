import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { loadSDKSessionMessages } from '@/providers/claude/history/ClaudeHistoryStore';
import { loadClaudeTurnStats } from '@/providers/claude/history/ClaudeTurnStats';
import type { SDKNativeMessage } from '@/providers/claude/history/sdkHistoryTypes';

it('matches replay across tool-result ancestry and reads a bounded suffix of a long session', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-turn-'));
  const directory = path.join(home, 'projects', '-vault');
  await fs.mkdir(directory, { recursive: true });
  const filePath = path.join(directory, 'session.jsonl');
  const records: SDKNativeMessage[] = [
    { type: 'user', uuid: 'old-u', timestamp: '2026-09-19T11:00:00Z', message: { content: 'Old' } },
    { type: 'assistant', uuid: 'old-a', parentUuid: 'old-u', timestamp: '2026-09-19T11:00:01Z', message: { content: 'Old text'.repeat(100000) } },
    { type: 'user', uuid: 'u', parentUuid: 'old-a', timestamp: '2026-09-20T11:00:00Z', message: { content: 'Work' } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u', timestamp: '2026-09-20T11:00:01Z',
      message: { id: 'r1', stop_reason: 'tool_use', usage: { output_tokens: 100 }, content: [{ type: 'text', text: 'Inspect' }] } },
    { type: 'assistant', uuid: 'a2', parentUuid: 'a1', timestamp: '2026-09-20T11:00:01Z',
      message: { id: 'r1', stop_reason: 'tool_use', usage: { output_tokens: 100 }, content: [{ type: 'tool_use', id: 'read', name: 'Read', input: {} }] } },
    { type: 'user', uuid: 'tool', parentUuid: 'a2', toolUseResult: {},
      message: { content: [{ type: 'tool_result', tool_use_id: 'read', content: 'Result' }] } },
    { type: 'assistant', uuid: 'final', parentUuid: 'tool', timestamp: '2026-09-20T11:00:02.500Z',
      message: { id: 'r2', stop_reason: 'end_turn', usage: { output_tokens: 25 }, content: [{ type: 'text', text: '答'.repeat(14000) }] } },
    { type: 'assistant', uuid: 'child', parentUuid: 'u', isSidechain: true,
      message: { id: 'child-response', stop_reason: 'end_turn', usage: { output_tokens: 900 } } },
  ];
  await fs.writeFile(filePath, records.map(record => JSON.stringify(record)).join('\n') + '\n');
  const context = { environment: { CLAUDE_CONFIG_DIR: home } };
  let bytesRead = 0;
  const nativeOpen = fs.open;
  const spy = jest.spyOn(jest.requireActual<typeof fs>('node:fs/promises'), 'open').mockImplementation(async (...args) => {
    const file = await nativeOpen(...args);
    const read = file.read.bind(file);
    jest.spyOn(file, 'read').mockImplementation((async (...readArgs: Parameters<typeof file.read>) => {
      const result = await read(...readArgs);
      bytesRead += result.bytesRead;
      return result;
    }) as typeof file.read);
    return file;
  });
  try {
    const stats = await loadClaudeTurnStats('/vault', 'session', 'final', context);
    expect(stats).toEqual({ outputTokens: 125, durationMs: 2500 });
    expect(bytesRead).toBeLessThan(65536);
    const replay = await loadSDKSessionMessages('/vault', 'session', 'final', filePath);
    expect(replay.messages.at(-1)?.turnStats).toEqual(stats);
  } finally {
    spy.mockRestore();
    await fs.rm(home, { recursive: true, force: true });
  }
});

it.each([
  '[Request interrupted by user]',
  'User: Earlier question\n\nAssistant: Earlier answer',
])('does not start native timing from an interrupt or rebuilt context: %s', async content => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-turn-boundary-'));
  const directory = path.join(home, 'projects', '-vault');
  await fs.mkdir(directory, { recursive: true });
  const filePath = path.join(directory, 'session.jsonl');
  await fs.writeFile(filePath, [
    { type: 'user', uuid: 'u', timestamp: '2026-09-20T11:00:00Z', message: { content } },
    { type: 'assistant', uuid: 'a', parentUuid: 'u', timestamp: '2026-09-20T11:00:02.500Z',
      message: { id: 'response', stop_reason: 'end_turn', usage: { output_tokens: 125 }, content: 'Answer' } },
  ].map(record => JSON.stringify(record)).join('\n'));
  try {
    expect(await loadClaudeTurnStats('/vault', 'session', 'a', { environment: { CLAUDE_CONFIG_DIR: home } })).toBeUndefined();
    expect((await loadSDKSessionMessages('/vault', 'session', 'a', filePath)).messages.at(-1)?.turnStats).toBeUndefined();
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});
