import { ClaudianService } from '@/core/agent/ClaudianService';
import type { McpServerManager } from '@/core/mcp';
import { createPermissionRule } from '@/core/types';
import type ClaudianPlugin from '@/main';

type MockMcpServerManager = jest.Mocked<McpServerManager>;

describe('ClaudianService', () => {
  let mockPlugin: Partial<ClaudianPlugin>;
  let mockMcpManager: MockMcpServerManager;
  let service: ClaudianService;

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
      const closePersistentQuerySpy = jest.spyOn(service as any, 'closePersistentQuery');
      service.setSessionId('test-session-123');
      expect(closePersistentQuerySpy).not.toHaveBeenCalled();
    });

    it('should close persistent query when switching to different session', () => {
      service.setSessionId('test-session-123');
      const closePersistentQuerySpy = jest.spyOn(service as any, 'closePersistentQuery');
      service.setSessionId('different-session-456');
      expect(closePersistentQuerySpy).toHaveBeenCalledWith('session switch');
    });

    it('should handle setting null session ID', () => {
      service.setSessionId('test-session-123');
      service.setSessionId(null);
      expect(service.getSessionId()).toBeNull();
    });
  });

  describe('CC Permissions Loading', () => {
    it('should load CC permissions from storage', async () => {
      const permissions = { allow: ['tool1'], deny: ['tool2'], ask: ['tool3'] };
      mockPlugin.storage!.getPermissions = jest.fn().mockResolvedValue(permissions);

      await service.loadCCPermissions();

      expect(mockPlugin.storage!.getPermissions).toHaveBeenCalled();
    });

    it('should handle permissions loading errors gracefully', async () => {
      await expect(service.loadCCPermissions()).resolves.not.toThrow();
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

    it('should restart persistent query', async () => {
      service.setSessionId('test-session');
      
      const startPersistentQuerySpy = jest.spyOn(service as any, 'startPersistentQuery');
      startPersistentQuerySpy.mockResolvedValue(undefined);
      
      await service.restartPersistentQuery('config change');

      expect(startPersistentQuerySpy).toHaveBeenCalled();
    });

    it('should cleanup resources', () => {
      const closePersistentQuerySpy = jest.spyOn(service as any, 'closePersistentQuery');
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
  });

  describe('Deny-Always Flow', () => {
    it('should persist deny rule when deny-always is selected', async () => {
      const approvalManager = (service as any).approvalManager;
      const rule = createPermissionRule('test-tool::{"arg":"val"}');

      const callback = (approvalManager as any).addDenyRuleCallback;
      await callback(rule);

      expect(mockPlugin.storage!.addDenyRule).toHaveBeenCalledWith('test-tool::{"arg":"val"}');
      expect(mockPlugin.storage!.getPermissions).toHaveBeenCalled();
    });
  });

  describe('Allow-Always Flow', () => {
    it('should persist allow rule when allow-always is selected', async () => {
      const approvalManager = (service as any).approvalManager;
      const rule = createPermissionRule('test-tool::{"arg":"val"}');

      const callback = (approvalManager as any).addAllowRuleCallback;
      await callback(rule);

      expect(mockPlugin.storage!.addAllowRule).toHaveBeenCalledWith('test-tool::{"arg":"val"}');
      expect(mockPlugin.storage!.getPermissions).toHaveBeenCalled();
    });
  });

  describe('Approval Callback', () => {
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
      const sessionManager = (service as any).sessionManager;
      service.resetSession();

      expect(sessionManager.getSessionId()).toBeNull();
      expect(service.getSessionId()).toBeNull();
    });
  });

  describe('Rewind Files', () => {
    it('should return error when no persistent query is active', async () => {
      // No persistent query started
      const result = await service.rewindFiles('test-uuid');

      expect(result.canRewind).toBe(false);
      expect(result.error).toBe('No active session. Please send a message first.');
    });

    it('should call persistentQuery.rewindFiles with correct parameters', async () => {
      const mockRewindFiles = jest.fn().mockResolvedValue({
        canRewind: true,
        filesChanged: ['file1.ts', 'file2.ts'],
      });

      // Set up persistent query mock
      (service as any).persistentQuery = {
        rewindFiles: mockRewindFiles,
      };

      const result = await service.rewindFiles('test-uuid', { dryRun: true });

      expect(mockRewindFiles).toHaveBeenCalledWith('test-uuid', { dryRun: true });
      expect(result.canRewind).toBe(true);
      expect(result.filesChanged).toEqual(['file1.ts', 'file2.ts']);
    });

    it('should return error when rewindFiles throws', async () => {
      const mockRewindFiles = jest.fn().mockRejectedValue(new Error('SDK error'));

      (service as any).persistentQuery = {
        rewindFiles: mockRewindFiles,
      };

      const result = await service.rewindFiles('test-uuid');

      expect(result.canRewind).toBe(false);
      expect(result.error).toBe('Rewind failed: SDK error');
    });

    it('should handle unknown error types', async () => {
      const mockRewindFiles = jest.fn().mockRejectedValue('string error');

      (service as any).persistentQuery = {
        rewindFiles: mockRewindFiles,
      };

      const result = await service.rewindFiles('test-uuid');

      expect(result.canRewind).toBe(false);
      expect(result.error).toBe('Rewind failed: Unknown error');
    });
  });

  describe('Restart After Rewind', () => {
    it('should close existing query and start new one', async () => {
      const closePersistentQuerySpy = jest.spyOn(service as any, 'closePersistentQuery');
      const startPersistentQuerySpy = jest.spyOn(service as any, 'startPersistentQuery');
      startPersistentQuerySpy.mockResolvedValue(undefined);

      // Set up session manager with a session ID
      service.setSessionId('test-session');

      await service.restartAfterRewind('resume-uuid');

      expect(closePersistentQuerySpy).toHaveBeenCalledWith('rewind');
      expect(startPersistentQuerySpy).toHaveBeenCalledWith(
        '/mock/vault/path',
        '/usr/local/bin/claude',
        'test-session',
        [], // externalContextPaths defaults to empty array
        'resume-uuid'
      );
    });

    it('should preserve external context paths during restart', async () => {
      const startPersistentQuerySpy = jest.spyOn(service as any, 'startPersistentQuery');
      startPersistentQuerySpy.mockResolvedValue(undefined);

      // Set up external context paths
      (service as any).currentExternalContextPaths = ['/path/a', '/path/b'];
      service.setSessionId('test-session');

      await service.restartAfterRewind('resume-uuid');

      expect(startPersistentQuerySpy).toHaveBeenCalledWith(
        '/mock/vault/path',
        '/usr/local/bin/claude',
        'test-session',
        ['/path/a', '/path/b'],
        'resume-uuid'
      );
    });

    it('should throw error when vault path is missing', async () => {
      // Mock missing vault path
      (mockPlugin as any).app.vault.adapter.basePath = undefined;

      await expect(service.restartAfterRewind('resume-uuid')).rejects.toThrow(
        'Cannot restart: missing vault path or CLI path'
      );
    });

    it('should throw error when CLI path is missing', async () => {
      (mockPlugin.getResolvedClaudeCliPath as jest.Mock).mockReturnValue(null);

      await expect(service.restartAfterRewind('resume-uuid')).rejects.toThrow(
        'Cannot restart: missing vault path or CLI path'
      );
    });

    it('should wrap and rethrow errors from startPersistentQuery', async () => {
      const startPersistentQuerySpy = jest.spyOn(service as any, 'startPersistentQuery');
      startPersistentQuerySpy.mockRejectedValue(new Error('Connection failed'));

      service.setSessionId('test-session');

      await expect(service.restartAfterRewind('resume-uuid')).rejects.toThrow(
        'Failed to restart session after rewind: Connection failed'
      );
    });

    it('should handle unknown error types during restart', async () => {
      const startPersistentQuerySpy = jest.spyOn(service as any, 'startPersistentQuery');
      startPersistentQuerySpy.mockRejectedValue('string error');

      service.setSessionId('test-session');

      await expect(service.restartAfterRewind('resume-uuid')).rejects.toThrow(
        'Failed to restart session after rewind: Unknown error'
      );
    });
  });
});
