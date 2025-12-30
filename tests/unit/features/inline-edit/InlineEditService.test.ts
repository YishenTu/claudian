/**
 * Tests for InlineEditService - Inline text editing with Claude
 */

// eslint-disable-next-line jest/no-mocks-import
import {
  getLastOptions,
  resetMockMessages,
  setMockMessages,
} from '@test/__mocks__/claude-agent-sdk';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Mock fs module
jest.mock('fs');

// Now import after all mocks are set up
import { getPathFromToolInput } from '@/core/tools/toolInput';
import type { InlineEditRequest } from '@/features/inline-edit/InlineEditService';
import { InlineEditService } from '@/features/inline-edit/InlineEditService';
import { buildCursorContext } from '@/utils/editor';

// Create a mock plugin
function createMockPlugin(settings = {}) {
  return {
    settings: {
      model: 'sonnet',
      thinkingBudget: 'off',
      ...settings,
    },
    app: {
      vault: {
        adapter: {
          basePath: '/test/vault/path',
        },
      },
    },
    getActiveEnvironmentVariables: jest.fn().mockReturnValue(''),
  } as any;
}

describe('InlineEditService', () => {
  let service: InlineEditService;
  let mockPlugin: any;

  beforeEach(() => {
    jest.clearAllMocks();
    resetMockMessages();
    mockPlugin = createMockPlugin();
    service = new InlineEditService(mockPlugin);
  });

  describe('findClaudeCLI', () => {
    it('should find claude CLI in ~/.claude/local/claude', () => {
      const homeDir = os.homedir();
      const expectedPath = path.join(homeDir, '.claude', 'local', 'claude');

      (fs.existsSync as jest.Mock).mockImplementation((p: string) => {
        return p === expectedPath;
      });

      // Access private method via any
      const foundPath = (service as any).findClaudeCLI();

      expect(foundPath).toBe(expectedPath);
    });

    it('should find claude CLI in ~/.local/bin/claude', () => {
      const homeDir = os.homedir();
      const expectedPath = path.join(homeDir, '.local', 'bin', 'claude');

      (fs.existsSync as jest.Mock).mockImplementation((p: string) => {
        return p === expectedPath;
      });

      const foundPath = (service as any).findClaudeCLI();

      expect(foundPath).toBe(expectedPath);
    });

    it('should return null when claude CLI not found', () => {
      (fs.existsSync as jest.Mock).mockReturnValue(false);

      const foundPath = (service as any).findClaudeCLI();

      expect(foundPath).toBeNull();
    });

    it('should check paths in order of priority', () => {
      const homeDir = os.homedir();
      const checkedPaths: string[] = [];

      (fs.existsSync as jest.Mock).mockImplementation((p: string) => {
        checkedPaths.push(p);
        return false;
      });

      (service as any).findClaudeCLI();

      // First path should be ~/.claude/local/claude
      expect(checkedPaths[0]).toBe(path.join(homeDir, '.claude', 'local', 'claude'));
    });
  });

  describe('vault restriction hook', () => {
    beforeEach(() => {
      const normalizePath = (p: string) => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const pathModule = require('path');
        return pathModule.resolve(p);
      };
      (fs.realpathSync as any) = jest.fn(normalizePath);
      if (fs.realpathSync) {
        (fs.realpathSync as any).native = jest.fn(normalizePath);
      }
    });

    it('should block Read outside vault', async () => {
      const hook = (service as any).createVaultRestrictionHook('/test/vault/path');
      const res = await hook.hooks[0](
        { tool_name: 'Read', tool_input: { file_path: '/etc/passwd' } },
        'tool-1',
        {}
      );

      expect(res.continue).toBe(false);
      expect(res.hookSpecificOutput.permissionDecisionReason).toContain('outside the vault');
    });

    it('should allow Read inside vault', async () => {
      const hook = (service as any).createVaultRestrictionHook('/test/vault/path');
      const res = await hook.hooks[0](
        { tool_name: 'Read', tool_input: { file_path: '/test/vault/path/notes/a.md' } },
        'tool-2',
        {}
      );

      expect(res.continue).toBe(true);
    });

    it('should block Glob escaping pattern', async () => {
      const hook = (service as any).createVaultRestrictionHook('/test/vault/path');
      const res = await hook.hooks[0](
        { tool_name: 'Glob', tool_input: { pattern: '../**/*.md' } },
        'tool-3',
        {}
      );

      expect(res.continue).toBe(false);
    });
  });

  describe('buildPrompt', () => {
    it('should build prompt with correct format', () => {
      const request: InlineEditRequest = {
        mode: 'selection',
        selectedText: 'Hello world',
        instruction: 'Fix the greeting',
        notePath: 'notes/test.md',
      };

      const prompt = (service as any).buildPrompt(request);

      expect(prompt).toContain('<editor_selection path="notes/test.md">');
      expect(prompt).toContain('Hello world');
      expect(prompt).toContain('</editor_selection>');
      expect(prompt).toContain('<query>');
      expect(prompt).toContain('Fix the greeting');
      expect(prompt).toContain('</query>');
    });

    it('should preserve selected text with newlines', () => {
      const request: InlineEditRequest = {
        mode: 'selection',
        selectedText: 'Line 1\nLine 2\nLine 3',
        instruction: 'Fix formatting',
        notePath: 'doc.md',
      };

      const prompt = (service as any).buildPrompt(request);

      expect(prompt).toContain('Line 1\nLine 2\nLine 3');
    });

    it('should handle empty selected text', () => {
      const request: InlineEditRequest = {
        mode: 'selection',
        selectedText: '',
        instruction: 'Add content',
        notePath: 'empty.md',
      };

      const prompt = (service as any).buildPrompt(request);

      expect(prompt).toContain('<editor_selection path="empty.md">');
      expect(prompt).toContain('<query>');
      expect(prompt).toContain('Add content');
      expect(prompt).toContain('</query>');
    });
  });

  describe('parseResponse', () => {
    it('should extract text from replacement tags', () => {
      const response = 'Here is the edit:\n<replacement>Fixed text here</replacement>';

      const result = (service as any).parseResponse(response);

      expect(result.success).toBe(true);
      expect(result.editedText).toBe('Fixed text here');
    });

    it('should handle multiline replacement content', () => {
      const response = '<replacement>Line 1\nLine 2\nLine 3</replacement>';

      const result = (service as any).parseResponse(response);

      expect(result.success).toBe(true);
      expect(result.editedText).toBe('Line 1\nLine 2\nLine 3');
    });

    it('should return clarification when no replacement tags', () => {
      const response = 'Could you please clarify what you mean by "fix"?';

      const result = (service as any).parseResponse(response);

      expect(result.success).toBe(true);
      expect(result.clarification).toBe('Could you please clarify what you mean by "fix"?');
      expect(result.editedText).toBeUndefined();
    });

    it('should return error for empty response', () => {
      const result = (service as any).parseResponse('');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Empty response');
    });

    it('should return error for whitespace-only response', () => {
      const result = (service as any).parseResponse('   \n\t  ');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Empty response');
    });

    it('should handle replacement tags with special characters', () => {
      const response = '<replacement>const x = a < b && c > d;</replacement>';

      const result = (service as any).parseResponse(response);

      expect(result.success).toBe(true);
      expect(result.editedText).toBe('const x = a < b && c > d;');
    });

    it('should extract first replacement tag if multiple exist', () => {
      const response = '<replacement>first</replacement> then <replacement>second</replacement>';

      const result = (service as any).parseResponse(response);

      expect(result.success).toBe(true);
      expect(result.editedText).toBe('first');
    });

    it('should handle empty replacement tags', () => {
      const response = '<replacement></replacement>';

      const result = (service as any).parseResponse(response);

      expect(result.success).toBe(true);
      expect(result.editedText).toBe('');
    });
  });

  describe('editText', () => {
    beforeEach(() => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
    });

    it('should return error when vault path cannot be determined', async () => {
      mockPlugin.app.vault.adapter.basePath = undefined;
      service = new InlineEditService(mockPlugin);

      const result = await service.editText({
        mode: 'selection',
        selectedText: 'test',
        instruction: 'fix',
        notePath: 'test.md',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('vault path');
    });

    it('should return error when claude CLI not found', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(false);

      const result = await service.editText({
        mode: 'selection',
        selectedText: 'test',
        instruction: 'fix',
        notePath: 'test.md',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Claude CLI not found');
    });

    it('should use restricted read-only tools', async () => {
      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: '<replacement>fixed</replacement>' }] },
        },
        { type: 'result' },
      ]);

      await service.editText({
        mode: 'selection',
        selectedText: 'test',
        instruction: 'fix',
        notePath: 'test.md',
      });

      const options = getLastOptions();
      expect(options?.allowedTools).toContain('Read');
      expect(options?.allowedTools).toContain('Grep');
      expect(options?.allowedTools).toContain('Glob');
      expect(options?.allowedTools).toContain('LS');
      expect(options?.allowedTools).toContain('WebSearch');
      expect(options?.allowedTools).toContain('WebFetch');
      // Should NOT include write tools
      expect(options?.allowedTools).not.toContain('Write');
      expect(options?.allowedTools).not.toContain('Edit');
      expect(options?.allowedTools).not.toContain('Bash');
    });

    it('should bypass permissions for read-only tools', async () => {
      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: '<replacement>fixed</replacement>' }] },
        },
        { type: 'result' },
      ]);

      await service.editText({
        mode: 'selection',
        selectedText: 'test',
        instruction: 'fix',
        notePath: 'test.md',
      });

      const options = getLastOptions();
      expect(options?.permissionMode).toBe('bypassPermissions');
    });

    it('should enable thinking when configured', async () => {
      mockPlugin.settings.thinkingBudget = 'medium';
      service = new InlineEditService(mockPlugin);

      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: '<replacement>fixed</replacement>' }] },
        },
        { type: 'result' },
      ]);

      await service.editText({
        mode: 'selection',
        selectedText: 'test',
        instruction: 'fix',
        notePath: 'test.md',
      });

      const options = getLastOptions();
      expect(options?.maxThinkingTokens).toBeGreaterThan(0);
    });

    it('should capture session ID for conversation continuity', async () => {
      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'inline-session-123' },
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'What do you want to change?' }] },
        },
        { type: 'result' },
      ]);

      await service.editText({
        mode: 'selection',
        selectedText: 'test',
        instruction: 'fix',
        notePath: 'test.md',
      });

      expect((service as any).sessionId).toBe('inline-session-123');
    });

    it('should return clarification response', async () => {
      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Could you clarify what "fix" means?' }] },
        },
        { type: 'result' },
      ]);

      const result = await service.editText({
        mode: 'selection',
        selectedText: 'broken code',
        instruction: 'fix',
        notePath: 'test.md',
      });

      expect(result.success).toBe(true);
      expect(result.clarification).toBe('Could you clarify what "fix" means?');
    });
  });

  describe('continueConversation', () => {
    beforeEach(() => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
    });

    it('should return error when no active conversation', async () => {
      const result = await service.continueConversation('more details');

      expect(result.success).toBe(false);
      expect(result.error).toContain('No active conversation');
    });

    it('should resume session on follow-up', async () => {
      // First message to establish session
      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'continue-session' },
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'What do you want?' }] },
        },
        { type: 'result' },
      ]);

      await service.editText({
        mode: 'selection',
        selectedText: 'test',
        instruction: 'fix',
        notePath: 'test.md',
      });

      // Follow-up message
      setMockMessages([
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: '<replacement>final result</replacement>' }] },
        },
        { type: 'result' },
      ]);

      await service.continueConversation('make it blue');

      const options = getLastOptions();
      expect(options?.resume).toBe('continue-session');
    });
  });

  describe('resetConversation', () => {
    it('should clear session ID', async () => {
      (service as any).sessionId = 'some-session';

      service.resetConversation();

      expect((service as any).sessionId).toBeNull();
    });
  });

  describe('cancel', () => {
    it('should abort ongoing request', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);

      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: '<replacement>fixed</replacement>' }] },
        },
      ]);

      const editPromise = service.editText({
        mode: 'selection',
        selectedText: 'test',
        instruction: 'fix',
        notePath: 'test.md',
      });

      // Cancel immediately
      service.cancel();

      const result = await editPromise;
      expect(result.success).toBe(false);
      expect(result.error).toBe('Cancelled');
    });

    it('should handle cancel when no request is running', () => {
      expect(() => service.cancel()).not.toThrow();
    });
  });

  describe('read-only hook enforcement', () => {
    it('should create hook that allows read-only tools', () => {
      const hook = (service as any).createReadOnlyHook();

      expect(hook.hooks).toHaveLength(1);
    });

    it('should allow Read tool through hook', async () => {
      const hook = (service as any).createReadOnlyHook();
      const hookFn = hook.hooks[0];

      const result = await hookFn({ tool_name: 'Read', tool_input: { file_path: 'test.md' } });

      expect(result.continue).toBe(true);
    });

    it('should allow Grep tool through hook', async () => {
      const hook = (service as any).createReadOnlyHook();
      const hookFn = hook.hooks[0];

      const result = await hookFn({ tool_name: 'Grep', tool_input: { pattern: 'test' } });

      expect(result.continue).toBe(true);
    });

    it('should allow WebSearch tool through hook', async () => {
      const hook = (service as any).createReadOnlyHook();
      const hookFn = hook.hooks[0];

      const result = await hookFn({ tool_name: 'WebSearch', tool_input: { query: 'test' } });

      expect(result.continue).toBe(true);
    });

    it('should block Write tool through hook', async () => {
      const hook = (service as any).createReadOnlyHook();
      const hookFn = hook.hooks[0];

      const result = await hookFn({ tool_name: 'Write', tool_input: { file_path: 'test.md' } });

      expect(result.continue).toBe(false);
      expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
      expect(result.hookSpecificOutput.permissionDecisionReason).toContain('not allowed');
    });

    it('should block Bash tool through hook', async () => {
      const hook = (service as any).createReadOnlyHook();
      const hookFn = hook.hooks[0];

      const result = await hookFn({ tool_name: 'Bash', tool_input: { command: 'rm -rf /' } });

      expect(result.continue).toBe(false);
      expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
    });

    it('should block Edit tool through hook', async () => {
      const hook = (service as any).createReadOnlyHook();
      const hookFn = hook.hooks[0];

      const result = await hookFn({ tool_name: 'Edit', tool_input: { file_path: 'test.md' } });

      expect(result.continue).toBe(false);
    });
  });

  describe('extractTextFromMessage', () => {
    it('should extract text from assistant message', () => {
      const message = {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Hello world' }],
        },
      };

      const text = (service as any).extractTextFromMessage(message);

      expect(text).toBe('Hello world');
    });

    it('should extract text from content_block_start stream event', () => {
      const message = {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: { type: 'text', text: 'Starting...' },
        },
      };

      const text = (service as any).extractTextFromMessage(message);

      expect(text).toBe('Starting...');
    });

    it('should extract text from content_block_delta stream event', () => {
      const message = {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: ' more text' },
        },
      };

      const text = (service as any).extractTextFromMessage(message);

      expect(text).toBe(' more text');
    });

    it('should return null for non-text messages', () => {
      const message = {
        type: 'system',
        subtype: 'init',
      };

      const text = (service as any).extractTextFromMessage(message);

      expect(text).toBeNull();
    });

    it('should return null for thinking blocks', () => {
      const message = {
        type: 'assistant',
        message: {
          content: [{ type: 'thinking', thinking: 'Let me think...' }],
        },
      };

      const text = (service as any).extractTextFromMessage(message);

      expect(text).toBeNull();
    });
  });

  describe('error handling', () => {
    beforeEach(() => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
    });

    it('should surface SDK query errors', async () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const sdk = require('@anthropic-ai/claude-agent-sdk');
      const spy = jest.spyOn(sdk, 'query').mockImplementation(() => {
        throw new Error('boom');
      });

      const result = await service.editText({
        mode: 'selection',
        selectedText: 'text',
        instruction: 'edit',
        notePath: 'note.md',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('boom');
      spy.mockRestore();
    });

    it('returns null path for unknown tool input', () => {
      expect(getPathFromToolInput('Unknown', {})).toBeNull();
    });

    it('allows non-file tools in vault restriction hook', async () => {
      const hook = (service as any).createVaultRestrictionHook('/test/vault/path');
      const res = await hook.hooks[0]({ tool_name: 'WebSearch', tool_input: {} }, 't', {});
      expect(res.continue).toBe(true);
    });

    it('extracts LS path from tool input', () => {
      expect(getPathFromToolInput('LS', { path: 'notes' })).toBe('notes');
    });
  });

  describe('buildCursorContext', () => {
    // Helper to create mock getLine function from array of lines
    const createGetLine = (lines: string[]) => (line: number) => lines[line] ?? '';

    describe('inline mode detection', () => {
      it('should detect inline when cursor is in middle of text', () => {
        const lines = ['Hello world'];
        const ctx = buildCursorContext(createGetLine(lines), 1, 0, 6);

        expect(ctx.isInbetween).toBe(false);
        expect(ctx.beforeCursor).toBe('Hello ');
        expect(ctx.afterCursor).toBe('world');
        expect(ctx.line).toBe(0);
        expect(ctx.column).toBe(6);
      });

      it('should detect inline when cursor is at line start with text after', () => {
        const lines = ['Hello world'];
        const ctx = buildCursorContext(createGetLine(lines), 1, 0, 0);

        expect(ctx.isInbetween).toBe(false);
        expect(ctx.beforeCursor).toBe('');
        expect(ctx.afterCursor).toBe('Hello world');
      });

      it('should detect inline when cursor is at line end with text before', () => {
        const lines = ['Hello world'];
        const ctx = buildCursorContext(createGetLine(lines), 1, 0, 11);

        expect(ctx.isInbetween).toBe(false);
        expect(ctx.beforeCursor).toBe('Hello world');
        expect(ctx.afterCursor).toBe('');
      });

      it('should preserve whitespace around cursor', () => {
        const lines = ['  hello   world  '];
        const ctx = buildCursorContext(createGetLine(lines), 1, 0, 9);

        expect(ctx.isInbetween).toBe(false);
        expect(ctx.beforeCursor).toBe('  hello  ');
        expect(ctx.afterCursor).toBe(' world  ');
      });
    });

    describe('inbetween mode detection', () => {
      it('should detect inbetween on empty line', () => {
        const lines = ['First paragraph', '', 'Second paragraph'];
        const ctx = buildCursorContext(createGetLine(lines), 3, 1, 0);

        expect(ctx.isInbetween).toBe(true);
        expect(ctx.beforeCursor).toBe('First paragraph');
        expect(ctx.afterCursor).toBe('Second paragraph');
      });

      it('should detect inbetween on whitespace-only line', () => {
        const lines = ['First paragraph', '   ', 'Second paragraph'];
        const ctx = buildCursorContext(createGetLine(lines), 3, 1, 2);

        expect(ctx.isInbetween).toBe(true);
        expect(ctx.beforeCursor).toBe('First paragraph');
        expect(ctx.afterCursor).toBe('Second paragraph');
      });

      it('should detect inbetween when cursor on line with only whitespace before and after', () => {
        const lines = ['Content', '  \t  ', 'More content'];
        const ctx = buildCursorContext(createGetLine(lines), 3, 1, 2);

        expect(ctx.isInbetween).toBe(true);
      });

      it('should find nearest non-empty line before cursor', () => {
        const lines = ['Content', '', '', '', 'More'];
        const ctx = buildCursorContext(createGetLine(lines), 5, 2, 0);

        expect(ctx.isInbetween).toBe(true);
        expect(ctx.beforeCursor).toBe('Content');
      });

      it('should find nearest non-empty line after cursor', () => {
        const lines = ['Content', '', '', '', 'More'];
        const ctx = buildCursorContext(createGetLine(lines), 5, 2, 0);

        expect(ctx.isInbetween).toBe(true);
        expect(ctx.afterCursor).toBe('More');
      });

      it('should handle cursor at document start (empty first line)', () => {
        const lines = ['', 'First content'];
        const ctx = buildCursorContext(createGetLine(lines), 2, 0, 0);

        expect(ctx.isInbetween).toBe(true);
        expect(ctx.beforeCursor).toBe('');
        expect(ctx.afterCursor).toBe('First content');
      });

      it('should handle cursor at document end (empty last line)', () => {
        const lines = ['Last content', ''];
        const ctx = buildCursorContext(createGetLine(lines), 2, 1, 0);

        expect(ctx.isInbetween).toBe(true);
        expect(ctx.beforeCursor).toBe('Last content');
        expect(ctx.afterCursor).toBe('');
      });

      it('should handle multiple consecutive empty lines', () => {
        const lines = ['Para A', '', '', '', 'Para B'];
        const ctx = buildCursorContext(createGetLine(lines), 5, 2, 0);

        expect(ctx.isInbetween).toBe(true);
        expect(ctx.beforeCursor).toBe('Para A');
        expect(ctx.afterCursor).toBe('Para B');
      });
    });

    describe('edge cases', () => {
      it('should handle single line document with cursor', () => {
        const lines = ['Only line'];
        const ctx = buildCursorContext(createGetLine(lines), 1, 0, 5);

        expect(ctx.isInbetween).toBe(false);
        expect(ctx.beforeCursor).toBe('Only ');
        expect(ctx.afterCursor).toBe('line');
      });

      it('should handle empty document', () => {
        const lines = [''];
        const ctx = buildCursorContext(createGetLine(lines), 1, 0, 0);

        expect(ctx.isInbetween).toBe(true);
        expect(ctx.beforeCursor).toBe('');
        expect(ctx.afterCursor).toBe('');
      });

      it('should preserve line and column in context', () => {
        const lines = ['Line 0', 'Line 1', 'Line 2'];
        const ctx = buildCursorContext(createGetLine(lines), 3, 1, 3);

        expect(ctx.line).toBe(1);
        expect(ctx.column).toBe(3);
      });
    });
  });

  describe('buildCursorPrompt', () => {
    it('should build inline cursor prompt correctly', () => {
      const request: InlineEditRequest = {
        mode: 'cursor',
        instruction: 'add missing word',
        notePath: 'notes/test.md',
        cursorContext: {
          beforeCursor: 'The quick brown ',
          afterCursor: ' jumps over',
          isInbetween: false,
          line: 5,
          column: 16,
        },
      };

      const prompt = (service as any).buildCursorPrompt(request);

      expect(prompt).toContain('<editor_cursor path="notes/test.md" line="6">');
      expect(prompt).toContain('The quick brown | jumps over #inline');
      expect(prompt).toContain('</editor_cursor>');
      expect(prompt).toContain('<query>');
      expect(prompt).toContain('add missing word');
      expect(prompt).toContain('</query>');
    });

    it('should build inbetween cursor prompt with surrounding context', () => {
      const request: InlineEditRequest = {
        mode: 'cursor',
        instruction: 'add a new section',
        notePath: 'docs/readme.md',
        cursorContext: {
          beforeCursor: '# Introduction',
          afterCursor: '## Features',
          isInbetween: true,
          line: 3,
          column: 0,
        },
      };

      const prompt = (service as any).buildCursorPrompt(request);

      expect(prompt).toContain('<editor_cursor path="docs/readme.md" line="4">');
      expect(prompt).toContain('# Introduction');
      expect(prompt).toContain('| #inbetween');
      expect(prompt).toContain('## Features');
      expect(prompt).toContain('</editor_cursor>');
      expect(prompt).toContain('<query>');
      expect(prompt).toContain('add a new section');
      expect(prompt).toContain('</query>');
    });

    it('should handle inbetween with no content before cursor', () => {
      const request: InlineEditRequest = {
        mode: 'cursor',
        instruction: 'add header',
        notePath: 'empty.md',
        cursorContext: {
          beforeCursor: '',
          afterCursor: 'First paragraph',
          isInbetween: true,
          line: 0,
          column: 0,
        },
      };

      const prompt = (service as any).buildCursorPrompt(request);

      expect(prompt).toContain('| #inbetween');
      expect(prompt).toContain('First paragraph');
      expect(prompt).not.toMatch(/\n\n\| #inbetween/); // No double newline before marker
    });

    it('should handle inbetween with no content after cursor', () => {
      const request: InlineEditRequest = {
        mode: 'cursor',
        instruction: 'add footer',
        notePath: 'doc.md',
        cursorContext: {
          beforeCursor: 'Last paragraph',
          afterCursor: '',
          isInbetween: true,
          line: 10,
          column: 0,
        },
      };

      const prompt = (service as any).buildCursorPrompt(request);

      expect(prompt).toContain('Last paragraph');
      expect(prompt).toContain('| #inbetween');
    });
  });

  describe('buildPrompt mode dispatch', () => {
    it('should dispatch to selection prompt for selection mode', () => {
      const request: InlineEditRequest = {
        mode: 'selection',
        instruction: 'fix this',
        notePath: 'test.md',
        selectedText: 'selected text here',
      };

      const prompt = (service as any).buildPrompt(request);

      expect(prompt).toContain('selected text here');
      expect(prompt).not.toContain('#inline');
      expect(prompt).not.toContain('#inbetween');
    });

    it('should dispatch to cursor prompt for cursor mode', () => {
      const request: InlineEditRequest = {
        mode: 'cursor',
        instruction: 'insert here',
        notePath: 'test.md',
        cursorContext: {
          beforeCursor: 'before',
          afterCursor: 'after',
          isInbetween: false,
          line: 0,
          column: 6,
        },
      };

      const prompt = (service as any).buildPrompt(request);

      expect(prompt).toContain('before|after #inline');
    });
  });

  describe('parseResponse with insertion tags', () => {
    it('should extract text from insertion tags', () => {
      const response = 'Here is the content:\n<insertion>inserted text here</insertion>';

      const result = (service as any).parseResponse(response);

      expect(result.success).toBe(true);
      expect(result.insertedText).toBe('inserted text here');
      expect(result.editedText).toBeUndefined();
    });

    it('should handle multiline insertion content', () => {
      const response = '<insertion>Line 1\nLine 2\nLine 3</insertion>';

      const result = (service as any).parseResponse(response);

      expect(result.success).toBe(true);
      expect(result.insertedText).toBe('Line 1\nLine 2\nLine 3');
    });

    it('should prefer replacement tags over insertion tags', () => {
      const response = '<replacement>replaced</replacement><insertion>inserted</insertion>';

      const result = (service as any).parseResponse(response);

      expect(result.success).toBe(true);
      expect(result.editedText).toBe('replaced');
      expect(result.insertedText).toBeUndefined();
    });

    it('should handle insertion tags with leading/trailing newlines', () => {
      const response = '<insertion>\n## New Section\n\nContent here\n</insertion>';

      const result = (service as any).parseResponse(response);

      expect(result.success).toBe(true);
      expect(result.insertedText).toBe('\n## New Section\n\nContent here\n');
    });

    it('should handle empty insertion tags', () => {
      const response = '<insertion></insertion>';

      const result = (service as any).parseResponse(response);

      expect(result.success).toBe(true);
      expect(result.insertedText).toBe('');
    });

    it('should handle insertion with special characters', () => {
      const response = '<insertion>const x = a < b && c > d;</insertion>';

      const result = (service as any).parseResponse(response);

      expect(result.success).toBe(true);
      expect(result.insertedText).toBe('const x = a < b && c > d;');
    });

    it('should return clarification when no tags present', () => {
      const response = 'What would you like me to insert?';

      const result = (service as any).parseResponse(response);

      expect(result.success).toBe(true);
      expect(result.clarification).toBe('What would you like me to insert?');
      expect(result.insertedText).toBeUndefined();
      expect(result.editedText).toBeUndefined();
    });
  });

  describe('editText with cursor mode', () => {
    beforeEach(() => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
    });

    it('should handle cursor mode request', async () => {
      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'cursor-session' },
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: '<insertion>fox</insertion>' }] },
        },
        { type: 'result' },
      ]);

      const result = await service.editText({
        mode: 'cursor',
        instruction: 'what animal?',
        notePath: 'test.md',
        cursorContext: {
          beforeCursor: 'The quick brown ',
          afterCursor: ' jumps over',
          isInbetween: false,
          line: 0,
          column: 16,
        },
      });

      expect(result.success).toBe(true);
      expect(result.insertedText).toBe('fox');
    });

    it('should handle inbetween mode request', async () => {
      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'inbetween-session' },
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: '<insertion>## Description\n\nNew section content</insertion>' }] },
        },
        { type: 'result' },
      ]);

      const result = await service.editText({
        mode: 'cursor',
        instruction: 'add description section',
        notePath: 'readme.md',
        cursorContext: {
          beforeCursor: '# Title',
          afterCursor: '## Features',
          isInbetween: true,
          line: 2,
          column: 0,
        },
      });

      expect(result.success).toBe(true);
      expect(result.insertedText).toContain('## Description');
    });
  });
});
