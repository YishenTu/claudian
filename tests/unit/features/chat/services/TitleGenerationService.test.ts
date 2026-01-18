/**
 * Tests for TitleGenerationService - Generating conversation titles with AI
 */

// eslint-disable-next-line jest/no-mocks-import
import {
  getLastOptions,
  resetMockMessages,
  setMockMessages,
} from '@test/__mocks__/claude-agent-sdk';

import { type TitleGenerationResult, TitleGenerationService } from '@/features/chat/services/TitleGenerationService';
function createMockPlugin(settings = {}) {
  return {
    settings: {
      model: 'sonnet',
      titleGenerationModel: '',
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
    getResolvedClaudeCliPath: jest.fn().mockReturnValue('/fake/claude'),
  } as any;
}

describe('TitleGenerationService', () => {
  let service: TitleGenerationService;
  let mockPlugin: any;

  beforeEach(() => {
    jest.clearAllMocks();
    resetMockMessages();
    mockPlugin = createMockPlugin();
    service = new TitleGenerationService(mockPlugin);
  });

  describe('generateTitle', () => {
    it('should generate a title from user message', async () => {
      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'Setting Up React Project' }],
          },
        },
        { type: 'result' },
      ]);

      const callback = jest.fn();
      await service.generateTitle(
        'conv-123',
        'How do I set up a React project?',
        callback
      );

      expect(callback).toHaveBeenCalledWith('conv-123', {
        success: true,
        title: 'Setting Up React Project',
      });
    });

    it('should use no tools for title generation', async () => {
      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'Test Title' }],
          },
        },
        { type: 'result' },
      ]);

      const callback = jest.fn();
      await service.generateTitle('conv-123', 'test', callback);

      const options = getLastOptions();
      expect(options?.tools).toEqual([]);
      expect(options?.permissionMode).toBe('bypassPermissions');
    });

    it('should use titleGenerationModel setting when set', async () => {
      mockPlugin.settings.titleGenerationModel = 'opus';

      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'Title' }],
          },
        },
        { type: 'result' },
      ]);

      const callback = jest.fn();
      await service.generateTitle('conv-123', 'test', callback);

      const options = getLastOptions();
      expect(options?.model).toBe('opus');
    });

    it('should prioritize setting over env var', async () => {
      mockPlugin.settings.titleGenerationModel = 'sonnet';
      mockPlugin.getActiveEnvironmentVariables.mockReturnValue(
        'ANTHROPIC_DEFAULT_HAIKU_MODEL=custom-haiku'
      );

      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'Title' }],
          },
        },
        { type: 'result' },
      ]);

      const callback = jest.fn();
      await service.generateTitle('conv-123', 'test', callback);

      const options = getLastOptions();
      expect(options?.model).toBe('sonnet');
    });

    it('should use ANTHROPIC_DEFAULT_HAIKU_MODEL when setting is empty', async () => {
      mockPlugin.settings.titleGenerationModel = '';
      mockPlugin.getActiveEnvironmentVariables.mockReturnValue(
        'ANTHROPIC_DEFAULT_HAIKU_MODEL=custom-haiku'
      );

      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'Title' }],
          },
        },
        { type: 'result' },
      ]);

      const callback = jest.fn();
      await service.generateTitle('conv-123', 'test', callback);

      const options = getLastOptions();
      expect(options?.model).toBe('custom-haiku');
    });

    it('should fallback to claude-haiku-4-5 model', async () => {
      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'Title' }],
          },
        },
        { type: 'result' },
      ]);

      const callback = jest.fn();
      await service.generateTitle('conv-123', 'test', callback);

      const options = getLastOptions();
      expect(options?.model).toBe('claude-haiku-4-5');
    });

    it('should strip surrounding quotes from title', async () => {
      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: '"Quoted Title"' }],
          },
        },
        { type: 'result' },
      ]);

      const callback = jest.fn();
      await service.generateTitle('conv-123', 'test', callback);

      expect(callback).toHaveBeenCalledWith('conv-123', {
        success: true,
        title: 'Quoted Title',
      });
    });

    it('should strip trailing punctuation from title', async () => {
      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'Title With Punctuation...' }],
          },
        },
        { type: 'result' },
      ]);

      const callback = jest.fn();
      await service.generateTitle('conv-123', 'test', callback);

      expect(callback).toHaveBeenCalledWith('conv-123', {
        success: true,
        title: 'Title With Punctuation',
      });
    });

    it('should truncate titles longer than 50 characters', async () => {
      const longTitle = 'A'.repeat(60);
      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: longTitle }],
          },
        },
        { type: 'result' },
      ]);

      const callback = jest.fn();
      await service.generateTitle('conv-123', 'test', callback);

      expect(callback).toHaveBeenCalledWith('conv-123', {
        success: true,
        title: 'A'.repeat(47) + '...',
      });
    });

    it('should fail gracefully when response is empty', async () => {
      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: '' }],
          },
        },
        { type: 'result' },
      ]);

      const callback = jest.fn();
      await service.generateTitle('conv-123', 'test', callback);

      expect(callback).toHaveBeenCalledWith('conv-123', {
        success: false,
        error: 'Failed to parse title from response',
      });
    });

    it('should fail when vault path cannot be determined', async () => {
      mockPlugin.app.vault.adapter.basePath = undefined;

      const callback = jest.fn();
      await service.generateTitle('conv-123', 'test', callback);

      expect(callback).toHaveBeenCalledWith('conv-123', {
        success: false,
        error: 'Could not determine vault path',
      });
    });

    it('should fail when Claude CLI is not found', async () => {
      mockPlugin.getResolvedClaudeCliPath.mockReturnValue(null);

      const callback = jest.fn();
      await service.generateTitle('conv-123', 'test', callback);

      expect(callback).toHaveBeenCalledWith('conv-123', {
        success: false,
        error: 'Claude CLI not found',
      });
    });

    it('should set settingSources to project only when loadUserClaudeSettings is false', async () => {
      mockPlugin.settings.loadUserClaudeSettings = false;

      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'Title' }],
          },
        },
        { type: 'result' },
      ]);

      const callback = jest.fn();
      await service.generateTitle('conv-123', 'test', callback);

      const options = getLastOptions();
      expect(options?.settingSources).toEqual(['project']);
    });

    it('should set settingSources to include user when loadUserClaudeSettings is true', async () => {
      mockPlugin.settings.loadUserClaudeSettings = true;

      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'Title' }],
          },
        },
        { type: 'result' },
      ]);

      const callback = jest.fn();
      await service.generateTitle('conv-123', 'test', callback);

      const options = getLastOptions();
      expect(options?.settingSources).toEqual(['user', 'project']);
    });

    it('should truncate long user messages', async () => {
      const longMessage = 'x'.repeat(1000);
      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'Title' }],
          },
        },
        { type: 'result' },
      ]);

      const callback = jest.fn();
      await service.generateTitle('conv-123', longMessage, callback);

      // Service should still complete successfully with truncated message
      expect(callback).toHaveBeenCalledWith('conv-123', {
        success: true,
        title: 'Title',
      });
    });
  });

  describe('concurrent generation', () => {
    it('should support multiple concurrent generations', async () => {
      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'Title' }],
          },
        },
        { type: 'result' },
      ]);

      const callback1 = jest.fn();
      const callback2 = jest.fn();

      // Start two generations concurrently
      const promise1 = service.generateTitle('conv-1', 'msg1', callback1);
      const promise2 = service.generateTitle('conv-2', 'msg2', callback2);

      await Promise.all([promise1, promise2]);

      expect(callback1).toHaveBeenCalledWith('conv-1', { success: true, title: 'Title' });
      expect(callback2).toHaveBeenCalledWith('conv-2', { success: true, title: 'Title' });
    });

    it('should cancel previous generation for same conversation', async () => {
      // First call will be aborted when second call starts
      const callback1 = jest.fn();
      const callback2 = jest.fn();

      // Mock a slow first generation
      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'Title 1' }],
          },
        },
        { type: 'result' },
      ]);

      // Start first generation (won't await it)
      const promise1 = service.generateTitle('conv-1', 'msg1', callback1);

      // Immediately start second generation for same conversation
      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session-2' },
        {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'Title 2' }],
          },
        },
        { type: 'result' },
      ]);
      const promise2 = service.generateTitle('conv-1', 'msg2', callback2);

      await Promise.all([promise1, promise2]);

      // Second generation should complete with new title
      expect(callback2).toHaveBeenCalledWith('conv-1', { success: true, title: 'Title 2' });
    });
  });

  describe('cancel', () => {
    it('should cancel all active generations', async () => {
      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'Title' }],
          },
        },
        { type: 'result' },
      ]);

      const callback = jest.fn();

      // Start generation then cancel immediately
      const promise = service.generateTitle('conv-1', 'msg', callback);
      service.cancel();

      await promise;

      // Should have been called with cancelled error or completed
      expect(callback).toHaveBeenCalled();
    });
  });

  describe('safeCallback', () => {
    it('should catch errors thrown by callback', async () => {
      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'Title' }],
          },
        },
        { type: 'result' },
      ]);

      const throwingCallback = jest.fn().mockRejectedValue(new Error('Callback error'));

      // Should not throw
      await expect(
        service.generateTitle('conv-123', 'test', throwingCallback)
      ).resolves.not.toThrow();
    });
  });
});

describe('TitleGenerationResult type', () => {
  it('should be a discriminated union for success', () => {
    const success: TitleGenerationResult = { success: true, title: 'Test Title' };
    expect(success.success).toBe(true);
    // TypeScript narrows the type based on success: true
    expect(success).toEqual({ success: true, title: 'Test Title' });
  });

  it('should be a discriminated union for failure', () => {
    const failure: TitleGenerationResult = { success: false, error: 'Some error' };
    expect(failure.success).toBe(false);
    // TypeScript narrows the type based on success: false
    expect(failure).toEqual({ success: false, error: 'Some error' });
  });
});
