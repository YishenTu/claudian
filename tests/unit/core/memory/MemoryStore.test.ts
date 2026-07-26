import type { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';
import { MemoryStore } from '@/core/memory/MemoryStore';
import { DEFAULT_MEMORY_FILE_PATH, MEMORY_FILE_TEMPLATE } from '@/core/memory/types';

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

describe('MemoryStore', () => {
  describe('load', () => {
    it('returns empty array when file does not exist', async () => {
      const adapter = createMockAdapter();
      const store = new MemoryStore(adapter);
      const entries = await store.load();
      expect(entries).toEqual([]);
    });

    it('parses markdown with categories and list items', async () => {
      const content = `# Claudian Memory

## User Preferences
- Prefers Chinese communication
- Likes TypeScript

## Project Context
- Working on an Obsidian plugin
`;
      const adapter = createMockAdapter({ '.claudian/memory.md': content });
      const store = new MemoryStore(adapter);
      const entries = await store.load();

      expect(entries).toHaveLength(3);
      expect(entries[0]).toMatchObject({
        category: 'User Preferences',
        content: 'Prefers Chinese communication',
      });
      expect(entries[1]).toMatchObject({
        category: 'User Preferences',
        content: 'Likes TypeScript',
      });
      expect(entries[2]).toMatchObject({
        category: 'Project Context',
        content: 'Working on an Obsidian plugin',
      });
    });

    it('handles file with no entries gracefully', async () => {
      const adapter = createMockAdapter({ '.claudian/memory.md': MEMORY_FILE_TEMPLATE });
      const store = new MemoryStore(adapter);
      const entries = await store.load();
      expect(entries).toEqual([]);
    });

    it('skips HTML comments in memory file', async () => {
      const content = `# Claudian Memory

## User Preferences
- Prefers dark mode
<!-- This is a comment -->
- Likes TypeScript
`;
      const adapter = createMockAdapter({ '.claudian/memory.md': content });
      const store = new MemoryStore(adapter);
      const entries = await store.load();

      expect(entries).toHaveLength(2);
      expect(entries[0].content).toBe('Prefers dark mode');
      expect(entries[1].content).toBe('Likes TypeScript');
    });

    it('supports different list markers (-, *, +)', async () => {
      const content = `# Claudian Memory

## User Preferences
- Item with dash
* Item with asterisk
+ Item with plus
`;
      const adapter = createMockAdapter({ '.claudian/memory.md': content });
      const store = new MemoryStore(adapter);
      const entries = await store.load();

      expect(entries).toHaveLength(3);
      expect(entries[0].content).toBe('Item with dash');
      expect(entries[1].content).toBe('Item with asterisk');
      expect(entries[2].content).toBe('Item with plus');
    });

    it('handles indented list items', async () => {
      const content = `# Claudian Memory

## User Preferences
  - Indented item
`;
      const adapter = createMockAdapter({ '.claudian/memory.md': content });
      const store = new MemoryStore(adapter);
      const entries = await store.load();

      expect(entries).toHaveLength(1);
      expect(entries[0].content).toBe('Indented item');
    });
  });

  describe('add', () => {
    it('creates file with template when it does not exist', async () => {
      const adapter = createMockAdapter();
      const store = new MemoryStore(adapter);

      await store.add({
        category: 'User Preferences',
        content: 'Test memory',
        source: 'user-explicit',
      });

      expect(adapter.write).toHaveBeenCalled();
      const calls = (adapter.write as jest.Mock).mock.calls;
      // Last write call contains the full content with the new entry
      const lastCall = calls[calls.length - 1];
      expect(lastCall[0]).toBe(DEFAULT_MEMORY_FILE_PATH);
      expect(lastCall[1]).toContain('- Test memory');
      expect(lastCall[1]).toContain('## User Preferences');
    });

    it('appends to existing entries', async () => {
      const content = `# Claudian Memory

## User Preferences
- Existing memory

## Project Context

`;
      const adapter = createMockAdapter({ '.claudian/memory.md': content });
      const store = new MemoryStore(adapter);

      await store.add({
        category: 'User Preferences',
        content: 'New memory',
        source: 'user-explicit',
      });

      const writeCall = (adapter.write as jest.Mock).mock.calls[0];
      const written = writeCall[1];
      expect(written).toContain('- Existing memory');
      expect(written).toContain('- New memory');
    });
  });

  describe('buildInjectionText', () => {
    it('returns null when no entries exist', async () => {
      const adapter = createMockAdapter();
      const store = new MemoryStore(adapter);
      const result = await store.buildInjectionText();
      expect(result).toBeNull();
    });

    it('returns formatted text grouped by category', async () => {
      const content = `# Claudian Memory

## User Preferences
- Prefers dark mode

## Project Context
- Uses TypeScript
`;
      const adapter = createMockAdapter({ '.claudian/memory.md': content });
      const store = new MemoryStore(adapter);
      const result = await store.buildInjectionText();

      expect(result).toContain('### User Preferences');
      expect(result).toContain('- Prefers dark mode');
      expect(result).toContain('### Project Context');
      expect(result).toContain('- Uses TypeScript');
    });

    it('respects maxInjectionChars limit', async () => {
      const content = `# Claudian Memory

## User Preferences
- First memory entry that is somewhat long
- Second memory entry that is also long
- Third memory entry that is very long indeed
`;
      const adapter = createMockAdapter({ '.claudian/memory.md': content });
      const store = new MemoryStore(adapter, { maxInjectionChars: 80 });
      const result = await store.buildInjectionText();

      expect(result).not.toBeNull();
      expect(result!.length).toBeLessThanOrEqual(80);
    });
  });

  describe('updateOptions', () => {
    it('updates filePath and maxInjectionChars', () => {
      const adapter = createMockAdapter();
      const store = new MemoryStore(adapter);

      store.updateOptions({ filePath: 'custom/path.md', maxInjectionChars: 3000 });

      expect(store.filePath).toBe('custom/path.md');
      expect(store.maxInjectionChars).toBe(3000);
    });
  });

  describe('remove', () => {
    it('removes entries matching the search term', async () => {
      const content = `# Claudian Memory

## User Preferences
- Prefers dark mode
- Likes TypeScript

## Project Context
- Working on an Obsidian plugin
`;
      const adapter = createMockAdapter({ '.claudian/memory.md': content });
      const store = new MemoryStore(adapter);

      const removedCount = await store.remove('dark mode');

      expect(removedCount).toBe(1);
      const entries = await store.load();
      expect(entries).toHaveLength(2);
      expect(entries.find(e => e.content.includes('dark mode'))).toBeUndefined();
    });

    it('removes multiple entries matching the search term', async () => {
      const content = `# Claudian Memory

## User Preferences
- Prefers dark mode
- Uses dark mode in editors

## Project Context

`;
      const adapter = createMockAdapter({ '.claudian/memory.md': content });
      const store = new MemoryStore(adapter);

      const removedCount = await store.remove('dark mode');

      expect(removedCount).toBe(2);
    });

    it('returns 0 when no entries match', async () => {
      const content = `# Claudian Memory

## User Preferences
- Prefers dark mode

## Project Context

`;
      const adapter = createMockAdapter({ '.claudian/memory.md': content });
      const store = new MemoryStore(adapter);

      const removedCount = await store.remove('light mode');

      expect(removedCount).toBe(0);
    });

    it('returns 0 when file does not exist', async () => {
      const adapter = createMockAdapter();
      const store = new MemoryStore(adapter);

      const removedCount = await store.remove('anything');

      expect(removedCount).toBe(0);
    });

    it('is case-insensitive', async () => {
      const content = `# Claudian Memory

## User Preferences
- Prefers DARK MODE

## Project Context

`;
      const adapter = createMockAdapter({ '.claudian/memory.md': content });
      const store = new MemoryStore(adapter);

      const removedCount = await store.remove('dark mode');

      expect(removedCount).toBe(1);
    });
  });
});
