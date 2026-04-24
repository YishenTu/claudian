import type { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';
import {
  CODEX_AGENTS_PATH,
  CodexSubagentStorage,
  createCodexSubagentPersistenceKey,
  parseCodexSubagentPersistenceKey,
  parseSubagentToml,
  serializeSubagentToml,
} from '@/providers/codex/storage/CodexSubagentStorage';
import { DEFAULT_CODEX_PRIMARY_MODEL } from '@/providers/codex/types/models';
import type { CodexSubagentDefinition } from '@/providers/codex/types/subagent';

function createMockAdapter(files: Record<string, string> = {}): VaultFileAdapter {
  return {
    exists: jest.fn(async (path: string) =>
      path in files || Object.keys(files).some(k => k.startsWith(path + '/')),
    ),
    read: jest.fn(async (path: string) => {
      if (!(path in files)) throw new Error(`File not found: ${path}`);
      return files[path];
    }),
    write: jest.fn(),
    delete: jest.fn(),
    listFiles: jest.fn(async (folder: string) => {
      const prefix = folder.endsWith('/') ? folder : folder + '/';
      return Object.keys(files).filter(
        k => k.startsWith(prefix) && !k.slice(prefix.length).includes('/'),
      );
    }),
    listFolders: jest.fn(),
    listFilesRecursive: jest.fn(),
    ensureFolder: jest.fn(),
    rename: jest.fn(),
    append: jest.fn(),
    stat: jest.fn(),
    deleteFolder: jest.fn(),
  } as unknown as VaultFileAdapter;
}

const BASIC_TOML = `name = "reviewer"
description = "PR reviewer focused on correctness."
developer_instructions = """
Review code like an owner.
Prioritize correctness and security.
"""
`;

const FULL_TOML = `name = "explorer"
description = "Read-only codebase explorer."
developer_instructions = """
Stay in exploration mode.
Trace the real execution path.
"""
nickname_candidates = ["Atlas", "Delta", "Echo"]
model = "${DEFAULT_CODEX_PRIMARY_MODEL}"
model_reasoning_effort = "high"
sandbox_mode = "read-only"
`;

describe('parseSubagentToml', () => {
  it('parses basic required fields', () => {
    const result = parseSubagentToml(BASIC_TOML, '.codex/agents/reviewer.toml');

    expect(result).not.toBeNull();
    expect(result!.name).toBe('reviewer');
    expect(result!.description).toBe('PR reviewer focused on correctness.');
    expect(result!.developerInstructions).toContain('Review code like an owner.');
    expect(result!.persistenceKey).toBe(
      createCodexSubagentPersistenceKey({ fileName: 'reviewer.toml' }),
    );
  });

  it('parses all optional fields', () => {
    const result = parseSubagentToml(FULL_TOML, '.codex/agents/explorer.toml');

    expect(result).not.toBeNull();
    expect(result!.nicknameCandidates).toEqual(['Atlas', 'Delta', 'Echo']);
    expect(result!.model).toBe(DEFAULT_CODEX_PRIMARY_MODEL);
    expect(result!.modelReasoningEffort).toBe('high');
    expect(result!.sandboxMode).toBe('read-only');
  });

  it('returns null for missing name', () => {
    const toml = `description = "test"\ndeveloper_instructions = "test"`;
    expect(parseSubagentToml(toml, 'test.toml')).toBeNull();
  });

  it('returns null for missing description', () => {
    const toml = `name = "test"\ndeveloper_instructions = "test"`;
    expect(parseSubagentToml(toml, 'test.toml')).toBeNull();
  });

  it('returns null for missing developer_instructions', () => {
    const toml = `name = "test"\ndescription = "test"`;
    expect(parseSubagentToml(toml, 'test.toml')).toBeNull();
  });

  it('returns null for invalid TOML', () => {
    expect(parseSubagentToml('{{invalid', 'test.toml')).toBeNull();
  });

  it('preserves unrecognized keys in extraFields', () => {
    const toml = `name = "test"\ndescription = "test"\ndeveloper_instructions = "test"\ncustom_key = "custom_value"`;
    const result = parseSubagentToml(toml, 'test.toml');

    expect(result).not.toBeNull();
    expect(result!.extraFields).toEqual({ custom_key: 'custom_value' });
  });

  it('omits extraFields when no unrecognized keys', () => {
    const result = parseSubagentToml(BASIC_TOML, 'test.toml');
    expect(result!.extraFields).toBeUndefined();
  });

  it('skips non-string nickname_candidates', () => {
    const toml = `name = "t"\ndescription = "t"\ndeveloper_instructions = "t"\nnickname_candidates = [42]`;
    const result = parseSubagentToml(toml, 'test.toml');
    expect(result!.nicknameCandidates).toBeUndefined();
  });
});

describe('serializeSubagentToml', () => {
  it('serializes required fields', () => {
    const agent: CodexSubagentDefinition = {
      name: 'reviewer',
      description: 'Reviews code.',
      developerInstructions: 'Review carefully.',
    };

    const toml = serializeSubagentToml(agent);

    expect(toml).toContain('name = "reviewer"');
    expect(toml).toContain('description = "Reviews code."');
    expect(toml).toContain('developer_instructions');
    expect(toml).toContain('Review carefully.');
  });

  it('serializes all optional fields', () => {
    const agent: CodexSubagentDefinition = {
      name: 'explorer',
      description: 'Explores code.',
      developerInstructions: 'Explore.',
      nicknameCandidates: ['Atlas', 'Delta'],
      model: DEFAULT_CODEX_PRIMARY_MODEL,
      modelReasoningEffort: 'high',
      sandboxMode: 'read-only',
    };

    const toml = serializeSubagentToml(agent);

    expect(toml).toContain('nickname_candidates');
    expect(toml).toContain('Atlas');
    expect(toml).toContain(`model = "${DEFAULT_CODEX_PRIMARY_MODEL}"`);
    expect(toml).toContain('model_reasoning_effort = "high"');
    expect(toml).toContain('sandbox_mode = "read-only"');
  });

  it('omits undefined optional fields', () => {
    const agent: CodexSubagentDefinition = {
      name: 'basic',
      description: 'Basic agent.',
      developerInstructions: 'Do stuff.',
    };

    const toml = serializeSubagentToml(agent);

    expect(toml).not.toContain('nickname_candidates');
    expect(toml).not.toContain('model =');
    expect(toml).not.toContain('model_reasoning_effort');
    expect(toml).not.toContain('sandbox_mode');
  });

  it('includes extraFields for round-trip fidelity', () => {
    const agent: CodexSubagentDefinition = {
      name: 'custom',
      description: 'Custom agent.',
      developerInstructions: 'Do custom.',
      extraFields: { custom_key: 'custom_value' },
    };

    const toml = serializeSubagentToml(agent);
    expect(toml).toContain('custom_key = "custom_value"');
  });

  it('round-trips through parse → serialize → parse', () => {
    const original = parseSubagentToml(FULL_TOML, 'test.toml')!;
    const serialized = serializeSubagentToml(original);
    const reparsed = parseSubagentToml(serialized, 'test.toml')!;

    expect(reparsed.name).toBe(original.name);
    expect(reparsed.description).toBe(original.description);
    expect(reparsed.developerInstructions).toBe(original.developerInstructions);
    expect(reparsed.nicknameCandidates).toEqual(original.nicknameCandidates);
    expect(reparsed.model).toBe(original.model);
    expect(reparsed.modelReasoningEffort).toBe(original.modelReasoningEffort);
    expect(reparsed.sandboxMode).toBe(original.sandboxMode);
  });
});

describe('CodexSubagentStorage', () => {
  describe('loadAll', () => {
    it('loads all .toml files from .codex/agents/', async () => {
      const adapter = createMockAdapter({
        '.codex/agents/reviewer.toml': BASIC_TOML,
        '.codex/agents/explorer.toml': FULL_TOML,
      });

      const storage = new CodexSubagentStorage(adapter);
      const agents = await storage.loadAll();

      expect(agents).toHaveLength(2);
      expect(agents.map(a => a.name).sort()).toEqual(['explorer', 'reviewer']);
    });

    it('skips non-.toml files', async () => {
      const adapter = createMockAdapter({
        '.codex/agents/reviewer.toml': BASIC_TOML,
        '.codex/agents/README.md': '# Agents',
      });

      const storage = new CodexSubagentStorage(adapter);
      const agents = await storage.loadAll();

      expect(agents).toHaveLength(1);
      expect(agents[0].name).toBe('reviewer');
    });

    it('skips malformed files', async () => {
      const adapter = createMockAdapter({
        '.codex/agents/good.toml': BASIC_TOML,
        '.codex/agents/bad.toml': '{{invalid toml',
      });

      const storage = new CodexSubagentStorage(adapter);
      const agents = await storage.loadAll();

      expect(agents).toHaveLength(1);
      expect(agents[0].name).toBe('reviewer');
    });

    it('returns empty array when directory does not exist', async () => {
      const adapter = createMockAdapter({});
      (adapter.listFiles as jest.Mock).mockRejectedValue(new Error('not found'));

      const storage = new CodexSubagentStorage(adapter);
      const agents = await storage.loadAll();

      expect(agents).toEqual([]);
    });
  });

  describe('load', () => {
    it('loads a single agent by filePath', async () => {
      const adapter = createMockAdapter({
        '.codex/agents/reviewer.toml': BASIC_TOML,
      });

      const storage = new CodexSubagentStorage(adapter);
      const agent = await storage.load({
        name: 'reviewer',
        description: '',
        developerInstructions: '',
        persistenceKey: createCodexSubagentPersistenceKey({ fileName: 'reviewer.toml' }),
      });

      expect(agent).not.toBeNull();
      expect(agent!.name).toBe('reviewer');
    });
    it('returns null when file does not exist', async () => {
      const adapter = createMockAdapter({});

      const storage = new CodexSubagentStorage(adapter);
      const agent = await storage.load({
        name: 'missing',
        description: '',
        developerInstructions: '',
      });

      expect(agent).toBeNull();
    });
  });

  describe('save', () => {
    it('writes TOML to .codex/agents/{name}.toml', async () => {
      const adapter = createMockAdapter({});
      const storage = new CodexSubagentStorage(adapter);

      await storage.save({
        name: 'reviewer',
        description: 'Reviews code.',
        developerInstructions: 'Review carefully.',
      });

      expect(adapter.ensureFolder).toHaveBeenCalledWith(CODEX_AGENTS_PATH);
      expect(adapter.write).toHaveBeenCalledWith(
        '.codex/agents/reviewer.toml',
        expect.stringContaining('name = "reviewer"'),
      );
    });

    it('preserves the existing backing file when the name is unchanged', async () => {
      const adapter = createMockAdapter({});
      const storage = new CodexSubagentStorage(adapter);

      await storage.save({
        name: 'reviewer',
        description: 'Reviews code.',
        developerInstructions: 'Review carefully.',
      }, {
        name: 'reviewer',
        description: 'Reviews code.',
        developerInstructions: 'Review carefully.',
        persistenceKey: createCodexSubagentPersistenceKey({ fileName: 'my-reviewer.toml' }),
      });

      expect(adapter.write).toHaveBeenCalledWith(
        '.codex/agents/my-reviewer.toml',
        expect.any(String),
      );
    });

    it('renames the backing file when the agent name changes', async () => {
      const adapter = createMockAdapter({});
      const storage = new CodexSubagentStorage(adapter);

      await storage.save({
        name: 'renamed-reviewer',
        description: 'Reviews code.',
        developerInstructions: 'Review carefully.',
      }, {
        name: 'reviewer',
        description: 'Reviews code.',
        developerInstructions: 'Review carefully.',
        persistenceKey: createCodexSubagentPersistenceKey({ fileName: 'my-reviewer.toml' }),
      });

      expect(adapter.write).toHaveBeenCalledWith(
        '.codex/agents/renamed-reviewer.toml',
        expect.any(String),
      );
      expect(adapter.delete).toHaveBeenCalledWith('.codex/agents/my-reviewer.toml');
    });
  });

  describe('delete', () => {
    it('deletes the file at the resolved path', async () => {
      const adapter = createMockAdapter({
        '.codex/agents/reviewer.toml': BASIC_TOML,
      });
      const storage = new CodexSubagentStorage(adapter);

      await storage.delete({
        name: 'reviewer',
        description: '',
        developerInstructions: '',
        persistenceKey: createCodexSubagentPersistenceKey({ fileName: 'reviewer.toml' }),
      });

      expect(adapter.delete).toHaveBeenCalledWith('.codex/agents/reviewer.toml');
    });
  });

  describe('persistence keys', () => {
    it('round-trips file identity without exposing the storage path', () => {
      const key = createCodexSubagentPersistenceKey({ fileName: 'reviewer.toml' });

      expect(parseCodexSubagentPersistenceKey(key)).toEqual({ fileName: 'reviewer.toml' });
    });

    it('parses legacy relative file paths for backward compatibility', () => {
      expect(parseCodexSubagentPersistenceKey('.codex/agents/reviewer.toml')).toEqual({
        fileName: 'reviewer.toml',
      });
    });
  });
});
