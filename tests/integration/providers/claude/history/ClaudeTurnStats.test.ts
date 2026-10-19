import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { testTime } from '@test/helpers/testClock';

import { loadSDKSessionMessages } from '@/providers/claude/history/ClaudeHistoryStore';
import { loadClaudeTurnStats } from '@/providers/claude/history/ClaudeTurnStats';
import type { SDKNativeMessage } from '@/providers/claude/history/sdkHistoryTypes';

it('matches replay across tool-result ancestry and reads a bounded suffix of a long session', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-turn-'));
  const vaultPath = path.resolve('/vault');
  const directory = path.join(home, 'projects', vaultPath.replace(/[^a-zA-Z0-9]/g, '-'));
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
  const vaultPath = path.resolve('/vault');
  const directory = path.join(home, 'projects', vaultPath.replace(/[^a-zA-Z0-9]/g, '-'));
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

// The active branch drops progress records, which a fold can still follow.
it.each([
  [1, 'tool result', 2500],
  [2, 'tool result', 2500],
  [1, 'progress record', 2000],
] as const)('times a turn resumed by %i folded queued prompts after a %s from their consumption, matching replay', async (count, followed, durationMs) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-turn-queued-'));
  const vaultPath = path.resolve('/vault');
  const directory = path.join(home, 'projects', vaultPath.replace(/[^a-zA-Z0-9]/g, '-'));
  await fs.mkdir(directory, { recursive: true });
  const filePath = path.join(directory, 'session.jsonl');
  // The attachment keeps its enqueue time; Claude folded it after the tool result.
  await fs.writeFile(filePath, [
    { type: 'user', uuid: 'u', timestamp: testTime(), message: { content: 'Work' } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u', timestamp: testTime({ seconds: 1 }),
      message: { id: 'r1', stop_reason: 'tool_use', usage: { output_tokens: 100 }, content: [{ type: 'tool_use', id: 'bash', name: 'Bash', input: {} }] } },
    { type: 'user', uuid: 'tool', parentUuid: 'a1', timestamp: testTime({ seconds: 10 }), toolUseResult: {},
      message: { content: [{ type: 'tool_result', tool_use_id: 'bash', content: 'done' }] } },
    ...(followed === 'progress record'
      ? [{ type: 'progress', uuid: 'progress', parentUuid: 'tool', timestamp: testTime({ seconds: 10, milliseconds: 500 }) }]
      : []),
    ...Array.from({ length: count }, (_, index) => ({
      type: 'attachment', uuid: `steer-${index}`,
      parentUuid: index > 0 ? `steer-${index - 1}` : followed === 'progress record' ? 'progress' : 'tool',
      timestamp: testTime({ milliseconds: 500 * (index + 1) }),
      attachment: { type: 'queued_command', prompt: `Steer ${index}`, source_uuid: `steer-input-${index}`, commandMode: 'prompt' },
    })),
    { type: 'assistant', uuid: 'final', parentUuid: `steer-${count - 1}`, timestamp: testTime({ seconds: 12, milliseconds: 500 }),
      message: { id: 'r2', stop_reason: 'end_turn', usage: { output_tokens: 25 }, content: [{ type: 'text', text: 'Done' }] } },
  ].map(record => JSON.stringify(record)).join('\n'));
  try {
    const stats = await loadClaudeTurnStats('/vault', 'session', 'final', { environment: { CLAUDE_CONFIG_DIR: home } });
    expect(stats).toEqual({ outputTokens: 25, durationMs });
    const replay = await loadSDKSessionMessages('/vault', 'session', 'final', filePath);
    expect(replay.messages.at(-1)?.turnStats).toEqual(stats);
    expect(replay.messages.map(message => message.content || message.contentBlocks?.[0]?.type))
      .toEqual(['Work', 'tool_use', ...Array.from({ length: count }, (_, index) => `Steer ${index}`), 'Done']);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});
