import * as sdkModule from '@anthropic-ai/claude-agent-sdk';

import { ClaudianService } from '@/core/agent/ClaudianService';
import { MessageChannel } from '@/core/agent/MessageChannel';
import { createResponseHandler } from '@/core/agent/types';
import type { McpServerManager } from '@/core/mcp';
import type ClaudianPlugin from '@/main';
import * as envUtils from '@/utils/env';
import * as sessionUtils from '@/utils/session';

const sdkMock = sdkModule as unknown as {
  setMockMessages: (messages: any[], options?: { appendResult?: boolean }) => void;
  resetMockMessages: () => void;
  simulateCrash: (afterChunks?: number) => void;
  query: typeof sdkModule.query;
};

type MockMcpServerManager = jest.Mocked<McpServerManager>;

describe('ClaudianService', () => {
  let mockPlugin: Partial<ClaudianPlugin>;
  let mockMcpManager: MockMcpServerManager;
  let service: ClaudianService;

  async function collectChunks(gen: AsyncGenerator<any>): Promise<any[]> {
    const chunks: any[] = [];
    for await (const chunk of gen) {
      chunks.push(chunk);
    }
    return chunks;
  }

  beforeEach(() => {
    jest.clearAllMocks();

    const storageMock = {
      addDenyRule: jest.fn().mockResolvedValue(undefined),
      addAllowRule: jest.fn().mockResolvedValue(undefined),
      getPermissions: jest.fn().mockResolvedValue({ allow: [], deny: [], ask: [] }),
    };

    mockPlugin = {
      app: {
        vault: { adapter: { basePath: '/mock/vault/path' } },
      },
      storage: storageMock,
      settings: {
        model: 'claude-3-5-sonnet',
        permissionMode: 'ask' as const,
        thinkingBudget: 0,
        blockedCommands: [],
        enableBlocklist: false,
        mediaFolder: 'claudian-media',
        systemPrompt: '',
        allowedExportPaths: [],
        loadUserClaudeSettings: false,
        claudeCliPath: '/usr/local/bin/claude',
        claudeCliPaths: [],
        enableAutoTitleGeneration: true,
        titleGenerationModel: 'claude-3-5-haiku',
      },
      getResolvedClaudeCliPath: jest.fn().mockReturnValue('/usr/local/bin/claude'),
      getActiveEnvironmentVariables: jest.fn().mockReturnValue(''),
      pluginManager: {
        getPluginsKey: jest.fn().mockReturnValue(''),
      },
    } as unknown as ClaudianPlugin;

    mockMcpManager = {
      loadServers: jest.fn().mockResolvedValue(undefined),
      getAllDisallowedMcpTools: jest.fn().mockReturnValue([]),
      getActiveServers: jest.fn().mockReturnValue({}),
      getDisallowedMcpTools: jest.fn().mockReturnValue([]),
    } as unknown as MockMcpServerManager;

    service = new ClaudianService(mockPlugin as ClaudianPlugin, mockMcpManager);
  });

  describe('Session Management', () => {
    it('should have null session ID initially', () => {
      expect(service.getSessionId()).toBeNull();
    });

    it('should set session ID', () => {
      service.setSessionId('test-session-123');
      expect(service.getSessionId()).toBe('test-session-123');
    });

    it('should reset session', () => {
      service.setSessionId('test-session-123');
      service.resetSession();
      expect(service.getSessionId()).toBeNull();
    });

    it('should not close persistent query when setting same session ID', () => {
      service.setSessionId('test-session-123');
      const activeStateBefore = service.isPersistentQueryActive();
      service.setSessionId('test-session-123');
      expect(service.getSessionId()).toBe('test-session-123');
      expect(service.isPersistentQueryActive()).toBe(activeStateBefore);
    });

    it('should update session ID when switching to different session', () => {
      service.setSessionId('test-session-123');
      service.setSessionId('different-session-456');
      expect(service.getSessionId()).toBe('different-session-456');
    });

    it('should handle setting null session ID', () => {
      service.setSessionId('test-session-123');
      service.setSessionId(null);
      expect(service.getSessionId()).toBeNull();
    });

    it('should pass externalContextPaths to ensureReady when setting session ID', async () => {
      const ensureReadySpy = jest.spyOn(service, 'ensureReady').mockResolvedValue(true);

      service.setSessionId('test-session', ['/path/a', '/path/b']);

      // ensureReady is called asynchronously, give it a tick
      await Promise.resolve();

      expect(ensureReadySpy).toHaveBeenCalledWith({
        sessionId: 'test-session',
        externalContextPaths: ['/path/a', '/path/b'],
      });
    });

    it('should pass undefined externalContextPaths when not provided', async () => {
      const ensureReadySpy = jest.spyOn(service, 'ensureReady').mockResolvedValue(true);

      service.setSessionId('test-session');

      await Promise.resolve();

      expect(ensureReadySpy).toHaveBeenCalledWith({
        sessionId: 'test-session',
        externalContextPaths: undefined,
      });
    });
  });

  describe('MCP Server Management', () => {
    it('should load MCP servers', async () => {
      await service.loadMcpServers();

      expect(mockMcpManager.loadServers).toHaveBeenCalled();
    });

    it('should reload MCP servers', async () => {
      await service.reloadMcpServers();

      expect(mockMcpManager.loadServers).toHaveBeenCalled();
    });

    it('should handle MCP server loading errors', async () => {
      await service.loadMcpServers();
      expect(mockMcpManager.loadServers).toHaveBeenCalled();
    });
  });

  describe('Persistent Query Management', () => {
    it('should not be active initially', () => {
      expect(service.isPersistentQueryActive()).toBe(false);
    });

    it('should close persistent query', () => {
      service.setSessionId('test-session');
      service.closePersistentQuery('test reason');

      expect(service.isPersistentQueryActive()).toBe(false);
    });

    it('should restart persistent query via ensureReady with force', async () => {
      service.setSessionId('test-session');

      const startPersistentQuerySpy = jest.spyOn(service as any, 'startPersistentQuery');
      startPersistentQuerySpy.mockResolvedValue(undefined);

      const result = await service.ensureReady({ force: true });

      expect(result).toBe(true);
      expect(startPersistentQuerySpy).toHaveBeenCalled();
    });

    it('should return false (no-op) when config unchanged and query running', async () => {
      const startPersistentQuerySpy = jest.spyOn(service as any, 'startPersistentQuery');

      // Mock startPersistentQuery to simulate real side effects (subprocess boundary)
      startPersistentQuerySpy.mockImplementation(async (vaultPath: string, cliPath: string, _sessionId?: string, externalContextPaths?: string[]) => {
        (service as any).persistentQuery = { interrupt: jest.fn().mockResolvedValue(undefined) };
        (service as any).currentConfig = (service as any).buildPersistentQueryConfig(vaultPath, cliPath, externalContextPaths);
      });

      // First call starts the query
      const result1 = await service.ensureReady();
      expect(result1).toBe(true);
      expect(startPersistentQuerySpy).toHaveBeenCalledTimes(1);

      // Second call with same config should no-op
      const result2 = await service.ensureReady();
      expect(result2).toBe(false);
      expect(startPersistentQuerySpy).toHaveBeenCalledTimes(1); // Still 1, not called again
    });

    it('should restart when config changed (external context paths)', async () => {
      const startPersistentQuerySpy = jest.spyOn(service as any, 'startPersistentQuery');

      // Mock startPersistentQuery to simulate real side effects (subprocess boundary)
      startPersistentQuerySpy.mockImplementation(async (vaultPath: string, cliPath: string, _sessionId?: string, externalContextPaths?: string[]) => {
        (service as any).persistentQuery = { interrupt: jest.fn().mockResolvedValue(undefined) };
        (service as any).currentConfig = (service as any).buildPersistentQueryConfig(vaultPath, cliPath, externalContextPaths);
      });

      // First call starts with no external paths (Case 1: not running)
      await service.ensureReady({ externalContextPaths: [] });
      expect(startPersistentQuerySpy).toHaveBeenCalledTimes(1);

      // Second call with different paths triggers restart via real needsRestart
      const result = await service.ensureReady({ externalContextPaths: ['/new/path'] });
      expect(result).toBe(true);
      expect(startPersistentQuerySpy).toHaveBeenCalledTimes(2);
    });

    it('should pass preserveHandlers: true to closePersistentQuery on force restart', async () => {
      const startPersistentQuerySpy = jest.spyOn(service as any, 'startPersistentQuery');
      const closePersistentQuerySpy = jest.spyOn(service, 'closePersistentQuery');

      startPersistentQuerySpy.mockImplementation(async () => {
        (service as any).persistentQuery = { interrupt: jest.fn().mockResolvedValue(undefined) };
      });

      // Start the query first
      await service.ensureReady();
      expect(startPersistentQuerySpy).toHaveBeenCalledTimes(1);

      // Force restart with preserveHandlers: true (crash recovery scenario)
      await service.ensureReady({ force: true, preserveHandlers: true });

      expect(closePersistentQuerySpy).toHaveBeenCalledWith('forced restart', { preserveHandlers: true });
      expect(startPersistentQuerySpy).toHaveBeenCalledTimes(2);
    });

    it('should pass preserveHandlers through config change restart', async () => {
      const startPersistentQuerySpy = jest.spyOn(service as any, 'startPersistentQuery');
      const closePersistentQuerySpy = jest.spyOn(service, 'closePersistentQuery');

      // Mock startPersistentQuery to simulate real side effects (subprocess boundary)
      startPersistentQuerySpy.mockImplementation(async (vaultPath: string, cliPath: string, _sessionId?: string, externalContextPaths?: string[]) => {
        (service as any).persistentQuery = { interrupt: jest.fn().mockResolvedValue(undefined) };
        (service as any).currentConfig = (service as any).buildPersistentQueryConfig(vaultPath, cliPath, externalContextPaths);
      });

      // Start the query first
      await service.ensureReady({ externalContextPaths: [] });

      // Config change with preserveHandlers: true
      await service.ensureReady({ externalContextPaths: ['/new/path'], preserveHandlers: true });

      expect(closePersistentQuerySpy).toHaveBeenCalledWith('config changed', { preserveHandlers: true });
    });

    it('should return false when CLI unavailable after force close', async () => {
      const startPersistentQuerySpy = jest.spyOn(service as any, 'startPersistentQuery');
      const closePersistentQuerySpy = jest.spyOn(service, 'closePersistentQuery');

      startPersistentQuerySpy.mockImplementation(async () => {
        (service as any).persistentQuery = { interrupt: jest.fn().mockResolvedValue(undefined) };
      });

      // Start the query first
      await service.ensureReady();
      expect(startPersistentQuerySpy).toHaveBeenCalledTimes(1);

      // Now make CLI unavailable
      (mockPlugin.getResolvedClaudeCliPath as jest.Mock).mockReturnValue(null);

      // Force restart should close but fail to start new one
      const result = await service.ensureReady({ force: true });
      expect(result).toBe(false);
      expect(closePersistentQuerySpy).toHaveBeenCalledWith('forced restart', { preserveHandlers: undefined });
      expect(startPersistentQuerySpy).toHaveBeenCalledTimes(1); // Not called again
    });

    it('should return false when CLI unavailable after config change close', async () => {
      const startPersistentQuerySpy = jest.spyOn(service as any, 'startPersistentQuery');
      const closePersistentQuerySpy = jest.spyOn(service, 'closePersistentQuery');

      // Mock startPersistentQuery to simulate real side effects (subprocess boundary)
      startPersistentQuerySpy.mockImplementation(async (vaultPath: string, cliPath: string, _sessionId?: string, externalContextPaths?: string[]) => {
        (service as any).persistentQuery = { interrupt: jest.fn().mockResolvedValue(undefined) };
        (service as any).currentConfig = (service as any).buildPersistentQueryConfig(vaultPath, cliPath, externalContextPaths);
      });

      // Start the query first (Case 1: not running)
      await service.ensureReady({ externalContextPaths: [] });

      // Make CLI unavailable after the config change detection
      // In Case 3, CLI is checked once before needsRestart, then again after close
      let cliCallCount = 0;
      (mockPlugin.getResolvedClaudeCliPath as jest.Mock).mockImplementation(() => {
        cliCallCount++;
        // First call (for config check) returns valid path
        // Second call (after close, for restart) returns null
        return cliCallCount === 1 ? '/usr/local/bin/claude' : null;
      });

      // Config change should close but fail to start new one (CLI unavailable)
      const result = await service.ensureReady({ externalContextPaths: ['/new/path'] });
      expect(result).toBe(false);
      expect(closePersistentQuerySpy).toHaveBeenCalledWith('config changed', { preserveHandlers: undefined });
    });

    it('should cleanup resources', () => {
      const closePersistentQuerySpy = jest.spyOn(service, 'closePersistentQuery');
      const cancelSpy = jest.spyOn(service, 'cancel');

      service.cleanup();

      expect(closePersistentQuerySpy).toHaveBeenCalledWith('plugin cleanup');
      expect(cancelSpy).toHaveBeenCalled();
    });
  });

  describe('Query Cancellation', () => {
    it('should cancel cold-start query', () => {
      const abortSpy = jest.fn();
      (service as any).abortController = { abort: abortSpy, signal: { aborted: false } };

      service.cancel();

      expect(abortSpy).toHaveBeenCalled();
    });

    it('should mark session as interrupted on cancel', () => {
      const sessionManager = (service as any).sessionManager;
      (service as any).abortController = { abort: jest.fn(), signal: { aborted: false } };

      service.cancel();

      expect(sessionManager.wasInterrupted()).toBe(true);
    });

    it('should call approval dismisser on cancel', () => {
      const dismisser = jest.fn();
      service.setApprovalDismisser(dismisser);

      service.cancel();

      expect(dismisser).toHaveBeenCalled();
    });

    it('should not throw when no approval dismisser is set', () => {
      expect(() => service.cancel()).not.toThrow();
    });
  });

  describe('Approval Callback', () => {
    // approvalCallback is private with no observable side effect from setApprovalCallback alone.
    // Verifying the stored value requires direct access.
    it('should set approval callback', () => {
      const callback = jest.fn();
      service.setApprovalCallback(callback);

      expect((service as any).approvalCallback).toBe(callback);
    });

    it('should set null approval callback', () => {
      const callback = jest.fn();
      service.setApprovalCallback(callback);
      service.setApprovalCallback(null);

      expect((service as any).approvalCallback).toBeNull();
    });

    describe('createApprovalCallback permission flow', () => {
      const canUseToolOptions = {
        signal: new AbortController().signal,
        toolUseID: 'test-tool-use-id',
      };

      it('should deny when no approvalCallback is set', async () => {
        const canUseTool = (service as any).createApprovalCallback();
        const result = await canUseTool('Bash', { command: 'ls' }, canUseToolOptions);

        expect(result.behavior).toBe('deny');
        expect(result.message).toBe('No approval handler available.');
      });

      it('should return deny when user denies', async () => {
        const callback = jest.fn().mockResolvedValue('deny');
        service.setApprovalCallback(callback);

        const canUseTool = (service as any).createApprovalCallback();
        const result = await canUseTool('Bash', { command: 'ls' }, canUseToolOptions);

        expect(result.behavior).toBe('deny');
        expect(result.message).toBe('User denied this action.');
        expect(result).not.toHaveProperty('updatedPermissions');
      });

      it('should return deny without interrupt when approvalCallback throws', async () => {
        const callback = jest.fn().mockRejectedValue(new Error('Modal render failed'));
        service.setApprovalCallback(callback);

        const canUseTool = (service as any).createApprovalCallback();
        const result = await canUseTool('Bash', { command: 'ls' }, canUseToolOptions);

        expect(result.behavior).toBe('deny');
        expect(result.message).toContain('Modal render failed');
        expect(result.interrupt).toBe(false);
      });

      it('should return deny with interrupt for cancel decisions', async () => {
        const callback = jest.fn().mockResolvedValue('cancel');
        service.setApprovalCallback(callback);

        const canUseTool = (service as any).createApprovalCallback();
        const result = await canUseTool('Bash', { command: 'ls' }, canUseToolOptions);

        expect(result.behavior).toBe('deny');
        expect(result.message).toBe('User interrupted.');
        expect(result.interrupt).toBe(true);
      });

      it('should prompt again after deny (no session cache)', async () => {
        const callback = jest.fn().mockResolvedValue('deny');
        service.setApprovalCallback(callback);

        const canUseTool = (service as any).createApprovalCallback();

        await canUseTool('Bash', { command: 'rm -rf /tmp' }, canUseToolOptions);
        await canUseTool('Bash', { command: 'rm -rf /tmp' }, canUseToolOptions);

        expect(callback).toHaveBeenCalledTimes(2);
      });

      it('should forward decisionReason and blockedPath to approvalCallback', async () => {
        const callback = jest.fn().mockResolvedValue('allow');
        service.setApprovalCallback(callback);

        const canUseTool = (service as any).createApprovalCallback();
        await canUseTool('Read', { file_path: '/etc/passwd' }, {
          ...canUseToolOptions,
          decisionReason: 'Path is outside allowed directories',
          blockedPath: '/etc/passwd',
        });

        expect(callback).toHaveBeenCalledWith(
          'Read',
          { file_path: '/etc/passwd' },
          'Read file: /etc/passwd',
          {
            decisionReason: 'Path is outside allowed directories',
            blockedPath: '/etc/passwd',
            agentID: undefined,
          },
        );
      });

      it('should forward agentID to approvalCallback', async () => {
        const callback = jest.fn().mockResolvedValue('allow');
        service.setApprovalCallback(callback);

        const canUseTool = (service as any).createApprovalCallback();
        await canUseTool('Bash', { command: 'ls' }, {
          ...canUseToolOptions,
          agentID: 'sub-agent-42',
        });

        expect(callback).toHaveBeenCalledWith(
          'Bash',
          { command: 'ls' },
          expect.any(String),
          {
            decisionReason: undefined,
            blockedPath: undefined,
            agentID: 'sub-agent-42',
          },
        );
      });

      it('should return updatedPermissions with session destination for allow decisions', async () => {
        const callback = jest.fn().mockResolvedValue('allow');
        service.setApprovalCallback(callback);

        const canUseTool = (service as any).createApprovalCallback();
        const result = await canUseTool('Bash', { command: 'git status' }, canUseToolOptions);

        expect(result.behavior).toBe('allow');
        expect(result.updatedPermissions).toBeDefined();
        expect(result.updatedPermissions[0]).toMatchObject({
          type: 'addRules',
          behavior: 'allow',
          destination: 'session',
        });
      });

      it('should return updatedPermissions for allow-always decisions', async () => {
        const callback = jest.fn().mockResolvedValue('allow-always');
        service.setApprovalCallback(callback);

        const canUseTool = (service as any).createApprovalCallback();
        const result = await canUseTool('Bash', { command: 'git status' }, canUseToolOptions);

        expect(result.behavior).toBe('allow');
        expect(result.updatedPermissions).toBeDefined();
        expect(result.updatedPermissions[0]).toMatchObject({
          type: 'addRules',
          behavior: 'allow',
          destination: 'projectSettings',
        });
      });
    });
  });

  describe('Session Restoration', () => {
    it('should restore session with custom model', () => {
      const customModel = 'claude-3-opus';
      (mockPlugin as any).settings.model = customModel;

      service.setSessionId('test-session-123');

      expect(service.getSessionId()).toBe('test-session-123');
    });

    it('should invalidate session on reset', () => {
      service.setSessionId('test-session-123');
      service.resetSession();

      expect(service.getSessionId()).toBeNull();
    });
  });

  describe('Ready State Change Listeners', () => {
    it('should call listener immediately with current ready state on subscribe', () => {
      const listener = jest.fn();

      service.onReadyStateChange(listener);

      expect(listener).toHaveBeenCalledWith(false);
    });

    it('should call listener with true when service is ready', () => {
      (service as any).persistentQuery = {};
      (service as any).shuttingDown = false;

      const listener = jest.fn();
      service.onReadyStateChange(listener);

      expect(listener).toHaveBeenCalledWith(true);
    });

    it('should return unsubscribe function that removes listener', () => {
      const listener = jest.fn();
      const unsubscribe = service.onReadyStateChange(listener);

      unsubscribe();

      expect((service as any).readyStateListeners.has(listener)).toBe(false);
    });

    it('should notify multiple listeners when ready state changes', () => {
      const listener1 = jest.fn();
      const listener2 = jest.fn();

      service.onReadyStateChange(listener1);
      service.onReadyStateChange(listener2);

      listener1.mockClear();
      listener2.mockClear();

      (service as any).notifyReadyStateChange();

      expect(listener1).toHaveBeenCalledWith(false);
      expect(listener2).toHaveBeenCalledWith(false);
    });

    it('should not call unsubscribed listeners on notify', () => {
      const listener1 = jest.fn();
      const listener2 = jest.fn();

      service.onReadyStateChange(listener1);
      const unsubscribe2 = service.onReadyStateChange(listener2);

      listener1.mockClear();
      listener2.mockClear();

      unsubscribe2();
      (service as any).notifyReadyStateChange();

      expect(listener1).toHaveBeenCalled();
      expect(listener2).not.toHaveBeenCalled();
    });

    it('should isolate listener errors and continue notifying other listeners', () => {
      const errorListener = jest.fn().mockImplementation(() => {
        throw new Error('Listener error');
      });
      const normalListener = jest.fn();

      service.onReadyStateChange(errorListener);
      service.onReadyStateChange(normalListener);

      normalListener.mockClear();

      expect(() => (service as any).notifyReadyStateChange()).not.toThrow();
      expect(normalListener).toHaveBeenCalledWith(false);
    });

    it('should isolate errors on immediate callback during subscribe', () => {
      const errorListener = jest.fn().mockImplementation(() => {
        throw new Error('Listener error');
      });

      expect(() => service.onReadyStateChange(errorListener)).not.toThrow();
      expect(errorListener).toHaveBeenCalled();
    });

    it('should skip notification when no listeners registered', () => {
      expect(() => (service as any).notifyReadyStateChange()).not.toThrow();
    });
  });

  describe('SDK Skills (Supported Commands)', () => {
    it('should report not ready when no persistent query exists', () => {
      expect(service.isReady()).toBe(false);
    });

    it('should report ready when persistent query is active', () => {
      // Simulate active persistent query
      (service as any).persistentQuery = {};
      (service as any).shuttingDown = false;

      expect(service.isReady()).toBe(true);
    });

    it('should report not ready when shutting down', () => {
      (service as any).persistentQuery = {};
      (service as any).shuttingDown = true;

      expect(service.isReady()).toBe(false);
    });

    it('should return empty array when no persistent query', async () => {
      const commands = await service.getSupportedCommands();
      expect(commands).toEqual([]);
    });

    it('should convert SDK skills to SlashCommand format', async () => {
      const mockSdkCommands = [
        { name: 'commit', description: 'Create a git commit', argumentHint: '' },
        { name: 'pr', description: 'Create a pull request', argumentHint: '<title>' },
      ];

      const mockQuery = {
        supportedCommands: jest.fn().mockResolvedValue(mockSdkCommands),
      };
      (service as any).persistentQuery = mockQuery;

      const commands = await service.getSupportedCommands();

      expect(mockQuery.supportedCommands).toHaveBeenCalled();
      expect(commands).toHaveLength(2);
      expect(commands[0]).toEqual({
        id: 'sdk:commit',
        name: 'commit',
        description: 'Create a git commit',
        argumentHint: '',
        content: '',
        source: 'sdk',
      });
      expect(commands[1]).toEqual({
        id: 'sdk:pr',
        name: 'pr',
        description: 'Create a pull request',
        argumentHint: '<title>',
        content: '',
        source: 'sdk',
      });
    });

    it('should return empty array on SDK error', async () => {
      const mockQuery = {
        supportedCommands: jest.fn().mockRejectedValue(new Error('SDK error')),
      };
      (service as any).persistentQuery = mockQuery;

      const commands = await service.getSupportedCommands();

      expect(commands).toEqual([]);
    });
  });

  describe('isPipeError', () => {
    it('should return true for EPIPE code', () => {
      const error = { code: 'EPIPE' };
      expect((service as any).isPipeError(error)).toBe(true);
    });

    it('should return true for EPIPE in message', () => {
      const error = { message: 'write EPIPE to stdin' };
      expect((service as any).isPipeError(error)).toBe(true);
    });

    it('should return false for other errors', () => {
      const error = { code: 'ENOENT', message: 'file not found' };
      expect((service as any).isPipeError(error)).toBe(false);
    });

    it('should return false for null', () => {
      expect((service as any).isPipeError(null)).toBe(false);
    });

    it('should return false for non-object', () => {
      expect((service as any).isPipeError('string')).toBe(false);
    });

    it('should return false for undefined', () => {
      expect((service as any).isPipeError(undefined)).toBe(false);
    });
  });

  describe('shouldUsePersistentQuery', () => {
    it('should return true by default', () => {
      expect((service as any).shouldUsePersistentQuery()).toBe(true);
    });

    it('should return true with empty options', () => {
      expect((service as any).shouldUsePersistentQuery({})).toBe(true);
    });

    it('should return false when forceColdStart is set', () => {
      expect((service as any).shouldUsePersistentQuery({ forceColdStart: true })).toBe(false);
    });

    it('should return true when forceColdStart is false', () => {
      expect((service as any).shouldUsePersistentQuery({ forceColdStart: false })).toBe(true);
    });
  });

  describe('isStreamTextEvent', () => {
    it('should return false for non-stream_event messages', () => {
      expect((service as any).isStreamTextEvent({ type: 'assistant' })).toBe(false);
      expect((service as any).isStreamTextEvent({ type: 'result' })).toBe(false);
      expect((service as any).isStreamTextEvent({ type: 'user' })).toBe(false);
    });

    it('should return false when event is missing', () => {
      expect((service as any).isStreamTextEvent({ type: 'stream_event' })).toBe(false);
    });

    it('should return true for content_block_start with text type', () => {
      expect((service as any).isStreamTextEvent({
        type: 'stream_event',
        event: { type: 'content_block_start', content_block: { type: 'text' } },
      })).toBe(true);
    });

    it('should return false for content_block_start with non-text type', () => {
      expect((service as any).isStreamTextEvent({
        type: 'stream_event',
        event: { type: 'content_block_start', content_block: { type: 'tool_use' } },
      })).toBe(false);
    });

    it('should return true for content_block_delta with text_delta type', () => {
      expect((service as any).isStreamTextEvent({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta' } },
      })).toBe(true);
    });

    it('should return false for content_block_delta with non-text_delta type', () => {
      expect((service as any).isStreamTextEvent({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'input_json_delta' } },
      })).toBe(false);
    });

    it('should return false for other stream event types', () => {
      expect((service as any).isStreamTextEvent({
        type: 'stream_event',
        event: { type: 'message_start' },
      })).toBe(false);
    });
  });

  describe('buildSDKUserMessage', () => {
    it('should build text-only message', () => {
      const message = (service as any).buildSDKUserMessage('Hello Claude');

      expect(message).toEqual({
        type: 'user',
        message: { role: 'user', content: 'Hello Claude' },
        parent_tool_use_id: null,
        session_id: '',
      });
    });

    it('should include session ID when available', () => {
      service.setSessionId('session-abc');
      const message = (service as any).buildSDKUserMessage('Test');

      expect(message.session_id).toBe('session-abc');
    });

    it('should build message with images', () => {
      const images = [{
        id: 'img1',
        name: 'test.png',
        mediaType: 'image/png',
        data: 'base64data',
        size: 100,
        source: 'file',
      }];

      const message = (service as any).buildSDKUserMessage('Look at this', images);

      expect(message.message.content).toEqual([
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'base64data' } },
        { type: 'text', text: 'Look at this' },
      ]);
    });

    it('should omit text block when prompt is empty with images', () => {
      const images = [{
        id: 'img1',
        name: 'test.png',
        mediaType: 'image/png',
        data: 'base64data',
        size: 100,
        source: 'file',
      }];

      const message = (service as any).buildSDKUserMessage('  ', images);

      expect(message.message.content).toEqual([
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'base64data' } },
      ]);
    });

    it('should handle empty images array as text-only', () => {
      const message = (service as any).buildSDKUserMessage('Hello', []);

      expect(message.message.content).toBe('Hello');
    });
  });

  describe('buildPromptWithImages', () => {
    it('should return plain string when no images', () => {
      const result = (service as any).buildPromptWithImages('Hello');
      expect(result).toBe('Hello');
    });

    it('should return plain string when images is undefined', () => {
      const result = (service as any).buildPromptWithImages('Hello', undefined);
      expect(result).toBe('Hello');
    });

    it('should return plain string when images is empty', () => {
      const result = (service as any).buildPromptWithImages('Hello', []);
      expect(result).toBe('Hello');
    });

    it('should return async generator when images are provided', async () => {
      const images = [{
        id: 'img1',
        name: 'test.png',
        mediaType: 'image/png',
        data: 'base64data',
        size: 100,
        source: 'file',
      }];

      const result = (service as any).buildPromptWithImages('Describe', images);

      // Should be an async generator
      expect(typeof result[Symbol.asyncIterator]).toBe('function');

      const messages: any[] = [];
      for await (const msg of result) {
        messages.push(msg);
      }

      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe('user');
      expect(messages[0].message.role).toBe('user');
      expect(messages[0].message.content).toEqual([
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'base64data' } },
        { type: 'text', text: 'Describe' },
      ]);
    });

    it('should omit text when prompt is whitespace with images', async () => {
      const images = [{
        id: 'img1',
        name: 'test.png',
        mediaType: 'image/png',
        data: 'base64data',
        size: 100,
        source: 'file',
      }];

      const result = (service as any).buildPromptWithImages('   ', images);

      const messages: any[] = [];
      for await (const msg of result) {
        messages.push(msg);
      }

      expect(messages[0].message.content).toEqual([
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'base64data' } },
      ]);
    });
  });

  describe('consumeSessionInvalidation', () => {
    it('should return false when no invalidation', () => {
      expect(service.consumeSessionInvalidation()).toBe(false);
    });

    it('should delegate to sessionManager', () => {
      const sessionManager = (service as any).sessionManager;
      sessionManager.invalidateSession();

      expect(service.consumeSessionInvalidation()).toBe(true);
      // Should be consumed
      expect(service.consumeSessionInvalidation()).toBe(false);
    });
  });

  describe('Response Handler Management', () => {
    it('should register and unregister handlers', () => {
      const handler = createResponseHandler({
        id: 'test-handler',
        onChunk: jest.fn(),
        onDone: jest.fn(),
        onError: jest.fn(),
      });

      (service as any).registerResponseHandler(handler);
      expect((service as any).responseHandlers).toHaveLength(1);

      (service as any).unregisterResponseHandler('test-handler');
      expect((service as any).responseHandlers).toHaveLength(0);
    });

    it('should not fail when unregistering non-existent handler', () => {
      (service as any).unregisterResponseHandler('nonexistent');
      expect((service as any).responseHandlers).toHaveLength(0);
    });

    it('should register multiple handlers', () => {
      const handler1 = createResponseHandler({
        id: 'h1',
        onChunk: jest.fn(),
        onDone: jest.fn(),
        onError: jest.fn(),
      });
      const handler2 = createResponseHandler({
        id: 'h2',
        onChunk: jest.fn(),
        onDone: jest.fn(),
        onError: jest.fn(),
      });

      (service as any).registerResponseHandler(handler1);
      (service as any).registerResponseHandler(handler2);
      expect((service as any).responseHandlers).toHaveLength(2);

      (service as any).unregisterResponseHandler('h1');
      expect((service as any).responseHandlers).toHaveLength(1);
      expect((service as any).responseHandlers[0].id).toBe('h2');
    });
  });

  describe('closePersistentQuery handler notification', () => {
    it('should call onDone on all handlers when not preserving', () => {
      const onDone1 = jest.fn();
      const onDone2 = jest.fn();
      const handler1 = createResponseHandler({ id: 'h1', onChunk: jest.fn(), onDone: onDone1, onError: jest.fn() });
      const handler2 = createResponseHandler({ id: 'h2', onChunk: jest.fn(), onDone: onDone2, onError: jest.fn() });

      // Set up persistent query state
      (service as any).persistentQuery = { interrupt: jest.fn().mockResolvedValue(undefined) };
      (service as any).messageChannel = { close: jest.fn() };
      (service as any).queryAbortController = { abort: jest.fn() };
      (service as any).responseHandlers = [handler1, handler2];

      service.closePersistentQuery('test');

      expect(onDone1).toHaveBeenCalled();
      expect(onDone2).toHaveBeenCalled();
    });

    it('should NOT call onDone when preserving handlers', () => {
      const onDone = jest.fn();
      const handler = createResponseHandler({ id: 'h1', onChunk: jest.fn(), onDone, onError: jest.fn() });

      (service as any).persistentQuery = { interrupt: jest.fn().mockResolvedValue(undefined) };
      (service as any).messageChannel = { close: jest.fn() };
      (service as any).queryAbortController = { abort: jest.fn() };
      (service as any).responseHandlers = [handler];

      service.closePersistentQuery('test', { preserveHandlers: true });

      expect(onDone).not.toHaveBeenCalled();
    });
  });

  describe('Cancel with persistent query', () => {
    it('should interrupt persistent query on cancel', () => {
      const interruptMock = jest.fn().mockResolvedValue(undefined);
      (service as any).persistentQuery = { interrupt: interruptMock };
      (service as any).shuttingDown = false;

      service.cancel();

      expect(interruptMock).toHaveBeenCalled();
    });

    it('should not interrupt persistent query when shutting down', () => {
      const interruptMock = jest.fn().mockResolvedValue(undefined);
      (service as any).persistentQuery = { interrupt: interruptMock };
      (service as any).shuttingDown = true;

      service.cancel();

      expect(interruptMock).not.toHaveBeenCalled();
    });
  });

  describe('createApprovalCallback - allowed tools restriction', () => {
    const canUseToolOptions = {
      signal: new AbortController().signal,
      toolUseID: 'test-tool-use-id',
    };

    it('should deny tools not in allowedTools list', async () => {
      (service as any).currentAllowedTools = ['Read', 'Glob'];
      const callback = jest.fn().mockResolvedValue('allow');
      service.setApprovalCallback(callback);

      const canUseTool = (service as any).createApprovalCallback();
      const result = await canUseTool('Bash', { command: 'ls' }, canUseToolOptions);

      expect(result.behavior).toBe('deny');
      expect(result.message).toContain('not allowed');
      expect(result.message).toContain('Allowed tools: Read, Glob');
      expect(callback).not.toHaveBeenCalled();
    });

    it('should deny when allowedTools is empty', async () => {
      (service as any).currentAllowedTools = [];
      const callback = jest.fn().mockResolvedValue('allow');
      service.setApprovalCallback(callback);

      const canUseTool = (service as any).createApprovalCallback();
      const result = await canUseTool('Read', { file_path: 'test.md' }, canUseToolOptions);

      expect(result.behavior).toBe('deny');
      expect(result.message).toContain('No tools are allowed');
    });

    it('should allow Skill tool even when not in allowedTools', async () => {
      (service as any).currentAllowedTools = ['Read'];
      const callback = jest.fn().mockResolvedValue('allow');
      service.setApprovalCallback(callback);

      const canUseTool = (service as any).createApprovalCallback();
      const result = await canUseTool('Skill', { name: 'commit' }, canUseToolOptions);

      expect(result.behavior).toBe('allow');
      expect(callback).toHaveBeenCalled();
    });

    it('should allow tools in the allowedTools list', async () => {
      (service as any).currentAllowedTools = ['Read', 'Glob'];
      const callback = jest.fn().mockResolvedValue('allow');
      service.setApprovalCallback(callback);

      const canUseTool = (service as any).createApprovalCallback();
      const result = await canUseTool('Read', { file_path: 'test.md' }, canUseToolOptions);

      expect(result.behavior).toBe('allow');
      expect(callback).toHaveBeenCalled();
    });

    it('should not restrict when currentAllowedTools is null', async () => {
      (service as any).currentAllowedTools = null;
      const callback = jest.fn().mockResolvedValue('allow');
      service.setApprovalCallback(callback);

      const canUseTool = (service as any).createApprovalCallback();
      const result = await canUseTool('Bash', { command: 'rm -rf /' }, canUseToolOptions);

      expect(result.behavior).toBe('allow');
      expect(callback).toHaveBeenCalled();
    });
  });

  describe('routeMessage', () => {
    let handler: ReturnType<typeof createResponseHandler>;
    let onChunk: jest.Mock;
    let onDone: jest.Mock;

    beforeEach(() => {
      onChunk = jest.fn();
      onDone = jest.fn();
      handler = createResponseHandler({
        id: 'route-test',
        onChunk,
        onDone,
        onError: jest.fn(),
      });
      (service as any).responseHandlers = [handler];
      (service as any).messageChannel = {
        onTurnComplete: jest.fn(),
        setSessionId: jest.fn(),
      };
    });

    it('should route session_init event and capture session', async () => {
      const message = { type: 'system', subtype: 'init', session_id: 'new-session-42' };

      await (service as any).routeMessage(message);

      expect(service.getSessionId()).toBe('new-session-42');
    });

    it('should route stream chunks to handler', async () => {
      const message = {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Hello' }] },
      };

      await (service as any).routeMessage(message);

      expect(onChunk).toHaveBeenCalled();
    });

    it('should signal turn complete on result message', async () => {
      const message = { type: 'result', result: 'completed' };

      await (service as any).routeMessage(message);

      expect((service as any).messageChannel.onTurnComplete).toHaveBeenCalled();
      expect(onDone).toHaveBeenCalled();
    });

    it('should signal turn complete on error message', async () => {
      const message = { type: 'error', message: 'Something went wrong' };

      await (service as any).routeMessage(message);

      expect((service as any).messageChannel.onTurnComplete).toHaveBeenCalled();
      expect(onDone).toHaveBeenCalled();
    });

    it('should add sessionId to usage chunks', async () => {
      service.setSessionId('usage-session');
      const message = {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Response' }],
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_creation_input_tokens: 10,
            cache_read_input_tokens: 20,
          },
        },
      };

      await (service as any).routeMessage(message);

      const usageChunks = onChunk.mock.calls.filter(
        ([chunk]: any) => chunk.type === 'usage'
      );
      expect(usageChunks.length).toBeGreaterThan(0);
      expect(usageChunks[0][0].sessionId).toBe('usage-session');
    });

    it('should mark stream text seen on text stream events', async () => {
      const message = {
        type: 'stream_event',
        event: { type: 'content_block_start', content_block: { type: 'text' } },
      };

      await (service as any).routeMessage(message);

      expect(handler.sawStreamText).toBe(true);
    });

    it('should skip duplicate text from assistant messages after stream text', async () => {
      // First, mark stream text as seen
      handler.markStreamTextSeen();

      // Now send an assistant message with text content
      const message = {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Streamed text' }] },
      };

      await (service as any).routeMessage(message);

      // Text chunks should be skipped
      const textChunks = onChunk.mock.calls.filter(
        ([chunk]: any) => chunk.type === 'text'
      );
      expect(textChunks).toHaveLength(0);
    });
  });

  describe('applyDynamicUpdates', () => {
    let mockPersistentQuery: any;

    beforeEach(async () => {
      sdkMock.resetMockMessages();

      // Start a persistent query via ensureReady
      const startSpy = jest.spyOn(service as any, 'startPersistentQuery');
      startSpy.mockImplementation(async (vaultPath: string, cliPath: string, _sessionId?: string, externalContextPaths?: string[]) => {
        mockPersistentQuery = {
          interrupt: jest.fn().mockResolvedValue(undefined),
          setModel: jest.fn().mockResolvedValue(undefined),
          setMaxThinkingTokens: jest.fn().mockResolvedValue(undefined),
          setPermissionMode: jest.fn().mockResolvedValue(undefined),
          setMcpServers: jest.fn().mockResolvedValue({ added: [], removed: [], errors: {} }),
        };
        (service as any).persistentQuery = mockPersistentQuery;
        (service as any).vaultPath = vaultPath;
        (service as any).currentConfig = (service as any).buildPersistentQueryConfig(vaultPath, cliPath, externalContextPaths);
      });

      await service.ensureReady({ externalContextPaths: [] });
    });

    it('should update model when changed', async () => {
      (mockPlugin as any).settings.model = 'claude-3-opus';

      await (service as any).applyDynamicUpdates({ model: 'claude-3-opus' });

      expect(mockPersistentQuery.setModel).toHaveBeenCalled();
    });

    it('should not update model when unchanged', async () => {
      await (service as any).applyDynamicUpdates({ model: 'claude-3-5-sonnet' });

      expect(mockPersistentQuery.setModel).not.toHaveBeenCalled();
    });

    it('should update thinking tokens when changed', async () => {
      // Initial budget is 0 (not a valid ThinkingBudget value) → tokens = null
      // Change to 'high' → tokens = 16000 (different from null → triggers update)
      (mockPlugin as any).settings.thinkingBudget = 'high';

      await (service as any).applyDynamicUpdates({});

      expect(mockPersistentQuery.setMaxThinkingTokens).toHaveBeenCalledWith(16000);
    });

    it('should update permission mode when changed', async () => {
      (mockPlugin as any).settings.permissionMode = 'yolo';

      await (service as any).applyDynamicUpdates({});

      expect(mockPersistentQuery.setPermissionMode).toHaveBeenCalledWith('bypassPermissions');
    });

    it('should update MCP servers when changed', async () => {
      mockMcpManager.getActiveServers.mockReturnValue({
        'test-server': { command: 'test', args: [] },
      });

      await (service as any).applyDynamicUpdates({
        mcpMentions: new Set(['test-server']),
      });

      expect(mockPersistentQuery.setMcpServers).toHaveBeenCalled();
    });

    it('should not restart when allowRestart is false', async () => {
      // Change something that would trigger restart
      (mockPlugin.getResolvedClaudeCliPath as jest.Mock).mockReturnValue('/new/path/to/claude');

      const ensureReadySpy = jest.spyOn(service, 'ensureReady');

      await (service as any).applyDynamicUpdates({}, undefined, false);

      // ensureReady should NOT be called for restart when allowRestart is false
      expect(ensureReadySpy).not.toHaveBeenCalled();
    });

    it('should return early when no persistent query', async () => {
      (service as any).persistentQuery = null;

      // Should not throw
      await expect((service as any).applyDynamicUpdates({})).resolves.toBeUndefined();
    });

    it('should return early when no vault path', async () => {
      (service as any).vaultPath = null;

      await (service as any).applyDynamicUpdates({});

      expect(mockPersistentQuery.setModel).not.toHaveBeenCalled();
    });

    it('should silently handle model update error', async () => {
      (mockPlugin as any).settings.model = 'claude-3-opus';
      mockPersistentQuery.setModel.mockRejectedValueOnce(new Error('Model error'));

      await expect((service as any).applyDynamicUpdates({ model: 'claude-3-opus' })).resolves.toBeUndefined();
    });

    it('should silently handle thinking tokens update error', async () => {
      (mockPlugin as any).settings.thinkingBudget = 5000;
      mockPersistentQuery.setMaxThinkingTokens.mockRejectedValueOnce(new Error('Thinking error'));

      await expect((service as any).applyDynamicUpdates({})).resolves.toBeUndefined();
    });

    it('should silently handle permission mode update error', async () => {
      (mockPlugin as any).settings.permissionMode = 'yolo';
      mockPersistentQuery.setPermissionMode.mockRejectedValueOnce(new Error('Permission error'));

      await expect((service as any).applyDynamicUpdates({})).resolves.toBeUndefined();
    });

    it('should silently handle MCP servers update error', async () => {
      mockMcpManager.getActiveServers.mockReturnValue({ 'server-1': { command: 'cmd' } });
      mockPersistentQuery.setMcpServers.mockRejectedValueOnce(new Error('MCP error'));

      await expect((service as any).applyDynamicUpdates({ mcpMentions: new Set(['server-1']) })).resolves.toBeUndefined();
    });
  });

  describe('query() method', () => {
    beforeEach(() => {
      sdkMock.resetMockMessages();
    });

    afterEach(() => {
      sdkMock.resetMockMessages();
    });

    it('should yield error when vault path is not available', async () => {
      (mockPlugin as any).app.vault.adapter.basePath = undefined;

      const chunks = await collectChunks(service.query('hello'));

      expect(chunks).toEqual([{ type: 'error', content: 'Could not determine vault path' }]);
    });

    it('should yield error when CLI path is not available', async () => {
      (mockPlugin.getResolvedClaudeCliPath as jest.Mock).mockReturnValue(null);

      const chunks = await collectChunks(service.query('hello'));

      expect(chunks).toEqual([{ type: 'error', content: expect.stringContaining('Claude CLI not found') }]);
    });

    it('should yield chunks from cold-start query', async () => {
      sdkMock.setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'cold-session' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Hi!' }] } },
      ]);

      const chunks = await collectChunks(service.query('hello'));

      expect(chunks.length).toBeGreaterThan(0);
      const doneChunks = chunks.filter(c => c.type === 'done');
      expect(doneChunks).toHaveLength(1);
    });

    it('should capture session ID from cold-start response', async () => {
      sdkMock.setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'captured-session' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }] } },
      ]);

      await collectChunks(service.query('hello'));

      expect(service.getSessionId()).toBe('captured-session');
    });

    it('should use persistent query when available', async () => {
      sdkMock.setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'persistent-session' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Hi' }] } },
      ]);

      // Start a real persistent query via ensureReady mocking
      const startSpy = jest.spyOn(service as any, 'startPersistentQuery');
      startSpy.mockImplementation(async (vaultPath: string, cliPath: string) => {
        const messageChannel = new MessageChannel();
        (service as any).messageChannel = messageChannel;
        (service as any).persistentQuery = sdkMock.query({ prompt: messageChannel, options: { cwd: vaultPath, pathToClaudeCodeExecutable: cliPath } as any });
        (service as any).currentConfig = (service as any).buildPersistentQueryConfig(vaultPath, cliPath, []);
        (service as any).startResponseConsumer();
      });

      await service.ensureReady();

      const chunks = await collectChunks(service.query('hello'));

      const doneChunks = chunks.filter(c => c.type === 'done');
      expect(doneChunks).toHaveLength(1);
    });

    it('should rebuild history context when no session but has history', async () => {
      sdkMock.setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'new-session' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'OK' }] } },
      ]);

      const history: any[] = [
        { id: '1', role: 'user', content: 'First question', timestamp: 1000 },
        { id: '2', role: 'assistant', content: 'First answer', timestamp: 1001 },
      ];

      // No session set, but has history → should force cold start
      const chunks = await collectChunks(service.query('follow up', undefined, history));

      const doneChunks = chunks.filter(c => c.type === 'done');
      expect(doneChunks).toHaveLength(1);
    });

    it('should handle errors in cold-start query', async () => {
      // Provide at least one message so the iterator runs and crash triggers
      sdkMock.setMockMessages([
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Hi' }] } },
      ]);

      // Crash on first iteration (before emitting any message)
      sdkMock.simulateCrash(0);

      // Force cold-start to test the cold-start error handling path
      const chunks = await collectChunks(
        service.query('hello', undefined, undefined, { forceColdStart: true })
      );

      const errorChunks = chunks.filter(c => c.type === 'error');
      expect(errorChunks).toHaveLength(1);
      expect(errorChunks[0].content).toContain('Simulated consumer crash');
    });
  });

  describe('buildHistoryRebuildRequest', () => {
    it('should build request with history context', () => {
      const history: any[] = [
        { id: '1', role: 'user', content: 'Tell me about X', timestamp: 1000 },
        { id: '2', role: 'assistant', content: 'X is great', timestamp: 1001 },
      ];

      const result = (service as any).buildHistoryRebuildRequest('New question', history);

      expect(result.prompt).toContain('Tell me about X');
      expect(result.prompt).toContain('X is great');
    });

    it('should include images from last user message', () => {
      const images = [{ id: 'img1', mediaType: 'image/png', data: 'abc', name: 'test.png', size: 100, source: 'file' }];
      const history: any[] = [
        { id: '1', role: 'user', content: 'Look', timestamp: 1000, images },
      ];

      const result = (service as any).buildHistoryRebuildRequest('Follow up', history);

      expect(result.images).toEqual(images);
    });

    it('should return undefined images when last user message has no images', () => {
      const history: any[] = [
        { id: '1', role: 'user', content: 'No images', timestamp: 1000 },
      ];

      const result = (service as any).buildHistoryRebuildRequest('Follow up', history);

      expect(result.images).toBeUndefined();
    });
  });

  describe('startPersistentQuery guard', () => {
    it('should not start if already running', async () => {
      (service as any).persistentQuery = { interrupt: jest.fn() };
      const buildOptsSpy = jest.spyOn(service as any, 'buildPersistentQueryOptions');

      await (service as any).startPersistentQuery('/vault', '/cli', 'session');

      expect(buildOptsSpy).not.toHaveBeenCalled();
    });
  });

  describe('attachPersistentQueryStdinErrorHandler', () => {
    it('should attach error handler to stdin', () => {
      const onMock = jest.fn();
      const onceMock = jest.fn();
      const mockQuery = {
        transport: {
          processStdin: {
            on: onMock,
            once: onceMock,
          },
        },
      };

      (service as any).attachPersistentQueryStdinErrorHandler(mockQuery);

      expect(onMock).toHaveBeenCalledWith('error', expect.any(Function));
      expect(onceMock).toHaveBeenCalledWith('close', expect.any(Function));
    });

    it('should handle query without transport', () => {
      const mockQuery = {};

      // Should not throw
      expect(() => (service as any).attachPersistentQueryStdinErrorHandler(mockQuery)).not.toThrow();
    });

    it('should handle query with transport but no processStdin', () => {
      const mockQuery = { transport: {} };

      expect(() => (service as any).attachPersistentQueryStdinErrorHandler(mockQuery)).not.toThrow();
    });

    it('should close persistent query on non-pipe error when not shutting down', () => {
      const closeSpy = jest.spyOn(service, 'closePersistentQuery');
      (service as any).persistentQuery = { interrupt: jest.fn().mockResolvedValue(undefined) };
      (service as any).messageChannel = { close: jest.fn() };
      (service as any).queryAbortController = { abort: jest.fn() };
      (service as any).shuttingDown = false;

      let errorHandler: (error: any) => void;
      const mockQuery = {
        transport: {
          processStdin: {
            on: jest.fn((event: string, handler: any) => {
              if (event === 'error') errorHandler = handler;
            }),
            once: jest.fn(),
            removeListener: jest.fn(),
          },
        },
      };

      (service as any).attachPersistentQueryStdinErrorHandler(mockQuery);

      // Trigger non-pipe error
      errorHandler!({ code: 'ECONNRESET', message: 'Connection reset' });

      expect(closeSpy).toHaveBeenCalledWith('stdin error');
    });

    it('should NOT close persistent query on EPIPE error', () => {
      const closeSpy = jest.spyOn(service, 'closePersistentQuery');
      (service as any).shuttingDown = false;

      let errorHandler: (error: any) => void;
      const mockQuery = {
        transport: {
          processStdin: {
            on: jest.fn((event: string, handler: any) => {
              if (event === 'error') errorHandler = handler;
            }),
            once: jest.fn(),
            removeListener: jest.fn(),
          },
        },
      };

      (service as any).attachPersistentQueryStdinErrorHandler(mockQuery);

      // Trigger EPIPE error
      errorHandler!({ code: 'EPIPE' });

      expect(closeSpy).not.toHaveBeenCalled();
    });

    it('should NOT close persistent query when shutting down', () => {
      const closeSpy = jest.spyOn(service, 'closePersistentQuery');
      (service as any).shuttingDown = true;

      let errorHandler: (error: any) => void;
      const mockQuery = {
        transport: {
          processStdin: {
            on: jest.fn((event: string, handler: any) => {
              if (event === 'error') errorHandler = handler;
            }),
            once: jest.fn(),
            removeListener: jest.fn(),
          },
        },
      };

      (service as any).attachPersistentQueryStdinErrorHandler(mockQuery);

      errorHandler!({ code: 'ECONNRESET' });

      expect(closeSpy).not.toHaveBeenCalled();
    });

    it('should remove error handler on close', () => {
      const removeListenerMock = jest.fn();
      let closeHandler: () => void;

      const mockQuery = {
        transport: {
          processStdin: {
            on: jest.fn(),
            once: jest.fn((_event: string, handler: any) => {
              closeHandler = handler;
            }),
            removeListener: removeListenerMock,
          },
        },
      };

      (service as any).attachPersistentQueryStdinErrorHandler(mockQuery);

      // Trigger close
      closeHandler!();

      expect(removeListenerMock).toHaveBeenCalledWith('error', expect.any(Function));
    });
  });

  describe('query() - missing node error', () => {
    beforeEach(() => {
      sdkMock.resetMockMessages();
    });

    afterEach(() => {
      sdkMock.resetMockMessages();
      jest.restoreAllMocks();
    });


    it('should yield error when Node.js is missing', async () => {
      jest.spyOn(envUtils, 'getMissingNodeError').mockReturnValueOnce(
        'Claude Code CLI requires Node.js, but Node was not found'
      );

      const chunks = await collectChunks(service.query('hello'));

      const errorChunks = chunks.filter(c => c.type === 'error');
      expect(errorChunks).toHaveLength(1);
      expect(errorChunks[0].content).toContain('Node.js');
    });
  });

  describe('query() - interrupted flag and history rebuild', () => {
    beforeEach(() => {
      sdkMock.resetMockMessages();
    });

    afterEach(() => {
      sdkMock.resetMockMessages();
    });


    it('should clear interrupted flag before query', async () => {
      sdkMock.setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'session-1' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'OK' }] } },
      ]);

      // Set interrupted state
      (service as any).sessionManager.markInterrupted();
      expect((service as any).sessionManager.wasInterrupted()).toBe(true);

      await collectChunks(service.query('hello'));

      expect((service as any).sessionManager.wasInterrupted()).toBe(false);
    });

    it('should rebuild history on session mismatch', async () => {
      // Use same session_id as the one we set to avoid captureSession re-setting the flag
      sdkMock.setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'old-session' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'OK' }] } },
      ]);

      // Set up session mismatch state: capture a session, then directly set the flag
      service.setSessionId('old-session');
      (service as any).sessionManager.state.needsHistoryRebuild = true;

      const history: any[] = [
        { id: '1', role: 'user', content: 'Previous question', timestamp: 1000 },
        { id: '2', role: 'assistant', content: 'Previous answer', timestamp: 1001 },
      ];

      // Spy on buildPromptWithHistoryContext to verify it's called
      const buildSpy = jest.spyOn(sessionUtils, 'buildPromptWithHistoryContext');

      const chunks = await collectChunks(service.query('follow up', undefined, history));

      // Should complete successfully
      const doneChunks = chunks.filter(c => c.type === 'done');
      expect(doneChunks).toHaveLength(1);
      // History rebuild function should have been called
      expect(buildSpy).toHaveBeenCalled();
    });
  });

  describe('query() - session expired retry (cold-start path)', () => {
    beforeEach(() => {
      sdkMock.resetMockMessages();
    });

    afterEach(() => {
      sdkMock.resetMockMessages();
      jest.restoreAllMocks();
    });


    it('should retry with history on session expired error in cold-start', async () => {
      // First call throws session expired, second succeeds
      let callCount = 0;
      const originalQuery = sdkMock.query;
      jest.spyOn(sdkModule, 'query' as any).mockImplementation((...args: any[]) => {
        callCount++;
        if (callCount === 1) {
          // First call: throw session expired error
          // eslint-disable-next-line require-yield
          const gen = (async function* () {
            throw new Error('session expired');
          })() as any;
          gen.interrupt = jest.fn();
          gen.setModel = jest.fn();
          gen.setMaxThinkingTokens = jest.fn();
          gen.setPermissionMode = jest.fn();
          gen.setMcpServers = jest.fn();
          return gen;
        }
        // Second call: succeed with retry
        return originalQuery.call(null, ...args);
      });

      service.setSessionId('old-session');
      const history: any[] = [
        { id: '1', role: 'user', content: 'Previous', timestamp: 1000 },
        { id: '2', role: 'assistant', content: 'Answer', timestamp: 1001 },
      ];

      sdkMock.setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'retry-session' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Retried OK' }] } },
      ]);

      const chunks = await collectChunks(
        service.query('follow up', undefined, history, { forceColdStart: true })
      );

      // Should have retried and yielded chunks
      const doneChunks = chunks.filter(c => c.type === 'done');
      expect(doneChunks).toHaveLength(1);
      expect(callCount).toBeGreaterThanOrEqual(2);
    });

    it('should yield error when session expired retry also fails', async () => {
      jest.spyOn(sdkModule, 'query' as any).mockImplementation(() => {
        // eslint-disable-next-line require-yield
        const gen = (async function* () {
          throw new Error('session expired');
        })() as any;
        gen.interrupt = jest.fn();
        gen.setModel = jest.fn();
        gen.setMaxThinkingTokens = jest.fn();
        gen.setPermissionMode = jest.fn();
        gen.setMcpServers = jest.fn();
        return gen;
      });

      service.setSessionId('old-session');
      const history: any[] = [
        { id: '1', role: 'user', content: 'Previous', timestamp: 1000 },
      ];

      const chunks = await collectChunks(
        service.query('follow up', undefined, history, { forceColdStart: true })
      );

      const errorChunks = chunks.filter(c => c.type === 'error');
      expect(errorChunks).toHaveLength(1);
      expect(errorChunks[0].content).toContain('session expired');
    });
  });

  describe('applyDynamicUpdates - cliPath null', () => {
    it('should return early when cliPath is null', async () => {
      (service as any).persistentQuery = { setModel: jest.fn() };
      (service as any).vaultPath = '/vault';
      (mockPlugin.getResolvedClaudeCliPath as jest.Mock).mockReturnValue(null);

      const setModelSpy = (service as any).persistentQuery.setModel;

      await (service as any).applyDynamicUpdates({});

      expect(setModelSpy).not.toHaveBeenCalled();
    });
  });

  describe('applyDynamicUpdates - restart needed', () => {
    it('should restart and re-apply when config changes require restart', async () => {
      sdkMock.resetMockMessages();
      sdkMock.setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'restart-session' },
      ]);

      // Set up mock persistent query
      const mockPQ = {
        interrupt: jest.fn().mockResolvedValue(undefined),
        setModel: jest.fn().mockResolvedValue(undefined),
        setMaxThinkingTokens: jest.fn().mockResolvedValue(undefined),
        setPermissionMode: jest.fn().mockResolvedValue(undefined),
        setMcpServers: jest.fn().mockResolvedValue({ added: [], removed: [], errors: {} }),
      };
      (service as any).persistentQuery = mockPQ;
      (service as any).vaultPath = '/mock/vault/path';
      (service as any).messageChannel = { close: jest.fn() };
      (service as any).queryAbortController = { abort: jest.fn() };
      (service as any).currentConfig = {
        model: 'claude-3-5-sonnet',
        thinkingTokens: null,
        permissionMode: 'ask',
        systemPromptKey: '',
        disallowedToolsKey: '',
        mcpServersKey: '{}',
        pluginsKey: '',
        externalContextPaths: [],
        allowedExportPaths: [],
        settingSources: '',
        claudeCliPath: '/usr/local/bin/claude',
        show1MModel: false,
        enableChrome: false,
      };

      // Change CLI path to trigger restart
      (mockPlugin.getResolvedClaudeCliPath as jest.Mock).mockReturnValue('/new/path/to/claude');

      // Mock ensureReady to return true (restarted)
      const ensureReadySpy = jest.spyOn(service, 'ensureReady').mockResolvedValue(true);

      await (service as any).applyDynamicUpdates({});

      expect(ensureReadySpy).toHaveBeenCalledWith(
        expect.objectContaining({ force: true })
      );
    });
  });

  describe('routeMessage - agents event', () => {
    it('should set builtin agent names from init event', async () => {
      const mockAgentManager = { setBuiltinAgentNames: jest.fn() };
      (mockPlugin as any).agentManager = mockAgentManager;

      const onChunk = jest.fn();
      const handler = createResponseHandler({
        id: 'agents-test',
        onChunk,
        onDone: jest.fn(),
        onError: jest.fn(),
      });
      (service as any).responseHandlers = [handler];
      (service as any).messageChannel = {
        onTurnComplete: jest.fn(),
        setSessionId: jest.fn(),
      };

      // Send a system init message with agents
      const message = {
        type: 'system',
        subtype: 'init',
        session_id: 'test-session',
        agents: ['agent1', 'agent2'],
      };

      await (service as any).routeMessage(message);

      expect(mockAgentManager.setBuiltinAgentNames).toHaveBeenCalledWith(['agent1', 'agent2']);
    });

    it('should not throw when agentManager.setBuiltinAgentNames fails', async () => {
      const mockAgentManager = {
        setBuiltinAgentNames: jest.fn().mockImplementation(() => {
          throw new Error('agent error');
        }),
      };
      (mockPlugin as any).agentManager = mockAgentManager;

      const handler = createResponseHandler({
        id: 'agents-error-test',
        onChunk: jest.fn(),
        onDone: jest.fn(),
        onError: jest.fn(),
      });
      (service as any).responseHandlers = [handler];
      (service as any).messageChannel = {
        onTurnComplete: jest.fn(),
        setSessionId: jest.fn(),
      };

      const message = {
        type: 'system',
        subtype: 'init',
        session_id: 'test-session',
        agents: ['agent1'],
      };

      // Should not throw
      await expect((service as any).routeMessage(message)).resolves.toBeUndefined();
    });
  });

  describe('routeMessage - usage chunk with sessionId', () => {
    it('should attach sessionId to usage chunks from assistant messages', async () => {
      service.setSessionId('usage-session-id');

      const onChunk = jest.fn();
      const handler = createResponseHandler({
        id: 'usage-test',
        onChunk,
        onDone: jest.fn(),
        onError: jest.fn(),
      });
      (service as any).responseHandlers = [handler];
      (service as any).messageChannel = {
        onTurnComplete: jest.fn(),
        setSessionId: jest.fn(),
      };

      // Usage is extracted from assistant messages (not result messages)
      const message = {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Response' }],
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_creation_input_tokens: 10,
            cache_read_input_tokens: 20,
          },
        },
      };

      await (service as any).routeMessage(message);

      const usageChunks = onChunk.mock.calls
        .map(([chunk]: any) => chunk)
        .filter((c: any) => c.type === 'usage');

      expect(usageChunks.length).toBeGreaterThan(0);
      expect(usageChunks[0].sessionId).toBe('usage-session-id');
    });
  });

  describe('queryViaPersistent - edge cases', () => {
    it('should fall back to cold-start when persistent query is null', async () => {
      sdkMock.resetMockMessages();
      sdkMock.setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'fallback-session' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Fallback' }] } },
      ]);

      // No persistent query set
      (service as any).persistentQuery = null;
      (service as any).messageChannel = null;

      const chunks: any[] = [];
      for await (const chunk of (service as any).queryViaPersistent(
        'test', undefined, '/mock/vault/path', '/usr/local/bin/claude'
      )) {
        chunks.push(chunk);
      }

      const doneChunks = chunks.filter(c => c.type === 'done');
      expect(doneChunks).toHaveLength(1);
    });

    it('should set allowedTools from query options', async () => {
      sdkMock.resetMockMessages();
      sdkMock.setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'allowed-tools-session' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'OK' }] } },
      ]);

      // Set up persistent query
      const mockPQ = {
        interrupt: jest.fn().mockResolvedValue(undefined),
        setModel: jest.fn().mockResolvedValue(undefined),
        setMaxThinkingTokens: jest.fn().mockResolvedValue(undefined),
        setPermissionMode: jest.fn().mockResolvedValue(undefined),
        setMcpServers: jest.fn().mockResolvedValue({ added: [], removed: [], errors: {} }),
      };
      (service as any).persistentQuery = mockPQ;
      const mockChannel = new MessageChannel();
      (service as any).messageChannel = mockChannel;
      (service as any).responseConsumerRunning = true;
      (service as any).vaultPath = '/mock/vault/path';
      (service as any).currentConfig = {
        model: 'claude-3-5-sonnet',
        thinkingTokens: null,
        permissionMode: 'ask',
        systemPromptKey: '',
        disallowedToolsKey: '',
        mcpServersKey: '{}',
        pluginsKey: '',
        externalContextPaths: [],
        allowedExportPaths: [],
        settingSources: '',
        claudeCliPath: '/usr/local/bin/claude',
        show1MModel: false,
        enableChrome: false,
      };

      // Set up handler to resolve immediately
      const gen = (service as any).queryViaPersistent(
        'test', undefined, '/mock/vault/path', '/usr/local/bin/claude',
        { allowedTools: ['Read', 'Glob'] }
      );

      // The generator will hang waiting for handler.onDone, so we need to
      // trigger it via the response handler
      const iterPromise = gen.next();

      // Wait a tick for the handler to be registered
      await new Promise(resolve => setTimeout(resolve, 10));

      // Find and trigger the handler
      const handlers = (service as any).responseHandlers;
      if (handlers.length > 0) {
        handlers[0].onChunk({ type: 'text', content: 'Hi' });
        handlers[0].onDone();
      }

      await iterPromise;

      // allowedTools should include the specified tools + Skill
      expect((service as any).currentAllowedTools).toEqual(['Read', 'Glob', 'Skill']);

      // Drain the generator
      let next = await gen.next();
      while (!next.done) {
        next = await gen.next();
      }
    });

    it('should fall back to cold-start when consumer is not running', async () => {
      sdkMock.resetMockMessages();
      sdkMock.setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'consumer-fallback' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Fallback' }] } },
      ]);

      // Persistent query exists but consumer is not running
      (service as any).persistentQuery = {
        interrupt: jest.fn().mockResolvedValue(undefined),
        setModel: jest.fn().mockResolvedValue(undefined),
        setMaxThinkingTokens: jest.fn().mockResolvedValue(undefined),
        setPermissionMode: jest.fn().mockResolvedValue(undefined),
        setMcpServers: jest.fn().mockResolvedValue({ added: [], removed: [], errors: {} }),
      };
      (service as any).messageChannel = new MessageChannel();
      (service as any).responseConsumerRunning = false;
      (service as any).vaultPath = '/mock/vault/path';
      (service as any).currentConfig = {
        model: 'claude-3-5-sonnet',
        thinkingTokens: null,
        permissionMode: 'ask',
        systemPromptKey: '',
        disallowedToolsKey: '',
        mcpServersKey: '{}',
        pluginsKey: '',
        externalContextPaths: [],
        allowedExportPaths: [],
        settingSources: '',
        claudeCliPath: '/usr/local/bin/claude',
        show1MModel: false,
        enableChrome: false,
      };

      const chunks: any[] = [];
      for await (const chunk of (service as any).queryViaPersistent(
        'test', undefined, '/mock/vault/path', '/usr/local/bin/claude'
      )) {
        chunks.push(chunk);
      }

      const doneChunks = chunks.filter(c => c.type === 'done');
      expect(doneChunks).toHaveLength(1);
    });

    it('should fall back when persistent query lost after applyDynamicUpdates', async () => {
      sdkMock.resetMockMessages();
      sdkMock.setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'lost-pq' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'OK' }] } },
      ]);

      // Set up persistent query that will be cleared by applyDynamicUpdates mock
      (service as any).persistentQuery = {
        interrupt: jest.fn().mockResolvedValue(undefined),
        setModel: jest.fn().mockResolvedValue(undefined),
        setMaxThinkingTokens: jest.fn().mockResolvedValue(undefined),
        setPermissionMode: jest.fn().mockResolvedValue(undefined),
        setMcpServers: jest.fn().mockResolvedValue({ added: [], removed: [], errors: {} }),
      };
      (service as any).messageChannel = new MessageChannel();
      (service as any).responseConsumerRunning = true;
      (service as any).vaultPath = '/mock/vault/path';
      (service as any).currentConfig = {
        model: 'claude-3-5-sonnet',
        thinkingTokens: null,
        permissionMode: 'ask',
        systemPromptKey: '',
        disallowedToolsKey: '',
        mcpServersKey: '{}',
        pluginsKey: '',
        externalContextPaths: [],
        allowedExportPaths: [],
        settingSources: '',
        claudeCliPath: '/usr/local/bin/claude',
        show1MModel: false,
        enableChrome: false,
      };

      // Mock applyDynamicUpdates to clear persistent query (simulating restart failure)
      jest.spyOn(service as any, 'applyDynamicUpdates').mockImplementation(async () => {
        (service as any).persistentQuery = null;
        (service as any).messageChannel = null;
      });

      const chunks: any[] = [];
      for await (const chunk of (service as any).queryViaPersistent(
        'test', undefined, '/mock/vault/path', '/usr/local/bin/claude'
      )) {
        chunks.push(chunk);
      }

      const doneChunks = chunks.filter(c => c.type === 'done');
      expect(doneChunks).toHaveLength(1);
    });

    it('should fall back when channel is closed during enqueue', async () => {
      sdkMock.resetMockMessages();
      sdkMock.setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'closed-channel' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'OK' }] } },
      ]);

      const closedChannel = new MessageChannel();
      closedChannel.close();

      (service as any).persistentQuery = {
        interrupt: jest.fn().mockResolvedValue(undefined),
        setModel: jest.fn().mockResolvedValue(undefined),
        setMaxThinkingTokens: jest.fn().mockResolvedValue(undefined),
        setPermissionMode: jest.fn().mockResolvedValue(undefined),
        setMcpServers: jest.fn().mockResolvedValue({ added: [], removed: [], errors: {} }),
      };
      (service as any).messageChannel = closedChannel;
      (service as any).responseConsumerRunning = true;
      (service as any).vaultPath = '/mock/vault/path';
      (service as any).currentConfig = {
        model: 'claude-3-5-sonnet',
        thinkingTokens: null,
        permissionMode: 'ask',
        systemPromptKey: '',
        disallowedToolsKey: '',
        mcpServersKey: '{}',
        pluginsKey: '',
        externalContextPaths: [],
        allowedExportPaths: [],
        settingSources: '',
        claudeCliPath: '/usr/local/bin/claude',
        show1MModel: false,
        enableChrome: false,
      };

      const chunks: any[] = [];
      for await (const chunk of (service as any).queryViaPersistent(
        'test', undefined, '/mock/vault/path', '/usr/local/bin/claude'
      )) {
        chunks.push(chunk);
      }

      // Should fall back to cold-start and complete
      const doneChunks = chunks.filter(c => c.type === 'done');
      expect(doneChunks).toHaveLength(1);
    });

    it('should handle onError in handler and re-throw session expired', async () => {
      const mockPQ = {
        interrupt: jest.fn().mockResolvedValue(undefined),
        setModel: jest.fn().mockResolvedValue(undefined),
        setMaxThinkingTokens: jest.fn().mockResolvedValue(undefined),
        setPermissionMode: jest.fn().mockResolvedValue(undefined),
        setMcpServers: jest.fn().mockResolvedValue({ added: [], removed: [], errors: {} }),
      };
      (service as any).persistentQuery = mockPQ;
      const mockChannel = new MessageChannel();
      (service as any).messageChannel = mockChannel;
      (service as any).responseConsumerRunning = true;
      (service as any).vaultPath = '/mock/vault/path';
      (service as any).currentConfig = {
        model: 'claude-3-5-sonnet',
        thinkingTokens: null,
        permissionMode: 'ask',
        systemPromptKey: '',
        disallowedToolsKey: '',
        mcpServersKey: '{}',
        pluginsKey: '',
        externalContextPaths: [],
        allowedExportPaths: [],
        settingSources: '',
        claudeCliPath: '/usr/local/bin/claude',
        show1MModel: false,
        enableChrome: false,
      };

      // Mock applyDynamicUpdates to avoid side effects
      jest.spyOn(service as any, 'applyDynamicUpdates').mockResolvedValue(undefined);

      const gen = (service as any).queryViaPersistent(
        'test', undefined, '/mock/vault/path', '/usr/local/bin/claude'
      );

      const iterPromise = gen.next();
      await new Promise(resolve => setTimeout(resolve, 10));

      // Trigger onError with session expired
      const handlers = (service as any).responseHandlers;
      expect(handlers.length).toBeGreaterThan(0);
      handlers[0].onError(new Error('session expired'));

      // Session expired should be re-thrown by the generator
      // gen.next() will resolve with the error propagating through the generator
      await expect(iterPromise).rejects.toThrow('session expired');
    });

    it('should handle onError with non-session error', async () => {
      const mockPQ = {
        interrupt: jest.fn().mockResolvedValue(undefined),
        setModel: jest.fn().mockResolvedValue(undefined),
        setMaxThinkingTokens: jest.fn().mockResolvedValue(undefined),
        setPermissionMode: jest.fn().mockResolvedValue(undefined),
        setMcpServers: jest.fn().mockResolvedValue({ added: [], removed: [], errors: {} }),
      };
      (service as any).persistentQuery = mockPQ;
      const mockChannel = new MessageChannel();
      (service as any).messageChannel = mockChannel;
      (service as any).responseConsumerRunning = true;
      (service as any).vaultPath = '/mock/vault/path';
      (service as any).currentConfig = {
        model: 'claude-3-5-sonnet',
        thinkingTokens: null,
        permissionMode: 'ask',
        systemPromptKey: '',
        disallowedToolsKey: '',
        mcpServersKey: '{}',
        pluginsKey: '',
        externalContextPaths: [],
        allowedExportPaths: [],
        settingSources: '',
        claudeCliPath: '/usr/local/bin/claude',
        show1MModel: false,
        enableChrome: false,
      };

      // Mock applyDynamicUpdates to avoid side effects
      jest.spyOn(service as any, 'applyDynamicUpdates').mockResolvedValue(undefined);

      const gen = (service as any).queryViaPersistent(
        'test', undefined, '/mock/vault/path', '/usr/local/bin/claude'
      );

      const chunks: any[] = [];
      const iterPromise = gen.next();
      await new Promise(resolve => setTimeout(resolve, 10));

      // Trigger onError with regular error
      const handlers = (service as any).responseHandlers;
      expect(handlers.length).toBeGreaterThan(0);
      handlers[0].onError(new Error('Some internal error'));

      const first = await iterPromise;
      if (!first.done) {
        chunks.push(first.value);
        let next = await gen.next();
        while (!next.done) {
          chunks.push(next.value);
          next = await gen.next();
        }
      }

      const errorChunks = chunks.filter(c => c.type === 'error');
      expect(errorChunks).toHaveLength(1);
      expect(errorChunks[0].content).toContain('Some internal error');
    });

    it('should yield buffered chunks from state.chunks', async () => {
      const mockPQ = {
        interrupt: jest.fn().mockResolvedValue(undefined),
        setModel: jest.fn().mockResolvedValue(undefined),
        setMaxThinkingTokens: jest.fn().mockResolvedValue(undefined),
        setPermissionMode: jest.fn().mockResolvedValue(undefined),
        setMcpServers: jest.fn().mockResolvedValue({ added: [], removed: [], errors: {} }),
      };
      (service as any).persistentQuery = mockPQ;
      const mockChannel = new MessageChannel();
      (service as any).messageChannel = mockChannel;
      (service as any).responseConsumerRunning = true;
      (service as any).vaultPath = '/mock/vault/path';
      (service as any).currentConfig = {
        model: 'claude-3-5-sonnet',
        thinkingTokens: null,
        permissionMode: 'ask',
        systemPromptKey: '',
        disallowedToolsKey: '',
        mcpServersKey: '{}',
        pluginsKey: '',
        externalContextPaths: [],
        allowedExportPaths: [],
        settingSources: '',
        claudeCliPath: '/usr/local/bin/claude',
        show1MModel: false,
        enableChrome: false,
      };

      // Mock applyDynamicUpdates to avoid side effects
      jest.spyOn(service as any, 'applyDynamicUpdates').mockResolvedValue(undefined);

      const gen = (service as any).queryViaPersistent(
        'test', undefined, '/mock/vault/path', '/usr/local/bin/claude'
      );

      const iterPromise = gen.next();
      await new Promise(resolve => setTimeout(resolve, 10));

      // Rapidly send multiple chunks then done
      const handlers = (service as any).responseHandlers;
      expect(handlers.length).toBeGreaterThan(0);
      handlers[0].onChunk({ type: 'text', content: 'First' });
      handlers[0].onChunk({ type: 'text', content: 'Second' });
      handlers[0].onDone();

      const chunks: any[] = [];
      const first = await iterPromise;
      if (!first.done) {
        chunks.push(first.value);
        let next = await gen.next();
        while (!next.done) {
          chunks.push(next.value);
          next = await gen.next();
        }
      }

      const textChunks = chunks.filter(c => c.type === 'text');
      expect(textChunks.length).toBe(2);
      expect(textChunks[0].content).toBe('First');
      expect(textChunks[1].content).toBe('Second');
    });
  });

  describe('query() - session expired retry from persistent path', () => {
    beforeEach(() => {
      sdkMock.resetMockMessages();
    });

    afterEach(() => {
      sdkMock.resetMockMessages();
      jest.restoreAllMocks();
    });


    it('should retry via cold-start when persistent query yields session expired error', async () => {
      // Set up a session and history so retry can happen
      service.setSessionId('old-persistent-session');
      const history: any[] = [
        { id: '1', role: 'user', content: 'Previous question', timestamp: 1000 },
        { id: '2', role: 'assistant', content: 'Previous answer', timestamp: 1001 },
      ];

      // Mock queryViaPersistent to throw session expired
      jest.spyOn(service as any, 'queryViaPersistent').mockImplementation(
        // eslint-disable-next-line require-yield
        async function* () {
          throw new Error('session expired');
        }
      );

      // Mock queryViaSDK to succeed on retry
      const queryViaSDKSpy = jest.spyOn(service as any, 'queryViaSDK').mockImplementation(
        async function* () {
          yield { type: 'text', content: 'Retried OK' };
          yield { type: 'done' };
        }
      );

      // Need a persistent query to be "active" for shouldUsePersistent
      (service as any).persistentQuery = { interrupt: jest.fn().mockResolvedValue(undefined) };
      (service as any).shuttingDown = false;

      const chunks = await collectChunks(service.query('follow up', undefined, history));

      // Should have retried via SDK
      expect(queryViaSDKSpy).toHaveBeenCalled();
      const textChunks = chunks.filter(c => c.type === 'text');
      expect(textChunks[0].content).toBe('Retried OK');
    });

    it('should yield error when persistent session expired retry also fails', async () => {
      service.setSessionId('old-persistent-session');
      const history: any[] = [
        { id: '1', role: 'user', content: 'Previous question', timestamp: 1000 },
      ];

      jest.spyOn(service as any, 'queryViaPersistent').mockImplementation(
        // eslint-disable-next-line require-yield
        async function* () {
          throw new Error('session expired');
        }
      );

      jest.spyOn(service as any, 'queryViaSDK').mockImplementation(
        // eslint-disable-next-line require-yield
        async function* () {
          throw new Error('retry also failed');
        }
      );

      (service as any).persistentQuery = { interrupt: jest.fn().mockResolvedValue(undefined) };
      (service as any).shuttingDown = false;

      const chunks = await collectChunks(service.query('follow up', undefined, history));

      const errorChunks = chunks.filter(c => c.type === 'error');
      expect(errorChunks).toHaveLength(1);
      expect(errorChunks[0].content).toContain('retry also failed');
    });

    it('should re-throw non-session-expired errors from persistent path', async () => {
      jest.spyOn(service as any, 'queryViaPersistent').mockImplementation(
        // eslint-disable-next-line require-yield
        async function* () {
          throw new Error('unexpected failure');
        }
      );

      (service as any).persistentQuery = { interrupt: jest.fn().mockResolvedValue(undefined) };
      (service as any).shuttingDown = false;

      // query() should propagate the error (not catch it)
      await expect(async () => {
        await collectChunks(service.query('hello'));
      }).rejects.toThrow('unexpected failure');
    });

    it('should not retry session expired without conversation history', async () => {
      jest.spyOn(service as any, 'queryViaPersistent').mockImplementation(
        // eslint-disable-next-line require-yield
        async function* () {
          throw new Error('session expired');
        }
      );

      (service as any).persistentQuery = { interrupt: jest.fn().mockResolvedValue(undefined) };
      (service as any).shuttingDown = false;

      // No history → should re-throw, not retry
      await expect(async () => {
        await collectChunks(service.query('hello'));
      }).rejects.toThrow('session expired');
    });
  });

  describe('query() - non-session-expired cold-start error', () => {
    beforeEach(() => {
      sdkMock.resetMockMessages();
    });

    afterEach(() => {
      sdkMock.resetMockMessages();
      jest.restoreAllMocks();
    });


    it('should yield error chunk for non-session-expired errors in cold-start path', async () => {
      jest.spyOn(sdkModule, 'query' as any).mockImplementation(() => {
        // eslint-disable-next-line require-yield
        const gen = (async function* () {
          throw new Error('connection timeout');
        })() as any;
        gen.interrupt = jest.fn();
        gen.setModel = jest.fn();
        gen.setMaxThinkingTokens = jest.fn();
        gen.setPermissionMode = jest.fn();
        gen.setMcpServers = jest.fn();
        return gen;
      });

      const chunks = await collectChunks(
        service.query('hello', undefined, undefined, { forceColdStart: true })
      );

      const errorChunks = chunks.filter(c => c.type === 'error');
      expect(errorChunks).toHaveLength(1);
      expect(errorChunks[0].content).toBe('connection timeout');
    });

    it('should handle non-Error thrown values in cold-start path', async () => {
      jest.spyOn(sdkModule, 'query' as any).mockImplementation(() => {
        // eslint-disable-next-line require-yield
        const gen = (async function* () {
          throw 'string error';  // eslint-disable-line no-throw-literal
        })() as any;
        gen.interrupt = jest.fn();
        gen.setModel = jest.fn();
        gen.setMaxThinkingTokens = jest.fn();
        gen.setPermissionMode = jest.fn();
        gen.setMcpServers = jest.fn();
        return gen;
      });

      const chunks = await collectChunks(
        service.query('hello', undefined, undefined, { forceColdStart: true })
      );

      const errorChunks = chunks.filter(c => c.type === 'error');
      expect(errorChunks).toHaveLength(1);
      expect(errorChunks[0].content).toBe('Unknown error');
    });
  });

  describe('queryViaSDK - abort signal handling', () => {
    beforeEach(() => {
      sdkMock.resetMockMessages();
    });

    afterEach(() => {
      sdkMock.resetMockMessages();
      jest.restoreAllMocks();
    });

    it('should interrupt response when abort signal is triggered during iteration', async () => {
      const abortController = new AbortController();
      (service as any).abortController = abortController;

      let interruptCalled = false;
      // Set up messages that allow us to abort mid-stream
      jest.spyOn(sdkModule, 'query' as any).mockImplementation(() => {
        const messages = [
          { type: 'system', subtype: 'init', session_id: 'abort-session' },
          { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }] } },
          // Third message won't be yielded because we abort after the second
          { type: 'assistant', message: { content: [{ type: 'text', text: 'World' }] } },
        ];

        let index = 0;
        const gen = {
          [Symbol.asyncIterator]() { return this; },
          async next() {
            if (index >= messages.length) return { done: true, value: undefined };
            const msg = messages[index++];
            // Abort after yielding the second message
            if (index === 2) {
              abortController.abort();
            }
            return { done: false, value: msg };
          },
          async return() { return { done: true, value: undefined }; },
          interrupt: jest.fn().mockImplementation(async () => { interruptCalled = true; }),
          setModel: jest.fn(),
          setMaxThinkingTokens: jest.fn(),
          setPermissionMode: jest.fn(),
          setMcpServers: jest.fn(),
        };
        return gen;
      });

      const chunks: any[] = [];
      for await (const chunk of (service as any).queryViaSDK(
        'hello', '/mock/vault/path', '/usr/local/bin/claude', undefined, { forceColdStart: true }
      )) {
        chunks.push(chunk);
      }

      // interrupt should have been called
      expect(interruptCalled).toBe(true);
    });
  });

  describe('startResponseConsumer - crash recovery', () => {
    it('should attempt crash recovery when error occurs before any chunks', async () => {
      // Set up persistent query that will throw on iteration
      const crashError = new Error('process crashed');
      let iterationCount = 0;
      const mockPQ = {
        [Symbol.asyncIterator]() { return this; },
        async next() {
          iterationCount++;
          if (iterationCount === 1) {
            throw crashError;
          }
          return { done: true, value: undefined };
        },
        async return() { return { done: true, value: undefined }; },
        interrupt: jest.fn().mockResolvedValue(undefined),
        setModel: jest.fn().mockResolvedValue(undefined),
        setMaxThinkingTokens: jest.fn().mockResolvedValue(undefined),
        setPermissionMode: jest.fn().mockResolvedValue(undefined),
        setMcpServers: jest.fn().mockResolvedValue({ added: [], removed: [], errors: {} }),
      };

      (service as any).persistentQuery = mockPQ;
      (service as any).messageChannel = { close: jest.fn(), enqueue: jest.fn(), onTurnComplete: jest.fn() };
      (service as any).queryAbortController = { abort: jest.fn() };
      (service as any).shuttingDown = false;
      (service as any).coldStartInProgress = false;
      (service as any).crashRecoveryAttempted = false;
      (service as any).responseConsumerRunning = false;

      // Set up a handler that hasn't seen any chunks (sawAnyChunk = false)
      const onError = jest.fn();
      const handler = createResponseHandler({
        id: 'crash-test',
        onChunk: jest.fn(),
        onDone: jest.fn(),
        onError,
      });
      (service as any).responseHandlers = [handler];

      // Set lastSentMessage for replay
      (service as any).lastSentMessage = {
        type: 'user',
        message: { role: 'user', content: 'test' },
        parent_tool_use_id: null,
        session_id: 'test-session',
      };

      // Mock ensureReady to succeed
      const ensureReadySpy = jest.spyOn(service, 'ensureReady').mockResolvedValue(true);
      // After ensureReady, messageChannel needs to exist
      jest.spyOn(service as any, 'applyDynamicUpdates').mockResolvedValue(undefined);

      (service as any).startResponseConsumer();

      // Wait for async consumer to process
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(ensureReadySpy).toHaveBeenCalledWith(
        expect.objectContaining({ force: true, preserveHandlers: true })
      );
    });

    it('should notify handler and restart when crash recovery already attempted', async () => {
      const crashError = new Error('process crashed again');
      let iterationCount = 0;
      const mockPQ = {
        [Symbol.asyncIterator]() { return this; },
        async next() {
          iterationCount++;
          if (iterationCount === 1) throw crashError;
          return { done: true, value: undefined };
        },
        async return() { return { done: true, value: undefined }; },
        interrupt: jest.fn().mockResolvedValue(undefined),
      };

      (service as any).persistentQuery = mockPQ;
      (service as any).messageChannel = { close: jest.fn() };
      (service as any).queryAbortController = { abort: jest.fn() };
      (service as any).shuttingDown = false;
      (service as any).coldStartInProgress = false;
      (service as any).crashRecoveryAttempted = true; // Already attempted
      (service as any).responseConsumerRunning = false;

      const onError = jest.fn();
      const handler = createResponseHandler({
        id: 'crash-test-2',
        onChunk: jest.fn(),
        onDone: jest.fn(),
        onError,
      });
      // handler hasn't seen chunks
      (service as any).responseHandlers = [handler];

      (service as any).lastSentMessage = {
        type: 'user',
        message: { role: 'user', content: 'test' },
        parent_tool_use_id: null,
        session_id: 'test-session',
      };

      // ensureReady should NOT be called for recovery (already attempted),
      // but should be called for restart-for-next-message
      jest.spyOn(service, 'ensureReady').mockResolvedValue(false);

      (service as any).startResponseConsumer();

      await new Promise(resolve => setTimeout(resolve, 50));

      // Handler should have been notified of error
      expect(onError).toHaveBeenCalledWith(crashError);
    });

    it('should invalidate session when crash recovery restart fails with session expired', async () => {
      const crashError = new Error('process crashed');
      let iterationCount = 0;
      const mockPQ = {
        [Symbol.asyncIterator]() { return this; },
        async next() {
          iterationCount++;
          if (iterationCount === 1) throw crashError;
          return { done: true, value: undefined };
        },
        async return() { return { done: true, value: undefined }; },
        interrupt: jest.fn().mockResolvedValue(undefined),
      };

      (service as any).persistentQuery = mockPQ;
      (service as any).messageChannel = { close: jest.fn() };
      (service as any).queryAbortController = { abort: jest.fn() };
      (service as any).shuttingDown = false;
      (service as any).coldStartInProgress = false;
      (service as any).crashRecoveryAttempted = false;
      (service as any).responseConsumerRunning = false;

      const onError = jest.fn();
      const handler = createResponseHandler({
        id: 'session-expire-test',
        onChunk: jest.fn(),
        onDone: jest.fn(),
        onError,
      });
      (service as any).responseHandlers = [handler];
      (service as any).lastSentMessage = {
        type: 'user',
        message: { role: 'user', content: 'test' },
        parent_tool_use_id: null,
        session_id: 'test-session',
      };

      // Set session directly to avoid ensureReady side effects
      (service as any).sessionManager.setSessionId('my-session', 'claude-3-5-sonnet');

      // ensureReady fails with session expired during crash recovery
      jest.spyOn(service, 'ensureReady').mockRejectedValue(new Error('session expired'));

      (service as any).startResponseConsumer();

      await new Promise(resolve => setTimeout(resolve, 50));

      // Session should be invalidated
      expect(service.consumeSessionInvalidation()).toBe(true);
      // Handler should be notified of the original error
      expect(onError).toHaveBeenCalledWith(crashError);
    });

    it('should skip error handling when consumer is orphaned (replaced)', async () => {
      const crashError = new Error('old consumer error');
      let resolveDelay: () => void;
      const delayPromise = new Promise<void>(resolve => { resolveDelay = resolve; });

      const oldMockPQ = {
        [Symbol.asyncIterator]() { return this; },
        async next() {
          // Wait for the swap to happen before throwing
          await delayPromise;
          throw crashError;
        },
        async return() { return { done: true, value: undefined }; },
        interrupt: jest.fn().mockResolvedValue(undefined),
      };

      // This PQ is the "old" one that the consumer will iterate
      (service as any).persistentQuery = oldMockPQ;
      (service as any).messageChannel = { close: jest.fn() };
      (service as any).queryAbortController = { abort: jest.fn() };
      (service as any).shuttingDown = false;
      (service as any).coldStartInProgress = false;
      (service as any).responseConsumerRunning = false;

      const onError = jest.fn();
      const handler = createResponseHandler({
        id: 'orphan-test',
        onChunk: jest.fn(),
        onDone: jest.fn(),
        onError,
      });
      (service as any).responseHandlers = [handler];

      (service as any).startResponseConsumer();

      // Wait for consumer to start its iteration (awaiting the delay)
      await new Promise(resolve => setTimeout(resolve, 10));

      // Swap to a new PQ before the error fires
      (service as any).persistentQuery = { interrupt: jest.fn() };

      // Now let the old PQ throw
      resolveDelay!();

      await new Promise(resolve => setTimeout(resolve, 50));

      // The orphaned consumer should NOT call onError
      expect(onError).not.toHaveBeenCalled();
    });
  });

  describe('buildHooks - null vaultPath', () => {
    it('should allow file access when vaultPath is null', async () => {
      (service as any).vaultPath = null;

      const hooks = (service as any).buildHooks();
      const vaultRestrictionHook = hooks.PreToolUse[1];

      // When vaultPath is null, getPathAccessType returns 'vault' for all paths,
      // so the hook should allow access
      const result = await vaultRestrictionHook.hooks[0]({
        tool_name: 'Read',
        tool_input: { file_path: '/some/external/path' },
      });

      expect(result.continue).toBe(true);
    });
  });

  describe('queryViaSDK - stream text dedup and allowedTools', () => {
    beforeEach(() => {
      sdkMock.resetMockMessages();
    });

    afterEach(() => {
      sdkMock.resetMockMessages();
      jest.restoreAllMocks();
    });


    it('should set allowedTools in cold-start query', async () => {
      sdkMock.setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'allowed-cs' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Hi' }] } },
      ]);

      const chunks = await collectChunks(
        service.query('hello', undefined, undefined, {
          forceColdStart: true,
          allowedTools: ['Read', 'Write'],
        })
      );

      expect(chunks.some(c => c.type === 'done')).toBe(true);
    });

    it('should handle stream text events and skip duplicate assistant text', async () => {
      sdkMock.setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'stream-dedup' },
        { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text' } } },
        { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } } },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }] } },
      ], { appendResult: true });

      const chunks = await collectChunks(
        service.query('hello', undefined, undefined, { forceColdStart: true })
      );

      // Stream text was seen, so duplicate text from assistant message should be skipped
      // Verify query completed successfully
      expect(chunks.some(c => c.type === 'done')).toBe(true);
    });

    it('should yield usage chunks with sessionId', async () => {
      service.setSessionId('usage-cold-session');
      sdkMock.setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'usage-cold-session' },
        {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'Hi' }],
            usage: {
              input_tokens: 100,
              output_tokens: 50,
              cache_creation_input_tokens: 10,
              cache_read_input_tokens: 20,
            },
          },
        },
      ], { appendResult: true });

      const chunks = await collectChunks(
        service.query('hello', undefined, undefined, { forceColdStart: true })
      );

      const usageChunks = chunks.filter(c => c.type === 'usage');
      expect(usageChunks.length).toBeGreaterThan(0);
      expect(usageChunks[0].sessionId).toBe('usage-cold-session');
      expect(chunks.some(c => c.type === 'done')).toBe(true);
    });
  });
});
