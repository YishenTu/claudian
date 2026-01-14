/**
 * Tests for SessionStorage - Chat session JSONL file management
 */

import { SESSIONS_PATH,SessionStorage } from '@/core/storage/SessionStorage';
import type { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';
import type { Conversation, UsageInfo } from '@/core/types';

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

  describe('getFilePath', () => {
    it('returns correct file path for conversation id', () => {
      const path = storage.getFilePath('conv-123');
      expect(path).toBe('.claude/sessions/conv-123.jsonl');
    });
  });

  describe('loadConversation', () => {
    it('returns null if file does not exist', async () => {
      mockAdapter.exists.mockResolvedValue(false);

      const result = await storage.loadConversation('conv-123');

      expect(result).toBeNull();
      expect(mockAdapter.exists).toHaveBeenCalledWith('.claude/sessions/conv-123.jsonl');
    });

    it('loads and parses conversation from JSONL file', async () => {
      const jsonlContent = [
        '{"type":"meta","id":"conv-123","title":"Test Chat","createdAt":1700000000,"updatedAt":1700001000,"sessionId":"sdk-session"}',
        '{"type":"message","message":{"id":"msg-1","role":"user","content":"Hello","timestamp":1700000100}}',
        '{"type":"message","message":{"id":"msg-2","role":"assistant","content":"Hi!","timestamp":1700000200}}',
      ].join('\n');

      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(jsonlContent);

      const result = await storage.loadConversation('conv-123');

      expect(result).toEqual({
        id: 'conv-123',
        title: 'Test Chat',
        createdAt: 1700000000,
        updatedAt: 1700001000,
        lastResponseAt: undefined,
        sessionId: 'sdk-session',
        messages: [
          { id: 'msg-1', role: 'user', content: 'Hello', timestamp: 1700000100 },
          { id: 'msg-2', role: 'assistant', content: 'Hi!', timestamp: 1700000200 },
        ],
        currentNote: undefined,
        usage: undefined,
        titleGenerationStatus: undefined,
      });
    });

    it('handles CRLF line endings', async () => {
      const jsonlContent = [
        '{"type":"meta","id":"conv-123","title":"Test","createdAt":1700000000,"updatedAt":1700001000,"sessionId":null}',
        '{"type":"message","message":{"id":"msg-1","role":"user","content":"Hello","timestamp":1700000100}}',
      ].join('\r\n');

      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(jsonlContent);

      const result = await storage.loadConversation('conv-123');

      expect(result?.messages).toHaveLength(1);
    });

    it('returns null for empty file', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue('');

      const result = await storage.loadConversation('conv-123');

      expect(result).toBeNull();
    });

    it('returns null if no meta record found', async () => {
      const jsonlContent = '{"type":"message","message":{"id":"msg-1","role":"user","content":"Hello","timestamp":1700000100}}';

      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(jsonlContent);

      const result = await storage.loadConversation('conv-123');

      expect(result).toBeNull();
    });

    it('handles read errors gracefully', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockRejectedValue(new Error('Read error'));


      const result = await storage.loadConversation('conv-123');

      expect(result).toBeNull();

    });

    it('skips invalid JSON lines and continues parsing', async () => {
      const jsonlContent = [
        '{"type":"meta","id":"conv-123","title":"Test","createdAt":1700000000,"updatedAt":1700001000,"sessionId":null}',
        'invalid json line',
        '{"type":"message","message":{"id":"msg-1","role":"user","content":"Hello","timestamp":1700000100}}',
      ].join('\n');

      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(jsonlContent);


      const result = await storage.loadConversation('conv-123');

      expect(result?.messages).toHaveLength(1);

    });

    it('preserves all conversation metadata', async () => {
      const usage: UsageInfo = {
        model: 'claude-sonnet-4-5',
        inputTokens: 1000,
        cacheCreationInputTokens: 500,
        cacheReadInputTokens: 200,
        contextWindow: 200000,
        contextTokens: 1700,
        percentage: 1,
      };

      const jsonlContent = JSON.stringify({
        type: 'meta',
        id: 'conv-123',
        title: 'Full Test',
        createdAt: 1700000000,
        updatedAt: 1700001000,
        lastResponseAt: 1700000900,
        sessionId: 'sdk-session',
        currentNote: 'notes/test.md',
        usage,
        titleGenerationStatus: 'success',
      });

      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(jsonlContent);

      const result = await storage.loadConversation('conv-123');

      expect(result?.currentNote).toBe('notes/test.md');
      expect(result?.usage).toEqual(usage);
      expect(result?.titleGenerationStatus).toBe('success');
      expect(result?.lastResponseAt).toBe(1700000900);
    });
  });

  describe('saveConversation', () => {
    it('serializes conversation to JSONL and writes to file', async () => {
      const conversation: Conversation = {
        id: 'conv-456',
        title: 'Save Test',
        createdAt: 1700000000,
        updatedAt: 1700001000,
        sessionId: 'sdk-session',
        messages: [
          { id: 'msg-1', role: 'user', content: 'Hello', timestamp: 1700000100 },
          { id: 'msg-2', role: 'assistant', content: 'Hi!', timestamp: 1700000200 },
        ],
      };

      await storage.saveConversation(conversation);

      expect(mockAdapter.write).toHaveBeenCalledWith(
        '.claude/sessions/conv-456.jsonl',
        expect.any(String)
      );

      const writtenContent = mockAdapter.write.mock.calls[0][1];
      const lines = writtenContent.split('\n');

      expect(lines).toHaveLength(3);

      const meta = JSON.parse(lines[0]);
      expect(meta.type).toBe('meta');
      expect(meta.id).toBe('conv-456');
      expect(meta.title).toBe('Save Test');

      const msg1 = JSON.parse(lines[1]);
      expect(msg1.type).toBe('message');
      expect(msg1.message.role).toBe('user');

      const msg2 = JSON.parse(lines[2]);
      expect(msg2.type).toBe('message');
      expect(msg2.message.role).toBe('assistant');
    });

    it('strips base64 data from images with cachePath', async () => {
      const conversation: Conversation = {
        id: 'conv-img',
        title: 'Image Test',
        createdAt: 1700000000,
        updatedAt: 1700001000,
        sessionId: null,
        messages: [
          {
            id: 'msg-1',
            role: 'user',
            content: 'Check this image',
            timestamp: 1700000100,
            images: [
              {
                id: 'img-1',
                name: 'test.png',
                data: 'base64encodeddata...',
                mediaType: 'image/png',
                cachePath: '/cache/img-abc.png',
                size: 1024,
                source: 'paste',
              },
            ],
          },
        ],
      };

      await storage.saveConversation(conversation);

      const writtenContent = mockAdapter.write.mock.calls[0][1];
      const lines = writtenContent.split('\n');
      const msgRecord = JSON.parse(lines[1]);

      expect(msgRecord.message.images[0]).not.toHaveProperty('data');
      expect(msgRecord.message.images[0].cachePath).toBe('/cache/img-abc.png');
      expect(msgRecord.message.images[0].mediaType).toBe('image/png');
    });

    it('strips base64 data from images with filePath', async () => {
      const conversation: Conversation = {
        id: 'conv-img2',
        title: 'Image Test 2',
        createdAt: 1700000000,
        updatedAt: 1700001000,
        sessionId: null,
        messages: [
          {
            id: 'msg-1',
            role: 'user',
            content: 'Another image',
            timestamp: 1700000100,
            images: [
              {
                id: 'img-2',
                name: 'photo.jpg',
                data: 'base64encodeddata...',
                mediaType: 'image/jpeg',
                filePath: '/vault/images/photo.jpg',
                size: 2048,
                source: 'file',
              },
            ],
          },
        ],
      };

      await storage.saveConversation(conversation);

      const writtenContent = mockAdapter.write.mock.calls[0][1];
      const lines = writtenContent.split('\n');
      const msgRecord = JSON.parse(lines[1]);

      expect(msgRecord.message.images[0]).not.toHaveProperty('data');
      expect(msgRecord.message.images[0].filePath).toBe('/vault/images/photo.jpg');
    });

    it('preserves base64 data for images without cachePath or filePath', async () => {
      const conversation: Conversation = {
        id: 'conv-img3',
        title: 'Inline Image Test',
        createdAt: 1700000000,
        updatedAt: 1700001000,
        sessionId: null,
        messages: [
          {
            id: 'msg-1',
            role: 'user',
            content: 'Pasted image',
            timestamp: 1700000100,
            images: [
              {
                id: 'img-3',
                name: 'pasted.png',
                data: 'base64encodeddata...',
                mediaType: 'image/png',
                size: 512,
                source: 'paste',
              },
            ],
          },
        ],
      };

      await storage.saveConversation(conversation);

      const writtenContent = mockAdapter.write.mock.calls[0][1];
      const lines = writtenContent.split('\n');
      const msgRecord = JSON.parse(lines[1]);

      expect(msgRecord.message.images[0].data).toBe('base64encodeddata...');
    });

    it('handles messages without images', async () => {
      const conversation: Conversation = {
        id: 'conv-no-img',
        title: 'No Image Test',
        createdAt: 1700000000,
        updatedAt: 1700001000,
        sessionId: null,
        messages: [
          { id: 'msg-1', role: 'user', content: 'Just text', timestamp: 1700000100 },
        ],
      };

      await storage.saveConversation(conversation);

      const writtenContent = mockAdapter.write.mock.calls[0][1];
      const lines = writtenContent.split('\n');
      const msgRecord = JSON.parse(lines[1]);

      expect(msgRecord.message).toEqual({
        id: 'msg-1',
        role: 'user',
        content: 'Just text',
        timestamp: 1700000100,
      });
    });

    it('preserves all metadata fields in serialization', async () => {
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
        id: 'conv-meta',
        title: 'Meta Test',
        createdAt: 1700000000,
        updatedAt: 1700001000,
        lastResponseAt: 1700000900,
        sessionId: 'sdk-session-abc',
        currentNote: 'projects/notes.md',
        usage,
        titleGenerationStatus: 'pending',
        messages: [],
      };

      await storage.saveConversation(conversation);

      const writtenContent = mockAdapter.write.mock.calls[0][1];
      const meta = JSON.parse(writtenContent);

      expect(meta.lastResponseAt).toBe(1700000900);
      expect(meta.currentNote).toBe('projects/notes.md');
      expect(meta.usage).toEqual(usage);
      expect(meta.titleGenerationStatus).toBe('pending');
    });
  });

  describe('deleteConversation', () => {
    it('deletes the JSONL file', async () => {
      await storage.deleteConversation('conv-del');

      expect(mockAdapter.delete).toHaveBeenCalledWith('.claude/sessions/conv-del.jsonl');
    });
  });

  describe('listConversations', () => {
    it('returns metadata for all JSONL files', async () => {
      mockAdapter.listFiles.mockResolvedValue([
        '.claude/sessions/conv-1.jsonl',
        '.claude/sessions/conv-2.jsonl',
        '.claude/sessions/readme.txt', // Should be skipped
      ]);

      mockAdapter.read.mockImplementation((path: string) => {
        if (path.includes('conv-1')) {
          return Promise.resolve([
            '{"type":"meta","id":"conv-1","title":"First","createdAt":1700000000,"updatedAt":1700002000,"sessionId":null}',
            '{"type":"message","message":{"id":"msg-1","role":"user","content":"First message content here","timestamp":1700000100}}',
          ].join('\n'));
        }
        if (path.includes('conv-2')) {
          return Promise.resolve([
            '{"type":"meta","id":"conv-2","title":"Second","createdAt":1700000000,"updatedAt":1700001000,"sessionId":"sdk-2"}',
            '{"type":"message","message":{"id":"msg-1","role":"assistant","content":"Assistant first","timestamp":1700000100}}',
            '{"type":"message","message":{"id":"msg-2","role":"user","content":"User message","timestamp":1700000200}}',
          ].join('\n'));
        }
        return Promise.resolve('');
      });

      const metas = await storage.listConversations();

      expect(metas).toHaveLength(2);

      // Should be sorted by updatedAt descending
      expect(metas[0].id).toBe('conv-1');
      expect(metas[0].title).toBe('First');
      expect(metas[0].messageCount).toBe(1);
      expect(metas[0].preview).toBe('First message content here');

      expect(metas[1].id).toBe('conv-2');
      expect(metas[1].title).toBe('Second');
      expect(metas[1].messageCount).toBe(2);
      expect(metas[1].preview).toBe('User message'); // First user message
    });

    it('handles empty sessions directory', async () => {
      mockAdapter.listFiles.mockResolvedValue([]);

      const metas = await storage.listConversations();

      expect(metas).toEqual([]);
    });

    it('handles listFiles error gracefully', async () => {
      mockAdapter.listFiles.mockRejectedValue(new Error('List error'));


      const metas = await storage.listConversations();

      expect(metas).toEqual([]);

    });

    it('skips files that fail to load', async () => {
      mockAdapter.listFiles.mockResolvedValue([
        '.claude/sessions/good.jsonl',
        '.claude/sessions/bad.jsonl',
      ]);

      mockAdapter.read.mockImplementation((path: string) => {
        if (path.includes('good')) {
          return Promise.resolve(
            '{"type":"meta","id":"good","title":"Good","createdAt":1700000000,"updatedAt":1700001000,"sessionId":null}'
          );
        }
        return Promise.reject(new Error('Read error'));
      });


      const metas = await storage.listConversations();

      expect(metas).toHaveLength(1);
      expect(metas[0].id).toBe('good');

    });

    it('truncates long previews', async () => {
      mockAdapter.listFiles.mockResolvedValue(['.claude/sessions/conv-long.jsonl']);

      const longContent = 'A'.repeat(100);
      mockAdapter.read.mockResolvedValue([
        '{"type":"meta","id":"conv-long","title":"Long","createdAt":1700000000,"updatedAt":1700001000,"sessionId":null}',
        `{"type":"message","message":{"id":"msg-1","role":"user","content":"${longContent}","timestamp":1700000100}}`,
      ].join('\n'));

      const metas = await storage.listConversations();

      expect(metas[0].preview).toBe('A'.repeat(50) + '...');
    });

    it('uses default preview for conversations without user messages', async () => {
      mockAdapter.listFiles.mockResolvedValue(['.claude/sessions/conv-no-user.jsonl']);

      mockAdapter.read.mockResolvedValue([
        '{"type":"meta","id":"conv-no-user","title":"No User","createdAt":1700000000,"updatedAt":1700001000,"sessionId":null}',
        '{"type":"message","message":{"id":"msg-1","role":"assistant","content":"Only assistant","timestamp":1700000100}}',
      ].join('\n'));

      const metas = await storage.listConversations();

      expect(metas[0].preview).toBe('New conversation');
    });

    it('preserves titleGenerationStatus in meta', async () => {
      mockAdapter.listFiles.mockResolvedValue(['.claude/sessions/conv-status.jsonl']);

      mockAdapter.read.mockResolvedValue(
        '{"type":"meta","id":"conv-status","title":"Status Test","createdAt":1700000000,"updatedAt":1700001000,"sessionId":null,"titleGenerationStatus":"failed"}'
      );

      const metas = await storage.listConversations();

      expect(metas[0].titleGenerationStatus).toBe('failed');
    });
  });

  describe('loadAllConversations', () => {
    it('loads full conversation data for all JSONL files', async () => {
      mockAdapter.listFiles.mockResolvedValue([
        '.claude/sessions/conv-a.jsonl',
        '.claude/sessions/conv-b.jsonl',
      ]);

      mockAdapter.read.mockImplementation((path: string) => {
        if (path.includes('conv-a')) {
          return Promise.resolve([
            '{"type":"meta","id":"conv-a","title":"Conv A","createdAt":1700000000,"updatedAt":1700002000,"sessionId":"a"}',
            '{"type":"message","message":{"id":"msg-1","role":"user","content":"Hello A","timestamp":1700000100}}',
          ].join('\n'));
        }
        if (path.includes('conv-b')) {
          return Promise.resolve([
            '{"type":"meta","id":"conv-b","title":"Conv B","createdAt":1700000000,"updatedAt":1700001000,"sessionId":"b"}',
            '{"type":"message","message":{"id":"msg-1","role":"user","content":"Hello B","timestamp":1700000100}}',
          ].join('\n'));
        }
        return Promise.resolve('');
      });

      const { conversations } = await storage.loadAllConversations();

      expect(conversations).toHaveLength(2);

      // Sorted by updatedAt descending
      expect(conversations[0].id).toBe('conv-a');
      expect(conversations[0].messages).toHaveLength(1);

      expect(conversations[1].id).toBe('conv-b');
      expect(conversations[1].messages).toHaveLength(1);
    });

    it('skips non-JSONL files', async () => {
      mockAdapter.listFiles.mockResolvedValue([
        '.claude/sessions/conv.jsonl',
        '.claude/sessions/notes.md',
        '.claude/sessions/.DS_Store',
      ]);

      mockAdapter.read.mockResolvedValue(
        '{"type":"meta","id":"conv","title":"Conv","createdAt":1700000000,"updatedAt":1700001000,"sessionId":null}'
      );

      const { conversations } = await storage.loadAllConversations();

      expect(conversations).toHaveLength(1);
      expect(mockAdapter.read).toHaveBeenCalledTimes(1);
    });

    it('handles errors gracefully', async () => {
      mockAdapter.listFiles.mockRejectedValue(new Error('List error'));


      const { conversations } = await storage.loadAllConversations();

      expect(conversations).toEqual([]);

    });

    it('continues loading after individual file errors', async () => {
      mockAdapter.listFiles.mockResolvedValue([
        '.claude/sessions/good.jsonl',
        '.claude/sessions/bad.jsonl',
      ]);

      mockAdapter.read.mockImplementation((path: string) => {
        if (path.includes('good')) {
          return Promise.resolve(
            '{"type":"meta","id":"good","title":"Good","createdAt":1700000000,"updatedAt":1700001000,"sessionId":null}'
          );
        }
        return Promise.reject(new Error('Read error'));
      });


      const { conversations, failedCount } = await storage.loadAllConversations();

      expect(conversations).toHaveLength(1);
      expect(conversations[0].id).toBe('good');
      expect(failedCount).toBe(1);

    });
  });

  describe('hasSessions', () => {
    it('returns true if JSONL files exist', async () => {
      mockAdapter.listFiles.mockResolvedValue([
        '.claude/sessions/conv-1.jsonl',
        '.claude/sessions/conv-2.jsonl',
      ]);

      const result = await storage.hasSessions();

      expect(result).toBe(true);
    });

    it('returns false if no JSONL files exist', async () => {
      mockAdapter.listFiles.mockResolvedValue([
        '.claude/sessions/readme.txt',
        '.claude/sessions/.gitkeep',
      ]);

      const result = await storage.hasSessions();

      expect(result).toBe(false);
    });

    it('returns false if directory is empty', async () => {
      mockAdapter.listFiles.mockResolvedValue([]);

      const result = await storage.hasSessions();

      expect(result).toBe(false);
    });
  });
});
