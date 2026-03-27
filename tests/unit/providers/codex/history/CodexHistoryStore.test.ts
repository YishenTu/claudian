import * as path from 'path';

import { parseCodexSessionContent, parseCodexSessionFile } from '@/providers/codex/history/CodexHistoryStore';

const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures');

describe('CodexHistoryStore', () => {
  describe('parseCodexSessionFile - simple session', () => {
    it('should parse a simple session with reasoning and agent message', () => {
      const filePath = path.join(FIXTURES_DIR, 'codex-session-simple.jsonl');
      const messages = parseCodexSessionFile(filePath);

      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe('assistant');
      expect(messages[0].content).toBe('Hello! I can help you with that.');

      // Should have thinking content block
      const thinkingBlock = messages[0].contentBlocks?.find(b => b.type === 'thinking');
      expect(thinkingBlock).toBeDefined();
      expect(thinkingBlock).toMatchObject({
        type: 'thinking',
        content: 'Let me think about this request carefully.',
      });

      // Should have text content block
      const textBlock = messages[0].contentBlocks?.find(b => b.type === 'text');
      expect(textBlock).toBeDefined();
    });
  });

  describe('parseCodexSessionFile - tools session', () => {
    it('should parse a session with command execution and file changes', () => {
      const filePath = path.join(FIXTURES_DIR, 'codex-session-tools.jsonl');
      const messages = parseCodexSessionFile(filePath);

      expect(messages).toHaveLength(1);

      const msg = messages[0];
      expect(msg.toolCalls).toBeDefined();
      expect(msg.toolCalls!.length).toBeGreaterThanOrEqual(2);

      // Check command execution
      const bashTool = msg.toolCalls!.find(tc => tc.name === 'Bash');
      expect(bashTool).toBeDefined();
      expect(bashTool!.input.command).toBe('cat src/main.ts');
      expect(bashTool!.status).toBe('completed');

      // Check file change
      const patchTool = msg.toolCalls!.find(tc => tc.name === 'apply_patch');
      expect(patchTool).toBeDefined();
      expect(patchTool!.status).toBe('completed');
    });

    it('should preserve content blocks order', () => {
      const filePath = path.join(FIXTURES_DIR, 'codex-session-tools.jsonl');
      const messages = parseCodexSessionFile(filePath);

      const blocks = messages[0].contentBlocks;
      expect(blocks).toBeDefined();
      expect(blocks!.length).toBeGreaterThanOrEqual(3);

      // First block should be text (from initial agent message)
      expect(blocks![0].type).toBe('text');
      // Then tool_use blocks
      const toolBlocks = blocks!.filter(b => b.type === 'tool_use');
      expect(toolBlocks.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('parseCodexSessionFile - abort session', () => {
    it('should handle turn.failed and mark as interrupted', () => {
      const filePath = path.join(FIXTURES_DIR, 'codex-session-abort.jsonl');
      const messages = parseCodexSessionFile(filePath);

      // Should have two messages: one interrupted, one successful
      expect(messages).toHaveLength(2);
      expect(messages[0].isInterrupt).toBe(true);
      expect(messages[1].isInterrupt).toBeUndefined();
      expect(messages[1].content).toBe('OK, what would you like me to do instead?');
    });

    it('keeps the latest streamed content for interrupted turns', () => {
      const content = [
        JSON.stringify({ type: 'event', event: { type: 'turn.started' } }),
        JSON.stringify({ type: 'event', event: { type: 'item.started', item: { id: 'item_1', type: 'agent_message', text: '' } } }),
        JSON.stringify({ type: 'event', event: { type: 'item.updated', item: { id: 'item_1', type: 'agent_message', text: 'Hello' } } }),
        JSON.stringify({ type: 'event', event: { type: 'item.updated', item: { id: 'item_1', type: 'agent_message', text: 'Hello world' } } }),
        JSON.stringify({ type: 'event', event: { type: 'turn.failed', error: { message: 'Cancelled' } } }),
      ].join('\n');

      const messages = parseCodexSessionContent(content);

      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        role: 'assistant',
        content: 'Hello world',
        isInterrupt: true,
      });
    });
  });

  describe('parseCodexSessionFile - web search session', () => {
    it('should parse web search items', () => {
      const filePath = path.join(FIXTURES_DIR, 'codex-session-websearch.jsonl');
      const messages = parseCodexSessionFile(filePath);

      expect(messages).toHaveLength(1);

      const msg = messages[0];
      expect(msg.toolCalls).toBeDefined();

      const searchTool = msg.toolCalls!.find(tc => tc.name === 'WebSearch');
      expect(searchTool).toBeDefined();
      expect(searchTool!.input.query).toBe('obsidian plugin API documentation');
      expect(searchTool!.status).toBe('completed');
    });
  });

  describe('parseCodexSessionFile - non-existent file', () => {
    it('should return empty array for missing files', () => {
      const messages = parseCodexSessionFile('/nonexistent/path.jsonl');
      expect(messages).toEqual([]);
    });
  });

  describe('parseCodexSessionContent - persisted response items', () => {
    it('reconstructs user and assistant turns from response_item logs', () => {
      const content = [
        JSON.stringify({
          timestamp: '2026-03-27T00:00:00.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Review this diff.' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-27T00:00:01.000Z',
          type: 'event_msg',
          payload: {
            type: 'agent_reasoning',
            text: 'Thinking through the changes.',
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-27T00:00:02.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'shell_command',
            arguments: '{"command":"git diff --stat"}',
            call_id: 'call_1',
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-27T00:00:03.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call_output',
            call_id: 'call_1',
            output: 'Exit code: 0\nOutput:\n src/main.ts | 2 +-',
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-27T00:00:04.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'The diff looks good.' }],
          },
        }),
      ].join('\n');

      const messages = parseCodexSessionContent(content);

      expect(messages).toHaveLength(2);
      expect(messages[0]).toMatchObject({
        role: 'user',
        content: 'Review this diff.',
      });
      expect(messages[1]).toMatchObject({
        role: 'assistant',
        content: 'The diff looks good.',
      });

      expect(messages[1].toolCalls).toEqual([
        expect.objectContaining({
          id: 'call_1',
          name: 'Bash',
          input: { command: 'git diff --stat' },
          status: 'completed',
        }),
      ]);

      expect(messages[1].contentBlocks).toEqual([
        { type: 'thinking', content: 'Thinking through the changes.' },
        { type: 'tool_use', toolId: 'call_1' },
        { type: 'text', content: 'The diff looks good.' },
      ]);
    });
  });
});
