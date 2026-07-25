import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  loadKimiHistory,
  parseKimiHistoryContent,
} from '@/providers/kimi/history/KimiHistoryStore';

const FIXTURE_PATH = path.join(
  process.cwd(),
  'tests/unit/providers/kimi/fixtures/wire.jsonl',
);

describe('KimiHistoryStore', () => {
  it('hydrates complete turns while tolerating malformed and unknown lines', () => {
    const content = fs.readFileSync(FIXTURE_PATH, 'utf8');

    const parsed = parseKimiHistoryContent(content, 'session-fixture');

    expect(parsed.messages).toHaveLength(6);
    expect(parsed.messages[0]).toMatchObject({
      content: 'Inspect the sample file.',
      id: 'kimi-session-fixture-turn-0-user',
      role: 'user',
      timestamp: 1_700_000_000_000,
      userMessageId: 'kimi-session-fixture-turn-0-user',
    });
    expect(parsed.messages[1]).toMatchObject({
      assistantMessageId: 'kimi-session-fixture-turn-0-assistant',
      content: 'Reading now. One moment.Done.',
      id: 'kimi-session-fixture-turn-0-assistant',
      role: 'assistant',
      timestamp: 1_700_000_000_000,
    });
    expect(parsed.messages[1].contentBlocks).toEqual([
      { content: 'I will read it.', type: 'thinking' },
      { content: 'Reading now. One moment.', type: 'text' },
      { toolId: 'tool-1', type: 'tool_use' },
      { toolId: 'tool-2', type: 'tool_use' },
      { content: 'Done.', type: 'text' },
    ]);
    expect(parsed.messages[1].toolCalls).toEqual([
      {
        id: 'tool-1',
        input: { path: 'notes/sample.md' },
        name: 'Read',
        result: 'sample text',
        status: 'completed',
      },
      {
        id: 'tool-2',
        input: { command: 'rm -rf /' },
        name: 'Bash',
        result: 'permission denied',
        status: 'error',
      },
    ]);
    expect(parsed.messages[2]).toMatchObject({
      content: 'Stop now.\nReally.',
      role: 'user',
      timestamp: 1_700_000_100_000,
    });
    expect(parsed.messages[2]).not.toHaveProperty('userMessageId');
    expect(parsed.messages[3]).toMatchObject({ content: 'Stopping.', role: 'assistant' });
    expect(parsed.messages.some(message => message.content.includes('dropped'))).toBe(false);
  });

  it('commits a pending turn at EOF when the wire log ends mid-turn', () => {
    const content = fs.readFileSync(FIXTURE_PATH, 'utf8');

    const parsed = parseKimiHistoryContent(content, 'session-fixture');

    expect(parsed.messages[4]).toMatchObject({
      content: 'Incomplete turn',
      id: 'kimi-session-fixture-turn-2-user',
      role: 'user',
      timestamp: 1_700_000_200_000,
    });
    expect(parsed.messages[5]).toMatchObject({
      content: 'Partial answer',
      role: 'assistant',
    });
  });

  it('pairs tool results by tool call id and ignores unknown results', () => {
    const records = [
      { message: { payload: { user_input: 'Run tools' }, type: 'TurnBegin' }, timestamp: 10 },
      {
        message: {
          payload: { function: { name: 'Read' }, id: 'tool-known' },
          type: 'ToolCall',
        },
        timestamp: 11,
      },
      {
        message: {
          payload: { return_value: { output: 'orphan' }, tool_call_id: 'tool-unknown' },
          type: 'ToolResult',
        },
        timestamp: 12,
      },
      {
        message: {
          payload: {
            return_value: {
              is_error: false,
              output: [{ text: 'first' }, { text: 'second' }, { nope: true }],
            },
            tool_call_id: 'tool-known',
          },
          type: 'ToolResult',
        },
        timestamp: 13,
      },
      { message: { payload: {}, type: 'TurnEnd' }, timestamp: 14 },
    ];
    const content = records.map(record => JSON.stringify(record)).join('\n');

    const parsed = parseKimiHistoryContent(content, 'session-tools');

    expect(parsed.messages).toHaveLength(2);
    expect(parsed.messages[1].toolCalls).toEqual([{
      id: 'tool-known',
      input: {},
      name: 'Read',
      result: 'first\nsecond',
      status: 'completed',
    }]);
  });

  it('keeps epoch-millisecond timestamps untouched and drops empty turns', () => {
    const records = [
      { message: { payload: {}, type: 'TurnBegin' }, timestamp: 1_700_000_000_000 },
      { message: { payload: {}, type: 'TurnEnd' }, timestamp: 1_700_000_000_100 },
      { message: { payload: { user_input: 'Hello' }, type: 'TurnBegin' }, timestamp: 1_700_000_000_200 },
      { message: { payload: {}, type: 'TurnEnd' }, timestamp: 1_700_000_000_300 },
    ];
    const content = records.map(record => JSON.stringify(record)).join('\n');

    const parsed = parseKimiHistoryContent(content, 'session-empty');

    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0]).toMatchObject({
      content: 'Hello',
      role: 'user',
      timestamp: 1_700_000_000_200,
    });
  });

  it('sanitizes the session id when deriving message ids', () => {
    const records = [
      { message: { payload: { user_input: 'Hi' }, type: 'TurnBegin' }, timestamp: 1 },
    ];
    const content = records.map(record => JSON.stringify(record)).join('\n');

    const parsed = parseKimiHistoryContent(content, 'session/with spaces');

    expect(parsed.messages[0].id).toBe('kimi-session-with-spaces-turn-0-user');
  });

  it('loads wire.jsonl from a session directory and tolerates a missing file', async () => {
    const content = fs.readFileSync(FIXTURE_PATH, 'utf8');
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-history-store-'));
    const sessionDirectory = path.join(tempRoot, 'session-loaded');
    fs.mkdirSync(sessionDirectory, { recursive: true });
    fs.writeFileSync(path.join(sessionDirectory, 'wire.jsonl'), content, 'utf8');

    try {
      const loaded = await loadKimiHistory(sessionDirectory);
      expect(loaded.messages).toHaveLength(6);
      expect(loaded.messages[0].id).toBe('kimi-session-loaded-turn-0-user');

      await expect(loadKimiHistory(path.join(tempRoot, 'missing'))).resolves.toEqual({
        messages: [],
      });
    } finally {
      fs.rmSync(tempRoot, { force: true, recursive: true });
    }
  });
});
