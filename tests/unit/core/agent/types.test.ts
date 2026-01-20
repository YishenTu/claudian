import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

import { computeSystemPromptKey, createResponseHandler, isTurnCompleteMessage } from '@/core/agent/types';

describe('isTurnCompleteMessage', () => {
  it('returns true for result message', () => {
    const message = { type: 'result' } as SDKMessage;
    expect(isTurnCompleteMessage(message)).toBe(true);
  });

  it('returns true for error message', () => {
    // Error type may not be in SDK types but can occur at runtime
    const message = { type: 'error' } as unknown as SDKMessage;
    expect(isTurnCompleteMessage(message)).toBe(true);
  });

  it('returns false for assistant message', () => {
    const message = { type: 'assistant' } as SDKMessage;
    expect(isTurnCompleteMessage(message)).toBe(false);
  });

  it('returns false for user message', () => {
    const message = { type: 'user' } as SDKMessage;
    expect(isTurnCompleteMessage(message)).toBe(false);
  });

  it('returns false for system message', () => {
    const message = { type: 'system' } as SDKMessage;
    expect(isTurnCompleteMessage(message)).toBe(false);
  });
});

describe('computeSystemPromptKey', () => {
  it('computes key from all settings', () => {
    // Note: Agents are passed via Options.agents, not system prompt, so not included in key.
    const settings = {
      mediaFolder: 'attachments',
      customPrompt: 'Be helpful',
      allowedExportPaths: ['/path/b', '/path/a'],
      vaultPath: '/vault',
    };

    const key = computeSystemPromptKey(settings);

    // Paths are sorted to keep the key stable.
    expect(key).toBe('attachments::Be helpful::/path/a|/path/b::/vault');
  });

  it('handles empty/undefined values', () => {
    const settings = {
      mediaFolder: '',
      customPrompt: '',
      allowedExportPaths: [],
      vaultPath: '',
    };

    const key = computeSystemPromptKey(settings);
    // 4 empty parts joined with '::' = 3 separators = 6 colons
    expect(key).toBe('::::::');
  });

  it('produces different keys for different inputs', () => {
    const settings1 = {
      mediaFolder: 'attachments',
      customPrompt: 'Be helpful',
      allowedExportPaths: [],
      vaultPath: '/vault1',
    };
    const settings2 = {
      mediaFolder: 'attachments',
      customPrompt: 'Be helpful',
      allowedExportPaths: [],
      vaultPath: '/vault2',
    };

    expect(computeSystemPromptKey(settings1)).not.toBe(computeSystemPromptKey(settings2));
  });

  it('produces same key for equivalent inputs with different path order', () => {
    const settings1 = {
      mediaFolder: '',
      customPrompt: '',
      allowedExportPaths: ['/a', '/b', '/c'],
      vaultPath: '',
    };
    const settings2 = {
      mediaFolder: '',
      customPrompt: '',
      allowedExportPaths: ['/c', '/a', '/b'],
      vaultPath: '',
    };

    // Paths are sorted, so order shouldn't matter
    expect(computeSystemPromptKey(settings1)).toBe(computeSystemPromptKey(settings2));
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
    handler1.markChunkSeen();

    // handler2 should not be affected
    expect(handler1.sawStreamText).toBe(true);
    expect(handler1.sawAnyChunk).toBe(true);
    expect(handler2.sawStreamText).toBe(false);
    expect(handler2.sawAnyChunk).toBe(false);
  });
});
