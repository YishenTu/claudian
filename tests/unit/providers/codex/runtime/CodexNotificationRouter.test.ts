import type { StreamChunk } from '@/core/types';
import { CodexNotificationRouter } from '@/providers/codex/runtime/CodexNotificationRouter';

describe('CodexNotificationRouter', () => {
  let router: CodexNotificationRouter;
  let chunks: StreamChunk[];
  let turnMetadata: Array<Record<string, unknown>>;

  beforeEach(() => {
    chunks = [];
    turnMetadata = [];
    router = new CodexNotificationRouter(
      (chunk) => chunks.push(chunk),
      (update) => turnMetadata.push(update),
    );
  });

  describe('text streaming', () => {
    it('maps item/agentMessage/delta to a text chunk', () => {
      router.handleNotification('item/agentMessage/delta', {
        threadId: 't1',
        turnId: 'turn1',
        itemId: 'msg1',
        delta: 'Hello',
      });

      expect(chunks).toEqual([{ type: 'text', content: 'Hello' }]);
    });

    it('accumulates multiple deltas', () => {
      router.handleNotification('item/agentMessage/delta', {
        threadId: 't1', turnId: 'turn1', itemId: 'msg1', delta: 'Hello',
      });
      router.handleNotification('item/agentMessage/delta', {
        threadId: 't1', turnId: 'turn1', itemId: 'msg1', delta: ' world',
      });

      expect(chunks).toEqual([
        { type: 'text', content: 'Hello' },
        { type: 'text', content: ' world' },
      ]);
    });

    it('emits only missing assistant text from raw completed messages', () => {
      router.handleNotification('item/agentMessage/delta', {
        threadId: 't1',
        turnId: 'turn1',
        itemId: 'msg1',
        delta: 'Hel',
      });
      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Hello' }],
        },
      });

      expect(chunks).toEqual([
        { type: 'text', content: 'Hel' },
        { type: 'text', content: 'lo' },
      ]);
    });

    it('deduplicates raw completed text against the current post-tool assistant segment', () => {
      router.handleNotification('item/agentMessage/delta', {
        threadId: 't1',
        turnId: 'turn1',
        itemId: 'msg1',
        delta: 'First',
      });
      router.handleNotification('item/started', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'commandExecution',
          id: 'call_abc',
          command: 'echo tool',
          cwd: '/workspace',
          processId: '123',
          source: 'unifiedExecStartup',
          status: 'inProgress',
          commandActions: [{ type: 'unknown', command: 'echo tool' }],
          aggregatedOutput: null,
          exitCode: null,
          durationMs: null,
        },
      });
      router.handleNotification('item/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'commandExecution',
          id: 'call_abc',
          command: 'echo tool',
          cwd: '/workspace',
          processId: '123',
          source: 'unifiedExecStartup',
          status: 'completed',
          commandActions: [{ type: 'unknown', command: 'echo tool' }],
          aggregatedOutput: 'tool\n',
          exitCode: 0,
          durationMs: 10,
        },
      });
      router.handleNotification('item/agentMessage/delta', {
        threadId: 't1',
        turnId: 'turn1',
        itemId: 'msg2',
        delta: 'Sec',
      });
      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Second' }],
        },
      });

      expect(chunks.filter(chunk => chunk.type === 'text')).toEqual([
        { type: 'text', content: 'First' },
        { type: 'text', content: 'Sec' },
        { type: 'text', content: 'ond' },
      ]);
    });

    it('does not render raw user bootstrap messages as assistant text', () => {
      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: '# AGENTS.md instructions for /vault\n\n<INSTRUCTIONS>\nDo good work.\n</INSTRUCTIONS>' },
            { type: 'input_text', text: '<environment_context>\n  <cwd>/vault</cwd>\n</environment_context>' },
          ],
        },
      });

      expect(chunks).toEqual([]);
    });

    it('does not render raw developer instruction messages as assistant text', () => {
      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'message',
          role: 'developer',
          content: [
            { type: 'input_text', text: '<permissions instructions>\nSandbox mode...\n</permissions instructions>' },
          ],
        },
      });

      expect(chunks).toEqual([]);
    });
  });

  describe('reasoning', () => {
    it('does not emit a chunk when a reasoning item starts (deltas carry content)', () => {
      router.handleNotification('item/started', {
        item: { type: 'reasoning', id: 'rs1', summary: [], content: [] },
        threadId: 't1',
        turnId: 'turn1',
      });

      expect(chunks).toHaveLength(0);
    });

    it('streams reasoning summary deltas as thinking chunks', () => {
      router.handleNotification('item/reasoning/summaryTextDelta', {
        threadId: 't1',
        turnId: 'turn1',
        itemId: 'rs1',
        summaryIndex: 0,
        delta: '**Analyzing',
      });
      router.handleNotification('item/reasoning/summaryTextDelta', {
        threadId: 't1',
        turnId: 'turn1',
        itemId: 'rs1',
        summaryIndex: 0,
        delta: ' the code**',
      });

      expect(chunks).toEqual([
        { type: 'thinking', content: '**Analyzing' },
        { type: 'thinking', content: ' the code**' },
      ]);
    });

    it('streams raw reasoning text deltas as thinking chunks', () => {
      router.handleNotification('item/reasoning/textDelta', {
        threadId: 't1',
        turnId: 'turn1',
        itemId: 'rs1',
        contentIndex: 0,
        delta: 'Checking raw reasoning',
      });

      expect(chunks).toEqual([{ type: 'thinking', content: 'Checking raw reasoning' }]);
    });

    it('ignores item/reasoning/summaryPartAdded (no-op boundary)', () => {
      router.handleNotification('item/reasoning/summaryPartAdded', {
        threadId: 't1',
        turnId: 'turn1',
        itemId: 'rs1',
        summaryIndex: 0,
      });

      expect(chunks).toHaveLength(0);
    });
  });

  describe('tool use', () => {
    it('maps commandExecution item/started to tool_use chunk', () => {
      router.handleNotification('item/started', {
        item: {
          type: 'commandExecution',
          id: 'call_abc',
          command: '/bin/zsh -lc \'echo test\'',
          cwd: '/workspace',
          processId: '123',
          source: 'unifiedExecStartup',
          status: 'inProgress',
          commandActions: [{ type: 'unknown', command: 'echo test' }],
          aggregatedOutput: null,
          exitCode: null,
          durationMs: null,
        },
        threadId: 't1',
        turnId: 'turn1',
      });

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toMatchObject({
        type: 'tool_use',
        id: 'call_abc',
        name: 'Bash',
        input: { command: 'echo test' },
      });
    });

    it('maps commandExecution item/completed to tool_result chunk', () => {
      router.handleNotification('item/completed', {
        item: {
          type: 'commandExecution',
          id: 'call_abc',
          command: 'echo test',
          cwd: '/workspace',
          processId: '123',
          source: 'unifiedExecStartup',
          status: 'completed',
          commandActions: [{ type: 'unknown', command: 'echo test' }],
          aggregatedOutput: 'test\n',
          exitCode: 0,
          durationMs: 100,
        },
        threadId: 't1',
        turnId: 'turn1',
      });

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toMatchObject({
        type: 'tool_result',
        id: 'call_abc',
        content: 'test\n',
        isError: false,
      });
    });

    it('marks tool_result as error when exitCode is non-zero', () => {
      router.handleNotification('item/completed', {
        item: {
          type: 'commandExecution',
          id: 'call_abc',
          command: 'false',
          cwd: '/workspace',
          processId: '123',
          source: 'unifiedExecStartup',
          status: 'completed',
          commandActions: [],
          aggregatedOutput: 'Error: exit 1',
          exitCode: 1,
          durationMs: 10,
        },
        threadId: 't1',
        turnId: 'turn1',
      });

      expect(chunks[0]).toMatchObject({
        type: 'tool_result',
        isError: true,
      });
    });

    it('maps raw response function calls to tool chunks without JSONL tailing', () => {
      router.beginTurn({ isPlanTurn: false });

      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'function_call',
          name: 'exec_command',
          call_id: 'call_raw',
          arguments: '{"cmd":"ls -1"}',
        },
      });
      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'function_call_output',
          call_id: 'call_raw',
          output: 'Exit code: 0\nOutput:\nfile.txt',
        },
      });
      router.handleNotification('turn/completed', {
        threadId: 't1',
        turn: { id: 'turn1', items: [], status: 'completed', error: null },
      });

      expect(chunks).toContainEqual({
        type: 'tool_use',
        id: 'call_raw',
        name: 'Bash',
        input: { command: 'ls -1' },
      });
      expect(chunks).toContainEqual({
        type: 'tool_result',
        id: 'call_raw',
        content: 'file.txt',
        isError: false,
      });
      expect(chunks[chunks.length - 1]).toEqual({ type: 'done' });
    });

    it('does not normalize raw command output a second time when item/completed arrives', () => {
      router.beginTurn({ isPlanTurn: false });

      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'function_call',
          name: 'exec_command',
          call_id: 'call_raw_json',
          arguments: '{"cmd":"printf json"}',
        },
      });
      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'function_call_output',
          call_id: 'call_raw_json',
          output: 'Exit code: 0\nOutput:\n{"output":"literal"}',
        },
      });
      router.handleNotification('item/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'commandExecution',
          id: 'call_raw_json',
          command: 'printf json',
          cwd: '/workspace',
          processId: '123',
          source: 'unifiedExecStartup',
          status: 'completed',
          commandActions: [{ type: 'unknown', command: 'printf json' }],
          aggregatedOutput: 'Exit code: 0\nOutput:\n{"output":"literal"}',
          exitCode: 0,
          durationMs: 10,
        },
      });

      expect(chunks).toContainEqual({
        type: 'tool_result',
        id: 'call_raw_json',
        content: '{"output":"literal"}',
        isError: false,
      });
      expect(chunks).not.toContainEqual(expect.objectContaining({
        type: 'tool_result',
        id: 'call_raw_json',
        content: 'literal',
      }));
    });

    it('preserves non-empty raw write_stdin calls as visible tool chunks', () => {
      router.beginTurn({ isPlanTurn: false });

      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'function_call',
          name: 'write_stdin',
          call_id: 'call_stdin',
          arguments: '{"session_id":2404,"chars":"y\\n"}',
        },
      });
      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'function_call_output',
          call_id: 'call_stdin',
          output: 'Input sent.',
        },
      });
      router.handleNotification('turn/completed', {
        threadId: 't1',
        turn: { id: 'turn1', items: [], status: 'completed', error: null },
      });

      expect(chunks).toContainEqual({
        type: 'tool_use',
        id: 'call_stdin',
        name: 'write_stdin',
        input: { session_id: 2404, chars: 'y\n' },
      });
      expect(chunks).toContainEqual({
        type: 'tool_result',
        id: 'call_stdin',
        content: 'Input sent.',
        isError: false,
      });
    });

    it('does not duplicate item/started when raw response already emitted the tool_use', () => {
      router.beginTurn({ isPlanTurn: false });

      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'function_call',
          name: 'exec_command',
          call_id: 'call_raw',
          arguments: '{"command":"pwd"}',
        },
      });
      router.handleNotification('item/started', {
        item: {
          type: 'commandExecution',
          id: 'call_raw',
          command: 'pwd',
          cwd: '/workspace',
          processId: '123',
          source: 'unifiedExecStartup',
          status: 'inProgress',
          commandActions: [{ type: 'unknown', command: 'pwd' }],
          aggregatedOutput: null,
          exitCode: null,
          durationMs: null,
        },
        threadId: 't1',
        turnId: 'turn1',
      });

      expect(chunks.filter(chunk => chunk.type === 'tool_use')).toHaveLength(1);
    });

    it('suppresses raw apply_patch transport rows so fileChange remains the owner', () => {
      router.beginTurn({ isPlanTurn: false });

      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call',
          name: 'apply_patch',
          call_id: 'patch_raw',
          input: '*** Begin Patch\n*** End Patch',
        },
      });
      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call_output',
          call_id: 'patch_raw',
          output: 'Success. Updated files.',
        },
      });
      router.handleNotification('turn/completed', {
        threadId: 't1',
        turn: { id: 'turn1', items: [], status: 'completed', error: null },
      });

      expect(chunks).toEqual([{ type: 'done' }]);
    });

    it('maps fileChange item/started to tool_use chunk', () => {
      router.handleNotification('item/started', {
        item: {
          type: 'fileChange',
          id: 'call_fc1',
          changes: [{ path: '/workspace/foo.ts', type: 'modify' }],
        },
        threadId: 't1',
        turnId: 'turn1',
      });

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toMatchObject({
        type: 'tool_use',
        id: 'call_fc1',
        name: 'apply_patch',
      });
    });

    it('emits fileChange tool input before completed result so final diffs can update the renderer', () => {
      router.handleNotification('item/completed', {
        item: {
          type: 'fileChange',
          id: 'call_fc_done',
          status: 'completed',
          changes: [
            {
              path: '/workspace/foo.ts',
              kind: 'update',
              diff: '@@ -1 +1 @@\n-old\n+new',
            },
          ],
        },
        threadId: 't1',
        turnId: 'turn1',
      });

      expect(chunks).toEqual([
        {
          type: 'tool_use',
          id: 'call_fc_done',
          name: 'apply_patch',
          input: {
            changes: [
              {
                path: '/workspace/foo.ts',
                kind: 'update',
                type: 'update',
                diff: '@@ -1 +1 @@\n-old\n+new',
              },
            ],
          },
        },
        {
          type: 'tool_result',
          id: 'call_fc_done',
          content: 'update: /workspace/foo.ts',
          isError: false,
        },
      ]);
    });

    it('maps fileChange patchUpdated diffs into apply_patch tool input', () => {
      router.handleNotification('item/fileChange/patchUpdated', {
        threadId: 't1',
        turnId: 'turn1',
        itemId: 'call_patch',
        changes: [
          {
            path: '/workspace/foo.ts',
            kind: { type: 'update', move_path: null },
            diff: '@@ -1 +1 @@\n-old\n+new',
          },
        ],
      });

      expect(chunks).toEqual([
        {
          type: 'tool_use',
          id: 'call_patch',
          name: 'apply_patch',
          input: {
            changes: [
              {
                path: '/workspace/foo.ts',
                kind: 'update',
                type: 'update',
                diff: '@@ -1 +1 @@\n-old\n+new',
              },
            ],
          },
        },
      ]);
    });

    it('merges raw apply_patch input into the fileChange-owned tool call', () => {
      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call',
          name: 'apply_patch',
          call_id: 'call_patch',
          input: '*** Begin Patch\n*** Update File: /workspace/foo.ts\n@@\n-old\n+new\n*** End Patch',
        },
      });
      router.handleNotification('item/started', {
        item: {
          type: 'fileChange',
          id: 'call_patch',
          changes: [{ path: '/workspace/foo.ts', type: 'update' }],
        },
        threadId: 't1',
        turnId: 'turn1',
      });

      expect(chunks).toEqual([
        {
          type: 'tool_use',
          id: 'call_patch',
          name: 'apply_patch',
          input: {
            patch: '*** Begin Patch\n*** Update File: /workspace/foo.ts\n@@\n-old\n+new\n*** End Patch',
            changes: [{ path: '/workspace/foo.ts', kind: 'update', type: 'update' }],
          },
        },
      ]);
    });
  });

  describe('plan and compaction events', () => {
    it('streams item/plan/delta as text chunks', () => {
      router.handleNotification('item/plan/delta', {
        threadId: 't1',
        turnId: 'turn1',
        itemId: 'plan-1',
        delta: '- Investigate failing tests',
      });

      expect(chunks).toEqual([{ type: 'text', content: '- Investigate failing tests' }]);
    });

    it('does not emit context_compacted when a context compaction item starts', () => {
      router.handleNotification('item/started', {
        item: { type: 'contextCompaction', id: 'compact-1' },
        threadId: 't1',
        turnId: 'turn1',
      });

      expect(chunks).toEqual([]);
    });

    it('emits context_compacted when a context compaction item completes', () => {
      router.handleNotification('item/completed', {
        item: { type: 'contextCompaction', id: 'compact-1' },
        threadId: 't1',
        turnId: 'turn1',
      });

      expect(chunks).toEqual([{ type: 'context_compacted' }]);
    });
  });

  describe('imageView tool', () => {
    it('maps imageView item/started to tool_use chunk', () => {
      router.handleNotification('item/started', {
        item: {
          type: 'imageView',
          id: 'call_img1',
          path: '/vault/attachments/cat.png',
        },
        threadId: 't1',
        turnId: 'turn1',
      });

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toMatchObject({
        type: 'tool_use',
        id: 'call_img1',
        name: 'Read',
        input: { file_path: '/vault/attachments/cat.png' },
      });
    });

    it('maps imageView item/completed to tool_result chunk', () => {
      router.handleNotification('item/completed', {
        item: {
          type: 'imageView',
          id: 'call_img1',
          path: '/vault/attachments/cat.png',
        },
        threadId: 't1',
        turnId: 'turn1',
      });

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toMatchObject({
        type: 'tool_result',
        id: 'call_img1',
        isError: false,
      });
    });
  });

  describe('webSearch tool', () => {
    it('maps webSearch item/started to tool_use chunk', () => {
      router.handleNotification('item/started', {
        item: {
          type: 'webSearch',
          id: 'ws_abc',
          query: 'codex documentation',
        },
        threadId: 't1',
        turnId: 'turn1',
      });

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toMatchObject({
        type: 'tool_use',
        id: 'ws_abc',
        name: 'WebSearch',
        input: { query: 'codex documentation' },
      });
    });

    it('preserves open_page metadata from webSearch items', () => {
      router.handleNotification('item/started', {
        item: {
          type: 'webSearch',
          id: 'ws_open',
          action: {
            type: 'open_page',
            url: 'https://example.com/docs',
          },
        },
        threadId: 't1',
        turnId: 'turn1',
      });

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toMatchObject({
        type: 'tool_use',
        id: 'ws_open',
        name: 'WebSearch',
        input: { actionType: 'open_page', url: 'https://example.com/docs' },
      });
    });

    it('maps webSearch item/completed to tool_result chunk', () => {
      router.handleNotification('item/completed', {
        item: {
          type: 'webSearch',
          id: 'ws_abc',
          query: 'codex documentation',
          status: 'completed',
        },
        threadId: 't1',
        turnId: 'turn1',
      });

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toMatchObject({
        type: 'tool_result',
        id: 'ws_abc',
        isError: false,
      });
    });

    it('deduplicates webSearch started events for same id', () => {
      router.handleNotification('item/started', {
        item: { type: 'webSearch', id: 'ws_dup', query: 'first' },
        threadId: 't1',
        turnId: 'turn1',
      });
      router.handleNotification('item/started', {
        item: { type: 'webSearch', id: 'ws_dup', query: 'second' },
        threadId: 't1',
        turnId: 'turn1',
      });

      const toolUseChunks = chunks.filter(c => c.type === 'tool_use');
      expect(toolUseChunks).toHaveLength(1);
    });
  });

  describe('collabAgentToolCall', () => {
    it('maps collabAgentToolCall item/started to tool_use chunk', () => {
      router.handleNotification('item/started', {
        item: {
          type: 'collabAgentToolCall',
          id: 'call_agent1',
          tool: 'spawnAgent',
          status: 'inProgress',
        },
        threadId: 't1',
        turnId: 'turn1',
      });

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toMatchObject({
        type: 'tool_use',
        id: 'call_agent1',
        name: 'spawn_agent',
      });
    });

    it('maps collabAgentToolCall item/completed to tool_result chunk', () => {
      router.handleNotification('item/completed', {
        item: {
          type: 'collabAgentToolCall',
          id: 'call_agent1',
          tool: 'spawnAgent',
          status: 'completed',
        },
        threadId: 't1',
        turnId: 'turn1',
      });

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toMatchObject({
        type: 'tool_result',
        id: 'call_agent1',
        isError: false,
      });
    });
  });

  describe('token usage', () => {
    it('maps thread/tokenUsage/updated to usage chunk using last call usage', () => {
      router.handleNotification('thread/tokenUsage/updated', {
        threadId: 't1',
        turnId: 'turn1',
        tokenUsage: {
          total: {
            totalTokens: 20000,
            inputTokens: 18000,
            cachedInputTokens: 5000,
            outputTokens: 2000,
            reasoningOutputTokens: 500,
          },
          last: {
            totalTokens: 10000,
            inputTokens: 9000,
            cachedInputTokens: 5000,
            outputTokens: 1000,
            reasoningOutputTokens: 200,
          },
          modelContextWindow: 200000,
        },
      });

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toMatchObject({
        type: 'usage',
        usage: {
          inputTokens: 9000,
          cacheReadInputTokens: 5000,
          cacheCreationInputTokens: 0,
          contextWindow: 200000,
          contextWindowIsAuthoritative: true,
          contextTokens: 9000,
          percentage: 5,
        },
      });
    });
  });

  describe('turn completion', () => {
    it('records assistant turn metadata then emits done on completion', () => {
      router.handleNotification('turn/completed', {
        threadId: 't1',
        turn: { id: 'turn1', items: [], status: 'completed', error: null },
      });

      expect(turnMetadata).toContainEqual({ assistantMessageId: 'turn1' });
      expect(chunks).toEqual([{ type: 'done' }]);
    });

    it('emits error then done on turn/completed with status failed', () => {
      router.handleNotification('turn/completed', {
        threadId: 't1',
        turn: {
          id: 'turn1',
          items: [],
          status: 'failed',
          error: { message: 'Model error', codexErrorInfo: 'other', additionalDetails: null },
        },
      });

      expect(chunks).toEqual([
        { type: 'error', content: 'Model error' },
        { type: 'done' },
      ]);
    });

    it('emits done on turn/completed with status interrupted', () => {
      router.handleNotification('turn/completed', {
        threadId: 't1',
        turn: { id: 'turn1', items: [], status: 'interrupted', error: null },
      });

      expect(chunks).toEqual([{ type: 'done' }]);
    });
  });

  describe('turn/plan/updated (update_plan tool)', () => {
    it('emits tool_use and tool_result from plan notification', () => {
      router.handleNotification('turn/plan/updated', {
        threadId: 't1',
        turnId: 'turn1',
        explanation: null,
        plan: [
          { step: 'Research', status: 'inProgress' },
          { step: 'Implement', status: 'pending' },
          { step: 'Test', status: 'pending' },
        ],
      });

      expect(chunks).toHaveLength(2);
      expect(chunks[0]).toMatchObject({
        type: 'tool_use',
        name: 'TodoWrite',
        input: {
          todos: [
            { content: 'Research', status: 'in_progress' },
            { content: 'Implement', status: 'pending' },
            { content: 'Test', status: 'pending' },
          ],
        },
      });
      expect(chunks[1]).toMatchObject({
        type: 'tool_result',
        content: 'Plan updated',
        isError: false,
      });
    });

  });

  describe('mcpToolCall', () => {
    it('maps mcpToolCall item/started to tool_use chunk with server__tool name', () => {
      router.handleNotification('item/started', {
        item: {
          type: 'mcpToolCall',
          id: 'call_mcp1',
          server: 'codex',
          tool: 'list_mcp_resources',
          status: 'inProgress',
          arguments: {},
          result: null,
          error: null,
          durationMs: null,
        },
        threadId: 't1',
        turnId: 'turn1',
      });

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toMatchObject({
        type: 'tool_use',
        id: 'call_mcp1',
        name: 'mcp__codex__list_mcp_resources',
        input: {},
      });
    });

    it('maps mcpToolCall item/completed to tool_result with content text', () => {
      router.handleNotification('item/completed', {
        item: {
          type: 'mcpToolCall',
          id: 'call_mcp1',
          server: 'codex',
          tool: 'list_mcp_resources',
          status: 'completed',
          arguments: {},
          result: { content: [{ type: 'text', text: '{"resources":[]}' }] },
          error: null,
          durationMs: 444,
        },
        threadId: 't1',
        turnId: 'turn1',
      });

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toMatchObject({
        type: 'tool_result',
        id: 'call_mcp1',
        content: '{"resources":[]}',
        isError: false,
      });
    });

    it('maps failed mcpToolCall to error tool_result', () => {
      router.handleNotification('item/completed', {
        item: {
          type: 'mcpToolCall',
          id: 'call_mcp2',
          server: 'test',
          tool: 'broken_tool',
          status: 'failed',
          arguments: {},
          result: null,
          error: 'Connection refused',
          durationMs: 100,
        },
        threadId: 't1',
        turnId: 'turn1',
      });

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toMatchObject({
        type: 'tool_result',
        id: 'call_mcp2',
        content: 'Connection refused',
        isError: true,
      });
    });
  });

  describe('plan_completed emission', () => {
    it('records plan completion metadata before done on successful plan turn with plan deltas', () => {
      router.beginTurn({ isPlanTurn: true });

      router.handleNotification('item/plan/delta', {
        threadId: 't1', turnId: 'turn1', itemId: 'plan-1', delta: 'Plan step 1',
      });
      router.handleNotification('turn/completed', {
        threadId: 't1',
        turn: { id: 'turn1', items: [], status: 'completed', error: null },
      });

      expect(turnMetadata).toContainEqual(expect.objectContaining({ planCompleted: true }));
      expect(chunks.map(c => c.type)).toContain('done');
    });

    it('does not emit plan_completed when no plan delta was seen', () => {
      router.beginTurn({ isPlanTurn: true });

      router.handleNotification('turn/completed', {
        threadId: 't1',
        turn: { id: 'turn1', items: [], status: 'completed', error: null },
      });

      expect(chunks.map(c => c.type)).not.toContain('plan_completed');
      expect(chunks.map(c => c.type)).toContain('done');
    });

    it('does not emit plan_completed when turn failed', () => {
      router.beginTurn({ isPlanTurn: true });

      router.handleNotification('item/plan/delta', {
        threadId: 't1', turnId: 'turn1', itemId: 'plan-1', delta: 'Step',
      });
      router.handleNotification('turn/completed', {
        threadId: 't1',
        turn: {
          id: 'turn1', items: [], status: 'failed',
          error: { message: 'Error', codexErrorInfo: 'other', additionalDetails: null },
        },
      });

      expect(chunks.map(c => c.type)).not.toContain('plan_completed');
    });

    it('does not emit plan_completed when beginTurn was called with isPlanTurn: false', () => {
      router.beginTurn({ isPlanTurn: false });

      router.handleNotification('item/plan/delta', {
        threadId: 't1', turnId: 'turn1', itemId: 'plan-1', delta: 'Step',
      });
      router.handleNotification('turn/completed', {
        threadId: 't1',
        turn: { id: 'turn1', items: [], status: 'completed', error: null },
      });

      expect(chunks.map(c => c.type)).not.toContain('plan_completed');
    });

    it('does not emit plan_completed when beginTurn was not called', () => {
      router.handleNotification('item/plan/delta', {
        threadId: 't1', turnId: 'turn1', itemId: 'plan-1', delta: 'Step',
      });
      router.handleNotification('turn/completed', {
        threadId: 't1',
        turn: { id: 'turn1', items: [], status: 'completed', error: null },
      });

      expect(chunks.map(c => c.type)).not.toContain('plan_completed');
    });

    it('resets plan state after endTurn', () => {
      router.beginTurn({ isPlanTurn: true });
      router.handleNotification('item/plan/delta', {
        threadId: 't1', turnId: 'turn1', itemId: 'plan-1', delta: 'Step',
      });
      router.endTurn();

      // New turn without beginTurn should not emit plan_completed
      router.handleNotification('turn/completed', {
        threadId: 't1',
        turn: { id: 'turn2', items: [], status: 'completed', error: null },
      });

      expect(chunks.map(c => c.type)).not.toContain('plan_completed');
    });
  });

  describe('error notifications', () => {
    it('emits error chunk for non-retryable error', () => {
      router.handleNotification('error', {
        error: { message: 'fatal error', codexErrorInfo: 'other', additionalDetails: null },
        willRetry: false,
        threadId: 't1',
        turnId: 'turn1',
      });

      expect(chunks).toEqual([{ type: 'error', content: 'fatal error' }]);
    });

    it('does not emit error chunk for retryable errors', () => {
      router.handleNotification('error', {
        error: { message: 'Reconnecting... 1/5', codexErrorInfo: 'other', additionalDetails: null },
        willRetry: true,
        threadId: 't1',
        turnId: 'turn1',
      });

      expect(chunks).toHaveLength(0);
    });
  });

  describe('command execution output delta', () => {
    it('emits tool_output chunk for incremental command output', () => {
      router.handleNotification('item/commandExecution/outputDelta', {
        threadId: 't1',
        turnId: 'turn1',
        itemId: 'call_1',
        delta: 'line 1\n',
      });

      expect(chunks).toEqual([
        { type: 'tool_output', id: 'call_1', content: 'line 1\n' },
      ]);
    });

    it('accumulates multiple output deltas', () => {
      router.handleNotification('item/commandExecution/outputDelta', {
        threadId: 't1', turnId: 'turn1', itemId: 'call_1', delta: 'line 1\n',
      });
      router.handleNotification('item/commandExecution/outputDelta', {
        threadId: 't1', turnId: 'turn1', itemId: 'call_1', delta: 'line 2\n',
      });

      expect(chunks).toHaveLength(2);
      expect(chunks[0]).toEqual({ type: 'tool_output', id: 'call_1', content: 'line 1\n' });
      expect(chunks[1]).toEqual({ type: 'tool_output', id: 'call_1', content: 'line 2\n' });
    });
  });

  describe('file change output delta', () => {
    it('emits tool_output chunk for incremental file change output', () => {
      router.handleNotification('item/fileChange/outputDelta', {
        threadId: 't1',
        turnId: 'turn1',
        itemId: 'fc_1',
        delta: 'Applied patch to foo.ts',
      });

      expect(chunks).toEqual([
        { type: 'tool_output', id: 'fc_1', content: 'Applied patch to foo.ts' },
      ]);
    });
  });

  describe('ignored notifications', () => {
    it('ignores mcpServer/startupStatus/updated', () => {
      router.handleNotification('mcpServer/startupStatus/updated', { name: 'test', status: 'ready' });
      expect(chunks).toHaveLength(0);
    });

    it('ignores account/rateLimits/updated', () => {
      router.handleNotification('account/rateLimits/updated', { rateLimits: {} });
      expect(chunks).toHaveLength(0);
    });

    it('maps userMessage item/started to a user_message_start chunk', () => {
      router.handleNotification('item/started', {
        item: { type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'hi' }] },
        threadId: 't1',
        turnId: 'turn1',
      });
      expect(chunks).toEqual([
        { type: 'user_message_start', itemId: 'u1', content: 'hi' },
      ]);
    });

    it('maps agentMessage item/started to an assistant_message_start chunk', () => {
      router.handleNotification('item/started', {
        item: { type: 'agentMessage', id: 'a1', text: '', phase: 'streaming', memoryCitation: null },
        threadId: 't1',
        turnId: 'turn1',
      });

      expect(chunks).toEqual([
        { type: 'assistant_message_start', itemId: 'a1' },
      ]);
    });
  });

  describe('assistant metadata emission', () => {
    it('records assistant metadata before done on completed turn', () => {
      router.handleNotification('turn/completed', {
        threadId: 't1',
        turn: { id: 'turn-uuid-123', items: [], status: 'completed', error: null },
      });

      const types = chunks.map(c => c.type);
      expect(types).toContain('done');
      expect(turnMetadata).toContainEqual({ assistantMessageId: 'turn-uuid-123' });
    });

    it('does NOT record assistant metadata on failed turn', () => {
      router.handleNotification('turn/completed', {
        threadId: 't1',
        turn: {
          id: 'turn-failed-1',
          items: [],
          status: 'failed',
          error: { message: 'Error', codexErrorInfo: 'other', additionalDetails: null },
        },
      });

      expect(turnMetadata).toEqual([]);
    });

    it('does NOT record assistant metadata on interrupted turn', () => {
      router.handleNotification('turn/completed', {
        threadId: 't1',
        turn: { id: 'turn-interrupted-1', items: [], status: 'interrupted', error: null },
      });

      expect(turnMetadata).toEqual([]);
    });
  });
});
