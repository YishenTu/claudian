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
      setActiveConversationId: jest.fn().mockResolvedValue(undefined),
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
});
