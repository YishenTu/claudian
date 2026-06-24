import { PROMPTS_PATH } from '@/core/bootstrap/StoragePaths';
import { PromptLibraryStorage, type StoredPrompt } from '@/core/storage/PromptLibraryStorage';
import type { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';

describe('PromptLibraryStorage', () => {
  let mockAdapter: jest.Mocked<VaultFileAdapter>;
  let storage: PromptLibraryStorage;

  beforeEach(() => {
    mockAdapter = {
      exists: jest.fn(),
      read: jest.fn(),
      write: jest.fn(),
      delete: jest.fn(),
      listFiles: jest.fn(),
    } as unknown as jest.Mocked<VaultFileAdapter>;
    storage = new PromptLibraryStorage(mockAdapter);
  });

  describe('PROMPTS_PATH', () => {
    it('is .claudian/prompts.json', () => {
      expect(PROMPTS_PATH).toBe('.claudian/prompts.json');
    });
  });

  describe('load', () => {
    it('returns empty array when file is missing', async () => {
      mockAdapter.exists.mockResolvedValue(false);
      await expect(storage.load()).resolves.toEqual([]);
      expect(mockAdapter.read).not.toHaveBeenCalled();
    });

    it('returns parsed prompts', async () => {
      const prompts: StoredPrompt[] = [
        { id: 'a', name: 'Summarize', content: 'Summarize this:', updatedAt: 1 },
      ];
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify(prompts));
      await expect(storage.load()).resolves.toEqual(prompts);
    });

    it('filters out malformed entries', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify([
        { id: 'a', name: 'OK', content: 'c', updatedAt: 1 },
        { id: 'b', name: 'no content' },
        'not-an-object',
        null,
      ]));
      const result = await storage.load();
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('a');
    });

    it('returns empty array on corrupt JSON', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue('{ not json');
      await expect(storage.load()).resolves.toEqual([]);
    });

    it('returns empty array when payload is not an array', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({ id: 'x' }));
      await expect(storage.load()).resolves.toEqual([]);
    });
  });

  describe('save', () => {
    it('writes JSON array to PROMPTS_PATH', async () => {
      const prompts: StoredPrompt[] = [
        { id: 'a', name: 'N', content: 'C', updatedAt: 9 },
      ];
      await storage.save(prompts);
      expect(mockAdapter.write).toHaveBeenCalledWith(PROMPTS_PATH, expect.any(String));
      const written = mockAdapter.write.mock.calls[0][1];
      expect(JSON.parse(written)).toEqual(prompts);
    });

    it('drops malformed entries before writing', async () => {
      await storage.save([
        { id: 'a', name: 'N', content: 'C', updatedAt: 1 },
        { id: 'b' } as unknown as StoredPrompt,
      ]);
      const written = JSON.parse(mockAdapter.write.mock.calls[0][1]);
      expect(written).toHaveLength(1);
      expect(written[0].id).toBe('a');
    });
  });
});
