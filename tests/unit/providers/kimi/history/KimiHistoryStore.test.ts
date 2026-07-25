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
      { toolId: 'tool_1', type: 'tool_use' },
      { toolId: 'tool_2', type: 'tool_use' },
      { content: 'Done.', type: 'text' },
    ]);
    expect(parsed.messages[1].toolCalls).toEqual([
      {
        id: 'tool_1',
        input: { path: 'notes/sample.md' },
        name: 'Read',
        result: 'sample text',
        status: 'completed',
      },
      {
        id: 'tool_2',
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
      {
        type: 'turn.prompt',
        time: 1_700_000_000_000,
        input: [{ type: 'text', text: 'Run tools' }],
        origin: { kind: 'user' },
      },
      {
        type: 'context.append_message',
        time: 1_700_000_000_100,
        message: {
          role: 'assistant',
          content: [],
          tool_calls: [{ id: 'tool_known', type: 'function', function: { name: 'Read' } }],
        },
      },
      {
        type: 'context.append_message',
        time: 1_700_000_000_200,
        message: {
          role: 'tool',
          tool_call_id: 'tool_unknown',
          content: [{ type: 'text', text: 'orphan' }],
        },
      },
      {
        type: 'context.append_message',
        time: 1_700_000_000_300,
        message: {
          role: 'tool',
          tool_call_id: 'tool_known',
          content: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }, { nope: true }],
        },
      },
    ];
    const content = records.map(record => JSON.stringify(record)).join('\n');

    const parsed = parseKimiHistoryContent(content, 'session-tools');

    expect(parsed.messages).toHaveLength(2);
    expect(parsed.messages[1].toolCalls).toEqual([{
      id: 'tool_known',
      input: {},
      name: 'Read',
      result: 'first\nsecond',
      status: 'completed',
    }]);
  });

  it('keeps tools running when no result was recorded before the turn ended', () => {
    const records = [
      {
        type: 'turn.prompt',
        time: 1_700_000_000_000,
        input: [{ type: 'text', text: 'Run' }],
        origin: { kind: 'user' },
      },
      {
        type: 'context.append_message',
        time: 1_700_000_000_100,
        message: {
          role: 'assistant',
          content: [],
          tool_calls: [{
            id: 'tool_open',
            type: 'function',
            function: { name: 'Bash', arguments: '{"command":"sleep 60"}' },
          }],
        },
      },
      { type: 'turn.cancel', time: 1_700_000_000_200, turnId: 1 },
    ];
    const content = records.map(record => JSON.stringify(record)).join('\n');

    const parsed = parseKimiHistoryContent(content, 'session-open');

    expect(parsed.messages).toHaveLength(2);
    expect(parsed.messages[1].toolCalls).toEqual([{
      id: 'tool_open',
      input: { command: 'sleep 60' },
      name: 'Bash',
      status: 'running',
    }]);
  });

  it('drops turns without user input and ignores records before the first prompt', () => {
    const records = [
      {
        type: 'context.append_message',
        time: 1_700_000_000_000,
        message: { role: 'assistant', content: [{ type: 'text', text: 'orphan' }] },
      },
      { type: 'turn.prompt', time: 1_700_000_000_100, input: [], origin: { kind: 'user' } },
      { type: 'turn.cancel', time: 1_700_000_000_200 },
      {
        type: 'turn.prompt',
        time: 1_700_000_000_300,
        input: [{ type: 'text', text: 'Hello' }],
        origin: { kind: 'user' },
      },
    ];
    const content = records.map(record => JSON.stringify(record)).join('\n');

    const parsed = parseKimiHistoryContent(content, 'session-empty');

    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0]).toMatchObject({
      content: 'Hello',
      id: 'kimi-session-empty-turn-0-user',
      role: 'user',
      timestamp: 1_700_000_000_300,
    });
  });

  it('sanitizes the session id when deriving message ids', () => {
    const records = [
      {
        type: 'turn.prompt',
        time: 1_700_000_000_000,
        input: [{ type: 'text', text: 'Hi' }],
        origin: { kind: 'user' },
      },
    ];
    const content = records.map(record => JSON.stringify(record)).join('\n');

    const parsed = parseKimiHistoryContent(content, 'session/with spaces');

    expect(parsed.messages[0].id).toBe('kimi-session-with-spaces-turn-0-user');
  });

  it('loads agents/main/wire.jsonl, reads the state.json title, and tolerates missing files', async () => {
    const content = fs.readFileSync(FIXTURE_PATH, 'utf8');
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-history-store-'));
    const sessionDirectory = path.join(tempRoot, 'session-loaded');
    fs.mkdirSync(path.join(sessionDirectory, 'agents', 'main'), { recursive: true });
    fs.writeFileSync(path.join(sessionDirectory, 'agents', 'main', 'wire.jsonl'), content, 'utf8');
    fs.writeFileSync(path.join(sessionDirectory, 'state.json'), JSON.stringify({
      createdAt: '2025-01-01T00:00:00.000Z',
      title: 'Inspect the sample file',
      updatedAt: '2025-01-01T00:01:00.000Z',
      workDir: '/vault',
    }), 'utf8');

    try {
      const loaded = await loadKimiHistory(sessionDirectory);
      expect(loaded.messages).toHaveLength(6);
      expect(loaded.messages[0].id).toBe('kimi-session-loaded-turn-0-user');
      expect(loaded.title).toBe('Inspect the sample file');

      // The CLI's default title carries no information.
      fs.writeFileSync(path.join(sessionDirectory, 'state.json'), JSON.stringify({
        title: 'New Session',
      }), 'utf8');
      expect((await loadKimiHistory(sessionDirectory)).title).toBeUndefined();

      await expect(loadKimiHistory(path.join(tempRoot, 'missing'))).resolves.toEqual({
        messages: [],
      });
    } finally {
      fs.rmSync(tempRoot, { force: true, recursive: true });
    }
  });
});
