import {
  createPiEventNormalizationState,
  normalizePiRpcEvent,
} from '@/providers/pi/normalizations/piEventNormalization';

describe('Pi event normalization', () => {
  it('normalizes text and thinking deltas', () => {
    const state = createPiEventNormalizationState();
    expect(normalizePiRpcEvent({
      assistantMessageEvent: { text_delta: 'hello' },
      type: 'message_update',
    }, state)).toEqual([{ type: 'text', content: 'hello' }]);
    expect(normalizePiRpcEvent({
      assistantMessageEvent: { thinking_delta: 'hmm' },
      type: 'message_update',
    }, state)).toEqual([{ type: 'thinking', content: 'hmm' }]);
  });

  it('dedupes tool use and maps output/result chunks', () => {
    const state = createPiEventNormalizationState();
    expect(normalizePiRpcEvent({
      id: 'tool-1',
      input: { path: 'a.md' },
      name: 'read',
      type: 'toolcall_end',
    }, state)).toEqual([{
      id: 'tool-1',
      input: { file_path: 'a.md', path: 'a.md' },
      name: 'Read',
      type: 'tool_use',
    }]);
    expect(normalizePiRpcEvent({
      id: 'tool-1',
      input: { path: 'a.md' },
      name: 'read',
      type: 'tool_execution_start',
    }, state)).toEqual([]);
    expect(normalizePiRpcEvent({
      id: 'tool-1',
      partialResult: { content: [{ text: 'partial', type: 'text' }] },
      type: 'tool_execution_update',
    }, state)).toEqual([{ id: 'tool-1', content: 'partial', type: 'tool_output' }]);
    expect(normalizePiRpcEvent({
      id: 'tool-1',
      result: { content: [{ text: 'done', type: 'text' }] },
      type: 'tool_execution_end',
    }, state)).toEqual([{
      id: 'tool-1',
      content: 'done',
      isError: false,
      toolUseResult: { content: [{ text: 'done', type: 'text' }] },
      type: 'tool_result',
    }]);
  });

  it('normalizes Pi RPC toolName and args to shared renderer tool shapes', () => {
    const state = createPiEventNormalizationState();

    expect(normalizePiRpcEvent({
      args: { command: 'pwd' },
      toolCallId: 'bash-1',
      toolName: 'bash',
      type: 'tool_execution_start',
    }, state)).toEqual([{
      id: 'bash-1',
      input: { command: 'pwd' },
      name: 'Bash',
      type: 'tool_use',
    }]);

    expect(normalizePiRpcEvent({
      args: { pattern: 'src/**/*.ts' },
      toolCallId: 'find-1',
      toolName: 'find',
      type: 'tool_execution_start',
    }, state)).toEqual([{
      id: 'find-1',
      input: { pattern: 'src/**/*.ts' },
      name: 'Glob',
      type: 'tool_use',
    }]);
  });

  it('preserves Pi write/edit result payloads for diff extraction', () => {
    const state = createPiEventNormalizationState();

    expect(normalizePiRpcEvent({
      args: { content: 'new text', path: 'notes/a.md' },
      toolCallId: 'write-1',
      toolName: 'write',
      type: 'tool_execution_start',
    }, state)).toEqual([{
      id: 'write-1',
      input: { content: 'new text', file_path: 'notes/a.md', path: 'notes/a.md' },
      name: 'Write',
      type: 'tool_use',
    }]);

    expect(normalizePiRpcEvent({
      isError: false,
      result: {
        content: [{ text: 'Edited notes/a.md', type: 'text' }],
        details: { diff: '--- a/notes/a.md\n+++ b/notes/a.md\n@@ -1 +1 @@\n-old\n+new' },
      },
      toolCallId: 'write-1',
      toolName: 'write',
      type: 'tool_execution_end',
    }, state)).toEqual([{
      id: 'write-1',
      content: 'Edited notes/a.md',
      isError: false,
      toolUseResult: {
        content: [{ text: 'Edited notes/a.md', type: 'text' }],
        details: { diff: '--- a/notes/a.md\n+++ b/notes/a.md\n@@ -1 +1 @@\n-old\n+new' },
      },
      type: 'tool_result',
    }]);
  });

  it('maps compaction and extension errors', () => {
    const state = createPiEventNormalizationState();
    expect(normalizePiRpcEvent({ type: 'compaction_end' }, state)).toEqual([{ type: 'context_compacted' }]);
    expect(normalizePiRpcEvent({ error: 'extension failed', type: 'extension_error' }, state)).toEqual([{
      content: 'extension failed',
      level: 'warning',
      type: 'notice',
    }]);
  });

  it('surfaces terminal Pi stop-reason errors', () => {
    const state = createPiEventNormalizationState();

    expect(normalizePiRpcEvent({
      errorMessage: 'Invalid image',
      stopReason: 'error',
      type: 'message_end',
    }, state)).toEqual([{ type: 'error', content: 'Invalid image' }]);

    expect(normalizePiRpcEvent({
      assistant_message_event: {
        error_message: 'Authentication failed',
        stop_reason: 'error',
      },
      type: 'turn_end',
    }, state)).toEqual([{ type: 'error', content: 'Authentication failed' }]);
  });
});
