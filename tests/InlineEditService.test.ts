/**
 * Tests for InlineEditService - Inline text editing with Claude
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  setMockMessages,
  resetMockMessages,
  getLastOptions,
} from '@anthropic-ai/claude-agent-sdk';

// Mock fs module
jest.mock('fs');

// Now import after all mocks are set up
import { InlineEditService, InlineEditRequest } from '../src/InlineEditService';

// Create a mock plugin
function createMockPlugin(settings = {}) {
  return {
    settings: {
      model: 'claude-sonnet-4-5',
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

  describe('buildPrompt', () => {
    it('should build prompt with correct format', () => {
      const request: InlineEditRequest = {
        selectedText: 'Hello world',
        instruction: 'Fix the greeting',
        notePath: 'notes/test.md',
      };

      const prompt = (service as any).buildPrompt(request);

      expect(prompt).toContain('File: notes/test.md');
      expect(prompt).toContain('---');
      expect(prompt).toContain('Hello world');
      expect(prompt).toContain('Request: Fix the greeting');
    });

    it('should preserve selected text with newlines', () => {
      const request: InlineEditRequest = {
        selectedText: 'Line 1\nLine 2\nLine 3',
        instruction: 'Fix formatting',
        notePath: 'doc.md',
      };

      const prompt = (service as any).buildPrompt(request);

      expect(prompt).toContain('Line 1\nLine 2\nLine 3');
    });

    it('should handle empty selected text', () => {
      const request: InlineEditRequest = {
        selectedText: '',
        instruction: 'Add content',
        notePath: 'empty.md',
      };

      const prompt = (service as any).buildPrompt(request);

      expect(prompt).toContain('File: empty.md');
      expect(prompt).toContain('Request: Add content');
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
});
