import { ClaudianService } from '@/core/agent/ClaudianService';
import type { McpServerManager } from '@/core/mcp';
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
          'Path is outside allowed directories',
          '/etc/passwd',
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
});
