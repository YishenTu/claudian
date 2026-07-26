import type { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';
import { ConsciousnessEngine } from '@/core/memory/ConsciousnessEngine';
import {
  AWARENESS_DIR,
  SOUL_FILE,
  USER_FILE,
  ACTIVITY_FILE,
} from '@/core/memory/consciousness-types';
import type { MemoryEntry } from '@/core/memory/types';

function createMockAdapter(files: Record<string, string> = {}): VaultFileAdapter {
  const store = { ...files };
  return {
    exists: jest.fn(async (path: string) => path in store),
    read: jest.fn(async (path: string) => {
      if (!(path in store)) throw new Error(`File not found: ${path}`);
      return store[path];
    }),
    write: jest.fn(async (path: string, content: string) => {
      store[path] = content;
    }),
    delete: jest.fn(async (path: string) => {
      delete store[path];
    }),
    listFiles: jest.fn(async () => []),
    listFolders: jest.fn(async () => []),
    listFilesRecursive: jest.fn(async () => []),
    ensureFolder: jest.fn(),
    rename: jest.fn(),
    append: jest.fn(),
    stat: jest.fn(),
    deleteFolder: jest.fn(),
  } as unknown as VaultFileAdapter;
}

describe('ConsciousnessEngine', () => {
  describe('initialize', () => {
    it('creates awareness directory and files', async () => {
      const adapter = createMockAdapter();
      const engine = new ConsciousnessEngine(adapter);

      await engine.initialize();

      expect(adapter.ensureFolder).toHaveBeenCalledWith(AWARENESS_DIR);
      expect(adapter.write).toHaveBeenCalledWith(SOUL_FILE, expect.stringContaining('协作风格'));
      expect(adapter.write).toHaveBeenCalledWith(USER_FILE, expect.stringContaining('用户画像'));
      expect(adapter.write).toHaveBeenCalledWith(ACTIVITY_FILE, '[]');
    });

    it('does not overwrite existing files', async () => {
      const adapter = createMockAdapter({
        [SOUL_FILE]: '# Existing Soul',
        [USER_FILE]: '# Existing User',
        [ACTIVITY_FILE]: '[{"id": "existing"}]',
      });
      const engine = new ConsciousnessEngine(adapter);

      await engine.initialize();

      // Should not write to existing files
      const writeCalls = (adapter.write as jest.Mock).mock.calls;
      const soulWrites = writeCalls.filter((call: string[]) => call[0] === SOUL_FILE);
      const userWrites = writeCalls.filter((call: string[]) => call[0] === USER_FILE);
      expect(soulWrites).toHaveLength(0);
      expect(userWrites).toHaveLength(0);
    });

    it('does nothing when disabled', async () => {
      const adapter = createMockAdapter();
      const engine = new ConsciousnessEngine(adapter, { enabled: false });

      await engine.initialize();

      expect(adapter.ensureFolder).not.toHaveBeenCalled();
    });
  });

  describe('logActivity', () => {
    it('logs activity to activity.json', async () => {
      const adapter = createMockAdapter({ [ACTIVITY_FILE]: '[]' });
      const engine = new ConsciousnessEngine(adapter);

      await engine.logActivity('memory-add', 'Added a memory');

      const activities = await engine.loadActivities();
      expect(activities).toHaveLength(1);
      expect(activities[0].type).toBe('memory-add');
      expect(activities[0].message).toBe('Added a memory');
    });

    it('keeps only last 100 activities', async () => {
      const existingActivities = Array.from({ length: 100 }, (_, i) => ({
        id: `act_${i}`,
        type: 'memory-add' as const,
        message: `Activity ${i}`,
        timestamp: Date.now() - i,
      }));
      const adapter = createMockAdapter({
        [ACTIVITY_FILE]: JSON.stringify(existingActivities),
      });
      const engine = new ConsciousnessEngine(adapter);

      await engine.logActivity('memory-remove', 'New activity');

      const activities = await engine.loadActivities();
      expect(activities).toHaveLength(100);
      expect(activities[0].message).toBe('New activity');
    });
  });

  describe('getAwarenessState', () => {
    it('returns correct state summary', async () => {
      const adapter = createMockAdapter({ [ACTIVITY_FILE]: '[]' });
      const engine = new ConsciousnessEngine(adapter);

      const memories: MemoryEntry[] = [
        { id: '1', category: 'User Preferences', content: 'Test 1', source: 'user-explicit', createdAt: 0, updatedAt: 0 },
        { id: '2', category: 'User Preferences', content: 'Test 2', source: 'user-explicit', createdAt: 0, updatedAt: 0 },
        { id: '3', category: 'Project Context', content: 'Test 3', source: 'user-explicit', createdAt: 0, updatedAt: 0 },
      ];

      const state = await engine.getAwarenessState(memories);

      expect(state.totalMemories).toBe(3);
      expect(state.categories['User Preferences']).toBe(2);
      expect(state.categories['Project Context']).toBe(1);
      expect(state.confidenceLevel).toBe('low');
    });

    it('calculates confidence level correctly', async () => {
      const adapter = createMockAdapter({ [ACTIVITY_FILE]: '[]' });
      const engine = new ConsciousnessEngine(adapter);

      // Low confidence (< 5 memories)
      const lowState = await engine.getAwarenessState([]);
      expect(lowState.confidenceLevel).toBe('low');

      // Medium confidence (5-19 memories)
      const mediumMemories = Array.from({ length: 10 }, (_, i) => ({
        id: `${i}`,
        category: 'Test',
        content: `Test ${i}`,
        source: 'user-explicit' as const,
        createdAt: 0,
        updatedAt: 0,
      }));
      const mediumState = await engine.getAwarenessState(mediumMemories);
      expect(mediumState.confidenceLevel).toBe('medium');

      // High confidence (>= 20 memories)
      const highMemories = Array.from({ length: 25 }, (_, i) => ({
        id: `${i}`,
        category: 'Test',
        content: `Test ${i}`,
        source: 'user-explicit' as const,
        createdAt: 0,
        updatedAt: 0,
      }));
      const highState = await engine.getAwarenessState(highMemories);
      expect(highState.confidenceLevel).toBe('high');
    });
  });

  describe('shouldReflect', () => {
    it('returns false when disabled', () => {
      const adapter = createMockAdapter();
      const engine = new ConsciousnessEngine(adapter, { enabled: false });

      const memories = Array.from({ length: 20 }, (_, i) => ({
        id: `${i}`,
        category: 'Test',
        content: `Test ${i}`,
        source: 'user-explicit' as const,
        createdAt: 0,
        updatedAt: 0,
      }));

      expect(engine.shouldReflect(memories, 10)).toBe(false);
    });

    it('returns false when not enough conversations', () => {
      const adapter = createMockAdapter();
      const engine = new ConsciousnessEngine(adapter, {
        minConversationsForReflection: 5,
      });

      const memories = Array.from({ length: 20 }, (_, i) => ({
        id: `${i}`,
        category: 'Test',
        content: `Test ${i}`,
        source: 'user-explicit' as const,
        createdAt: 0,
        updatedAt: 0,
      }));

      expect(engine.shouldReflect(memories, 3)).toBe(false);
    });

    it('returns true when conditions are met', () => {
      const adapter = createMockAdapter();
      const engine = new ConsciousnessEngine(adapter, {
        minConversationsForReflection: 5,
        minMemoriesForConsolidation: 10,
      });

      const memories = Array.from({ length: 15 }, (_, i) => ({
        id: `${i}`,
        category: 'Test',
        content: `Test ${i}`,
        source: 'user-explicit' as const,
        createdAt: 0,
        updatedAt: 0,
      }));

      expect(engine.shouldReflect(memories, 10)).toBe(true);
    });
  });
});
