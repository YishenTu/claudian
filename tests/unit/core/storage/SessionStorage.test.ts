import type { ProviderId } from '@/core/providers/types';
import type { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';
import type { Conversation, SessionMetadata, UsageInfo } from '@/core/types';
import { SESSIONS_PATH, SessionStorage } from '@/providers/claude/storage/SessionStorage';

describe('SessionStorage', () => {
  let mockAdapter: jest.Mocked<VaultFileAdapter>;
  let storage: SessionStorage;

  beforeEach(() => {
    mockAdapter = {
      exists: jest.fn(),
      read: jest.fn(),
      write: jest.fn(),
      delete: jest.fn(),
      listFiles: jest.fn(),
    } as unknown as jest.Mocked<VaultFileAdapter>;

    storage = new SessionStorage(mockAdapter);
  });

  describe('SESSIONS_PATH', () => {
    it('should be .claude/sessions', () => {
      expect(SESSIONS_PATH).toBe('.claude/sessions');
    });
  });

  describe('getMetadataPath', () => {
    it('returns correct file path for session id', () => {
      const path = storage.getMetadataPath('session-abc');
      expect(path).toBe('.claude/sessions/session-abc.meta.json');
    });
  });

  describe('saveMetadata', () => {
    it('serializes metadata to JSON and writes to file', async () => {
      const metadata: SessionMetadata = {
        id: 'session-456',
        title: 'Test Session',
        createdAt: 1700000000,
        updatedAt: 1700001000,
        lastResponseAt: 1700000900,
        currentNote: 'notes/test.md',
        titleGenerationStatus: 'success',
      };

      await storage.saveMetadata(metadata);

      expect(mockAdapter.write).toHaveBeenCalledWith(
        '.claude/sessions/session-456.meta.json',
        expect.any(String)
      );

      const writtenContent = mockAdapter.write.mock.calls[0][1];
      const parsed = JSON.parse(writtenContent);

      expect(parsed.id).toBe('session-456');
      expect(parsed.title).toBe('Test Session');
      expect(parsed.lastResponseAt).toBe(1700000900);
      expect(parsed.titleGenerationStatus).toBe('success');
    });

    it('preserves all optional fields', async () => {
      const usage: UsageInfo = {
        model: 'claude-sonnet-4-5',
        inputTokens: 1000,
        cacheCreationInputTokens: 500,
        cacheReadInputTokens: 200,
        contextWindow: 200000,
        contextTokens: 1700,
        percentage: 1,
      };

      const metadata: SessionMetadata = {
        id: 'session-full',
        title: 'Full Test',
        createdAt: 1700000000,
        updatedAt: 1700001000,
        externalContextPaths: ['/path/to/external'],
        enabledMcpServers: ['server1', 'server2'],
        usage,
      };

      await storage.saveMetadata(metadata);

      const writtenContent = mockAdapter.write.mock.calls[0][1];
      const parsed = JSON.parse(writtenContent);

      expect(parsed.externalContextPaths).toEqual(['/path/to/external']);
      expect(parsed.enabledMcpServers).toEqual(['server1', 'server2']);
      expect(parsed.usage).toEqual(usage);
    });
  });

  describe('loadMetadata', () => {
    it('returns null if file does not exist', async () => {
      mockAdapter.exists.mockResolvedValue(false);

      const result = await storage.loadMetadata('session-123');

      expect(result).toBeNull();
    });

    it('loads and parses metadata from JSON file', async () => {
      const metadata = {
        id: 'session-abc',
        title: 'Loaded Session',
        createdAt: 1700000000,
        updatedAt: 1700001000,
        titleGenerationStatus: 'pending',
      };

      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify(metadata));

      const result = await storage.loadMetadata('session-abc');

      expect(result).toEqual({ ...metadata, providerId: 'claude' });
    });

    it('preserves explicit providerId on load', async () => {
      const metadata = {
        id: 'session-codex',
        providerId: 'codex',
        title: 'Codex Session',
        createdAt: 1700000000,
        updatedAt: 1700001000,
      };

      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify(metadata));

      const result = await storage.loadMetadata('session-codex');

      expect(result!.providerId).toBe('codex');
    });

    it('returns null on parse error', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue('invalid json');

      const result = await storage.loadMetadata('session-bad');

      expect(result).toBeNull();
    });

    it('returns null on read error', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockRejectedValue(new Error('Read error'));

      const result = await storage.loadMetadata('session-error');

      expect(result).toBeNull();
    });
  });

  describe('metadata migration', () => {
    it('migrates legacy top-level providerSessionId into providerState', async () => {
      const legacy = {
        id: 'session-legacy-1',
        title: 'Legacy Session',
        createdAt: 1700000000,
        updatedAt: 1700001000,
        providerSessionId: 'sdk-session-abc',
      };

      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify(legacy));

      const result = await storage.loadMetadata('session-legacy-1');

      expect(result!.providerId).toBe('claude');
      expect((result!.providerState as any)?.providerSessionId).toBe('sdk-session-abc');
      expect(result).not.toHaveProperty('providerSessionId');
    });

    it('migrates legacy top-level previousProviderSessionIds into providerState', async () => {
      const legacy = {
        id: 'session-legacy-2',
        title: 'Legacy Session',
        createdAt: 1700000000,
        updatedAt: 1700001000,
        previousProviderSessionIds: ['old-1', 'old-2'],
      };

      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify(legacy));

      const result = await storage.loadMetadata('session-legacy-2');

      expect((result!.providerState as any)?.previousProviderSessionIds).toEqual(['old-1', 'old-2']);
      expect(result).not.toHaveProperty('previousProviderSessionIds');
    });

    it('migrates legacy top-level forkSource into providerState', async () => {
      const legacy = {
        id: 'session-legacy-fork',
        title: 'Legacy Fork',
        createdAt: 1700000000,
        updatedAt: 1700001000,
        forkSource: { sessionId: 'parent-session', resumeAt: 'msg-uuid-123' },
      };

      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify(legacy));

      const result = await storage.loadMetadata('session-legacy-fork');

      expect((result!.providerState as any)?.forkSource).toEqual({
        sessionId: 'parent-session',
        resumeAt: 'msg-uuid-123',
      });
      expect(result).not.toHaveProperty('forkSource');
    });

    it('migrates legacy top-level subagentData into providerState', async () => {
      const legacy = {
        id: 'session-legacy-subagent',
        title: 'Legacy Subagent',
        createdAt: 1700000000,
        updatedAt: 1700001000,
        subagentData: {
          'task-1': { id: 'task-1', description: 'Run tests', status: 'completed', isExpanded: false, toolCalls: [] },
        },
      };

      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify(legacy));

      const result = await storage.loadMetadata('session-legacy-subagent');

      expect((result!.providerState as any)?.subagentData['task-1'].id).toBe('task-1');
      expect(result).not.toHaveProperty('subagentData');
    });

    it('migrates all legacy fields together', async () => {
      const legacy = {
        id: 'session-legacy-all',
        title: 'Full Legacy',
        createdAt: 1700000000,
        updatedAt: 1700001000,
        providerSessionId: 'sdk-session-xyz',
        previousProviderSessionIds: ['old-session'],
        forkSource: { sessionId: 'source', resumeAt: 'uuid' },
        subagentData: { 't1': { id: 't1', description: 'Task', status: 'completed' as const, isExpanded: false, toolCalls: [] } },
      };

      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify(legacy));

      const result = await storage.loadMetadata('session-legacy-all');

      expect(result!.providerId).toBe('claude');
      const ps = result!.providerState as any;
      expect(ps.providerSessionId).toBe('sdk-session-xyz');
      expect(ps.previousProviderSessionIds).toEqual(['old-session']);
      expect(ps.forkSource).toEqual({ sessionId: 'source', resumeAt: 'uuid' });
      expect(ps.subagentData.t1.id).toBe('t1');

      // Legacy fields must be cleaned from the top level
      expect(result).not.toHaveProperty('providerSessionId');
      expect(result).not.toHaveProperty('previousProviderSessionIds');
      expect(result).not.toHaveProperty('forkSource');
      expect(result).not.toHaveProperty('subagentData');
    });

    it('does not overwrite existing providerState with legacy fields', async () => {
      const metadata = {
        id: 'session-mixed',
        title: 'Mixed Session',
        createdAt: 1700000000,
        updatedAt: 1700001000,
        providerId: 'claude',
        providerState: { providerSessionId: 'new-session' },
        providerSessionId: 'old-session',
      };

      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify(metadata));

      const result = await storage.loadMetadata('session-mixed');

      // Existing providerState wins over legacy fields
      expect((result!.providerState as any)?.providerSessionId).toBe('new-session');
    });

    it('migrates legacy fields during listMetadata', async () => {
      mockAdapter.listFiles.mockResolvedValue([
        '.claude/sessions/legacy.meta.json',
      ]);

      mockAdapter.read.mockResolvedValue(JSON.stringify({
        id: 'legacy',
        title: 'Legacy',
        createdAt: 1700000000,
        updatedAt: 1700001000,
        providerSessionId: 'old-sdk-session',
      }));

      const metas = await storage.listMetadata();

      expect(metas).toHaveLength(1);
      expect(metas[0].providerId).toBe('claude');
      expect((metas[0].providerState as any)?.providerSessionId).toBe('old-sdk-session');
      expect(metas[0]).not.toHaveProperty('providerSessionId');
    });
  });

  describe('listAllConversations - provider routing', () => {
    it('preserves providerId from metadata', async () => {
      mockAdapter.listFiles.mockResolvedValue([
        '.claude/sessions/claude-session.meta.json',
        '.claude/sessions/codex-session.meta.json',
      ]);

      mockAdapter.read.mockImplementation((path: string) => {
        if (path.includes('claude-session')) {
          return Promise.resolve(JSON.stringify({
            id: 'claude-session',
            providerId: 'claude',
            title: 'Claude Session',
            createdAt: 1700000000,
            updatedAt: 1700001000,
          }));
        }
        if (path.includes('codex-session')) {
          return Promise.resolve(JSON.stringify({
            id: 'codex-session',
            providerId: 'codex',
            title: 'Codex Session',
            createdAt: 1700000000,
            updatedAt: 1700002000,
          }));
        }
        return Promise.resolve('{}');
      });

      const metas = await storage.listAllConversations();

      expect(metas).toHaveLength(2);
      const claudeMeta = metas.find(m => m.id === 'claude-session');
      const codexMeta = metas.find(m => m.id === 'codex-session');
      expect(claudeMeta!.providerId).toBe('claude');
      expect(codexMeta!.providerId).toBe('codex');
    });

    it('defaults providerId to claude for legacy conversations', async () => {
      mockAdapter.listFiles.mockResolvedValue([
        '.claude/sessions/old.meta.json',
      ]);

      mockAdapter.read.mockResolvedValue(JSON.stringify({
        id: 'old',
        title: 'Old Session',
        createdAt: 1700000000,
        updatedAt: 1700001000,
      }));

      const metas = await storage.listAllConversations();

      expect(metas).toHaveLength(1);
      expect(metas[0].providerId).toBe('claude');
    });
  });

  describe('toSessionMetadata - round trip', () => {
    it('round-trips providerState through save and load', async () => {
      const conversation: Conversation = {
        id: 'conv-roundtrip',
        providerId: 'claude' as ProviderId,
        title: 'Round Trip Test',
        createdAt: 1700000000,
        updatedAt: 1700001000,
        sessionId: 'sdk-session',
        providerState: {
          providerSessionId: 'active-session',
          forkSource: { sessionId: 'parent', resumeAt: 'uuid-456' },
        },
        messages: [],
      };

      const metadata = storage.toSessionMetadata(conversation);
      await storage.saveMetadata(metadata);

      // Simulate loading back what was saved
      const writtenContent = mockAdapter.write.mock.calls[0][1];
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(writtenContent);

      const loaded = await storage.loadMetadata('conv-roundtrip');

      expect(loaded!.providerId).toBe('claude');
      expect((loaded!.providerState as any)?.providerSessionId).toBe('active-session');
      expect((loaded!.providerState as any)?.forkSource).toEqual({
        sessionId: 'parent',
        resumeAt: 'uuid-456',
      });
    });

    it('round-trips non-Claude providerId', async () => {
      const conversation: Conversation = {
        id: 'conv-codex-rt',
        providerId: 'codex' as ProviderId,
        title: 'Codex Round Trip',
        createdAt: 1700000000,
        updatedAt: 1700001000,
        sessionId: 'codex-session',
        providerState: { codexSpecific: 'data' },
        messages: [],
      };

      const metadata = storage.toSessionMetadata(conversation);
      await storage.saveMetadata(metadata);

      const writtenContent = mockAdapter.write.mock.calls[0][1];
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(writtenContent);

      const loaded = await storage.loadMetadata('conv-codex-rt');

      expect(loaded!.providerId).toBe('codex');
      expect((loaded!.providerState as any)?.codexSpecific).toBe('data');
    });
  });

  describe('deleteMetadata', () => {
    it('deletes the meta.json file', async () => {
      await storage.deleteMetadata('session-del');

      expect(mockAdapter.delete).toHaveBeenCalledWith('.claude/sessions/session-del.meta.json');
    });
  });

  describe('listMetadata', () => {
    it('returns metadata for .meta.json files', async () => {
      mockAdapter.listFiles.mockResolvedValue([
        '.claude/sessions/native-1.meta.json',
        '.claude/sessions/native-2.meta.json',
      ]);

      mockAdapter.read.mockImplementation((path: string) => {
        if (path.includes('native-1')) {
          return Promise.resolve(JSON.stringify({
            id: 'native-1',
            title: 'Native One',
            createdAt: 1700000000,
            updatedAt: 1700002000,
          }));
        }
        if (path.includes('native-2')) {
          return Promise.resolve(JSON.stringify({
            id: 'native-2',
            title: 'Native Two',
            createdAt: 1700000000,
            updatedAt: 1700001000,
          }));
        }
        return Promise.resolve('{}');
      });

      const metas = await storage.listMetadata();

      expect(metas).toHaveLength(2);
      expect(metas.map(m => m.id)).toContain('native-1');
      expect(metas.map(m => m.id)).toContain('native-2');
    });

    it('handles empty sessions directory', async () => {
      mockAdapter.listFiles.mockResolvedValue([]);

      const metas = await storage.listMetadata();

      expect(metas).toEqual([]);
    });

    it('handles listFiles error gracefully', async () => {
      mockAdapter.listFiles.mockRejectedValue(new Error('List error'));

      const metas = await storage.listMetadata();

      expect(metas).toEqual([]);
    });

    it('skips files that fail to load', async () => {
      mockAdapter.listFiles.mockResolvedValue([
        '.claude/sessions/good.meta.json',
        '.claude/sessions/bad.meta.json',
      ]);

      mockAdapter.read.mockImplementation((path: string) => {
        if (path.includes('good')) {
          return Promise.resolve(JSON.stringify({
            id: 'good',
            title: 'Good',
            createdAt: 1700000000,
            updatedAt: 1700001000,
          }));
        }
        return Promise.reject(new Error('Read error'));
      });

      const metas = await storage.listMetadata();

      expect(metas).toHaveLength(1);
      expect(metas[0].id).toBe('good');
    });
  });

  describe('listAllConversations', () => {
    it('returns metadata from listMetadata as ConversationMeta[]', async () => {
      mockAdapter.listFiles.mockResolvedValue([
        '.claude/sessions/session-1.meta.json',
        '.claude/sessions/session-2.meta.json',
      ]);

      mockAdapter.read.mockImplementation((path: string) => {
        if (path.includes('session-1')) {
          return Promise.resolve(JSON.stringify({
            id: 'session-1',
            title: 'Session One',
            createdAt: 1700000000,
            updatedAt: 1700001000,
            lastResponseAt: 1700000900,
          }));
        }
        if (path.includes('session-2')) {
          return Promise.resolve(JSON.stringify({
            id: 'session-2',
            title: 'Session Two',
            createdAt: 1700000000,
            updatedAt: 1700002000,
            lastResponseAt: 1700001500,
          }));
        }
        return Promise.resolve('{}');
      });

      const metas = await storage.listAllConversations();

      expect(metas).toHaveLength(2);

      // Should be sorted by lastResponseAt descending
      expect(metas[0].id).toBe('session-2');
      expect(metas[1].id).toBe('session-1');

      // Each entry should have SDK session defaults
      expect(metas[0].preview).toBe('SDK session');
      expect(metas[0].messageCount).toBe(0);
      expect(metas[1].preview).toBe('SDK session');
      expect(metas[1].messageCount).toBe(0);
    });

    it('returns empty array when no metadata exists', async () => {
      mockAdapter.listFiles.mockResolvedValue([]);

      const metas = await storage.listAllConversations();

      expect(metas).toEqual([]);
    });

    it('preserves titleGenerationStatus', async () => {
      mockAdapter.listFiles.mockResolvedValue([
        '.claude/sessions/session-status.meta.json',
      ]);

      mockAdapter.read.mockResolvedValue(JSON.stringify({
        id: 'session-status',
        title: 'Status Test',
        createdAt: 1700000000,
        updatedAt: 1700001000,
        titleGenerationStatus: 'failed',
      }));

      const metas = await storage.listAllConversations();

      expect(metas).toHaveLength(1);
      expect(metas[0].titleGenerationStatus).toBe('failed');
    });
  });

  describe('toSessionMetadata - extractSubagentData', () => {
    it('extracts subagent data from Task toolCalls', () => {
      const conversation: Conversation = {
        id: 'conv-subagent',
        providerId: 'claude' as ProviderId,
        title: 'Subagent Test',
        createdAt: 1700000000,
        updatedAt: 1700001000,
        sessionId: 'sdk-session',
        messages: [
          { id: 'msg-1', role: 'user', content: 'Hello', timestamp: 1700000100 },
          {
            id: 'msg-2',
            role: 'assistant',
            content: 'Working...',
            timestamp: 1700000200,
            toolCalls: [
              {
                id: 'task-1',
                name: 'Task',
                input: { description: 'Test subagent' },
                status: 'completed',
                result: 'Done',
                subagent: {
                  id: 'task-1',
                  description: 'Test subagent',
                  isExpanded: false,
                  status: 'completed' as const,
                  toolCalls: [],
                  result: 'Done',
                },
              },
            ],
          },
        ],
      };

      const metadata = storage.toSessionMetadata(conversation);

      expect((metadata.providerState as any)?.subagentData).toBeDefined();
      expect((metadata.providerState as any)?.subagentData['task-1']).toEqual(expect.objectContaining({
        id: 'task-1',
        description: 'Test subagent',
        status: 'completed',
      }));
    });

    it('returns undefined subagentData when no subagents present', () => {
      const conversation: Conversation = {
        id: 'conv-no-subagent',
        providerId: 'claude' as ProviderId,
        title: 'No Subagent',
        createdAt: 1700000000,
        updatedAt: 1700001000,
        sessionId: null,
        messages: [
          { id: 'msg-1', role: 'user', content: 'Hello', timestamp: 1700000100 },
          { id: 'msg-2', role: 'assistant', content: 'Hi!', timestamp: 1700000200 },
        ],
      };

      const metadata = storage.toSessionMetadata(conversation);

      expect((metadata.providerState as any)?.subagentData).toBeUndefined();
    });

    it('ignores Task toolCalls without linked subagent', () => {
      const conversation: Conversation = {
        id: 'conv-task-subagent',
        providerId: 'claude' as ProviderId,
        title: 'Task Subagent Test',
        createdAt: 1700000000,
        updatedAt: 1700001000,
        sessionId: 'sdk-session',
        messages: [
          {
            id: 'msg-1',
            role: 'assistant',
            content: '',
            timestamp: 1700000200,
            toolCalls: [
              {
                id: 'task-1',
                name: 'Task',
                input: { description: 'Background task', run_in_background: true },
                status: 'completed',
                result: 'Task running',
              } as any,
            ],
          },
        ],
      };

      const metadata = storage.toSessionMetadata(conversation);

      expect((metadata.providerState as any)?.subagentData).toBeUndefined();
    });
  });

  describe('toSessionMetadata - resumeAtMessageId', () => {
    it('includes resumeAtMessageId when set', () => {
      const conversation: Conversation = {
        id: 'conv-rewind',
        providerId: 'claude' as ProviderId,
        title: 'Rewind Test',
        createdAt: 1700000000,
        updatedAt: 1700001000,
        sessionId: 'sdk-session',
        messages: [],
        resumeAtMessageId: 'assistant-uuid-123',
      };

      const metadata = storage.toSessionMetadata(conversation);

      expect(metadata.resumeAtMessageId).toBe('assistant-uuid-123');
    });

    it('omits resumeAtMessageId when not set', () => {
      const conversation: Conversation = {
        id: 'conv-no-rewind',
        providerId: 'claude' as ProviderId,
        title: 'No Rewind',
        createdAt: 1700000000,
        updatedAt: 1700001000,
        sessionId: null,
        messages: [],
      };

      const metadata = storage.toSessionMetadata(conversation);

      expect(metadata.resumeAtMessageId).toBeUndefined();
    });
  });

  describe('toSessionMetadata', () => {
    it('converts Conversation to SessionMetadata', () => {
      const usage: UsageInfo = {
        model: 'claude-opus-4-5',
        inputTokens: 5000,
        cacheCreationInputTokens: 1000,
        cacheReadInputTokens: 500,
        contextWindow: 200000,
        contextTokens: 6500,
        percentage: 3,
      };

      const conversation: Conversation = {
        id: 'conv-convert',
        providerId: 'claude' as ProviderId,
        title: 'Convert Test',
        createdAt: 1700000000,
        updatedAt: 1700001000,
        lastResponseAt: 1700000900,
        sessionId: 'sdk-session',
        providerState: { providerSessionId: 'current-sdk-session' },
        messages: [
          { id: 'msg-1', role: 'user', content: 'Hello', timestamp: 1700000100 },
        ],
        currentNote: 'notes/test.md',
        externalContextPaths: ['/external/path'],
        enabledMcpServers: ['mcp-server'],
        usage,
        titleGenerationStatus: 'success',
      };

      const metadata = storage.toSessionMetadata(conversation);

      expect(metadata.id).toBe('conv-convert');
      expect(metadata.title).toBe('Convert Test');
      expect(metadata.createdAt).toBe(1700000000);
      expect(metadata.updatedAt).toBe(1700001000);
      expect(metadata.lastResponseAt).toBe(1700000900);
      expect(metadata.sessionId).toBe('sdk-session');
      expect((metadata.providerState as any)?.providerSessionId).toBe('current-sdk-session');
      expect(metadata.currentNote).toBe('notes/test.md');
      expect(metadata.externalContextPaths).toEqual(['/external/path']);
      expect(metadata.enabledMcpServers).toEqual(['mcp-server']);
      expect(metadata.usage).toEqual(usage);
      expect(metadata.titleGenerationStatus).toBe('success');

      // Should not include messages
      expect(metadata).not.toHaveProperty('messages');
    });

    it('includes forkSource when set', () => {
      const conversation: Conversation = {
        id: 'conv-fork',
        providerId: 'claude' as ProviderId,
        title: 'Fork Test',
        createdAt: 1700000000,
        updatedAt: 1700001000,
        sessionId: null,
        messages: [],
        providerState: { forkSource: { sessionId: 'source-session-abc', resumeAt: 'asst-uuid-xyz' } },
      };

      const metadata = storage.toSessionMetadata(conversation);

      expect((metadata.providerState as any)?.forkSource).toEqual({
        sessionId: 'source-session-abc',
        resumeAt: 'asst-uuid-xyz',
      });
    });

    it('omits forkSource when not set', () => {
      const conversation: Conversation = {
        id: 'conv-no-fork',
        providerId: 'claude' as ProviderId,
        title: 'No Fork',
        createdAt: 1700000000,
        updatedAt: 1700001000,
        sessionId: 'sdk-session',
        messages: [],
      };

      const metadata = storage.toSessionMetadata(conversation);

      expect((metadata.providerState as any)?.forkSource).toBeUndefined();
    });
  });
});
