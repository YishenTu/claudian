import { AgentVaultStorage } from '@/core/storage/AgentVaultStorage';
import type { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';

describe('AgentVaultStorage', () => {
  let mockAdapter: jest.Mocked<VaultFileAdapter>;
  let storage: AgentVaultStorage;

  const validAgentMd = `---
name: code-reviewer
description: Reviews code for issues
model: sonnet
---
You are a code reviewer.`;

  const validAgent2Md = `---
name: test-runner
description: Runs tests
tools: [Bash]
---
Run the tests.`;

  beforeEach(() => {
    mockAdapter = {
      exists: jest.fn().mockResolvedValue(true),
      read: jest.fn(),
      write: jest.fn(),
      delete: jest.fn(),
      ensureFolder: jest.fn(),
      rename: jest.fn(),
      stat: jest.fn(),
      append: jest.fn(),
      listFiles: jest.fn(),
      listFolders: jest.fn(),
      listFilesRecursive: jest.fn(),
    } as unknown as jest.Mocked<VaultFileAdapter>;

    storage = new AgentVaultStorage(mockAdapter);
  });

  describe('loadAll', () => {
    it('loads all agent files', async () => {
      mockAdapter.listFiles.mockResolvedValue([
        '.claude/agents/code-reviewer.md',
        '.claude/agents/test-runner.md',
      ]);
      mockAdapter.read
        .mockResolvedValueOnce(validAgentMd)
        .mockResolvedValueOnce(validAgent2Md);

      const agents = await storage.loadAll();

      expect(agents).toHaveLength(2);
      expect(agents[0].name).toBe('code-reviewer');
      expect(agents[0].description).toBe('Reviews code for issues');
      expect(agents[0].model).toBe('sonnet');
      expect(agents[0].source).toBe('vault');
      expect(agents[0].prompt).toBe('You are a code reviewer.');
      expect(agents[1].name).toBe('test-runner');
      expect(agents[1].tools).toEqual(['Bash']);
    });

    it('skips non-markdown files', async () => {
      mockAdapter.listFiles.mockResolvedValue([
        '.claude/agents/agent.md',
        '.claude/agents/readme.txt',
        '.claude/agents/config.json',
      ]);
      mockAdapter.read.mockResolvedValue(validAgentMd);

      const agents = await storage.loadAll();

      expect(agents).toHaveLength(1);
    });

    it('returns empty array when directory does not exist', async () => {
      mockAdapter.listFiles.mockRejectedValue(new Error('not found'));

      const agents = await storage.loadAll();

      expect(agents).toHaveLength(0);
    });

    it('skips malformed files', async () => {
      mockAdapter.listFiles.mockResolvedValue([
        '.claude/agents/good.md',
        '.claude/agents/bad.md',
      ]);
      mockAdapter.read
        .mockResolvedValueOnce(validAgentMd)
        .mockResolvedValueOnce('not valid frontmatter');

      const agents = await storage.loadAll();

      expect(agents).toHaveLength(1);
      expect(agents[0].name).toBe('code-reviewer');
    });

    it('continues loading if one file throws', async () => {
      mockAdapter.listFiles.mockResolvedValue([
        '.claude/agents/good.md',
        '.claude/agents/error.md',
        '.claude/agents/also-good.md',
      ]);
      mockAdapter.read
        .mockResolvedValueOnce(validAgentMd)
        .mockRejectedValueOnce(new Error('read error'))
        .mockResolvedValueOnce(validAgent2Md);

      const agents = await storage.loadAll();

      expect(agents).toHaveLength(2);
    });

    it('handles empty directory', async () => {
      mockAdapter.listFiles.mockResolvedValue([]);

      const agents = await storage.loadAll();

      expect(agents).toHaveLength(0);
    });

    it('preserves filePath from disk', async () => {
      mockAdapter.listFiles.mockResolvedValue([
        '.claude/agents/custom-filename.md',
      ]);
      mockAdapter.read.mockResolvedValue(validAgentMd);

      const agents = await storage.loadAll();

      expect(agents[0].filePath).toBe('.claude/agents/custom-filename.md');
    });

    it('parses permissionMode from frontmatter', async () => {
      const agentWithPermission = `---
name: strict-agent
description: Strict agent
permissionMode: dontAsk
---
Be strict.`;

      mockAdapter.listFiles.mockResolvedValue(['.claude/agents/strict-agent.md']);
      mockAdapter.read.mockResolvedValue(agentWithPermission);

      const agents = await storage.loadAll();

      expect(agents).toHaveLength(1);
      expect(agents[0].permissionMode).toBe('dontAsk');
    });
  });

  describe('save', () => {
    it('writes to correct file path', async () => {
      await storage.save({
        id: 'code-reviewer',
        name: 'code-reviewer',
        description: 'Reviews code',
        prompt: 'Review code.',
        source: 'vault',
      });

      expect(mockAdapter.write).toHaveBeenCalledWith(
        '.claude/agents/code-reviewer.md',
        expect.stringContaining('name: code-reviewer')
      );
    });

    it('serializes agent content correctly', async () => {
      await storage.save({
        id: 'my-agent',
        name: 'my-agent',
        description: 'My agent',
        prompt: 'Do stuff.',
        model: 'opus',
        tools: ['Read', 'Grep'],
        source: 'vault',
      });

      const written = mockAdapter.write.mock.calls[0][1] as string;
      expect(written).toContain('name: my-agent');
      expect(written).toContain('description: My agent');
      expect(written).toContain('model: opus');
      expect(written).toContain('tools:\n  - Read\n  - Grep');
      expect(written).toContain('Do stuff.');
    });
  });

  describe('delete', () => {
    it('deletes using filePath when available', async () => {
      await storage.delete({
        id: 'code-reviewer',
        name: 'code-reviewer',
        description: 'Reviews code',
        prompt: 'Review.',
        source: 'vault',
        filePath: '.claude/agents/custom-filename.md',
      });

      expect(mockAdapter.delete).toHaveBeenCalledWith('.claude/agents/custom-filename.md');
    });

    it('falls back to name-based path when no filePath', async () => {
      await storage.delete({
        id: 'code-reviewer',
        name: 'code-reviewer',
        description: 'Reviews code',
        prompt: 'Review.',
        source: 'vault',
      });

      expect(mockAdapter.delete).toHaveBeenCalledWith('.claude/agents/code-reviewer.md');
    });
  });
});
