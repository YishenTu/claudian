import * as fs from 'fs';
import * as path from 'path';

import type { StreamChunk } from '@/core/types';
import {
  createCursorNormalizationState,
  normalizeCursorEvent,
  normalizeCursorEventStream,
} from '@/providers/cursor/normalization/cursorEventNormalization';
import type {
  CursorResultEvent,
  CursorStreamEvent,
} from '@/providers/cursor/runtime/cursorEventTypes';

const FIXTURES_DIR = path.join(__dirname, '..', 'runtime', 'fixtures');

function loadFixtureEvents(filename: string): CursorStreamEvent[] {
  const content = fs.readFileSync(path.join(FIXTURES_DIR, filename), 'utf-8');
  return content
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => JSON.parse(line) as CursorStreamEvent);
}

describe('normalizeCursorEvent', () => {
  it('captures session id from system.init without emitting chunks', () => {
    const state = createCursorNormalizationState();
    const event = {
      type: 'system',
      session_id: 'chat-abc',
      subtype: 'init',
      model: 'gpt-5',
    } as unknown as CursorStreamEvent;

    const chunks = normalizeCursorEvent(event, state);
    expect(chunks).toEqual([]);
    expect(state.sessionId).toBe('chat-abc');
  });

  it('skips user echo events', () => {
    const state = createCursorNormalizationState();
    const event = {
      type: 'user',
      session_id: 'chat-1',
      message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    } as unknown as CursorStreamEvent;
    expect(normalizeCursorEvent(event, state)).toEqual([]);
  });

  it('emits thinking chunks for thinking deltas only', () => {
    const state = createCursorNormalizationState();
    expect(
      normalizeCursorEvent({
        type: 'thinking',
        subtype: 'delta',
        text: 'planning',
      } as unknown as CursorStreamEvent, state),
    ).toEqual<StreamChunk[]>([{ type: 'thinking', content: 'planning' }]);

    expect(
      normalizeCursorEvent({
        type: 'thinking',
        subtype: 'completed',
      } as unknown as CursorStreamEvent, state),
    ).toEqual([]);
  });

  it('emits incremental text chunks for assistant deltas with timestamp_ms', () => {
    const state = createCursorNormalizationState();
    const chunks = normalizeCursorEvent({
      type: 'assistant',
      timestamp_ms: 123,
      message: { role: 'assistant', content: [{ type: 'text', text: 'Hel' }] },
    } as unknown as CursorStreamEvent, state);
    expect(chunks).toEqual([{ type: 'text', content: 'Hel' }]);
    expect(state.assistantTextSoFar).toBe('Hel');
  });

  it('captures the final assistant message without re-emitting', () => {
    const state = createCursorNormalizationState();
    state.assistantTextSoFar = 'Hello';
    const chunks = normalizeCursorEvent({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Hello world' }] },
    } as unknown as CursorStreamEvent, state);
    expect(chunks).toEqual([]);
    expect(state.finalText).toBe('Hello world');
  });

  it('emits tool_use for shell tool started events', () => {
    const state = createCursorNormalizationState();
    const chunks = normalizeCursorEvent({
      type: 'tool_call',
      subtype: 'started',
      call_id: 'tc-1',
      tool_call: {
        shellToolCall: {
          args: {
            command: 'ls -la',
            workingDirectory: '/tmp',
            description: 'List files',
          },
          description: 'List files',
        },
      },
    } as unknown as CursorStreamEvent, state);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      type: 'tool_use',
      id: 'tc-1',
      name: 'shell',
      input: {
        command: 'ls -la',
        workingDirectory: '/tmp',
        description: 'List files',
      },
    });
  });

  it('emits tool_result for shell tool completed events with stdout', () => {
    const state = createCursorNormalizationState();
    const chunks = normalizeCursorEvent({
      type: 'tool_call',
      subtype: 'completed',
      call_id: 'tc-1',
      tool_call: {
        shellToolCall: {
          args: { command: 'ls' },
          result: {
            success: { exitCode: 0, stdout: 'file1\nfile2', stderr: '' },
          },
        },
      },
    } as unknown as CursorStreamEvent, state);

    expect(chunks).toEqual<StreamChunk[]>([
      { type: 'tool_result', id: 'tc-1', content: 'file1\nfile2', isError: false },
    ]);
  });

  it('marks tool_result as error when exit code is non-zero', () => {
    const state = createCursorNormalizationState();
    const chunks = normalizeCursorEvent({
      type: 'tool_call',
      subtype: 'completed',
      call_id: 'tc-2',
      tool_call: {
        shellToolCall: {
          args: { command: 'ls /missing' },
          result: {
            success: { exitCode: 1, stdout: '', stderr: 'No such file' },
          },
        },
      },
    } as unknown as CursorStreamEvent, state);

    expect(chunks[0]).toMatchObject({
      type: 'tool_result',
      id: 'tc-2',
      isError: true,
    });
    expect((chunks[0] as { content: string }).content).toContain('No such file');
  });

  it('emits usage + done on result.success', () => {
    const state = createCursorNormalizationState();
    const event: CursorResultEvent = {
      type: 'result',
      session_id: 'chat-1',
      subtype: 'success',
      duration_ms: 1234,
      is_error: false,
      result: 'final answer',
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 25,
        cacheWriteTokens: 10,
      },
    };

    const chunks = normalizeCursorEvent(event, state);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].type).toBe('usage');
    expect(chunks[1].type).toBe('done');
    expect((chunks[0] as { usage: { inputTokens: number } }).usage.inputTokens).toBe(100);
    expect(state.finalText).toBe('final answer');
    expect(state.done).toBe(true);
  });

  it('emits error + done on result.error or is_error=true', () => {
    const state = createCursorNormalizationState();
    const event: CursorResultEvent = {
      type: 'result',
      subtype: 'error',
      is_error: true,
      error: { message: 'rate limit hit' },
    };

    const chunks = normalizeCursorEvent(event, state);
    expect(chunks[0]).toEqual({ type: 'error', content: 'rate limit hit' });
    expect(chunks[1]).toEqual({ type: 'done' });
    expect(state.done).toBe(true);
  });
});

describe('normalizeCursorEventStream (fixture-driven)', () => {
  it('produces a coherent stream from the simple-text fixture', () => {
    const events = loadFixtureEvents('simple-text-stream.ndjson');
    const { chunks, state } = normalizeCursorEventStream(events);

    const types = chunks.map(chunk => chunk.type);
    expect(types).toContain('text');
    expect(types[types.length - 2]).toBe('usage');
    expect(types[types.length - 1]).toBe('done');
    expect(state.sessionId).toBe('dea8eb05-fa9f-4170-8dab-99d61f1e3fe5');
    expect(state.assistantTextSoFar.length).toBeGreaterThan(0);
  });

  it('produces tool + text + usage stream from the tool-call fixture', () => {
    const events = loadFixtureEvents('tool-call-stream.ndjson');
    const { chunks, state } = normalizeCursorEventStream(events);

    const types = chunks.map(chunk => chunk.type);
    expect(types).toContain('thinking');
    expect(types).toContain('tool_use');
    expect(types).toContain('tool_result');
    expect(types).toContain('text');
    expect(types[types.length - 2]).toBe('usage');
    expect(types[types.length - 1]).toBe('done');
    expect(state.done).toBe(true);
  });
});
