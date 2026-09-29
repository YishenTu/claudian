import type { StreamChunk } from '@/core/types';
import {
  createPiEventNormalizationState,
  getPiTerminalErrorMessage,
  normalizePiRPCEvent,
  type PiEventNormalizationState,
} from '@/providers/pi/normalizations/piEventNormalization';

describe('Pi event normalization', () => {
  it('normalizes text and thinking deltas', () => {
    const state = createPiEventNormalizationState();
    expect(normalizePiRPCEvent({
      assistantMessageEvent: { text_delta: 'hello' },
      type: 'message_update',
    }, state)).toEqual([{ type: 'text', content: 'hello' }]);
    expect(normalizePiRPCEvent({
      assistantMessageEvent: { thinking_delta: 'hmm' },
      type: 'message_update',
    }, state)).toEqual([{ type: 'thinking', content: 'hmm' }]);
  });

  it('dedupes tool use and maps output/result chunks', () => {
    const state = createPiEventNormalizationState();
    expect(normalizePiRPCEvent({
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
    expect(normalizePiRPCEvent({
      id: 'tool-1',
      input: { path: 'a.md' },
      name: 'read',
      type: 'tool_execution_start',
    }, state)).toEqual([]);
    expect(normalizePiRPCEvent({
      id: 'tool-1',
      partialResult: { content: [{ text: 'partial', type: 'text' }] },
      type: 'tool_execution_update',
    }, state)).toEqual([{ id: 'tool-1', content: 'partial', type: 'tool_output' }]);
    expect(normalizePiRPCEvent({
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

  describe('cumulative partial results', () => {
    // Pi's partialResult is the tool's latest snapshot (native bash emits its
    // rolling output tail), while the neutral tool_output chunk is a delta that
    // consumers append. Fold emitted chunks the way the stream consumer does.
    const update = (state: PiEventNormalizationState, toolCallId: string, text: string) =>
      normalizePiRPCEvent({
        partialResult: { content: [{ text, type: 'text' }] },
        toolCallId,
        toolName: 'bash',
        type: 'tool_execution_update',
      }, state);
    const appended = (chunks: StreamChunk[], id: string) => chunks
      .flatMap(chunk => (chunk.type === 'tool_output' && chunk.id === id ? [chunk.content] : []))
      .join('');

    it('emits only the new suffix of growing snapshots per tool', () => {
      const state = createPiEventNormalizationState();
      const chunks = [
        ...update(state, 'bash-1', 'a'),
        ...update(state, 'bash-2', 'x'),
        ...update(state, 'bash-1', 'ab'),
        ...update(state, 'bash-1', 'ab'),
        ...update(state, 'bash-2', 'xy'),
        ...update(state, 'bash-1', 'abc'),
      ];

      expect(chunks).toEqual([
        { content: 'a', id: 'bash-1', type: 'tool_output' },
        { content: 'x', id: 'bash-2', type: 'tool_output' },
        { content: 'b', id: 'bash-1', type: 'tool_output' },
        { content: 'y', id: 'bash-2', type: 'tool_output' },
        { content: 'c', id: 'bash-1', type: 'tool_output' },
      ]);
      expect(appended(chunks, 'bash-1')).toBe('abc');
    });

    it('stops live output when a snapshot no longer extends the streamed text and lets completion replace it', () => {
      const state = createPiEventNormalizationState();
      const chunks = [
        ...update(state, 'bash-1', 'line1\nline2\n'),
        // Rolling window shifted past line1: not an extension of what was streamed.
        ...update(state, 'bash-1', 'line2\nline3\n'),
        // Extends the latest snapshot, but appending it would skip line3.
        ...update(state, 'bash-1', 'line2\nline3\nline4\n'),
      ];

      expect(appended(chunks, 'bash-1')).toBe('line1\nline2\n');
      expect(normalizePiRPCEvent({
        result: { content: [{ text: 'line3\nline4\nline5\n', type: 'text' }] },
        toolCallId: 'bash-1',
        type: 'tool_execution_end',
      }, state)).toEqual([expect.objectContaining({
        content: 'line3\nline4\nline5\n',
        id: 'bash-1',
        type: 'tool_result',
      })]);
    });

    it('stops live output when a snapshot resets and completes with the latest snapshot when the result has no text', () => {
      const state = createPiEventNormalizationState();
      const chunks = [
        ...update(state, 'bash-1', 'Deploying...'),
        ...update(state, 'bash-1', 'Done'),
      ];

      expect(appended(chunks, 'bash-1')).toBe('Deploying...');
      expect(normalizePiRPCEvent({
        toolCallId: 'bash-1',
        type: 'tool_execution_end',
      }, state)).toEqual([expect.objectContaining({ content: 'Done', id: 'bash-1', type: 'tool_result' })]);
      expect(state.toolOutputs.has('bash-1')).toBe(false);
    });
  });

  it('normalizes Pi RPC toolName and args to shared renderer tool shapes', () => {
    const state = createPiEventNormalizationState();

    expect(normalizePiRPCEvent({
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

    expect(normalizePiRPCEvent({
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

  it('maps Pi web extension tools to shared renderer names', () => {
    const state = createPiEventNormalizationState();

    expect(normalizePiRPCEvent({
      args: { count: 5, query: 'provider protocol' },
      toolCallId: 'web-search-1',
      toolName: 'web_search',
      type: 'tool_execution_start',
    }, state)).toEqual([{
      id: 'web-search-1',
      input: { count: 5, query: 'provider protocol' },
      name: 'WebSearch',
      type: 'tool_use',
    }]);

    expect(normalizePiRPCEvent({
      args: { url: 'https://example.com/reference' },
      toolCallId: 'web-fetch-1',
      toolName: 'web_fetch',
      type: 'tool_execution_start',
    }, state)).toEqual([{
      id: 'web-fetch-1',
      input: { url: 'https://example.com/reference' },
      name: 'WebFetch',
      type: 'tool_use',
    }]);
  });

  it('preserves Pi write/edit result payloads for diff extraction', () => {
    const state = createPiEventNormalizationState();

    expect(normalizePiRPCEvent({
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

    expect(normalizePiRPCEvent({
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
    expect(normalizePiRPCEvent({ type: 'compaction_end' }, state)).toEqual([{ type: 'context_compacted' }]);
    expect(normalizePiRPCEvent({ error: 'extension failed', type: 'extension_error' }, state)).toEqual([{
      content: 'extension failed',
      level: 'warning',
      type: 'notice',
    }]);
  });

  it('surfaces terminal Pi stop-reason errors', () => {
    const state = createPiEventNormalizationState();

    expect(normalizePiRPCEvent({
      errorMessage: 'Invalid image',
      stopReason: 'error',
      type: 'message_end',
    }, state)).toEqual([{ type: 'error', content: 'Invalid image' }]);

    expect(normalizePiRPCEvent({
      assistant_message_event: {
        error_message: 'Authentication failed',
        stop_reason: 'error',
      },
      type: 'turn_end',
    }, state)).toEqual([{ type: 'error', content: 'Authentication failed' }]);
  });

  it('reads terminal errors from the native Pi message payload', () => {
    expect(getPiTerminalErrorMessage({
      message: {
        content: [],
        errorMessage: 'OpenRouter quota exceeded',
        role: 'assistant',
        stopReason: 'error',
      },
      type: 'message_end',
    })).toBe('OpenRouter quota exceeded');
  });
});
