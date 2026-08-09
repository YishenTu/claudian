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
      '/workspace',
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

    it('emits only the missing suffix from a completed agent message', () => {
      router.handleNotification('item/started', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'agentMessage',
          id: 'msg1',
          text: '',
          phase: 'streaming',
          memoryCitation: null,
        },
      });
      router.handleNotification('item/agentMessage/delta', {
        threadId: 't1',
        turnId: 'turn1',
        itemId: 'msg1',
        delta: 'Hel',
      });
      router.handleNotification('item/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'agentMessage',
          id: 'msg1',
          text: 'Hello',
          phase: 'final',
          memoryCitation: null,
        },
      });

      expect(chunks).toEqual([
        { type: 'assistant_message_start', itemId: 'msg1' },
        { type: 'text', content: 'Hel' },
        { type: 'text', content: 'lo' },
      ]);
    });

    it('does not repeat an earlier completed agent message after segment changes', () => {
      const startAgentMessage = (itemId: string) => {
        router.handleNotification('item/started', {
          threadId: 't1',
          turnId: 'turn1',
          item: {
            type: 'agentMessage',
            id: itemId,
            text: '',
            phase: 'streaming',
            memoryCitation: null,
          },
        });
      };
      startAgentMessage('msg1');
      router.handleNotification('item/agentMessage/delta', {
        threadId: 't1',
        turnId: 'turn1',
        itemId: 'msg1',
        delta: 'First',
      });
      startAgentMessage('msg2');
      router.handleNotification('item/agentMessage/delta', {
        threadId: 't1',
        turnId: 'turn1',
        itemId: 'msg2',
        delta: 'Second',
      });
      router.handleNotification('item/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'agentMessage',
          id: 'msg1',
          text: 'First',
          phase: 'final',
          memoryCitation: null,
        },
      });

      expect(chunks.filter(chunk => chunk.type === 'text')).toEqual([
        { type: 'text', content: 'First' },
        { type: 'text', content: 'Second' },
      ]);
    });

    it('does not append raw memory citation markup after streamed text', () => {
      router.handleNotification('item/agentMessage/delta', {
        threadId: 't1',
        turnId: 'turn1',
        itemId: 'msg1',
        delta: 'Answer\n',
      });
      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'message',
          role: 'assistant',
          content: [{
            type: 'output_text',
            text: [
              'Answer',
              '<oai-mem-citation>',
              '<citation_entries>',
              'MEMORY.md:10-12|note=[Used project conventions]',
              '</citation_entries>',
              '<rollout_ids>',
              '</rollout_ids>',
              '</oai-mem-citation>',
            ].join('\n'),
          }],
        },
      });

      expect(chunks).toEqual([{ type: 'text', content: 'Answer\n' }]);
    });

    it('hides an unterminated raw memory citation block', () => {
      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'message',
          role: 'assistant',
          content: [{
            type: 'output_text',
            text: 'Answer<oai-mem-citation>unfinished citation',
          }],
        },
      });

      expect(chunks).toEqual([{ type: 'text', content: 'Answer' }]);
    });

    it('emits structured memory citations from a completed agent message', () => {
      router.handleNotification('item/started', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'agentMessage',
          id: 'msg1',
          text: '',
          phase: 'streaming',
          memoryCitation: null,
        },
      });
      router.handleNotification('item/agentMessage/delta', {
        threadId: 't1',
        turnId: 'turn1',
        itemId: 'msg1',
        delta: 'Answer',
      });
      router.handleNotification('item/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'agentMessage',
          id: 'msg1',
          text: 'Answer',
          phase: 'final_answer',
          memoryCitation: {
            entries: [{
              path: 'MEMORY.md',
              lineStart: 10,
              lineEnd: 12,
              note: 'Used project conventions',
            }],
            threadIds: ['thread-1'],
          },
        },
      });

      expect(chunks).toEqual([
        { type: 'assistant_message_start', itemId: 'msg1' },
        { type: 'text', content: 'Answer' },
        {
          type: 'citations',
          citations: {
            kind: 'memory',
            entries: [{
              path: 'MEMORY.md',
              lineStart: 10,
              lineEnd: 12,
              note: 'Used project conventions',
            }],
          },
        },
      ]);
    });

    it('normalizes memory citations from event_msg fallback notifications without duplication', () => {
      const memoryCitation = {
        entries: [{
          path: 'MEMORY.md',
          lineStart: 10,
          lineEnd: 12,
          note: 'Used project conventions',
        }],
        rolloutIds: ['thread-1'],
      };
      router.handleNotification('item/started', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'agentMessage',
          id: 'msg1',
          text: '',
          phase: 'streaming',
          memoryCitation: null,
        },
      });
      router.handleNotification('event_msg', {
        type: 'agent_message',
        message: [
          'Answer',
          '<oai-mem-citation>',
          '<citation_entries>',
          'MEMORY.md:10-12|note=[Used project conventions]',
          '</citation_entries>',
          '<rollout_ids>',
          'thread-1',
          '</rollout_ids>',
          '</oai-mem-citation>',
        ].join('\n'),
        memory_citation: memoryCitation,
      });
      router.handleNotification('item/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'agentMessage',
          id: 'msg1',
          text: 'Answer\n',
          phase: 'final_answer',
          memoryCitation,
        },
      });

      expect(chunks).toEqual([
        { type: 'assistant_message_start', itemId: 'msg1' },
        { type: 'text', content: 'Answer\n' },
        {
          type: 'citations',
          citations: {
            kind: 'memory',
            entries: [{
              path: 'MEMORY.md',
              lineStart: 10,
              lineEnd: 12,
              note: 'Used project conventions',
            }],
          },
        },
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

      expect(chunks).toHaveLength(2);
      expect(chunks[1]).toMatchObject({
        type: 'tool_result',
        id: 'call_abc',
        content: 'test\n',
        isError: false,
      });
    });

    it('ignores a late same-ID raw Bash call after canonical command completion', () => {
      router.beginTurn({ isPlanTurn: false });
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
      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'call_abc',
          input: 'const r = await tools.exec_command({cmd:"echo test"}); text(r.output);',
        },
      });
      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call_output',
          call_id: 'call_abc',
          output: 'Script completed\nOutput:\ntest\n',
        },
      });

      expect(chunks.filter(chunk => chunk.type === 'tool_use')).toHaveLength(1);
      expect(chunks.filter(chunk => chunk.type === 'tool_result')).toHaveLength(1);
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

      expect(chunks).toHaveLength(2);
      expect(chunks[1]).toMatchObject({
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

    it('unwraps exec envelopes and completes them when the raw output arrives', () => {
      router.beginTurn({ isPlanTurn: false });

      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'call_exec_wrapper',
          input: 'const r = await tools.exec_command({cmd:"ls -1",workdir:"/workspace"}); text(r.output);',
        },
      });
      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call_output',
          call_id: 'call_exec_wrapper',
          output: [
            { type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' },
            { type: 'input_text', text: 'file.txt\n' },
          ],
        },
      });

      expect(chunks).toEqual([
        {
          type: 'tool_use',
          id: 'call_exec_wrapper',
          name: 'Bash',
          input: { command: 'ls -1' },
        },
        {
          type: 'tool_result',
          id: 'call_exec_wrapper',
          content: 'file.txt\n',
          isError: false,
        },
      ]);

      router.handleNotification('turn/completed', {
        threadId: 't1',
        turn: { id: 'turn1', items: [], status: 'completed', error: null },
      });

      expect(chunks.filter(chunk => chunk.type === 'tool_result')).toHaveLength(1);
      expect(chunks[chunks.length - 1]).toEqual({ type: 'done' });
    });

    it('keeps yielded exec envelopes running until their wait call completes', () => {
      router.beginTurn({ isPlanTurn: false });

      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'call_exec_wrapper',
          input: 'const r = await tools.exec_command({cmd:"npm test"}); text(r.output);',
        },
      });
      router.handleNotification('item/started', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'commandExecution',
          id: 'exec_canonical',
          command: 'npm test',
          cwd: '/workspace',
          processId: '123',
          source: 'unifiedExecStartup',
          status: 'inProgress',
          commandActions: [{ type: 'unknown', command: 'npm test' }],
          aggregatedOutput: null,
          exitCode: null,
          durationMs: null,
        },
      });
      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call_output',
          call_id: 'call_exec_wrapper',
          output: [
            { type: 'input_text', text: 'Script running with cell ID 42\nWall time 10.0 seconds\nOutput:\n' },
            { type: 'input_text', text: 'tests started\n' },
          ],
        },
      });
      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call_output',
          call_id: 'call_exec_wrapper',
          output: [
            { type: 'input_text', text: 'Script running with cell ID 42\nWall time 10.0 seconds\nOutput:\n' },
            { type: 'input_text', text: 'tests started\n' },
          ],
        },
      });
      router.handleNotification('item/commandExecution/outputDelta', {
        threadId: 't1',
        turnId: 'turn1',
        itemId: 'exec_canonical',
        delta: 'tests started\n',
      });
      router.handleNotification('item/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'commandExecution',
          id: 'exec_canonical',
          command: 'npm test',
          cwd: '/workspace',
          processId: '123',
          source: 'unifiedExecStartup',
          status: 'completed',
          commandActions: [{ type: 'unknown', command: 'npm test' }],
          aggregatedOutput: 'tests started\n',
          exitCode: 0,
          durationMs: 10_000,
        },
      });
      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'function_call',
          name: 'wait',
          call_id: 'call_wait_1',
          arguments: '{"cell_id":"42","yield_time_ms":30000}',
        },
      });
      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'function_call_output',
          call_id: 'call_wait_1',
          output: [
            { type: 'input_text', text: 'Script running with cell ID 42\nWall time 30.0 seconds\nOutput:\n' },
            { type: 'input_text', text: 'tests still running\n' },
          ],
        },
      });
      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'function_call',
          name: 'wait',
          call_id: 'call_wait_2',
          arguments: '{"cell_id":"42","yield_time_ms":30000}',
        },
      });
      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'function_call_output',
          call_id: 'call_wait_2',
          output: [
            { type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' },
            { type: 'input_text', text: 'tests passed\n' },
          ],
        },
      });

      expect(chunks).toEqual([
        {
          type: 'tool_use',
          id: 'call_exec_wrapper',
          name: 'Bash',
          input: { command: 'npm test' },
        },
        {
          type: 'tool_output',
          id: 'call_exec_wrapper',
          content: 'tests started\n',
        },
        {
          type: 'tool_output',
          id: 'call_exec_wrapper',
          content: 'tests still running\n',
        },
        {
          type: 'tool_result',
          id: 'call_exec_wrapper',
          content: 'tests started\ntests still running\ntests passed\n',
          isError: false,
        },
      ]);
    });

    it('binds a wait call and output that arrive before the yielded exec output', () => {
      router.beginTurn({ isPlanTurn: false });

      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'call_exec_wrapper',
          input: 'const r = await tools.exec_command({cmd:"npm test"}); text(r.output);',
        },
      });
      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'function_call',
          name: 'wait',
          call_id: 'call_wait',
          arguments: '{"cell_id":"42","yield_time_ms":30000}',
        },
      });
      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'function_call_output',
          call_id: 'call_wait',
          output: 'Script completed\nOutput:\ntests passed\n',
        },
      });
      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call_output',
          call_id: 'call_exec_wrapper',
          output: 'Script running with cell ID 42\nOutput:\ntests started\n',
        },
      });

      expect(chunks).toEqual([
        {
          type: 'tool_use',
          id: 'call_exec_wrapper',
          name: 'Bash',
          input: { command: 'npm test' },
        },
        {
          type: 'tool_output',
          id: 'call_exec_wrapper',
          content: 'tests started\n',
        },
        {
          type: 'tool_result',
          id: 'call_exec_wrapper',
          content: 'tests started\ntests passed\n',
          isError: false,
        },
      ]);
    });

    it('unwraps a raw-only apply_patch exec envelope when its output arrives', () => {
      router.beginTurn({ isPlanTurn: false });
      const patch = '*** Begin Patch\n*** Update File: note.md\n*** End Patch';

      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'call_patch_wrapper',
          input: `const patch = ${JSON.stringify(patch)};\ntext(await tools.apply_patch(patch));`,
        },
      });

      expect(chunks).toEqual([]);

      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call_output',
          call_id: 'call_patch_wrapper',
          output: 'Success. Updated files.',
        },
      });

      expect(chunks).toEqual([]);
      router.handleNotification('turn/completed', {
        threadId: 't1',
        turn: { id: 'turn1', items: [], status: 'completed', error: null },
      });

      expect(chunks).toEqual([
        {
          type: 'tool_use',
          id: 'call_patch_wrapper',
          name: 'apply_patch',
          input: { patch },
        },
        {
          type: 'tool_result',
          id: 'call_patch_wrapper',
          content: 'Success. Updated files.',
          isError: false,
        },
        { type: 'done' },
      ]);
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

    it('coalesces raw exec envelopes with canonical commands that use a different id', () => {
      router.beginTurn({ isPlanTurn: false });

      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call',
          id: 'ctc_raw',
          name: 'exec',
          call_id: 'call_raw',
          input: 'const r = await tools.exec_command({cmd:"pwd",workdir:"/workspace"}); text(r.output);',
        },
      });
      router.handleNotification('item/started', {
        item: {
          type: 'commandExecution',
          id: 'exec_canonical',
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
      router.handleNotification('item/completed', {
        item: {
          type: 'commandExecution',
          id: 'exec_canonical',
          command: 'pwd',
          cwd: '/workspace',
          processId: '123',
          source: 'unifiedExecStartup',
          status: 'completed',
          commandActions: [{ type: 'unknown', command: 'pwd' }],
          aggregatedOutput: '/workspace\n',
          exitCode: 0,
          durationMs: 10,
        },
        threadId: 't1',
        turnId: 'turn1',
      });
      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call_output',
          id: 'ctco_raw',
          call_id: 'call_raw',
          output: [
            { type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' },
            { type: 'input_text', text: '/workspace\n' },
          ],
        },
      });

      expect(chunks).toEqual([
        {
          type: 'tool_use',
          id: 'call_raw',
          name: 'Bash',
          input: { command: 'pwd' },
        },
        {
          type: 'tool_result',
          id: 'call_raw',
          content: '/workspace\n',
          isError: false,
        },
      ]);
    });

    it('ignores repeated terminal output for a raw-owned Bash call', () => {
      router.beginTurn({ isPlanTurn: false });

      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'call_raw',
          input: 'const r = await tools.exec_command({cmd:"pwd"}); text(r.output);',
        },
      });
      for (let index = 0; index < 2; index += 1) {
        router.handleNotification('rawResponseItem/completed', {
          threadId: 't1',
          turnId: 'turn1',
          item: {
            type: 'custom_tool_call_output',
            call_id: 'call_raw',
            output: 'Script completed\nOutput:\n/workspace\n',
          },
        });
      }
      router.handleNotification('turn/completed', {
        threadId: 't1',
        turn: { id: 'turn1', items: [], status: 'completed', error: null },
      });

      expect(chunks.filter(chunk => chunk.type === 'tool_result')).toHaveLength(1);
    });

    it('defers raw non-command exec envelopes to the canonical semantic item', () => {
      router.beginTurn({ isPlanTurn: false });
      const patch = '*** Begin Patch\n*** Add File: note.md\n+hello\n*** End Patch';

      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call',
          id: 'ctc_patch',
          name: 'exec',
          call_id: 'call_patch',
          input: `const patch = ${JSON.stringify(patch)}; text(await tools.apply_patch(patch));`,
        },
      });

      expect(chunks).toEqual([]);

      router.handleNotification('item/started', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'fileChange',
          id: 'exec_patch',
          changes: [{
            path: '/workspace/note.md',
            type: 'add',
            diff: '@@ -0,0 +1 @@\n+hello',
          }],
          status: 'inProgress',
        },
      });
      router.handleNotification('item/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'fileChange',
          id: 'exec_patch',
          changes: [{
            path: '/workspace/note.md',
            type: 'add',
            diff: '@@ -0,0 +1 @@\n+hello',
          }],
          status: 'completed',
        },
      });
      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call_output',
          id: 'ctco_patch',
          call_id: 'call_patch',
          output: 'Success. Updated files.',
        },
      });

      expect(chunks.filter(chunk => (
        chunk.type === 'tool_use' || chunk.type === 'tool_result'
      )).every(chunk => chunk.id === 'exec_patch')).toBe(true);
      expect(chunks.filter(chunk => chunk.type === 'tool_result')).toHaveLength(1);
    });

    it('does not recreate a claimed exec envelope from a repeated raw call', () => {
      router.beginTurn({ isPlanTurn: false });
      const rawCall = {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'call_image',
          input: 'const r = await tools.view_image({path:"/workspace/image.png"}); image(r.image_url);',
        },
      };

      router.handleNotification('rawResponseItem/completed', rawCall);
      router.handleNotification('item/started', {
        threadId: 't1',
        turnId: 'turn1',
        item: { type: 'imageView', id: 'image_canonical', path: '/workspace/image.png' },
      });
      router.handleNotification('rawResponseItem/completed', rawCall);
      router.handleNotification('item/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: { type: 'imageView', id: 'image_canonical', path: '/workspace/image.png' },
      });
      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call_output',
          call_id: 'call_image',
          output: 'Image viewed.',
        },
      });
      router.handleNotification('turn/completed', {
        threadId: 't1',
        turn: { id: 'turn1', items: [], status: 'completed', error: null },
      });

      expect(chunks.filter(chunk => chunk.type === 'tool_use')).toHaveLength(1);
      expect(chunks.filter(chunk => chunk.type === 'tool_result')).toHaveLength(1);
      expect(chunks.filter(chunk => (
        chunk.type === 'tool_use' || chunk.type === 'tool_result'
      )).every(chunk => chunk.id === 'image_canonical')).toBe(true);
    });

    it('replays Bash output that arrives before its raw call', () => {
      router.beginTurn({ isPlanTurn: false });

      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call_output',
          call_id: 'call_bash',
          output: 'Script completed\nOutput:\nready\n',
        },
      });
      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'call_bash',
          input: 'const r = await tools.exec_command({cmd:"printf ready"}); text(r.output);',
        },
      });

      expect(chunks).toEqual([
        {
          type: 'tool_use',
          id: 'call_bash',
          name: 'Bash',
          input: { command: 'printf ready' },
        },
        {
          type: 'tool_result',
          id: 'call_bash',
          content: 'ready\n',
          isError: false,
        },
      ]);
    });

    it('replays deferred non-Bash output that arrives before its raw call', () => {
      router.beginTurn({ isPlanTurn: false });

      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call_output',
          call_id: 'call_image',
          output: 'Image viewed.',
        },
      });
      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'call_image',
          input: 'const r = await tools.view_image({path:"/workspace/image.png"}); image(r.image_url);',
        },
      });
      router.handleNotification('turn/completed', {
        threadId: 't1',
        turn: { id: 'turn1', items: [], status: 'completed', error: null },
      });

      expect(chunks.filter(chunk => chunk.type === 'tool_use')).toHaveLength(1);
      expect(chunks.filter(chunk => chunk.type === 'tool_result')).toHaveLength(1);
      expect(chunks.filter(chunk => (
        chunk.type === 'tool_use' || chunk.type === 'tool_result'
      )).every(chunk => chunk.id === 'call_image')).toBe(true);
    });

    it('does not correlate raw and canonical patches that affect different paths', () => {
      router.beginTurn({ isPlanTurn: false });
      const patch = '*** Begin Patch\n*** Add File: raw-only.md\n+raw\n*** End Patch';

      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'call_raw_patch',
          input: `const patch = ${JSON.stringify(patch)}; text(await tools.apply_patch(patch));`,
        },
      });
      router.handleNotification('item/started', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'fileChange',
          id: 'canonical_other_patch',
          changes: [{ path: '/workspace/canonical-only.md', type: 'add' }],
          status: 'inProgress',
        },
      });
      router.handleNotification('item/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'fileChange',
          id: 'canonical_other_patch',
          changes: [{ path: '/workspace/canonical-only.md', type: 'add' }],
          status: 'completed',
        },
      });
      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call_output',
          call_id: 'call_raw_patch',
          output: 'Success. Updated files.',
        },
      });
      router.handleNotification('turn/completed', {
        threadId: 't1',
        turn: { id: 'turn1', items: [], status: 'completed', error: null },
      });

      const lifecycleIds = new Set(chunks
        .filter(chunk => chunk.type === 'tool_use' || chunk.type === 'tool_result')
        .map(chunk => chunk.id));
      expect(lifecycleIds).toEqual(new Set(['call_raw_patch', 'canonical_other_patch']));
    });

    it('does not correlate different patch content for the same path', () => {
      router.beginTurn({ isPlanTurn: false });
      const patch = '*** Begin Patch\n*** Add File: same.md\n+raw\n*** End Patch';

      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'call_raw_patch',
          input: `const patch = ${JSON.stringify(patch)}; text(await tools.apply_patch(patch));`,
        },
      });
      for (const method of ['item/started', 'item/completed']) {
        router.handleNotification(method, {
          threadId: 't1',
          turnId: 'turn1',
          item: {
            type: 'fileChange',
            id: 'canonical_other_patch',
            changes: [{
              path: '/workspace/same.md',
              type: 'add',
              diff: '@@ -0,0 +1 @@\n+canonical',
            }],
            status: method === 'item/started' ? 'inProgress' : 'completed',
          },
        });
      }
      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call_output',
          call_id: 'call_raw_patch',
          output: 'Success. Updated files.',
        },
      });
      router.handleNotification('turn/completed', {
        threadId: 't1',
        turn: { id: 'turn1', items: [], status: 'completed', error: null },
      });

      const lifecycleIds = new Set(chunks
        .filter(chunk => chunk.type === 'tool_use' || chunk.type === 'tool_result')
        .map(chunk => chunk.id));
      expect(lifecycleIds).toEqual(new Set(['call_raw_patch', 'canonical_other_patch']));
    });

    it('does not correlate identical edits in different patch contexts', () => {
      router.beginTurn({ isPlanTurn: false });
      const patch = [
        '*** Begin Patch',
        '*** Update File: same.md',
        '@@',
        ' section-a',
        '-old',
        '+new',
        '*** End Patch',
      ].join('\n');

      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'call_raw_patch',
          input: `const patch = ${JSON.stringify(patch)}; text(await tools.apply_patch(patch));`,
        },
      });
      for (const method of ['item/started', 'item/completed']) {
        router.handleNotification(method, {
          threadId: 't1',
          turnId: 'turn1',
          item: {
            type: 'fileChange',
            id: 'canonical_other_patch',
            changes: [{
              path: '/workspace/same.md',
              type: 'update',
              diff: '@@ -1,2 +1,2 @@\n section-b\n-old\n+new',
            }],
            status: method === 'item/started' ? 'inProgress' : 'completed',
          },
        });
      }
      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call_output',
          call_id: 'call_raw_patch',
          output: 'Success. Updated files.',
        },
      });
      router.handleNotification('turn/completed', {
        threadId: 't1',
        turn: { id: 'turn1', items: [], status: 'completed', error: null },
      });

      const lifecycleIds = new Set(chunks
        .filter(chunk => chunk.type === 'tool_use' || chunk.type === 'tool_result')
        .map(chunk => chunk.id));
      expect(lifecycleIds).toEqual(new Set(['call_raw_patch', 'canonical_other_patch']));
    });

    it('correlates matching patch hunks with named anchors', () => {
      router.beginTurn({ isPlanTurn: false });
      const patch = [
        '*** Begin Patch',
        '*** Update File: note.md',
        '@@ function target',
        ' context',
        '-old',
        '+new',
        '*** End Patch',
      ].join('\n');
      const change = {
        path: '/workspace/note.md',
        type: 'update',
        diff: '@@ -1,2 +1,2 @@ function target\n context\n-old\n+new',
      };

      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'call_raw_patch',
          input: `const patch = ${JSON.stringify(patch)}; text(await tools.apply_patch(patch));`,
        },
      });
      router.handleNotification('item/started', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'fileChange',
          id: 'canonical_patch',
          changes: [change],
          status: 'inProgress',
        },
      });
      router.handleNotification('item/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'fileChange',
          id: 'canonical_patch',
          changes: [change],
          status: 'completed',
        },
      });
      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call_output',
          call_id: 'call_raw_patch',
          output: 'Success. Updated files.',
        },
      });

      const lifecycleIds = chunks
        .filter(chunk => chunk.type === 'tool_use' || chunk.type === 'tool_result')
        .map(chunk => chunk.id);
      expect(lifecycleIds.every(id => id === 'canonical_patch')).toBe(true);
      expect(chunks.filter(chunk => chunk.type === 'tool_result')).toHaveLength(1);
    });

    it('correlates matching move patches across raw and canonical kind shapes', () => {
      router.beginTurn({ isPlanTurn: false });
      const patch = [
        '*** Begin Patch',
        '*** Update File: old.md',
        '*** Move to: new.md',
        '@@',
        ' context',
        '-old',
        '+new',
        '*** End Patch',
      ].join('\n');
      const change = {
        path: '/workspace/old.md',
        kind: { type: 'move', move_path: '/workspace/new.md' },
        diff: '@@ -1,2 +1,2 @@\n context\n-old\n+new',
      };

      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'call_raw_patch',
          input: `const patch = ${JSON.stringify(patch)}; text(await tools.apply_patch(patch));`,
        },
      });
      router.handleNotification('item/started', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'fileChange',
          id: 'canonical_move',
          changes: [change],
          status: 'inProgress',
        },
      });
      router.handleNotification('item/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'fileChange',
          id: 'canonical_move',
          changes: [change],
          status: 'completed',
        },
      });
      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call_output',
          call_id: 'call_raw_patch',
          output: 'Success. Updated files.',
        },
      });

      expect(chunks.filter(chunk => (
        chunk.type === 'tool_use' || chunk.type === 'tool_result'
      )).every(chunk => chunk.id === 'canonical_move')).toBe(true);
    });

    it('falls back to a raw non-command exec when no canonical item arrives', () => {
      router.beginTurn({ isPlanTurn: false });
      const imagePath = '/workspace/image.png';

      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call',
          id: 'ctc_image',
          name: 'exec',
          call_id: 'call_image',
          input: `const result = await tools.view_image({path:${JSON.stringify(imagePath)}}); image(result.image_url);`,
        },
      });

      expect(chunks).toEqual([]);

      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call_output',
          id: 'ctco_image',
          call_id: 'call_image',
          output: [{ type: 'input_text', text: 'Image Size: 100x100.' }],
        },
      });

      expect(chunks).toEqual([]);
      router.handleNotification('turn/completed', {
        threadId: 't1',
        turn: { id: 'turn1', items: [], status: 'completed', error: null },
      });

      expect(chunks).toEqual([
        {
          type: 'tool_use',
          id: 'call_image',
          name: 'Read',
          input: { path: imagePath, file_path: imagePath },
        },
        {
          type: 'tool_result',
          id: 'call_image',
          content: imagePath,
          isError: false,
        },
        { type: 'done' },
      ]);
    });

    it('waits for a canonical item when raw non-command output arrives first', () => {
      router.beginTurn({ isPlanTurn: false });
      const imagePath = '/workspace/image.png';

      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'call_image',
          input: `const r = await tools.view_image({path:${JSON.stringify(imagePath)}}); image(r.image_url);`,
        },
      });
      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call_output',
          call_id: 'call_image',
          output: 'Image viewed.',
        },
      });
      expect(chunks).toEqual([]);

      router.handleNotification('item/started', {
        threadId: 't1',
        turnId: 'turn1',
        item: { type: 'imageView', id: 'image_canonical', path: imagePath },
      });
      router.handleNotification('item/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: { type: 'imageView', id: 'image_canonical', path: imagePath },
      });

      expect(chunks).toEqual([
        {
          type: 'tool_use',
          id: 'image_canonical',
          name: 'Read',
          input: { path: imagePath, file_path: imagePath },
        },
        {
          type: 'tool_result',
          id: 'image_canonical',
          content: imagePath,
          isError: false,
        },
      ]);
    });

    it('projects every call in a multi-tool exec through its canonical lifecycle', () => {
      router.beginTurn({ isPlanTurn: false });
      const imagePath = '/workspace/image.png';

      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'call_multi',
          input: [
            'const results = await Promise.all([',
            `tools.view_image({path:${JSON.stringify(imagePath)}}),`,
            `tools.view_image({path:${JSON.stringify(imagePath)}})`,
            ']); results.forEach(image);',
          ].join(''),
        },
      });

      for (const id of ['image_one', 'image_two']) {
        router.handleNotification('item/started', {
          threadId: 't1',
          turnId: 'turn1',
          item: { type: 'imageView', id, path: imagePath },
        });
        router.handleNotification('item/completed', {
          threadId: 't1',
          turnId: 'turn1',
          item: { type: 'imageView', id, path: imagePath },
        });
      }
      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call_output',
          call_id: 'call_multi',
          output: 'Images viewed.',
        },
      });

      expect(chunks.filter(chunk => chunk.type === 'tool_use')).toHaveLength(2);
      expect(chunks.filter(chunk => chunk.type === 'tool_result')).toHaveLength(2);
      expect(chunks.some(chunk => (
        (chunk.type === 'tool_use' || chunk.type === 'tool_result')
        && chunk.id === 'call_multi'
      ))).toBe(false);
    });

    it('projects mixed Bash and non-Bash exec calls through canonical lifecycles', () => {
      router.beginTurn({ isPlanTurn: false });

      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'call_multi',
          input: [
            'const results = await Promise.all([',
            'tools.exec_command({cmd:"pwd"}),',
            'tools.view_image({path:"/workspace/image.png"})',
            ']); results.forEach(text);',
          ].join(''),
        },
      });
      router.handleNotification('item/started', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'commandExecution',
          id: 'command_canonical',
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
      });
      router.handleNotification('item/started', {
        threadId: 't1',
        turnId: 'turn1',
        item: { type: 'imageView', id: 'image_canonical', path: '/workspace/image.png' },
      });
      router.handleNotification('item/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'commandExecution',
          id: 'command_canonical',
          command: 'pwd',
          cwd: '/workspace',
          processId: '123',
          source: 'unifiedExecStartup',
          status: 'completed',
          commandActions: [{ type: 'unknown', command: 'pwd' }],
          aggregatedOutput: '/workspace\n',
          exitCode: 0,
          durationMs: 10,
        },
      });
      router.handleNotification('item/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: { type: 'imageView', id: 'image_canonical', path: '/workspace/image.png' },
      });
      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call_output',
          call_id: 'call_multi',
          output: 'Completed.',
        },
      });

      expect(chunks.filter(chunk => chunk.type === 'tool_use').map(chunk => chunk.id)).toEqual([
        'command_canonical',
        'image_canonical',
      ]);
      expect(chunks.filter(chunk => chunk.type === 'tool_result')).toHaveLength(2);
      expect(chunks.some(chunk => (
        (chunk.type === 'tool_use' || chunk.type === 'tool_result')
        && chunk.id.startsWith('call_multi')
      ))).toBe(false);
    });

    it('does not correlate mixed-envelope Bash calls across working directories', () => {
      router.beginTurn({ isPlanTurn: false });

      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'call_multi',
          input: [
            'const results = await Promise.all([',
            'tools.exec_command({cmd:"pwd",workdir:"/workspace/a"}),',
            'tools.view_image({path:"/workspace/image.png"})',
            ']); results.forEach(text);',
          ].join(''),
        },
      });
      router.handleNotification('item/started', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'commandExecution',
          id: 'command_other_directory',
          command: 'pwd',
          cwd: '/workspace/b',
          processId: '123',
          source: 'unifiedExecStartup',
          status: 'inProgress',
          commandActions: [{ type: 'unknown', command: 'pwd' }],
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
          id: 'command_other_directory',
          command: 'pwd',
          cwd: '/workspace/b',
          processId: '123',
          source: 'unifiedExecStartup',
          status: 'completed',
          commandActions: [{ type: 'unknown', command: 'pwd' }],
          aggregatedOutput: '/workspace/b\n',
          exitCode: 0,
          durationMs: 10,
        },
      });
      router.handleNotification('item/started', {
        threadId: 't1',
        turnId: 'turn1',
        item: { type: 'imageView', id: 'image_canonical', path: '/workspace/image.png' },
      });
      router.handleNotification('item/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: { type: 'imageView', id: 'image_canonical', path: '/workspace/image.png' },
      });
      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call_output',
          call_id: 'call_multi',
          output: 'Completed.',
        },
      });
      router.handleNotification('turn/completed', {
        threadId: 't1',
        turn: { id: 'turn1', items: [], status: 'completed', error: null },
      });

      expect(chunks.filter(chunk => chunk.type === 'tool_use').map(chunk => chunk.id)).toEqual([
        'command_other_directory',
        'image_canonical',
        'call_multi:1',
      ]);
    });

    it('assigns a canonical Bash item to only one raw correlation path', () => {
      router.beginTurn({ isPlanTurn: false });

      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'call_multi',
          input: [
            'const results = await Promise.all([',
            'tools.exec_command({cmd:"pwd"}),',
            'tools.view_image({path:"/workspace/image.png"})',
            ']); results.forEach(text);',
          ].join(''),
        },
      });
      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'call_single',
          input: 'const r = await tools.exec_command({cmd:"pwd"}); text(r.output);',
        },
      });
      const commandItem = {
        type: 'commandExecution',
        id: 'command_canonical',
        command: 'pwd',
        cwd: '/workspace',
        processId: '123',
        source: 'unifiedExecStartup',
        commandActions: [{ type: 'unknown', command: 'pwd' }],
      };
      router.handleNotification('item/started', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          ...commandItem,
          status: 'inProgress',
          aggregatedOutput: null,
          exitCode: null,
          durationMs: null,
        },
      });
      router.handleNotification('item/started', {
        threadId: 't1',
        turnId: 'turn1',
        item: { type: 'imageView', id: 'image_canonical', path: '/workspace/image.png' },
      });
      router.handleNotification('item/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          ...commandItem,
          status: 'completed',
          aggregatedOutput: '/workspace\n',
          exitCode: 0,
          durationMs: 10,
        },
      });
      router.handleNotification('item/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: { type: 'imageView', id: 'image_canonical', path: '/workspace/image.png' },
      });
      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call_output',
          call_id: 'call_single',
          output: 'Script completed\nOutput:\n/workspace\n',
        },
      });
      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call_output',
          call_id: 'call_multi',
          output: 'Completed.',
        },
      });

      expect(chunks.filter(chunk => chunk.type === 'tool_use').map(chunk => chunk.id)).toEqual([
        'call_single',
        'command_canonical',
        'image_canonical',
      ]);
      expect(chunks.filter(chunk => chunk.type === 'tool_result')).toHaveLength(3);
    });

    it('falls back only the unclaimed operation from a partial multi-tool exec', () => {
      router.beginTurn({ isPlanTurn: false });
      const imagePath = '/workspace/image.png';

      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'call_partial',
          input: [
            'const results = await Promise.all([',
            `tools.view_image({path:${JSON.stringify(imagePath)}}),`,
            'tools.probe_tool({})',
            ']); results.forEach(text);',
          ].join(''),
        },
      });
      router.handleNotification('item/started', {
        threadId: 't1',
        turnId: 'turn1',
        item: { type: 'imageView', id: 'image_canonical', path: imagePath },
      });
      router.handleNotification('item/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: { type: 'imageView', id: 'image_canonical', path: imagePath },
      });
      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call_output',
          call_id: 'call_partial',
          output: 'probe complete',
        },
      });
      router.handleNotification('turn/completed', {
        threadId: 't1',
        turn: { id: 'turn1', items: [], status: 'completed', error: null },
      });

      expect(chunks.filter(chunk => chunk.type === 'tool_use')).toEqual([
        {
          type: 'tool_use',
          id: 'image_canonical',
          name: 'Read',
          input: { path: imagePath, file_path: imagePath },
        },
        {
          type: 'tool_use',
          id: 'call_partial:2',
          name: 'probe_tool',
          input: {},
        },
      ]);
      expect(chunks.filter(chunk => chunk.type === 'tool_result')).toHaveLength(2);
      expect(chunks).not.toContainEqual(expect.objectContaining({ name: 'exec' }));
    });

    it('keeps identical operations in one exec envelope visible when correlation is ambiguous', () => {
      router.beginTurn({ isPlanTurn: false });
      const imagePath = '/workspace/image.png';

      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'call_multi',
          input: [
            'const results = await Promise.all([',
            `tools.view_image({path:${JSON.stringify(imagePath)}}),`,
            `tools.view_image({path:${JSON.stringify(imagePath)}})`,
            ']); results.forEach(image);',
          ].join(''),
        },
      });
      router.handleNotification('item/started', {
        threadId: 't1',
        turnId: 'turn1',
        item: { type: 'imageView', id: 'image_canonical', path: imagePath },
      });
      router.handleNotification('item/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: { type: 'imageView', id: 'image_canonical', path: imagePath },
      });
      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call_output',
          call_id: 'call_multi',
          output: 'Images viewed.',
        },
      });
      router.handleNotification('turn/completed', {
        threadId: 't1',
        turn: { id: 'turn1', items: [], status: 'completed', error: null },
      });

      expect(chunks.filter(chunk => chunk.type === 'tool_use').map(chunk => chunk.id)).toEqual([
        'image_canonical',
        'call_multi:1',
        'call_multi:2',
      ]);
      expect(chunks.filter(chunk => chunk.type === 'tool_result')).toHaveLength(3);
    });

    it('coalesces a canonical-first non-command item with its later raw exec envelope', () => {
      router.beginTurn({ isPlanTurn: false });
      const imagePath = '/workspace/image.png';

      router.handleNotification('item/started', {
        threadId: 't1',
        turnId: 'turn1',
        item: { type: 'imageView', id: 'image_canonical', path: imagePath },
      });
      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'call_image',
          input: `const r = await tools.view_image({path:${JSON.stringify(imagePath)}}); image(r.image_url);`,
        },
      });
      router.handleNotification('item/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: { type: 'imageView', id: 'image_canonical', path: imagePath },
      });
      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call_output',
          call_id: 'call_image',
          output: 'Image viewed.',
        },
      });

      expect(chunks).toEqual([
        {
          type: 'tool_use',
          id: 'image_canonical',
          name: 'Read',
          input: { path: imagePath, file_path: imagePath },
        },
        {
          type: 'tool_result',
          id: 'image_canonical',
          content: imagePath,
          isError: false,
        },
      ]);
    });

    it('emits an ordered lifecycle when canonical completion precedes its start', () => {
      router.beginTurn({ isPlanTurn: false });
      const item = { type: 'imageView', id: 'image_canonical', path: '/workspace/image.png' };

      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'call_image',
          input: 'const r = await tools.view_image({path:"/workspace/image.png"}); image(r.image_url);',
        },
      });
      router.handleNotification('item/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item,
      });
      router.handleNotification('item/started', {
        threadId: 't1',
        turnId: 'turn1',
        item,
      });
      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call_output',
          call_id: 'call_image',
          output: 'Image viewed.',
        },
      });

      expect(chunks).toEqual([
        {
          type: 'tool_use',
          id: 'image_canonical',
          name: 'Read',
          input: { path: '/workspace/image.png', file_path: '/workspace/image.png' },
        },
        {
          type: 'tool_result',
          id: 'image_canonical',
          content: '/workspace/image.png',
          isError: false,
        },
      ]);
    });

    it('ignores a repeated canonical tool completion', () => {
      router.beginTurn({ isPlanTurn: false });
      const item = { type: 'imageView', id: 'image_canonical', path: '/workspace/image.png' };

      router.handleNotification('item/started', {
        threadId: 't1',
        turnId: 'turn1',
        item,
      });
      router.handleNotification('item/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item,
      });
      router.handleNotification('item/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item,
      });

      expect(chunks.filter(chunk => chunk.type === 'tool_use')).toHaveLength(1);
      expect(chunks.filter(chunk => chunk.type === 'tool_result')).toHaveLength(1);
    });

    it('keeps a later identical raw-only call visible after a canonical item completed', () => {
      router.beginTurn({ isPlanTurn: false });
      const imagePath = '/workspace/image.png';

      router.handleNotification('item/started', {
        threadId: 't1',
        turnId: 'turn1',
        item: { type: 'imageView', id: 'image_canonical', path: imagePath },
      });
      router.handleNotification('item/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: { type: 'imageView', id: 'image_canonical', path: imagePath },
      });
      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'call_image',
          input: `const r = await tools.view_image({path:${JSON.stringify(imagePath)}}); image(r.image_url);`,
        },
      });
      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call_output',
          call_id: 'call_image',
          output: 'Image viewed.',
        },
      });
      router.handleNotification('turn/completed', {
        threadId: 't1',
        turn: { id: 'turn1', items: [], status: 'completed', error: null },
      });

      const lifecycleIds = chunks
        .filter(chunk => chunk.type === 'tool_use' || chunk.type === 'tool_result')
        .map(chunk => chunk.id);
      expect(new Set(lifecycleIds)).toEqual(new Set(['image_canonical', 'call_image']));
      expect(chunks.filter(chunk => chunk.type === 'tool_result')).toHaveLength(2);
    });

    it.each([
      {
        label: 'web search',
        nestedCall: 'web__run',
        nestedInput: { search_query: [{ q: 'Codex app server' }] },
        canonicalId: 'web_canonical',
        startedItem: {
          type: 'webSearch',
          id: 'web_canonical',
          query: 'Codex app server',
          status: 'inProgress',
        },
        completedItem: {
          type: 'webSearch',
          id: 'web_canonical',
          query: 'Codex app server',
          status: 'completed',
        },
      },
      {
        label: 'web open page',
        nestedCall: 'web__run',
        nestedInput: { open: [{ ref_id: 'https://example.com/docs' }] },
        canonicalId: 'web_open_canonical',
        startedItem: {
          type: 'webSearch',
          id: 'web_open_canonical',
          action: { type: 'openPage', url: 'https://example.com/docs' },
          status: 'inProgress',
        },
        completedItem: {
          type: 'webSearch',
          id: 'web_open_canonical',
          query: 'https://example.com/docs',
          action: { type: 'openPage', url: 'https://example.com/docs' },
          status: 'completed',
        },
      },
      {
        label: 'web find in page',
        nestedCall: 'web__run',
        nestedInput: {
          find: [{ ref_id: 'https://example.com/docs', pattern: 'Codex' }],
        },
        canonicalId: 'web_find_canonical',
        startedItem: {
          type: 'webSearch',
          id: 'web_find_canonical',
          status: 'inProgress',
        },
        completedItem: {
          type: 'webSearch',
          id: 'web_find_canonical',
          query: 'https://example.com/docs',
          action: {
            type: 'findInPage',
            url: 'https://example.com/docs',
            pattern: 'Codex',
          },
          status: 'completed',
        },
      },
      {
        label: 'MCP tool',
        nestedCall: 'mcp__docs__search',
        nestedInput: { query: 'Codex app server' },
        canonicalId: 'mcp_canonical',
        startedItem: {
          type: 'mcpToolCall',
          id: 'mcp_canonical',
          server: 'docs',
          tool: 'search',
          arguments: { query: 'Codex app server' },
          status: 'inProgress',
        },
        completedItem: {
          type: 'mcpToolCall',
          id: 'mcp_canonical',
          server: 'docs',
          tool: 'search',
          arguments: { query: 'Codex app server' },
          status: 'completed',
          result: { content: [{ type: 'text', text: 'Found.' }] },
          error: null,
        },
      },
      {
        label: 'dynamic tool',
        nestedCall: 'probe_tool',
        nestedInput: {},
        canonicalId: 'dynamic_canonical',
        startedItem: {
          type: 'dynamicToolCall',
          id: 'dynamic_canonical',
          tool: 'probe_tool',
          arguments: {},
          status: 'inProgress',
        },
        completedItem: {
          type: 'dynamicToolCall',
          id: 'dynamic_canonical',
          tool: 'probe_tool',
          arguments: {},
          status: 'completed',
          contentItems: [{ type: 'inputText', text: 'probe complete' }],
          success: true,
        },
      },
    ])('defers a raw exec envelope to the canonical $label item', ({
      nestedCall,
      nestedInput,
      canonicalId,
      startedItem,
      completedItem,
    }) => {
      router.beginTurn({ isPlanTurn: false });

      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'call_raw_exec',
          input: `const r = await tools.${nestedCall}(${JSON.stringify(nestedInput)}); text(r);`,
        },
      });
      router.handleNotification('item/started', {
        threadId: 't1',
        turnId: 'turn1',
        item: startedItem,
      });
      router.handleNotification('item/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: completedItem,
      });
      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call_output',
          call_id: 'call_raw_exec',
          output: 'raw aggregate output',
        },
      });

      expect(chunks.filter(chunk => chunk.type === 'tool_use')).toHaveLength(1);
      expect(chunks.filter(chunk => chunk.type === 'tool_result')).toHaveLength(1);
      expect(chunks.filter(chunk => (
        chunk.type === 'tool_use' || chunk.type === 'tool_result'
      )).every(chunk => chunk.id === canonicalId)).toBe(true);
    });

    it('does not correlate MCP calls when canonical arguments are a strict superset', () => {
      router.beginTurn({ isPlanTurn: false });

      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'call_raw_mcp',
          input: [
            'const r = await tools.mcp__docs__search(',
            '{query:"Codex app server"}',
            '); text(r);',
          ].join(''),
        },
      });
      router.handleNotification('item/started', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'mcpToolCall',
          id: 'canonical_other_mcp',
          server: 'docs',
          tool: 'search',
          arguments: { query: 'Codex app server', limit: 10 },
          status: 'inProgress',
        },
      });
      router.handleNotification('item/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'mcpToolCall',
          id: 'canonical_other_mcp',
          server: 'docs',
          tool: 'search',
          arguments: { query: 'Codex app server', limit: 10 },
          status: 'completed',
          result: { content: [{ type: 'text', text: 'Canonical result.' }] },
          error: null,
        },
      });
      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call_output',
          call_id: 'call_raw_mcp',
          output: 'Raw result.',
        },
      });
      router.handleNotification('turn/completed', {
        threadId: 't1',
        turn: { id: 'turn1', items: [], status: 'completed', error: null },
      });

      const lifecycleIds = new Set(chunks
        .filter(chunk => chunk.type === 'tool_use' || chunk.type === 'tool_result')
        .map(chunk => chunk.id));
      expect(lifecycleIds).toEqual(new Set(['call_raw_mcp', 'canonical_other_mcp']));
    });

    it('defers an update_plan exec envelope to turn/plan/updated', () => {
      router.beginTurn({ isPlanTurn: false });

      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'call_plan',
          input: [
            'const r = await tools.update_plan({',
            'plan:[{step:"Confirm stream events",status:"in_progress"}]',
            '}); text(r);',
          ].join(''),
        },
      });
      router.handleNotification('turn/plan/updated', {
        threadId: 't1',
        turnId: 'turn1',
        explanation: null,
        plan: [{ step: 'Confirm stream events', status: 'inProgress' }],
      });
      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call_output',
          call_id: 'call_plan',
          output: 'Plan updated.',
        },
      });

      expect(chunks).toEqual([
        {
          type: 'tool_use',
          id: 'plan-update-turn1-1',
          name: 'TodoWrite',
          input: {
            todos: [{
              id: '',
              content: 'Confirm stream events',
              activeForm: 'Confirm stream events',
              status: 'in_progress',
            }],
          },
        },
        {
          type: 'tool_result',
          id: 'plan-update-turn1-1',
          content: 'Plan updated',
          isError: false,
        },
      ]);
    });

    it('correlates repeated update_plan calls within the same turn', () => {
      router.beginTurn({ isPlanTurn: false });

      for (const [index, step] of ['First plan', 'Second plan'].entries()) {
        const callId = `call_plan_${index}`;
        router.handleNotification('rawResponseItem/completed', {
          threadId: 't1',
          turnId: 'turn1',
          item: {
            type: 'custom_tool_call',
            name: 'exec',
            call_id: callId,
            input: [
              'const r = await tools.update_plan({',
              `plan:[{step:${JSON.stringify(step)},status:"in_progress"}]`,
              '}); text(r);',
            ].join(''),
          },
        });
        router.handleNotification('turn/plan/updated', {
          threadId: 't1',
          turnId: 'turn1',
          explanation: null,
          plan: [{ step, status: 'inProgress' }],
        });
        router.handleNotification('rawResponseItem/completed', {
          threadId: 't1',
          turnId: 'turn1',
          item: {
            type: 'custom_tool_call_output',
            call_id: callId,
            output: 'Plan updated.',
          },
        });
      }

      expect(chunks.filter(chunk => chunk.type === 'tool_use')).toHaveLength(2);
      expect(chunks.filter(chunk => chunk.type === 'tool_result')).toHaveLength(2);
      expect(chunks.filter(chunk => chunk.type === 'tool_use').map(chunk => chunk.id)).toEqual([
        'plan-update-turn1-1',
        'plan-update-turn1-2',
      ]);
      expect(chunks.filter(chunk => chunk.type === 'tool_result').map(chunk => chunk.id)).toEqual([
        'plan-update-turn1-1',
        'plan-update-turn1-2',
      ]);
    });

    it('keeps a later identical raw-only call visible after a plan update completed', () => {
      router.beginTurn({ isPlanTurn: false });

      router.handleNotification('turn/plan/updated', {
        threadId: 't1',
        turnId: 'turn1',
        explanation: null,
        plan: [{ step: 'Canonical first', status: 'inProgress' }],
      });
      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'call_plan',
          input: [
            'const r = await tools.update_plan({',
            'plan:[{step:"Canonical first",status:"in_progress"}]',
            '}); text(r);',
          ].join(''),
        },
      });
      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call_output',
          call_id: 'call_plan',
          output: 'Plan updated.',
        },
      });
      router.handleNotification('turn/completed', {
        threadId: 't1',
        turn: { id: 'turn1', items: [], status: 'completed', error: null },
      });

      expect(chunks.filter(chunk => chunk.type === 'tool_use').map(chunk => chunk.id)).toEqual([
        'plan-update-turn1-1',
        'call_plan',
      ]);
      expect(chunks.filter(chunk => chunk.type === 'tool_result')).toHaveLength(2);
    });

    it('routes canonical command progress through a correlated raw function call', () => {
      router.beginTurn({ isPlanTurn: false });

      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'function_call',
          id: 'fc_raw',
          name: 'exec_command',
          call_id: 'call_raw',
          arguments: '{"command":"pwd"}',
        },
      });
      router.handleNotification('item/started', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'commandExecution',
          id: 'exec_canonical',
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
      });
      router.handleNotification('item/commandExecution/outputDelta', {
        threadId: 't1',
        turnId: 'turn1',
        itemId: 'exec_canonical',
        delta: '/work',
      });
      router.handleNotification('item/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'commandExecution',
          id: 'exec_canonical',
          command: 'pwd',
          cwd: '/workspace',
          processId: '123',
          source: 'unifiedExecStartup',
          status: 'completed',
          commandActions: [{ type: 'unknown', command: 'pwd' }],
          aggregatedOutput: '/workspace\n',
          exitCode: 0,
          durationMs: 10,
        },
      });
      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'function_call_output',
          id: 'fco_raw',
          call_id: 'call_raw',
          output: 'Exit code: 0\nOutput:\n/workspace\n',
        },
      });

      expect(chunks).toEqual([
        { type: 'tool_use', id: 'call_raw', name: 'Bash', input: { command: 'pwd' } },
        { type: 'tool_output', id: 'call_raw', content: '/work' },
        { type: 'tool_result', id: 'call_raw', content: '/workspace\n', isError: false },
      ]);
    });

    it('keeps repeated commands as separate calls while coalescing each canonical event', () => {
      router.beginTurn({ isPlanTurn: false });

      for (const suffix of ['one', 'two']) {
        router.handleNotification('rawResponseItem/completed', {
          threadId: 't1',
          turnId: 'turn1',
          item: {
            type: 'custom_tool_call',
            id: `ctc_${suffix}`,
            name: 'exec',
            call_id: `call_${suffix}`,
            input: 'const r = await tools.exec_command({cmd:"pwd"}); text(r.output);',
          },
        });
        router.handleNotification('item/started', {
          threadId: 't1',
          turnId: 'turn1',
          item: {
            type: 'commandExecution',
            id: `exec_${suffix}`,
            command: 'pwd',
            cwd: '/workspace',
            processId: suffix,
            source: 'unifiedExecStartup',
            status: 'inProgress',
            commandActions: [{ type: 'unknown', command: 'pwd' }],
            aggregatedOutput: null,
            exitCode: null,
            durationMs: null,
          },
        });
      }

      expect(chunks).toEqual([
        { type: 'tool_use', id: 'call_one', name: 'Bash', input: { command: 'pwd' } },
        { type: 'tool_use', id: 'call_two', name: 'Bash', input: { command: 'pwd' } },
      ]);
    });

    it('coalesces a canonical-first command with its later raw exec envelope', () => {
      router.beginTurn({ isPlanTurn: false });

      router.handleNotification('item/started', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'commandExecution',
          id: 'exec_canonical',
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
      });
      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'call_raw',
          input: 'const r = await tools.exec_command({cmd:"pwd"}); text(r.output);',
        },
      });
      router.handleNotification('item/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'commandExecution',
          id: 'exec_canonical',
          command: 'pwd',
          cwd: '/workspace',
          processId: '123',
          source: 'unifiedExecStartup',
          status: 'completed',
          commandActions: [{ type: 'unknown', command: 'pwd' }],
          aggregatedOutput: '/workspace\n',
          exitCode: 0,
          durationMs: 10,
        },
      });
      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call_output',
          call_id: 'call_raw',
          output: 'Script completed\nOutput:\n/workspace\n',
        },
      });

      expect(chunks).toEqual([
        { type: 'tool_use', id: 'exec_canonical', name: 'Bash', input: { command: 'pwd' } },
        { type: 'tool_result', id: 'exec_canonical', content: '/workspace\n', isError: false },
      ]);
    });

    it('does not replay canonical output when a later raw Bash call yields', () => {
      router.beginTurn({ isPlanTurn: false });
      const canonicalItem = {
        type: 'commandExecution',
        id: 'exec_canonical',
        command: 'npm test',
        cwd: '/workspace',
        processId: '123',
        source: 'unifiedExecStartup',
        commandActions: [{ type: 'unknown', command: 'npm test' }],
      };

      router.handleNotification('item/started', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          ...canonicalItem,
          status: 'inProgress',
          aggregatedOutput: null,
          exitCode: null,
          durationMs: null,
        },
      });
      router.handleNotification('item/commandExecution/outputDelta', {
        threadId: 't1',
        turnId: 'turn1',
        itemId: 'exec_canonical',
        delta: 'tests started\n',
      });
      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'call_raw',
          input: 'const r = await tools.exec_command({cmd:"npm test"}); text(r.output);',
        },
      });
      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call_output',
          call_id: 'call_raw',
          output: [
            { type: 'input_text', text: 'Script running with cell ID 42\nOutput:\n' },
            { type: 'input_text', text: 'tests started\n' },
          ],
        },
      });
      router.handleNotification('item/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          ...canonicalItem,
          status: 'completed',
          aggregatedOutput: 'tests started\n',
          exitCode: 0,
          durationMs: 10,
        },
      });
      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'function_call',
          name: 'wait',
          call_id: 'call_wait',
          arguments: '{"cell_id":"42","yield_time_ms":30000}',
        },
      });
      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'function_call_output',
          call_id: 'call_wait',
          output: 'Script completed\nOutput:\ntests passed\n',
        },
      });

      expect(chunks.filter(chunk => chunk.type === 'tool_output')).toEqual([{
        type: 'tool_output',
        id: 'exec_canonical',
        content: 'tests started\n',
      }]);
      expect(chunks.filter(chunk => chunk.type === 'tool_result')).toEqual([{
        type: 'tool_result',
        id: 'exec_canonical',
        content: 'tests started\ntests passed\n',
        isError: false,
      }]);
    });

    it('keeps a later identical raw-only command visible after a canonical command completed', () => {
      router.beginTurn({ isPlanTurn: false });
      const canonicalItem = {
        type: 'commandExecution',
        id: 'exec_canonical',
        command: 'pwd',
        cwd: '/workspace',
        processId: '123',
        source: 'unifiedExecStartup',
        commandActions: [{ type: 'unknown', command: 'pwd' }],
        aggregatedOutput: '/workspace\n',
        exitCode: 0,
        durationMs: 10,
      };

      router.handleNotification('item/started', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          ...canonicalItem,
          status: 'inProgress',
          aggregatedOutput: null,
          exitCode: null,
          durationMs: null,
        },
      });
      router.handleNotification('item/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: { ...canonicalItem, status: 'completed' },
      });
      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'call_raw',
          input: 'const r = await tools.exec_command({cmd:"pwd"}); text(r.output);',
        },
      });
      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call_output',
          call_id: 'call_raw',
          output: 'Script completed\nOutput:\n/workspace\n',
        },
      });

      expect(chunks).toEqual([
        { type: 'tool_use', id: 'exec_canonical', name: 'Bash', input: { command: 'pwd' } },
        { type: 'tool_result', id: 'exec_canonical', content: '/workspace\n', isError: false },
        { type: 'tool_use', id: 'call_raw', name: 'Bash', input: { command: 'pwd' } },
        { type: 'tool_result', id: 'call_raw', content: '/workspace\n', isError: false },
      ]);
    });

    it('coalesces a canonical command delivered after the raw terminal output', () => {
      router.beginTurn({ isPlanTurn: false });

      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'call_raw_only',
          input: 'const r = await tools.exec_command({cmd:"pwd"}); text(r.output);',
        },
      });
      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call_output',
          call_id: 'call_raw_only',
          output: 'Script completed\nOutput:\n/workspace\n',
        },
      });
      router.handleNotification('item/started', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'commandExecution',
          id: 'exec_later',
          command: 'pwd',
          cwd: '/workspace',
          processId: '456',
          source: 'unifiedExecStartup',
          status: 'inProgress',
          commandActions: [{ type: 'unknown', command: 'pwd' }],
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
          id: 'exec_later',
          command: 'pwd',
          cwd: '/workspace',
          processId: '456',
          source: 'unifiedExecStartup',
          status: 'completed',
          commandActions: [{ type: 'unknown', command: 'pwd' }],
          aggregatedOutput: '/workspace\n',
          exitCode: 0,
          durationMs: 10,
        },
      });

      expect(chunks.filter(chunk => chunk.type === 'tool_use')).toEqual([
        { type: 'tool_use', id: 'call_raw_only', name: 'Bash', input: { command: 'pwd' } },
      ]);
      expect(chunks.filter(chunk => chunk.type === 'tool_result')).toHaveLength(1);
    });

    it('matches canonical-first commands by their full command alias', () => {
      router.beginTurn({ isPlanTurn: false });
      const canonicalItem = {
        type: 'commandExecution',
        id: 'exec_canonical',
        command: '/bin/zsh -lc "echo test"',
        cwd: '/workspace',
        processId: '123',
        source: 'unifiedExecStartup',
        commandActions: [{ type: 'unknown', command: 'echo test' }],
      };

      router.handleNotification('item/started', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          ...canonicalItem,
          status: 'inProgress',
          aggregatedOutput: null,
          exitCode: null,
          durationMs: null,
        },
      });
      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'call_raw',
          input: 'const r = await tools.exec_command({cmd:"/bin/zsh -lc \\"echo test\\""}); text(r.output);',
        },
      });
      router.handleNotification('item/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          ...canonicalItem,
          status: 'completed',
          aggregatedOutput: 'test\n',
          exitCode: 0,
          durationMs: 10,
        },
      });
      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call_output',
          call_id: 'call_raw',
          output: 'Script completed\nOutput:\ntest\n',
        },
      });

      expect(chunks).toEqual([
        { type: 'tool_use', id: 'exec_canonical', name: 'Bash', input: { command: 'echo test' } },
        { type: 'tool_result', id: 'exec_canonical', content: 'test\n', isError: false },
      ]);
    });

    it('keeps ambiguous concurrent identical commands visible instead of guessing a correlation', () => {
      router.beginTurn({ isPlanTurn: false });

      for (const callId of ['call_one', 'call_two']) {
        router.handleNotification('rawResponseItem/completed', {
          threadId: 't1',
          turnId: 'turn1',
          item: {
            type: 'custom_tool_call',
            name: 'exec',
            call_id: callId,
            input: 'const r = await tools.exec_command({cmd:"pwd"}); text(r.output);',
          },
        });
      }
      router.handleNotification('item/started', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'commandExecution',
          id: 'exec_ambiguous',
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
      });

      expect(chunks.filter(chunk => chunk.type === 'tool_use').map(chunk => chunk.id)).toEqual([
        'call_one',
        'call_two',
        'exec_ambiguous',
      ]);
    });

    it('does not correlate identical commands from different working directories', () => {
      router.beginTurn({ isPlanTurn: false });

      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'call_raw_a',
          input: [
            'const r = await tools.exec_command({',
            'cmd:"pwd",workdir:"/workspace/a"',
            '}); text(r.output);',
          ].join(''),
        },
      });
      router.handleNotification('item/started', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'commandExecution',
          id: 'exec_b',
          command: 'pwd',
          cwd: '/workspace/b',
          processId: '123',
          source: 'unifiedExecStartup',
          status: 'inProgress',
          commandActions: [{ type: 'unknown', command: 'pwd' }],
          aggregatedOutput: null,
          exitCode: null,
          durationMs: null,
        },
      });

      expect(chunks.filter(chunk => chunk.type === 'tool_use').map(chunk => chunk.id)).toEqual([
        'call_raw_a',
        'exec_b',
      ]);
    });

    it('falls back to a direct raw-only apply_patch call at turn completion', () => {
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

      expect(chunks).toEqual([
        {
          type: 'tool_use',
          id: 'patch_raw',
          name: 'apply_patch',
          input: { patch: '*** Begin Patch\n*** End Patch' },
        },
        {
          type: 'tool_result',
          id: 'patch_raw',
          content: 'Success. Updated files.',
          isError: false,
        },
        { type: 'done' },
      ]);
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

    it('retains raw ownership claimed by patchUpdated through completion', () => {
      router.beginTurn({ isPlanTurn: false });
      const patch = '*** Begin Patch\n*** Add File: note.md\n+hello\n*** End Patch';
      const changes = [{
        path: '/workspace/note.md',
        type: 'add',
        diff: '@@ -0,0 +1 @@\n+hello',
      }];

      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'call_patch',
          input: `const patch = ${JSON.stringify(patch)}; text(await tools.apply_patch(patch));`,
        },
      });
      router.handleNotification('item/fileChange/patchUpdated', {
        threadId: 't1',
        turnId: 'turn1',
        itemId: 'patch_canonical',
        changes,
      });
      router.handleNotification('item/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'fileChange',
          id: 'patch_canonical',
          changes,
          status: 'completed',
        },
      });
      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call_output',
          call_id: 'call_patch',
          output: 'Success. Updated files.',
        },
      });
      router.handleNotification('turn/completed', {
        threadId: 't1',
        turn: { id: 'turn1', items: [], status: 'completed', error: null },
      });

      expect(chunks.filter(chunk => chunk.type === 'tool_result')).toHaveLength(1);
      expect(chunks.filter(chunk => (
        chunk.type === 'tool_use' || chunk.type === 'tool_result'
      )).every(chunk => chunk.id === 'patch_canonical')).toBe(true);
    });

    it('merges raw apply_patch input into the fileChange-owned tool call', () => {
      router.beginTurn({ isPlanTurn: false });
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

    it('keeps a same-ID sparse direct patch owned by its canonical fileChange', () => {
      router.beginTurn({ isPlanTurn: false });
      const patch = [
        '*** Begin Patch',
        '*** Update File: /workspace/foo.ts',
        '@@',
        '-old',
        '+new',
        '*** End Patch',
      ].join('\n');
      const changes = [{ path: '/workspace/foo.ts', type: 'update' }];

      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call',
          name: 'apply_patch',
          call_id: 'call_patch',
          input: patch,
        },
      });
      router.handleNotification('item/started', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'fileChange',
          id: 'call_patch',
          changes,
          status: 'inProgress',
        },
      });
      router.handleNotification('item/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'fileChange',
          id: 'call_patch',
          changes,
          status: 'completed',
        },
      });
      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call_output',
          call_id: 'call_patch',
          output: 'Success',
        },
      });
      router.handleNotification('turn/completed', {
        threadId: 't1',
        turn: { id: 'turn1', items: [], status: 'completed', error: null },
      });

      expect(chunks.filter(chunk => chunk.type === 'tool_result')).toHaveLength(1);
      expect(chunks.filter(chunk => chunk.type === 'tool_use')).toHaveLength(2);
      expect(chunks.every(chunk => (
        chunk.type === 'done' || ('id' in chunk && chunk.id === 'call_patch')
      ))).toBe(true);
    });

    it('keeps a canonical-completed-first direct patch owned when its raw call arrives later', () => {
      router.beginTurn({ isPlanTurn: false });
      const patch = [
        '*** Begin Patch',
        '*** Update File: /workspace/foo.ts',
        '@@',
        '-old',
        '+new',
        '*** End Patch',
      ].join('\n');
      const completedItem = {
        type: 'fileChange' as const,
        id: 'call_patch',
        changes: [{ path: '/workspace/foo.ts', type: 'update' }],
        status: 'completed' as const,
      };

      router.handleNotification('item/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: completedItem,
      });
      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call',
          name: 'apply_patch',
          call_id: 'call_patch',
          input: patch,
        },
      });
      router.handleNotification('item/started', {
        threadId: 't1',
        turnId: 'turn1',
        item: { ...completedItem, status: 'inProgress' },
      });
      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call_output',
          call_id: 'call_patch',
          output: 'Success',
        },
      });
      router.handleNotification('turn/completed', {
        threadId: 't1',
        turn: { id: 'turn1', items: [], status: 'completed', error: null },
      });

      expect(chunks.filter(chunk => chunk.type === 'tool_use')).toHaveLength(1);
      expect(chunks.filter(chunk => chunk.type === 'tool_result')).toHaveLength(1);
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

      expect(chunks).toHaveLength(2);
      expect(chunks[1]).toMatchObject({
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

      expect(chunks).toHaveLength(2);
      expect(chunks[1]).toMatchObject({
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

      expect(chunks).toHaveLength(2);
      expect(chunks[1]).toMatchObject({
        type: 'tool_result',
        id: 'call_agent1',
        isError: false,
      });
    });

    it('ignores a late same-ID raw function call after canonical collab completion', () => {
      router.beginTurn({ isPlanTurn: false });
      router.handleNotification('item/completed', {
        item: {
          type: 'collabAgentToolCall',
          id: 'call_wait',
          tool: 'wait',
          status: 'completed',
          arguments: { timeout_ms: 30000 },
          result: { status: 'done' },
        },
        threadId: 't1',
        turnId: 'turn1',
      });
      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'function_call',
          name: 'wait_agent',
          call_id: 'call_wait',
          arguments: '{"timeout_ms":30000}',
        },
      });
      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'function_call_output',
          call_id: 'call_wait',
          output: 'Agent finished.',
        },
      });

      expect(chunks.filter(chunk => chunk.type === 'tool_use')).toHaveLength(1);
      expect(chunks.filter(chunk => chunk.type === 'tool_result')).toHaveLength(1);
    });

    it('closes a raw-only function call without output at turn completion', () => {
      router.beginTurn({ isPlanTurn: false });
      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'function_call',
          name: 'wait_agent',
          call_id: 'call_wait',
          arguments: '{"timeout_ms":30000}',
        },
      });
      router.handleNotification('turn/completed', {
        threadId: 't1',
        turn: { id: 'turn1', items: [], status: 'completed', error: null },
      });

      expect(chunks.filter(chunk => chunk.type === 'tool_result')).toEqual([{
        type: 'tool_result',
        id: 'call_wait',
        content: '',
        isError: false,
      }]);
    });

    it('ignores a late raw output after a same-id canonical collab completion', () => {
      router.beginTurn({ isPlanTurn: false });

      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'function_call',
          name: 'wait_agent',
          call_id: 'call_wait',
          arguments: '{"timeout_ms":30000}',
        },
      });
      router.handleNotification('item/started', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'collabAgentToolCall',
          id: 'call_wait',
          tool: 'wait',
          status: 'inProgress',
          arguments: { timeout_ms: 30000 },
        },
      });
      router.handleNotification('item/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'collabAgentToolCall',
          id: 'call_wait',
          tool: 'wait',
          status: 'completed',
          arguments: { timeout_ms: 30000 },
          result: { status: 'done' },
        },
      });
      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'function_call_output',
          call_id: 'call_wait',
          output: 'Agent finished.',
        },
      });
      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'function_call_output',
          call_id: 'call_wait',
          output: 'Agent finished.',
        },
      });
      router.handleNotification('turn/completed', {
        threadId: 't1',
        turn: { id: 'turn1', items: [], status: 'completed', error: null },
      });

      expect(chunks.filter(chunk => chunk.type === 'tool_use')).toHaveLength(1);
      expect(chunks.filter(chunk => chunk.type === 'tool_result')).toHaveLength(1);
    });

    it('flushes a deferred raw-only operation before a terminal error', () => {
      router.beginTurn({ isPlanTurn: false });

      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'call_image',
          input: 'const r = await tools.view_image({path:"/workspace/image.png"}); image(r.image_url);',
        },
      });
      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call_output',
          call_id: 'call_image',
          output: 'Image viewed.',
        },
      });
      router.handleNotification('error', {
        error: { message: 'Transport failed' },
        willRetry: false,
      });

      expect(chunks.filter(chunk => chunk.type === 'tool_use')).toEqual([{
        type: 'tool_use',
        id: 'call_image',
        name: 'Read',
        input: { path: '/workspace/image.png', file_path: '/workspace/image.png' },
      }]);
      expect(chunks.filter(chunk => chunk.type === 'tool_result')).toHaveLength(1);
      expect(chunks[chunks.length - 1]).toEqual({ type: 'error', content: 'Transport failed' });
    });

    it('marks an unfinished deferred raw-only operation failed at a terminal error', () => {
      router.beginTurn({ isPlanTurn: false });

      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'call_image',
          input: 'const r = await tools.view_image({path:"/workspace/image.png"}); image(r.image_url);',
        },
      });
      router.handleNotification('error', {
        error: { message: 'Transport failed' },
        willRetry: false,
      });

      expect(chunks.filter(chunk => chunk.type === 'tool_result')).toEqual([{
        type: 'tool_result',
        id: 'call_image',
        content: '',
        isError: true,
      }]);
      expect(chunks[chunks.length - 1]).toEqual({ type: 'error', content: 'Transport failed' });
    });

    it('closes a claimed canonical operation before a terminal error', () => {
      router.beginTurn({ isPlanTurn: false });

      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'call_image',
          input: 'const r = await tools.view_image({path:"/workspace/image.png"}); image(r.image_url);',
        },
      });
      router.handleNotification('item/started', {
        threadId: 't1',
        turnId: 'turn1',
        item: { type: 'imageView', id: 'image_canonical', path: '/workspace/image.png' },
      });
      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call_output',
          call_id: 'call_image',
          output: 'Image viewed.',
        },
      });
      router.handleNotification('error', {
        error: { message: 'Transport failed' },
        willRetry: false,
      });
      router.handleNotification('item/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: { type: 'imageView', id: 'image_canonical', path: '/workspace/image.png' },
      });

      expect(chunks.filter(chunk => chunk.type === 'tool_use')).toHaveLength(1);
      expect(chunks.filter(chunk => chunk.type === 'tool_result')).toEqual([{
        type: 'tool_result',
        id: 'image_canonical',
        content: 'Image viewed.',
        isError: false,
      }]);
      expect(chunks[chunks.length - 1]).toEqual({ type: 'error', content: 'Transport failed' });
    });

    it('flushes deferred operations before a failed-turn error', () => {
      router.beginTurn({ isPlanTurn: false });

      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'call_image',
          input: 'const r = await tools.view_image({path:"/workspace/image.png"}); image(r.image_url);',
        },
      });
      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call_output',
          call_id: 'call_image',
          output: 'Image viewed.',
        },
      });
      router.handleNotification('turn/completed', {
        threadId: 't1',
        turn: {
          id: 'turn1',
          items: [],
          status: 'failed',
          error: { message: 'Turn failed' },
        },
      });

      expect(chunks.filter(chunk => chunk.type === 'tool_use')).toHaveLength(1);
      expect(chunks.filter(chunk => chunk.type === 'tool_result')).toHaveLength(1);
      expect(chunks[chunks.length - 1]).toEqual({ type: 'error', content: 'Turn failed' });
    });

    it('closes a deferred raw-only operation without output at turn completion', () => {
      router.beginTurn({ isPlanTurn: false });

      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'call_image',
          input: 'const r = await tools.view_image({path:"/workspace/image.png"}); image(r.image_url);',
        },
      });
      router.handleNotification('turn/completed', {
        threadId: 't1',
        turn: { id: 'turn1', items: [], status: 'completed', error: null },
      });

      expect(chunks.filter(chunk => chunk.type === 'tool_use')).toHaveLength(1);
      expect(chunks.filter(chunk => chunk.type === 'tool_result')).toHaveLength(1);
      expect(chunks[chunks.length - 1]).toEqual({ type: 'done' });
    });

    it('closes a yielded Bash operation at turn completion', () => {
      router.beginTurn({ isPlanTurn: false });

      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'call_bash',
          input: 'const r = await tools.exec_command({cmd:"npm test"}); text(r.output);',
        },
      });
      router.handleNotification('rawResponseItem/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'custom_tool_call_output',
          call_id: 'call_bash',
          output: 'Script running with cell ID 42\nOutput:\ntests started\n',
        },
      });
      router.handleNotification('turn/completed', {
        threadId: 't1',
        turn: { id: 'turn1', items: [], status: 'completed', error: null },
      });

      expect(chunks.filter(chunk => chunk.type === 'tool_result')).toEqual([{
        type: 'tool_result',
        id: 'call_bash',
        content: 'tests started\n',
        isError: false,
      }]);
      expect(chunks[chunks.length - 1]).toEqual({ type: 'done' });
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

    it('emits a terminal error on turn/completed with status failed', () => {
      router.handleNotification('turn/completed', {
        threadId: 't1',
        turn: {
          id: 'turn1',
          items: [],
          status: 'failed',
          error: { message: 'Model error', codexErrorInfo: 'other', additionalDetails: null },
        },
      });

      expect(chunks).toEqual([{ type: 'error', content: 'Model error' }]);
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

      expect(chunks).toHaveLength(2);
      expect(chunks[1]).toMatchObject({
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

      expect(chunks).toHaveLength(2);
      expect(chunks[1]).toMatchObject({
        type: 'tool_result',
        id: 'call_mcp2',
        content: 'Connection refused',
        isError: true,
      });
    });
  });

  describe('dynamicToolCall', () => {
    it('maps canonical dynamic tool lifecycle events to tool chunks', () => {
      router.handleNotification('item/started', {
        item: {
          type: 'dynamicToolCall',
          id: 'call_dynamic1',
          namespace: 'codex_app',
          tool: 'load_workspace_dependencies',
          arguments: {},
          status: 'inProgress',
          contentItems: null,
          success: null,
          durationMs: null,
        },
        threadId: 't1',
        turnId: 'turn1',
      });
      router.handleNotification('item/completed', {
        item: {
          type: 'dynamicToolCall',
          id: 'call_dynamic1',
          namespace: 'codex_app',
          tool: 'load_workspace_dependencies',
          arguments: {},
          status: 'completed',
          contentItems: [{ type: 'inputText', text: 'Workspace dependencies are available.' }],
          success: true,
          durationMs: 12,
        },
        threadId: 't1',
        turnId: 'turn1',
      });

      expect(chunks).toEqual([
        {
          type: 'tool_use',
          id: 'call_dynamic1',
          name: 'load_workspace_dependencies',
          input: {},
        },
        {
          type: 'tool_result',
          id: 'call_dynamic1',
          content: 'Workspace dependencies are available.',
          isError: false,
        },
      ]);
    });

    it('does not duplicate dynamic tool chunks also emitted as raw items', () => {
      router.handleNotification('item/started', {
        item: {
          type: 'dynamicToolCall',
          id: 'call_dynamic2',
          namespace: 'codex_app',
          tool: 'load_workspace_dependencies',
          arguments: {},
          status: 'inProgress',
        },
        threadId: 't1',
        turnId: 'turn1',
      });
      router.handleNotification('rawResponseItem/completed', {
        item: {
          type: 'custom_tool_call',
          name: 'load_workspace_dependencies',
          call_id: 'call_dynamic2',
          input: '{}',
        },
        threadId: 't1',
        turnId: 'turn1',
      });
      router.handleNotification('rawResponseItem/completed', {
        item: {
          type: 'custom_tool_call_output',
          call_id: 'call_dynamic2',
          output: 'Workspace dependencies are available.',
        },
        threadId: 't1',
        turnId: 'turn1',
      });
      router.handleNotification('item/completed', {
        item: {
          type: 'dynamicToolCall',
          id: 'call_dynamic2',
          namespace: 'codex_app',
          tool: 'load_workspace_dependencies',
          arguments: {},
          status: 'completed',
          contentItems: [{ type: 'inputText', text: 'Workspace dependencies are available.' }],
          success: true,
          durationMs: 12,
        },
        threadId: 't1',
        turnId: 'turn1',
      });

      expect(chunks.filter(chunk => chunk.type === 'tool_use')).toHaveLength(1);
      expect(chunks.filter(chunk => chunk.type === 'tool_result')).toHaveLength(1);
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
    const startCommand = (): void => {
      router.handleNotification('item/started', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'commandExecution',
          id: 'call_1',
          command: 'echo line 1',
          cwd: '/workspace',
          processId: '123',
          source: 'unifiedExecStartup',
          status: 'inProgress',
          commandActions: [{ type: 'unknown', command: 'echo line 1' }],
          aggregatedOutput: null,
          exitCode: null,
          durationMs: null,
        },
      });
    };

    it('buffers a command output delta until its tool use starts', () => {
      router.beginTurn({ isPlanTurn: false });
      router.handleNotification('item/commandExecution/outputDelta', {
        threadId: 't1',
        turnId: 'turn1',
        itemId: 'call_1',
        delta: 'line 1\n',
      });

      expect(chunks).toEqual([]);

      router.handleNotification('item/started', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'commandExecution',
          id: 'call_1',
          command: 'echo line 1',
          cwd: '/workspace',
          processId: '123',
          source: 'unifiedExecStartup',
          status: 'inProgress',
          commandActions: [{ type: 'unknown', command: 'echo line 1' }],
          aggregatedOutput: null,
          exitCode: null,
          durationMs: null,
        },
      });

      expect(chunks.map(chunk => chunk.type)).toEqual(['tool_use', 'tool_output']);
    });

    it('emits tool_output chunk for incremental command output', () => {
      startCommand();
      router.handleNotification('item/commandExecution/outputDelta', {
        threadId: 't1',
        turnId: 'turn1',
        itemId: 'call_1',
        delta: 'line 1\n',
      });

      expect(chunks.filter(chunk => chunk.type === 'tool_output')).toEqual([
        { type: 'tool_output', id: 'call_1', content: 'line 1\n' },
      ]);
    });

    it('accumulates multiple output deltas', () => {
      startCommand();
      router.handleNotification('item/commandExecution/outputDelta', {
        threadId: 't1', turnId: 'turn1', itemId: 'call_1', delta: 'line 1\n',
      });
      router.handleNotification('item/commandExecution/outputDelta', {
        threadId: 't1', turnId: 'turn1', itemId: 'call_1', delta: 'line 2\n',
      });

      expect(chunks.filter(chunk => chunk.type === 'tool_output')).toEqual([
        { type: 'tool_output', id: 'call_1', content: 'line 1\n' },
        { type: 'tool_output', id: 'call_1', content: 'line 2\n' },
      ]);
    });
  });

  describe('file change output delta', () => {
    const startFileChange = (): void => {
      router.handleNotification('item/started', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'fileChange',
          id: 'fc_1',
          changes: [{ path: '/workspace/foo.ts', type: 'update' }],
          status: 'inProgress',
        },
      });
    };

    it('buffers a file change output delta until its tool use starts', () => {
      router.beginTurn({ isPlanTurn: false });
      router.handleNotification('item/fileChange/outputDelta', {
        threadId: 't1',
        turnId: 'turn1',
        itemId: 'fc_1',
        delta: 'Applied patch to foo.ts',
      });

      expect(chunks).toEqual([]);

      router.handleNotification('item/started', {
        threadId: 't1',
        turnId: 'turn1',
        item: {
          type: 'fileChange',
          id: 'fc_1',
          changes: [{ path: '/workspace/foo.ts', type: 'update' }],
          status: 'inProgress',
        },
      });

      expect(chunks.map(chunk => chunk.type)).toEqual(['tool_use', 'tool_output']);
    });

    it('emits tool_output chunk for incremental file change output', () => {
      startFileChange();
      router.handleNotification('item/fileChange/outputDelta', {
        threadId: 't1',
        turnId: 'turn1',
        itemId: 'fc_1',
        delta: 'Applied patch to foo.ts',
      });

      expect(chunks.filter(chunk => chunk.type === 'tool_output')).toEqual([
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

    it('hides generated image placeholder tags from userMessage boundaries', () => {
      router.handleNotification('item/started', {
        item: {
          type: 'userMessage',
          id: 'u1',
          content: [
            { type: 'text', text: '<image name=[Image #1] path="/tmp/1-image-1.png">' },
            { type: 'localImage', path: '/tmp/1-image-1.png' },
            { type: 'text', text: '</image>' },
            { type: 'text', text: 'what was in this img?' },
          ],
        },
        threadId: 't1',
        turnId: 'turn1',
      });

      expect(chunks).toEqual([
        { type: 'user_message_start', itemId: 'u1', content: 'what was in this img?' },
      ]);
    });

    it('hides recommended plugin metadata from userMessage boundaries', () => {
      router.handleNotification('item/started', {
        item: {
          type: 'userMessage',
          id: 'metadata',
          content: [{
            type: 'text',
            text: [
              '<recommended_plugins>',
              'Install Google Drive when it would help.',
              '</recommended_plugins>',
              '# AGENTS.md instructions for /vault',
              '<INSTRUCTIONS>',
              'Do good work.',
              '</INSTRUCTIONS>',
              '<environment_context>',
              '  <cwd>/vault</cwd>',
              '</environment_context>',
            ].join('\n'),
          }],
        },
        threadId: 't1',
        turnId: 'turn1',
      });
      router.handleNotification('item/started', {
        item: { type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'fix it' }] },
        threadId: 't1',
        turnId: 'turn1',
      });

      expect(chunks).toEqual([
        { type: 'user_message_start', itemId: 'u1', content: 'fix it' },
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
