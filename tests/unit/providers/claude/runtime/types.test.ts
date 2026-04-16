import { buildSDKMessage } from '@test/helpers/sdkMessages';

import { createResponseHandler, isTurnCompleteMessage } from '@/providers/claude/runtime/types';

describe('isTurnCompleteMessage', () => {
  it('returns true for result message', () => {
    const message = buildSDKMessage({ type: 'result' });
    expect(isTurnCompleteMessage(message)).toBe(true);
  });

  it('returns false for assistant message', () => {
    const message = buildSDKMessage({ type: 'assistant' });
    expect(isTurnCompleteMessage(message)).toBe(false);
  });

  it('returns false for user message', () => {
    const message = buildSDKMessage({ type: 'user' });
    expect(isTurnCompleteMessage(message)).toBe(false);
  });

  it('returns false for system message', () => {
    const message = buildSDKMessage({ type: 'system', subtype: 'status' });
    expect(isTurnCompleteMessage(message)).toBe(false);
  });
});

describe('createResponseHandler', () => {
  it('creates a handler with initial state values as false', () => {
    const handler = createResponseHandler({
      id: 'test-handler',
      onChunk: jest.fn(),
      onDone: jest.fn(),
      onError: jest.fn(),
    });

    expect(handler.sawStreamText).toBe(false);
    expect(handler.sawStreamThinking).toBe(false);
    expect(handler.sawAnyChunk).toBe(false);
  });

  it('markStreamTextSeen sets sawStreamText to true', () => {
    const handler = createResponseHandler({
      id: 'test-handler',
      onChunk: jest.fn(),
      onDone: jest.fn(),
      onError: jest.fn(),
    });

    expect(handler.sawStreamText).toBe(false);
    handler.markStreamTextSeen();
    expect(handler.sawStreamText).toBe(true);
  });

  it('resetStreamText sets sawStreamText back to false', () => {
    const handler = createResponseHandler({
      id: 'test-handler',
      onChunk: jest.fn(),
      onDone: jest.fn(),
      onError: jest.fn(),
    });

    handler.markStreamTextSeen();
    expect(handler.sawStreamText).toBe(true);
    handler.resetStreamText();
    expect(handler.sawStreamText).toBe(false);
  });

  it('markStreamThinkingSeen sets sawStreamThinking to true', () => {
    const handler = createResponseHandler({
      id: 'test-handler',
      onChunk: jest.fn(),
      onDone: jest.fn(),
      onError: jest.fn(),
    });

    expect(handler.sawStreamThinking).toBe(false);
    handler.markStreamThinkingSeen();
    expect(handler.sawStreamThinking).toBe(true);
  });

  it('resetStreamThinking sets sawStreamThinking back to false', () => {
    const handler = createResponseHandler({
      id: 'test-handler',
      onChunk: jest.fn(),
      onDone: jest.fn(),
      onError: jest.fn(),
    });

    handler.markStreamThinkingSeen();
    expect(handler.sawStreamThinking).toBe(true);
    handler.resetStreamThinking();
    expect(handler.sawStreamThinking).toBe(false);
  });

  it('markChunkSeen sets sawAnyChunk to true', () => {
    const handler = createResponseHandler({
      id: 'test-handler',
      onChunk: jest.fn(),
      onDone: jest.fn(),
      onError: jest.fn(),
    });

    expect(handler.sawAnyChunk).toBe(false);
    handler.markChunkSeen();
    expect(handler.sawAnyChunk).toBe(true);
  });

  it('preserves id from options', () => {
    const handler = createResponseHandler({
      id: 'my-unique-id',
      onChunk: jest.fn(),
      onDone: jest.fn(),
      onError: jest.fn(),
    });

    expect(handler.id).toBe('my-unique-id');
  });

  it('calls onChunk callback when invoked', () => {
    const onChunk = jest.fn();
    const handler = createResponseHandler({
      id: 'test-handler',
      onChunk,
      onDone: jest.fn(),
      onError: jest.fn(),
    });

    const chunk = { type: 'text' as const, content: 'hello' };
    handler.onChunk(chunk);

    expect(onChunk).toHaveBeenCalledWith(chunk);
  });

  it('calls onDone callback when invoked', () => {
    const onDone = jest.fn();
    const handler = createResponseHandler({
      id: 'test-handler',
      onChunk: jest.fn(),
      onDone,
      onError: jest.fn(),
    });

    handler.onDone();

    expect(onDone).toHaveBeenCalled();
  });

  it('calls onError callback when invoked', () => {
    const onError = jest.fn();
    const handler = createResponseHandler({
      id: 'test-handler',
      onChunk: jest.fn(),
      onDone: jest.fn(),
      onError,
    });

    const error = new Error('test error');
    handler.onError(error);

    expect(onError).toHaveBeenCalledWith(error);
  });

  it('maintains independent state between handlers', () => {
    const handler1 = createResponseHandler({
      id: 'handler-1',
      onChunk: jest.fn(),
      onDone: jest.fn(),
      onError: jest.fn(),
    });

    const handler2 = createResponseHandler({
      id: 'handler-2',
      onChunk: jest.fn(),
      onDone: jest.fn(),
      onError: jest.fn(),
    });

    handler1.markStreamTextSeen();
    handler1.markStreamThinkingSeen();
    handler1.markChunkSeen();

    // handler2 should not be affected
    expect(handler1.sawStreamText).toBe(true);
    expect(handler1.sawStreamThinking).toBe(true);
    expect(handler1.sawAnyChunk).toBe(true);
    expect(handler2.sawStreamText).toBe(false);
    expect(handler2.sawStreamThinking).toBe(false);
    expect(handler2.sawAnyChunk).toBe(false);
  });
});
