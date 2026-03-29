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

    it('should rebuild thinking text from persisted reasoning content blocks', () => {
      const content = [
        JSON.stringify({
          timestamp: '2026-03-29T00:00:00.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Explain this.' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-29T00:00:00.000Z',
          type: 'response_item',
          payload: {
            type: 'reasoning',
            summary: [],
            content: ['First thought', ' second thought'],
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-29T00:00:00.002Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Done.' }],
          },
        }),
      ].join('\n');

      const messages = parseCodexSessionContent(content);

      expect(messages).toHaveLength(2);
      expect(messages[1].contentBlocks).toEqual([
        { type: 'thinking', content: 'First thought\n\nsecond thought' },
        { type: 'text', content: 'Done.' },
      ]);
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

      // Result should be normalized (Output:\n stripped)
      expect(messages[1].toolCalls![0].result).toBe(' src/main.ts | 2 +-');

      expect(messages[1].contentBlocks).toEqual([
        { type: 'thinking', content: 'Thinking through the changes.' },
        { type: 'tool_use', toolId: 'call_1' },
        { type: 'text', content: 'The diff looks good.' },
      ]);
    });

    it('deduplicates the same user message when both response_item and event_msg are persisted', () => {
      const content = [
        JSON.stringify({
          timestamp: '2026-03-27T00:00:00.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'hi' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-27T00:00:00.001Z',
          type: 'event_msg',
          payload: {
            type: 'user_message',
            message: 'hi',
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-27T00:00:01.000Z',
          type: 'event_msg',
          payload: {
            type: 'agent_message',
            message: 'Hello there.',
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-27T00:00:01.001Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Hello there.' }],
          },
        }),
      ].join('\n');

      const messages = parseCodexSessionContent(content);

      expect(messages).toEqual([
        expect.objectContaining({
          role: 'user',
          content: 'hi',
        }),
        expect.objectContaining({
          role: 'assistant',
          content: 'Hello there.',
        }),
      ]);
    });
  });

  describe('parseCodexSessionFile - persisted tools', () => {
    it('restores exec_command as Bash with normalized result', () => {
      const filePath = path.join(FIXTURES_DIR, 'codex-session-persisted-tools.jsonl');
      const messages = parseCodexSessionFile(filePath);

      const assistantMsg = messages.find(m => m.role === 'assistant' && m.toolCalls);
      expect(assistantMsg).toBeDefined();

      const bashTool = assistantMsg!.toolCalls!.find(tc => tc.name === 'Bash');
      expect(bashTool).toBeDefined();
      expect(bashTool!.id).toBe('call_exec_1');
      expect(bashTool!.input).toEqual({ command: 'cat src/main.ts' });
      expect(bashTool!.status).toBe('completed');
      // Result should be normalized: "Output:\n" prefix stripped
      expect(bashTool!.result).toBe("import { Plugin } from 'obsidian';");
    });

    it('restores custom_tool_call apply_patch as native apply_patch', () => {
      const filePath = path.join(FIXTURES_DIR, 'codex-session-persisted-tools.jsonl');
      const messages = parseCodexSessionFile(filePath);

      const assistantMsg = messages.find(m => m.role === 'assistant' && m.toolCalls);
      const patchTool = assistantMsg!.toolCalls!.find(tc => tc.name === 'apply_patch');
      expect(patchTool).toBeDefined();
      expect(patchTool!.id).toBe('call_patch_1');
      expect(patchTool!.input.patch).toContain('Update File: src/main.ts');
      expect(patchTool!.status).toBe('completed');
    });

    it('restores raw custom_tool_call apply_patch input as patch text', () => {
      const content = [
        JSON.stringify({
          timestamp: '2026-03-27T00:00:00.000Z',
          type: 'event_msg',
          payload: { type: 'task_started' },
        }),
        JSON.stringify({
          timestamp: '2026-03-27T00:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'custom_tool_call',
            name: 'apply_patch',
            call_id: 'call_patch_raw',
            input: '*** Begin Patch\n*** Update File: src/main.ts\n*** End Patch',
          },
        }),
      ].join('\n');

      const messages = parseCodexSessionContent(content);
      const assistantMsg = messages.find(m => m.role === 'assistant' && m.toolCalls);
      const patchTool = assistantMsg!.toolCalls!.find(tc => tc.name === 'apply_patch');
      expect(patchTool).toBeDefined();
      expect(patchTool!.input.patch).toBe('*** Begin Patch\n*** Update File: src/main.ts\n*** End Patch');
    });

    it('restores update_plan as TodoWrite', () => {
      const filePath = path.join(FIXTURES_DIR, 'codex-session-persisted-tools.jsonl');
      const messages = parseCodexSessionFile(filePath);

      const assistantMsg = messages.find(m => m.role === 'assistant' && m.toolCalls);
      const todoTool = assistantMsg!.toolCalls!.find(tc => tc.name === 'TodoWrite');
      expect(todoTool).toBeDefined();
      expect(todoTool!.id).toBe('call_plan_1');
      expect(todoTool!.input.todos).toEqual([
        expect.objectContaining({ content: 'Fix the bug', status: 'completed' }),
        expect.objectContaining({ content: 'Run tests', status: 'in_progress' }),
      ]);
    });

    it('restores request_user_input as AskUserQuestion', () => {
      const filePath = path.join(FIXTURES_DIR, 'codex-session-persisted-tools.jsonl');
      const messages = parseCodexSessionFile(filePath);

      const assistantMsg = messages.find(m => m.role === 'assistant' && m.toolCalls);
      const askTool = assistantMsg!.toolCalls!.find(tc => tc.name === 'AskUserQuestion');
      expect(askTool).toBeDefined();
      expect(askTool!.id).toBe('call_ask_1');
      expect(askTool!.input.questions).toEqual([
        expect.objectContaining({ question: 'Should I also update the tests?', id: 'q1' }),
      ]);
    });

    it('restores request_user_input options and multi-select metadata', () => {
      const content = [
        JSON.stringify({
          timestamp: '2026-03-27T00:00:00.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'request_user_input',
            call_id: 'call_ask_opts',
            arguments: JSON.stringify({
              questions: [{
                id: 'title_generation_timing',
                question: 'When should I generate the title?',
                options: [
                  { label: 'Non-blocking', description: 'Generate it later.' },
                  { label: 'Blocking', description: 'Wait before continuing.' },
                ],
                multi_select: true,
              }],
            }),
          },
        }),
      ].join('\n');

      const messages = parseCodexSessionContent(content);
      const assistantMsg = messages.find(m => m.role === 'assistant' && m.toolCalls);
      const askTool = assistantMsg!.toolCalls!.find(tc => tc.name === 'AskUserQuestion');

      expect(askTool!.input.questions).toEqual([
        {
          id: 'title_generation_timing',
          question: 'When should I generate the title?',
          header: 'Q1',
          options: [
            { label: 'Non-blocking', description: 'Generate it later.' },
            { label: 'Blocking', description: 'Wait before continuing.' },
          ],
          multiSelect: true,
        },
      ]);
    });

    it('restores view_image as Read', () => {
      const filePath = path.join(FIXTURES_DIR, 'codex-session-persisted-tools.jsonl');
      const messages = parseCodexSessionFile(filePath);

      const assistantMsg = messages.find(m => m.role === 'assistant' && m.toolCalls);
      const readTool = assistantMsg!.toolCalls!.find(tc => tc.name === 'Read');
      expect(readTool).toBeDefined();
      expect(readTool!.id).toBe('call_img_1');
      expect(readTool!.input.file_path).toBe('/tmp/screenshot.png');
    });

    it('restores write_stdin as native write_stdin', () => {
      const filePath = path.join(FIXTURES_DIR, 'codex-session-persisted-tools.jsonl');
      const messages = parseCodexSessionFile(filePath);

      const assistantMsg = messages.find(m => m.role === 'assistant' && m.toolCalls);
      const stdinTool = assistantMsg!.toolCalls!.find(tc => tc.name === 'write_stdin');
      expect(stdinTool).toBeDefined();
      expect(stdinTool!.id).toBe('call_stdin_1');
      expect(stdinTool!.input.session_id).toBe('sess_1');
    });
  });

  describe('parseCodexSessionFile - agent lifecycle', () => {
    it('restores agent lifecycle tools with native names', () => {
      const filePath = path.join(FIXTURES_DIR, 'codex-session-agent-lifecycle.jsonl');
      const messages = parseCodexSessionFile(filePath);

      const assistantMsg = messages.find(m => m.role === 'assistant' && m.toolCalls);
      expect(assistantMsg).toBeDefined();
      const toolNames = assistantMsg!.toolCalls!.map(tc => tc.name);

      expect(toolNames).toContain('spawn_agent');
      expect(toolNames).toContain('send_input');
      expect(toolNames).toContain('wait');
      expect(toolNames).toContain('resume_agent');
      expect(toolNames).toContain('close_agent');

      // Should NOT be mapped to Agent/Task
      expect(toolNames).not.toContain('Agent');
      expect(toolNames).not.toContain('Task');
    });

    it('preserves spawn_agent input fields', () => {
      const filePath = path.join(FIXTURES_DIR, 'codex-session-agent-lifecycle.jsonl');
      const messages = parseCodexSessionFile(filePath);

      const assistantMsg = messages.find(m => m.role === 'assistant' && m.toolCalls);
      const spawnTool = assistantMsg!.toolCalls!.find(tc => tc.name === 'spawn_agent');
      expect(spawnTool!.input).toEqual({
        message: 'Update the imports in utils.ts',
        agent_type: 'code-writer',
      });
    });

    it('preserves wait input fields', () => {
      const filePath = path.join(FIXTURES_DIR, 'codex-session-agent-lifecycle.jsonl');
      const messages = parseCodexSessionFile(filePath);

      const assistantMsg = messages.find(m => m.role === 'assistant' && m.toolCalls);
      const waitTool = assistantMsg!.toolCalls!.find(tc => tc.name === 'wait');
      expect(waitTool!.input).toEqual({
        ids: ['agent_001'],
        timeout_ms: 30000,
      });
    });
  });

  describe('parseCodexSessionContent - system-injected user messages', () => {
    it('should skip AGENTS.md instructions injected as user message', () => {
      const content = [
        JSON.stringify({ type: 'session_meta', id: 'test-session' }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'developer',
            content: [{ type: 'input_text', text: '<permissions instructions>\nSandbox mode...\n</permissions instructions>' }],
          },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [
              { type: 'input_text', text: '# AGENTS.md instructions for /Users/test/project\n\n<INSTRUCTIONS>\nDo good work.\n</INSTRUCTIONS>' },
              { type: 'input_text', text: '<environment_context>\n  <cwd>/Users/test/project</cwd>\n</environment_context>' },
            ],
          },
        }),
        JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }),
        JSON.stringify({
          timestamp: '2026-03-27T00:00:00.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Fix the bug in main.ts' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-27T00:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Done.' }],
          },
        }),
      ].join('\n');

      const messages = parseCodexSessionContent(content);

      // AGENTS.md message should be filtered out; only real user + assistant remain
      expect(messages).toHaveLength(2);
      expect(messages[0]).toMatchObject({ role: 'user', content: 'Fix the bug in main.ts' });
      expect(messages[1]).toMatchObject({ role: 'assistant', content: 'Done.' });
    });

    it('should skip standalone <environment_context> user message', () => {
      const content = [
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '<environment_context>\n  <cwd>/Users/test</cwd>\n</environment_context>' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-27T00:00:00.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Ready.' }],
          },
        }),
      ].join('\n');

      const messages = parseCodexSessionContent(content);

      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({ role: 'assistant', content: 'Ready.' });
    });

    it('should set displayContent stripping bracket context from user messages', () => {
      const content = [
        JSON.stringify({
          timestamp: '2026-03-27T00:00:00.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Fix the bug\n[Current note: notes/bug.md]' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-27T00:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Done.' }],
          },
        }),
      ].join('\n');

      const messages = parseCodexSessionContent(content);

      expect(messages).toHaveLength(2);
      expect(messages[0]).toMatchObject({
        role: 'user',
        content: 'Fix the bug\n[Current note: notes/bug.md]',
        displayContent: 'Fix the bug',
      });
    });

    it('should set displayContent stripping editor selection context', () => {
      const content = [
        JSON.stringify({
          timestamp: '2026-03-27T00:00:00.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Explain this\n[Editor selection from notes/code.md:\nconst x = 1;\n]' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-27T00:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'It declares a variable.' }],
          },
        }),
      ].join('\n');

      const messages = parseCodexSessionContent(content);

      expect(messages[0]).toMatchObject({
        role: 'user',
        displayContent: 'Explain this',
      });
    });

    it('should not set displayContent on plain user messages', () => {
      const content = [
        JSON.stringify({
          timestamp: '2026-03-27T00:00:00.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'What does main.ts do?' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-27T00:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'It initializes the plugin.' }],
          },
        }),
      ].join('\n');

      const messages = parseCodexSessionContent(content);

      expect(messages[0]).toMatchObject({ role: 'user', content: 'What does main.ts do?' });
      expect(messages[0].displayContent).toBeUndefined();
    });

    it('should filter out skill wrapper user messages as system-injected', () => {
      const skillText = [
        '<skill>',
        '<name>test</name>',
        '<path>/Users/me/.codex/skills/test/SKILL.md</path>',
        '---',
        'description: testing',
        '---',
        '',
        '## Task',
        '',
        'tell me a joke',
        '',
        '</skill>',
      ].join('\n');

      const content = [
        JSON.stringify({
          timestamp: '2026-03-27T00:00:00.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: skillText }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-27T00:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Why did the skeleton...' }],
          },
        }),
      ].join('\n');

      const messages = parseCodexSessionContent(content);

      // Skill wrapper is system-injected — only the assistant message should remain
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({ role: 'assistant' });
    });

    it('should NOT skip real user messages', () => {
      const content = [
        JSON.stringify({
          timestamp: '2026-03-27T00:00:00.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'What does main.ts do?' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-27T00:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'It initializes the plugin.' }],
          },
        }),
      ].join('\n');

      const messages = parseCodexSessionContent(content);

      expect(messages).toHaveLength(2);
      expect(messages[0]).toMatchObject({ role: 'user', content: 'What does main.ts do?' });
    });
  });

  describe('parseCodexSessionFile - persisted web_search_call', () => {
    it('restores web_search_call as WebSearch', () => {
      const filePath = path.join(FIXTURES_DIR, 'codex-session-websearch-persisted.jsonl');
      const messages = parseCodexSessionFile(filePath);

      const assistantMsg = messages.find(m => m.role === 'assistant' && m.toolCalls);
      expect(assistantMsg).toBeDefined();

      const searchTool = assistantMsg!.toolCalls!.find(tc => tc.name === 'WebSearch');
      expect(searchTool).toBeDefined();
      expect(searchTool!.id).toBe('call_ws_1');
      expect(searchTool!.input.actionType).toBe('search');
      expect(searchTool!.input.query).toBe('obsidian plugin API');
      expect(searchTool!.status).toBe('completed');
    });

    it('keeps distinct persisted web_search_call entries when call_id is missing', () => {
      const content = [
        JSON.stringify({
          timestamp: '2026-03-27T00:00:00.000Z',
          type: 'event_msg',
          payload: { type: 'task_started' },
        }),
        JSON.stringify({
          timestamp: '2026-03-27T00:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'web_search_call',
            status: 'completed',
            action: { type: 'search', query: 'obsidian plugin API' },
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-27T00:00:02.000Z',
          type: 'response_item',
          payload: {
            type: 'web_search_call',
            status: 'completed',
            action: { type: 'open_page', url: 'https://docs.obsidian.md' },
          },
        }),
      ].join('\n');

      const messages = parseCodexSessionContent(content);
      const assistantMsg = messages.find(m => m.role === 'assistant' && m.toolCalls);
      expect(assistantMsg).toBeDefined();

      const webSearchTools = assistantMsg!.toolCalls!.filter(tc => tc.name === 'WebSearch');
      expect(webSearchTools).toHaveLength(2);
      expect(webSearchTools[0]).toMatchObject({
        id: 'tail-ws-1',
        input: { actionType: 'search', query: 'obsidian plugin API' },
        result: 'Search complete',
      });
      expect(webSearchTools[1]).toMatchObject({
        id: 'tail-ws-2',
        input: { actionType: 'open_page', url: 'https://docs.obsidian.md' },
        result: 'Search complete',
      });
    });
  });

  describe('parseCodexSessionContent - event_msg handling', () => {
    it('task_started + agent_message + task_complete produces proper turn', () => {
      const content = [
        JSON.stringify({
          timestamp: '2026-03-27T00:00:00.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Hello' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-27T00:00:01.000Z',
          type: 'event_msg',
          payload: { type: 'task_started' },
        }),
        JSON.stringify({
          timestamp: '2026-03-27T00:00:02.000Z',
          type: 'event_msg',
          payload: { type: 'agent_message', message: 'Hi there!' },
        }),
        JSON.stringify({
          timestamp: '2026-03-27T00:00:03.000Z',
          type: 'event_msg',
          payload: { type: 'task_complete' },
        }),
      ].join('\n');

      const messages = parseCodexSessionContent(content);

      expect(messages).toHaveLength(2);
      expect(messages[0]).toMatchObject({ role: 'user', content: 'Hello' });
      expect(messages[1]).toMatchObject({ role: 'assistant', content: 'Hi there!' });
    });

    it('turn_aborted marks bubble as interrupted', () => {
      const content = [
        JSON.stringify({
          timestamp: '2026-03-27T00:00:00.000Z',
          type: 'event_msg',
          payload: { type: 'task_started' },
        }),
        JSON.stringify({
          timestamp: '2026-03-27T00:00:01.000Z',
          type: 'event_msg',
          payload: { type: 'agent_message', message: 'Working on it...' },
        }),
        JSON.stringify({
          timestamp: '2026-03-27T00:00:02.000Z',
          type: 'event_msg',
          payload: { type: 'turn_aborted' },
        }),
      ].join('\n');

      const messages = parseCodexSessionContent(content);

      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        role: 'assistant',
        content: 'Working on it...',
        isInterrupt: true,
      });
    });

    it('user_message reconstructs user ChatMessage from event_msg', () => {
      const content = [
        JSON.stringify({
          timestamp: '2026-03-27T00:00:00.000Z',
          type: 'event_msg',
          payload: { type: 'task_started' },
        }),
        JSON.stringify({
          timestamp: '2026-03-27T00:00:00.500Z',
          type: 'event_msg',
          payload: { type: 'user_message', message: 'What is 2+2?' },
        }),
        JSON.stringify({
          timestamp: '2026-03-27T00:00:01.000Z',
          type: 'event_msg',
          payload: { type: 'agent_message', message: 'The answer is 4.' },
        }),
        JSON.stringify({
          timestamp: '2026-03-27T00:00:02.000Z',
          type: 'event_msg',
          payload: { type: 'task_complete' },
        }),
      ].join('\n');

      const messages = parseCodexSessionContent(content);

      expect(messages).toHaveLength(2);
      expect(messages[0]).toMatchObject({
        role: 'user',
        content: 'What is 2+2?',
      });
      expect(messages[1]).toMatchObject({
        role: 'assistant',
        content: 'The answer is 4.',
      });
    });

    it('user_message with system content is filtered out', () => {
      const content = [
        JSON.stringify({
          timestamp: '2026-03-27T00:00:00.000Z',
          type: 'event_msg',
          payload: { type: 'task_started' },
        }),
        JSON.stringify({
          timestamp: '2026-03-27T00:00:00.500Z',
          type: 'event_msg',
          payload: { type: 'user_message', message: '# AGENTS.md instructions for /test\nDo good.' },
        }),
        JSON.stringify({
          timestamp: '2026-03-27T00:00:01.000Z',
          type: 'event_msg',
          payload: { type: 'agent_message', message: 'Done.' },
        }),
        JSON.stringify({
          timestamp: '2026-03-27T00:00:02.000Z',
          type: 'event_msg',
          payload: { type: 'task_complete' },
        }),
      ].join('\n');

      const messages = parseCodexSessionContent(content);

      // System user message should be filtered; only assistant remains
      const userMessages = messages.filter(m => m.role === 'user');
      expect(userMessages).toHaveLength(0);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({ role: 'assistant', content: 'Done.' });
    });
  });

  describe('parseCodexSessionContent - multi-bubble turns', () => {
    it('assistant text + tool call + tool result + more text in single turn', () => {
      const content = [
        JSON.stringify({
          timestamp: '2026-03-27T00:00:00.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Check the file.' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-27T00:00:01.000Z',
          type: 'event_msg',
          payload: { type: 'agent_reasoning', text: 'Let me check.' },
        }),
        JSON.stringify({
          timestamp: '2026-03-27T00:00:02.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'exec_command',
            arguments: '{"command":"cat file.txt"}',
            call_id: 'call_100',
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-27T00:00:03.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call_output',
            call_id: 'call_100',
            output: 'Exit code: 0\nOutput:\nhello world',
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-27T00:00:04.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'The file contains hello world.' }],
          },
        }),
      ].join('\n');

      const messages = parseCodexSessionContent(content);

      expect(messages).toHaveLength(2);
      expect(messages[0]).toMatchObject({ role: 'user', content: 'Check the file.' });

      const assistant = messages[1];
      expect(assistant.role).toBe('assistant');
      expect(assistant.content).toBe('The file contains hello world.');

      // Tool calls should be present
      expect(assistant.toolCalls).toHaveLength(1);
      expect(assistant.toolCalls![0]).toMatchObject({
        id: 'call_100',
        name: 'Bash',
        status: 'completed',
      });

      // Content blocks: thinking, tool_use, text
      expect(assistant.contentBlocks).toBeDefined();
      const blockTypes = assistant.contentBlocks!.map(b => b.type);
      expect(blockTypes).toContain('thinking');
      expect(blockTypes).toContain('tool_use');
      expect(blockTypes).toContain('text');
    });
  });

  describe('parseCodexSessionContent - cross-turn tool output', () => {
    it('function_call in turn 1, function_call_output in turn 2 links back', () => {
      const content = [
        // Turn 1: user + tool call
        JSON.stringify({
          timestamp: '2026-03-27T00:00:00.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Run the command.' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-27T00:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'exec_command',
            arguments: '{"command":"echo hi"}',
            call_id: 'call_cross_1',
          },
        }),
        // Turn 2: new user message + output for turn 1's call
        JSON.stringify({
          timestamp: '2026-03-27T00:00:02.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Continue.' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-27T00:00:03.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call_output',
            call_id: 'call_cross_1',
            output: 'Exit code: 0\nOutput:\nhi',
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-27T00:00:04.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Done.' }],
          },
        }),
      ].join('\n');

      const messages = parseCodexSessionContent(content);

      // Find the assistant message from turn 1 (has the tool call)
      const turn1Assistant = messages.find(
        m => m.role === 'assistant' && m.toolCalls?.some(tc => tc.id === 'call_cross_1'),
      );
      expect(turn1Assistant).toBeDefined();

      // The tool output should be resolved back to turn 1
      const tc = turn1Assistant!.toolCalls!.find(t => t.id === 'call_cross_1');
      expect(tc!.status).toBe('completed');
      expect(tc!.result).toBe('hi');
    });
  });

  describe('parseCodexSessionContent - non-string tool output', () => {
    it('does not crash when function_call_output has an array output (e.g. view_image)', () => {
      const content = [
        JSON.stringify({
          timestamp: '2026-03-27T00:00:00.000Z',
          type: 'event_msg',
          payload: { type: 'task_started', turn_id: 'turn-img' },
        }),
        JSON.stringify({
          timestamp: '2026-03-27T00:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Show me the image.' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-27T00:00:02.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'view_image',
            arguments: '{"path":"/tmp/cat.png"}',
            call_id: 'call_img_1',
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-27T00:00:03.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call_output',
            call_id: 'call_img_1',
            output: [{ type: 'input_image', image_url: 'data:image/jpeg;base64,abc' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-27T00:00:04.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Here is the image.' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-27T00:00:05.000Z',
          type: 'event_msg',
          payload: { type: 'task_complete' },
        }),
      ].join('\n');

      const messages = parseCodexSessionContent(content);

      // Should not throw and should produce messages
      expect(messages.length).toBeGreaterThan(0);

      // The tool call should be resolved
      const assistantMsg = messages.find(
        m => m.role === 'assistant' && m.toolCalls?.some(tc => tc.id === 'call_img_1'),
      );
      expect(assistantMsg).toBeDefined();

      const tc = assistantMsg!.toolCalls!.find(t => t.id === 'call_img_1');
      expect(tc!.status).toBe('completed');
      expect(tc!.result).toBe('/tmp/cat.png');
    });
  });

  describe('parseCodexSessionContent - interrupted message granularity', () => {
    it('interrupted bubble with content sets isInterrupt on ChatMessage', () => {
      const content = [
        JSON.stringify({
          timestamp: '2026-03-27T00:00:00.000Z',
          type: 'event_msg',
          payload: { type: 'task_started' },
        }),
        JSON.stringify({
          timestamp: '2026-03-27T00:00:01.000Z',
          type: 'event_msg',
          payload: { type: 'agent_message', message: 'Starting to work on the feature...' },
        }),
        JSON.stringify({
          timestamp: '2026-03-27T00:00:02.000Z',
          type: 'event_msg',
          payload: { type: 'turn_aborted' },
        }),
      ].join('\n');

      const messages = parseCodexSessionContent(content);

      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('Starting to work on the feature...');
      expect(messages[0].isInterrupt).toBe(true);
    });

    it('interrupted empty bubble sets isInterrupt on bare ChatMessage', () => {
      const content = [
        JSON.stringify({
          timestamp: '2026-03-27T00:00:00.000Z',
          type: 'event_msg',
          payload: { type: 'task_started' },
        }),
        JSON.stringify({
          timestamp: '2026-03-27T00:00:01.000Z',
          type: 'event_msg',
          payload: { type: 'turn_aborted' },
        }),
      ].join('\n');

      const messages = parseCodexSessionContent(content);

      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('');
      expect(messages[0].isInterrupt).toBe(true);
    });
  });

  describe('parseCodexSessionContent - response duration', () => {
    it('calculates durationSeconds from user timestamp to last assistant event', () => {
      const content = [
        JSON.stringify({
          timestamp: '2026-03-27T00:00:00.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Quick question.' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-27T00:00:05.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Quick answer.' }],
          },
        }),
      ].join('\n');

      const messages = parseCodexSessionContent(content);

      expect(messages).toHaveLength(2);
      const assistant = messages.find(m => m.role === 'assistant');
      expect(assistant!.durationSeconds).toBe(5);
    });

    it('attaches durationSeconds to the last assistant message of the turn', () => {
      const content = [
        JSON.stringify({
          timestamp: '2026-03-27T00:00:00.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Do stuff.' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-27T00:00:02.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'exec_command',
            arguments: '{"command":"ls"}',
            call_id: 'call_dur_1',
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-27T00:00:04.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call_output',
            call_id: 'call_dur_1',
            output: 'Exit code: 0\nOutput:\nfile.txt',
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-27T00:00:10.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Listed files.' }],
          },
        }),
      ].join('\n');

      const messages = parseCodexSessionContent(content);

      const assistant = messages.find(m => m.role === 'assistant');
      expect(assistant).toBeDefined();
      expect(assistant!.durationSeconds).toBe(10);
    });
  });

  describe('parseCodexSessionContent - persisted mcp_tool_call', () => {
    it('restores mcp_tool_call from response_item as mcp__server__tool', () => {
      const content = [
        JSON.stringify({
          timestamp: '2026-03-27T00:00:00.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Use MCP tool.' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-27T00:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'mcp_tool_call',
            server: 'myserver',
            tool: 'mytool',
            call_id: 'call_mcp_1',
            status: 'completed',
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-27T00:00:02.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'MCP tool executed.' }],
          },
        }),
      ].join('\n');

      const messages = parseCodexSessionContent(content);

      const assistant = messages.find(m => m.role === 'assistant' && m.toolCalls);
      expect(assistant).toBeDefined();

      const mcpTool = assistant!.toolCalls!.find(tc => tc.name === 'mcp__myserver__mytool');
      expect(mcpTool).toBeDefined();
      expect(mcpTool!.id).toBe('call_mcp_1');
      expect(mcpTool!.status).toBe('completed');
    });

    it('preserves MCP arguments and structured result text', () => {
      const content = [
        JSON.stringify({
          timestamp: '2026-03-27T00:00:00.000Z',
          type: 'response_item',
          payload: {
            type: 'mcp_tool_call',
            server: 'filesystem',
            tool: 'read_file',
            call_id: 'call_mcp_2',
            status: 'completed',
            arguments: { path: 'README.md' },
            result: {
              content: [
                { type: 'text', text: 'line 1' },
                { type: 'text', text: 'line 2' },
              ],
            },
          },
        }),
      ].join('\n');

      const messages = parseCodexSessionContent(content);
      const assistant = messages.find(m => m.role === 'assistant' && m.toolCalls);
      const mcpTool = assistant!.toolCalls!.find(tc => tc.id === 'call_mcp_2');

      expect(mcpTool).toMatchObject({
        name: 'mcp__filesystem__read_file',
        input: { path: 'README.md' },
        status: 'completed',
        result: 'line 1\nline 2',
      });
    });

    it('preserves MCP error output', () => {
      const content = [
        JSON.stringify({
          timestamp: '2026-03-27T00:00:00.000Z',
          type: 'response_item',
          payload: {
            type: 'mcp_tool_call',
            server: 'filesystem',
            tool: 'write_file',
            call_id: 'call_mcp_3',
            status: 'failed',
            arguments: '{"path":"README.md"}',
            error: 'Permission denied',
          },
        }),
      ].join('\n');

      const messages = parseCodexSessionContent(content);
      const assistant = messages.find(m => m.role === 'assistant' && m.toolCalls);
      const mcpTool = assistant!.toolCalls!.find(tc => tc.id === 'call_mcp_3');

      expect(mcpTool).toMatchObject({
        name: 'mcp__filesystem__write_file',
        input: { path: 'README.md' },
        status: 'error',
        result: 'Permission denied',
      });
    });
  });
});
