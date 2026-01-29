import { isSessionInitEvent, isStreamChunk } from '@/core/sdk/typeGuards';
import type { TransformEvent } from '@/core/sdk/types';

describe('isSessionInitEvent', () => {
  it('should return true for session_init events', () => {
    const event: TransformEvent = { type: 'session_init', sessionId: 'abc-123' };

    expect(isSessionInitEvent(event)).toBe(true);
  });

  it('should return true for session_init with agents', () => {
    const event: TransformEvent = { type: 'session_init', sessionId: 'abc', agents: ['agent1'] };

    expect(isSessionInitEvent(event)).toBe(true);
  });

  it('should return false for stream chunk events', () => {
    const textChunk: TransformEvent = { type: 'text', content: 'hello' };
    const doneChunk: TransformEvent = { type: 'done' };
    const toolUseChunk: TransformEvent = { type: 'tool_use', id: 't1', name: 'Read', input: {} };

    expect(isSessionInitEvent(textChunk)).toBe(false);
    expect(isSessionInitEvent(doneChunk)).toBe(false);
    expect(isSessionInitEvent(toolUseChunk)).toBe(false);
  });
});

describe('isStreamChunk', () => {
  it('should return true for stream chunk events', () => {
    const textChunk: TransformEvent = { type: 'text', content: 'hello' };
    const doneChunk: TransformEvent = { type: 'done' };
    const errorChunk: TransformEvent = { type: 'error', content: 'oops' };
    const blockedChunk: TransformEvent = { type: 'blocked', content: 'blocked cmd' };
    const toolUseChunk: TransformEvent = { type: 'tool_use', id: 't1', name: 'Read', input: {} };
    const toolResultChunk: TransformEvent = { type: 'tool_result', id: 't1', content: 'result' };

    expect(isStreamChunk(textChunk)).toBe(true);
    expect(isStreamChunk(doneChunk)).toBe(true);
    expect(isStreamChunk(errorChunk)).toBe(true);
    expect(isStreamChunk(blockedChunk)).toBe(true);
    expect(isStreamChunk(toolUseChunk)).toBe(true);
    expect(isStreamChunk(toolResultChunk)).toBe(true);
  });

  it('should return false for session_init events', () => {
    const event: TransformEvent = { type: 'session_init', sessionId: 'abc-123' };

    expect(isStreamChunk(event)).toBe(false);
  });
});
