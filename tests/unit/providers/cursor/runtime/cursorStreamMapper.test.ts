import { CursorNdjsonStreamReducer } from '@/providers/cursor/runtime/cursorStreamMapper';

describe('CursorNdjsonStreamReducer', () => {
  it('emits text deltas for cumulative assistant output', () => {
    const r = new CursorNdjsonStreamReducer();
    const a = r.reduceLine(JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hel' }] },
      session_id: 's1',
    }));
    expect(a.chunks).toEqual([{ type: 'text', content: 'hel' }]);
    expect(a.sessionId).toBe('s1');

    const b = r.reduceLine(JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
      session_id: 's1',
    }));
    expect(b.chunks).toEqual([{ type: 'text', content: 'lo' }]);
  });

  it('emits tool_use on started and tool_result on completed', () => {
    const r = new CursorNdjsonStreamReducer();
    const start = r.reduceLine(JSON.stringify({
      type: 'tool_call',
      subtype: 'started',
      call_id: 'c1',
      tool_call: { readToolCall: { args: { path: 'a.md' } } },
    }));
    expect(start.chunks).toEqual([{
      type: 'tool_use',
      id: 'c1',
      name: 'read_file',
      input: { path: 'a.md' },
    }]);

    const done = r.reduceLine(JSON.stringify({
      type: 'tool_call',
      subtype: 'completed',
      call_id: 'c1',
      tool_call: { readToolCall: { args: { path: 'a.md' }, result: { success: { content: 'x' } } } },
    }));
    expect(done.chunks[0]).toMatchObject({
      type: 'tool_result',
      id: 'c1',
      content: expect.stringContaining('readToolCall'),
    });
  });

  it('ends with usage and done on result success', () => {
    const r = new CursorNdjsonStreamReducer();
    const out = r.reduceLine(JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      session_id: 's9',
    }));
    expect(out.chunks.map(c => c.type)).toEqual(['usage', 'done']);
  });
});
