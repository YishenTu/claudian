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

    it('should restart persistent query via ensureReady with force', async () => {
      service.setSessionId('test-session');

      const startPersistentQuerySpy = jest.spyOn(service as any, 'startPersistentQuery');
      startPersistentQuerySpy.mockResolvedValue(undefined);

      await service.ensureReady({ force: true });

      expect(startPersistentQuerySpy).toHaveBeenCalled();
    });

    it('should return false (no-op) when config unchanged and query running', async () => {
      // Setup: simulate running query with current config
      const startPersistentQuerySpy = jest.spyOn(service as any, 'startPersistentQuery');
      const buildConfigSpy = jest.spyOn(service as any, 'buildPersistentQueryConfig');
      const needsRestartSpy = jest.spyOn(service as any, 'needsRestart');

      const mockConfig = { model: 'test', externalContextPaths: [] };
      buildConfigSpy.mockReturnValue(mockConfig);
      needsRestartSpy.mockReturnValue(false);

      startPersistentQuerySpy.mockImplementation(async () => {
        // Simulate that query is now running
        (service as any).persistentQuery = {};
        (service as any).currentConfig = mockConfig;
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
      const closePersistentQuerySpy = jest.spyOn(service as any, 'closePersistentQuery');
      const buildConfigSpy = jest.spyOn(service as any, 'buildPersistentQueryConfig');
      const needsRestartSpy = jest.spyOn(service as any, 'needsRestart');

      const mockConfig = { model: 'test', externalContextPaths: [] };
      buildConfigSpy.mockReturnValue(mockConfig);

      // needsRestart is only called when query is already running (Case 3)
      // Return true to trigger restart on config change
      needsRestartSpy.mockReturnValue(true);

      startPersistentQuerySpy.mockImplementation(async () => {
        (service as any).persistentQuery = {};
      });

      closePersistentQuerySpy.mockImplementation(() => {
        (service as any).persistentQuery = null;
      });

      // First call starts with no external paths (Case 1: not running)
      await service.ensureReady({ externalContextPaths: [] });
      expect(startPersistentQuerySpy).toHaveBeenCalledTimes(1);

      // Second call: query is running, needsRestart returns true → restart
      const result = await service.ensureReady({ externalContextPaths: ['/new/path'] });
      expect(result).toBe(true);
      expect(closePersistentQuerySpy).toHaveBeenCalledWith('config changed', { preserveHandlers: undefined });
      expect(startPersistentQuerySpy).toHaveBeenCalledTimes(2);
    });

    it('should pass preserveHandlers: true to closePersistentQuery on force restart', async () => {
      const startPersistentQuerySpy = jest.spyOn(service as any, 'startPersistentQuery');
      const closePersistentQuerySpy = jest.spyOn(service as any, 'closePersistentQuery');

      startPersistentQuerySpy.mockImplementation(async () => {
        (service as any).persistentQuery = {};
      });

      closePersistentQuerySpy.mockImplementation(() => {
        (service as any).persistentQuery = null;
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
      const closePersistentQuerySpy = jest.spyOn(service as any, 'closePersistentQuery');
      const buildConfigSpy = jest.spyOn(service as any, 'buildPersistentQueryConfig');
      const needsRestartSpy = jest.spyOn(service as any, 'needsRestart');

      const mockConfig = { model: 'test', externalContextPaths: [] };
      buildConfigSpy.mockReturnValue(mockConfig);
      needsRestartSpy.mockReturnValue(true);

      startPersistentQuerySpy.mockImplementation(async () => {
        (service as any).persistentQuery = {};
      });

      closePersistentQuerySpy.mockImplementation(() => {
        (service as any).persistentQuery = null;
      });

      // Start the query first
      await service.ensureReady({ externalContextPaths: [] });

      // Config change with preserveHandlers: true
      await service.ensureReady({ externalContextPaths: ['/new/path'], preserveHandlers: true });

      expect(closePersistentQuerySpy).toHaveBeenCalledWith('config changed', { preserveHandlers: true });
    });

    it('should return false when CLI unavailable after force close', async () => {
      const startPersistentQuerySpy = jest.spyOn(service as any, 'startPersistentQuery');
      const closePersistentQuerySpy = jest.spyOn(service as any, 'closePersistentQuery');

      startPersistentQuerySpy.mockImplementation(async () => {
        (service as any).persistentQuery = {};
      });

      closePersistentQuerySpy.mockImplementation(() => {
        (service as any).persistentQuery = null;
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
      const closePersistentQuerySpy = jest.spyOn(service as any, 'closePersistentQuery');
      const buildConfigSpy = jest.spyOn(service as any, 'buildPersistentQueryConfig');
      const needsRestartSpy = jest.spyOn(service as any, 'needsRestart');

      const mockConfig = { model: 'test', externalContextPaths: [] };
      buildConfigSpy.mockReturnValue(mockConfig);

      // needsRestart returns true to trigger config change restart
      needsRestartSpy.mockReturnValue(true);

      startPersistentQuerySpy.mockImplementation(async () => {
        (service as any).persistentQuery = {};
      });

      closePersistentQuerySpy.mockImplementation(() => {
        (service as any).persistentQuery = null;
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

});
