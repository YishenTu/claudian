import { SlashCommandStorage } from '@/core/storage/SlashCommandStorage';
import type { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';
import type { SlashCommand } from '@/core/types';

describe('SlashCommandStorage', () => {
  let mockAdapter: jest.Mocked<VaultFileAdapter>;
  let storage: SlashCommandStorage;

  const mockCommand1: SlashCommand = {
    id: 'cmd-review-code',
    name: 'review-code',
    description: 'Review code for issues',
    argumentHint: '[file] [focus]',
    allowedTools: ['Read', 'Grep'],
    model: 'claude-sonnet-4-5',
    content: 'Please review $ARGUMENTS for any issues.',
  };

  const mockCommand2: SlashCommand = {
    id: 'cmd-test--coverage',
    name: 'test/coverage',
    description: 'Run test coverage',
    argumentHint: '[path]',
    allowedTools: ['Bash'],
    content: 'Run tests for $ARGUMENTS.',
  };

  const validMarkdown = `---
description: Review code for issues
argument-hint: "[file] [focus]"
allowed-tools:
  - Read
  - Grep
model: claude-sonnet-4-5
---
Please review $ARGUMENTS for any issues.`;

  const nestedMarkdown = `---
description: Run test coverage
argument-hint: "[path]"
allowed-tools:
  - Bash
---
Run tests for $ARGUMENTS.`;

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

    storage = new SlashCommandStorage(mockAdapter);
  });

  describe('loadAll', () => {
    it('loads all commands from vault', async () => {
      mockAdapter.listFilesRecursive.mockResolvedValue([
        '.claude/commands/review-code.md',
        '.claude/commands/test/coverage.md',
        '.claude/commands/deploy.sh',
      ]);
      mockAdapter.read
        .mockResolvedValueOnce(validMarkdown)
        .mockResolvedValueOnce(nestedMarkdown);

      const commands = await storage.loadAll();

      expect(commands).toHaveLength(2);
      expect(commands[0].name).toBe('review-code');
      expect(commands[1].name).toBe('test/coverage');
    });

    it('handles empty command folder', async () => {
      mockAdapter.listFilesRecursive.mockResolvedValue([]);

      const commands = await storage.loadAll();

      expect(commands).toHaveLength(0);
    });

    it('handles files that are not markdown', async () => {
      mockAdapter.listFilesRecursive.mockResolvedValue([
        '.claude/commands/review-code.md',
        '.claude/commands/deploy.sh',
        '.claude/commands/config.json',
      ]);
      mockAdapter.read.mockResolvedValue(validMarkdown);

      const commands = await storage.loadAll();

      expect(commands).toHaveLength(1);
    });

    it('continues loading if one file fails', async () => {
      mockAdapter.listFilesRecursive.mockResolvedValue([
        '.claude/commands/good.md',
        '.claude/commands/bad.md',
        '.claude/commands/good2.md',
      ]);
      mockAdapter.read
        .mockResolvedValueOnce(validMarkdown)
        .mockRejectedValueOnce(new Error('Read error'))
        .mockResolvedValueOnce(validMarkdown);

      const commands = await storage.loadAll();

      expect(commands).toHaveLength(2);
      expect(mockAdapter.listFilesRecursive).toHaveBeenCalledTimes(1);
    });

    it('handles listFilesRecursive error gracefully', async () => {
      mockAdapter.listFilesRecursive.mockRejectedValue(new Error('List error'));

      const commands = await storage.loadAll();

      expect(commands).toHaveLength(0);
    });

    it('handles deeply nested commands', async () => {
      mockAdapter.listFilesRecursive.mockResolvedValue([
        '.claude/commands/level1/level2/level3/deep.md',
      ]);
      mockAdapter.read.mockResolvedValue(validMarkdown);

      const commands = await storage.loadAll();

      expect(commands).toHaveLength(1);
      expect(commands[0].name).toBe('level1/level2/level3/deep');
    });
  });

  describe('loading single files (tested through loadAll)', () => {
    it('loads a command from file path', async () => {
      mockAdapter.listFilesRecursive.mockResolvedValue(['.claude/commands/review-code.md']);
      mockAdapter.read.mockResolvedValue(validMarkdown);

      const commands = await storage.loadAll();

      expect(commands).toHaveLength(1);
      expect(commands[0].name).toBe('review-code');
      expect(commands[0].id).toBe('cmd-review-_code');
      expect(commands[0].description).toBe('Review code for issues');
    });

    it('loads nested command correctly', async () => {
      mockAdapter.listFilesRecursive.mockResolvedValue(['.claude/commands/test/coverage.md']);
      mockAdapter.read.mockResolvedValue(nestedMarkdown);

      const commands = await storage.loadAll();

      expect(commands).toHaveLength(1);
      expect(commands[0].name).toBe('test/coverage');
      expect(commands[0].id).toBe('cmd-test--coverage');
    });

    it('handles command without optional fields', async () => {
      const simpleMarkdown = `---
description: Simple command
---
Just a simple prompt with $ARGUMENTS.`;

      mockAdapter.listFilesRecursive.mockResolvedValue(['.claude/commands/simple.md']);
      mockAdapter.read.mockResolvedValue(simpleMarkdown);

      const commands = await storage.loadAll();

      expect(commands).toHaveLength(1);
      expect(commands[0].description).toBe('Simple command');
      expect(commands[0].allowedTools).toBeUndefined();
      expect(commands[0].model).toBeUndefined();
    });

    it('passes through skill fields from frontmatter', async () => {
      const skillMarkdown = `---
description: A skill-like command
disable-model-invocation: true
user-invocable: false
context: fork
agent: code-reviewer
---
Do the thing`;

      mockAdapter.listFilesRecursive.mockResolvedValue(['.claude/commands/skill-cmd.md']);
      mockAdapter.read.mockResolvedValue(skillMarkdown);

      const commands = await storage.loadAll();

      expect(commands).toHaveLength(1);
      expect(commands[0].disableModelInvocation).toBe(true);
      expect(commands[0].userInvocable).toBe(false);
      expect(commands[0].context).toBe('fork');
      expect(commands[0].agent).toBe('code-reviewer');
    });
  });

  describe('save', () => {
    it('saves command to correct file path', async () => {
      await storage.save(mockCommand1);

      const expectedPath = '.claude/commands/review-code.md';
      expect(mockAdapter.write).toHaveBeenCalledWith(expectedPath, expect.stringContaining('description: Review code for issues'));
    });

    it('saves nested command to correct nested path', async () => {
      await storage.save(mockCommand2);

      const expectedPath = '.claude/commands/test/coverage.md';
      expect(mockAdapter.write).toHaveBeenCalledWith(expectedPath, expect.stringContaining('description: Run test coverage'));
    });

    it('serializes command with all fields', async () => {
      await storage.save(mockCommand1);

      expect(mockAdapter.write).toHaveBeenCalledWith(
        '.claude/commands/review-code.md',
        expect.stringContaining('---')
      );
      expect(mockAdapter.write).toHaveBeenCalledWith(
        '.claude/commands/review-code.md',
        expect.stringContaining('description: Review code for issues')
      );
      expect(mockAdapter.write).toHaveBeenCalledWith(
        '.claude/commands/review-code.md',
        expect.stringContaining('argument-hint: [file] [focus]')
      );
      expect(mockAdapter.write).toHaveBeenCalledWith(
        '.claude/commands/review-code.md',
        expect.stringContaining('allowed-tools:')
      );
      expect(mockAdapter.write).toHaveBeenCalledWith(
        '.claude/commands/review-code.md',
        expect.stringContaining('model: claude-sonnet-4-5')
      );
      expect(mockAdapter.write).toHaveBeenCalledWith(
        '.claude/commands/review-code.md',
        expect.stringContaining('Please review $ARGUMENTS')
      );
    });

    it('handles special characters in description', async () => {
      const commandWithSpecial: SlashCommand = {
        ...mockCommand1,
        description: 'Test: value with # and spaces',
      };

      await storage.save(commandWithSpecial);

      expect(mockAdapter.write).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining('description: "Test: value with # and spaces"')
      );
    });

    it('handles multiline descriptions', async () => {
      const commandWithMultiline: SlashCommand = {
        ...mockCommand1,
        description: 'Line1\nLine2\nLine3',
      };

      await storage.save(commandWithMultiline);

      expect(mockAdapter.write).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining('description: "Line1\nLine2\nLine3"')
      );
    });

    it('sanitizes command name when generating path', async () => {
      const commandWithInvalidName: SlashCommand = {
        ...mockCommand1,
        name: 'test command!@#',
      };

      await storage.save(commandWithInvalidName);

      expect(mockAdapter.write).toHaveBeenCalledWith(
        '.claude/commands/test-command---.md',
        expect.anything()
      );
    });

    it('preserves slashes for deeply nested command path', async () => {
      const command: SlashCommand = {
        ...mockCommand1,
        name: 'level1/level2/level3',
      };

      await storage.save(command);

      expect(mockAdapter.write).toHaveBeenCalledWith(
        '.claude/commands/level1/level2/level3.md',
        expect.anything()
      );
    });

    it('serializes skill fields in kebab-case', async () => {
      const command: SlashCommand = {
        ...mockCommand1,
        disableModelInvocation: true,
        userInvocable: false,
        context: 'fork',
        agent: 'code-reviewer',
      };

      await storage.save(command);

      const written = mockAdapter.write.mock.calls[0][1] as string;
      expect(written).toContain('disable-model-invocation: true');
      expect(written).toContain('user-invocable: false');
      expect(written).toContain('context: fork');
      expect(written).toContain('agent: code-reviewer');
      // Should NOT contain camelCase variants
      expect(written).not.toContain('disableModelInvocation');
      expect(written).not.toContain('userInvocable');
    });

    it('omits skill fields when undefined', async () => {
      await storage.save(mockCommand1);

      const written = mockAdapter.write.mock.calls[0][1] as string;
      expect(written).not.toContain('disable-model-invocation');
      expect(written).not.toContain('user-invocable');
      expect(written).not.toContain('context');
      expect(written).not.toContain('agent');
      expect(written).not.toContain('hooks');
    });

    it('serializes hooks as JSON', async () => {
      const hooks = { PreToolUse: [{ matcher: 'Bash' }] };
      const command: SlashCommand = {
        ...mockCommand1,
        hooks,
      };

      await storage.save(command);

      const written = mockAdapter.write.mock.calls[0][1] as string;
      expect(written).toContain(`hooks: ${JSON.stringify(hooks)}`);
    });

    it('round-trips skill fields through save and load', async () => {
      const command: SlashCommand = {
        id: 'cmd-roundtrip',
        name: 'roundtrip',
        description: 'Round trip test',
        content: 'Do the thing',
        disableModelInvocation: true,
        userInvocable: false,
        context: 'fork',
        agent: 'code-reviewer',
      };

      await storage.save(command);

      const written = mockAdapter.write.mock.calls[0][1] as string;
      mockAdapter.read.mockResolvedValue(written);
      mockAdapter.listFilesRecursive.mockResolvedValue(['.claude/commands/roundtrip.md']);
      const loaded = await storage.loadAll();

      expect(loaded).toHaveLength(1);
      expect(loaded[0].disableModelInvocation).toBe(true);
      expect(loaded[0].userInvocable).toBe(false);
      expect(loaded[0].context).toBe('fork');
      expect(loaded[0].agent).toBe('code-reviewer');
      expect(loaded[0].content).toBe('Do the thing');
    });
  });

  describe('delete', () => {
    it('deletes command by ID', async () => {
      mockAdapter.listFilesRecursive.mockResolvedValue([
        '.claude/commands/review-code.md',
        '.claude/commands/test/coverage.md',
      ]);

      await storage.delete('cmd-review-_code');

      expect(mockAdapter.delete).toHaveBeenCalledWith('.claude/commands/review-code.md');
    });

    it('deletes nested command by ID', async () => {
      mockAdapter.listFilesRecursive.mockResolvedValue([
        '.claude/commands/test/coverage.md',
      ]);

      await storage.delete('cmd-test--coverage');

      expect(mockAdapter.delete).toHaveBeenCalledWith('.claude/commands/test/coverage.md');
    });

    it('handles command with dashes in name', async () => {
      mockAdapter.listFilesRecursive.mockResolvedValue([
        '.claude/commands/test-command.md',
      ]);

      await storage.delete('cmd-test-_command');

      expect(mockAdapter.delete).toHaveBeenCalledWith('.claude/commands/test-command.md');
    });

    it('does nothing if command ID not found', async () => {
      mockAdapter.listFilesRecursive.mockResolvedValue([
        '.claude/commands/review-code.md',
      ]);

      await storage.delete('cmd-nonexistent');

      expect(mockAdapter.delete).not.toHaveBeenCalled();
    });

    it('handles list error gracefully', async () => {
      mockAdapter.listFilesRecursive.mockRejectedValue(new Error('List error'));

      await expect(storage.delete('cmd-test')).rejects.toThrow('List error');
      expect(mockAdapter.delete).not.toHaveBeenCalled();
    });

    it('handles non-markdown files', async () => {
      mockAdapter.listFilesRecursive.mockResolvedValue([
        '.claude/commands/config.json',
      ]);

      await storage.delete('cmd-config');

      expect(mockAdapter.delete).not.toHaveBeenCalled();
    });
  });

  describe('filePathToId (private method tested through loadAll)', () => {
    it('encodes simple path correctly', async () => {
      mockAdapter.listFilesRecursive.mockResolvedValue(['.claude/commands/test.md']);
      mockAdapter.read.mockResolvedValue(validMarkdown);

      const commands = await storage.loadAll();
      expect(commands[0].id).toBe('cmd-test');
    });

    it('encodes path with slashes correctly', async () => {
      mockAdapter.listFilesRecursive.mockResolvedValue(['.claude/commands/a/b.md']);
      mockAdapter.read.mockResolvedValue(validMarkdown);

      const commands = await storage.loadAll();
      expect(commands[0].id).toBe('cmd-a--b');
    });

    it('encodes path with dashes correctly', async () => {
      mockAdapter.listFilesRecursive.mockResolvedValue(['.claude/commands/a-b.md']);
      mockAdapter.read.mockResolvedValue(validMarkdown);

      const commands = await storage.loadAll();
      expect(commands[0].id).toBe('cmd-a-_b');
    });

    it('encodes path with both slashes and dashes correctly', async () => {
      mockAdapter.listFilesRecursive.mockResolvedValue(['.claude/commands/a/b-c.md']);
      mockAdapter.read.mockResolvedValue(validMarkdown);

      const commands = await storage.loadAll();
      expect(commands[0].id).toBe('cmd-a--b-_c');
    });

    it('encodes path with double dashes correctly', async () => {
      mockAdapter.listFilesRecursive.mockResolvedValue(['.claude/commands/a--b.md']);
      mockAdapter.read.mockResolvedValue(validMarkdown);

      const commands = await storage.loadAll();
      expect(commands[0].id).toBe('cmd-a-_-_b');
    });
  });

  describe('filePathToName (private method tested through loadAll)', () => {
    it('extracts name from simple path', async () => {
      mockAdapter.listFilesRecursive.mockResolvedValue(['.claude/commands/test.md']);
      mockAdapter.read.mockResolvedValue(validMarkdown);

      const commands = await storage.loadAll();
      expect(commands[0].name).toBe('test');
    });

    it('extracts name from nested path', async () => {
      mockAdapter.listFilesRecursive.mockResolvedValue(['.claude/commands/a/b/c.md']);
      mockAdapter.read.mockResolvedValue(validMarkdown);

      const commands = await storage.loadAll();
      expect(commands[0].name).toBe('a/b/c');
    });
  });

  describe('yamlString (private method tested through save)', () => {
    it('quotes strings with colons', async () => {
      const command: SlashCommand = {
        ...mockCommand1,
        description: 'key:value',
      };

      await storage.save(command);

      expect(mockAdapter.write).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining('description: "key:value"')
      );
    });

    it('quotes strings starting with space', async () => {
      const command: SlashCommand = {
        ...mockCommand1,
        description: ' spaced',
      };

      await storage.save(command);

      expect(mockAdapter.write).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining('description: " spaced"')
      );
    });

    it('quotes strings ending with space', async () => {
      const command: SlashCommand = {
        ...mockCommand1,
        description: 'spaced ',
      };

      await storage.save(command);

      expect(mockAdapter.write).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining('description: "spaced "')
      );
    });

    it('handles strings with quotes', async () => {
      const command: SlashCommand = {
        ...mockCommand1,
        description: 'text with "quotes"',
      };

      await storage.save(command);

      expect(mockAdapter.write).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining('description: text with "quotes"')
      );
    });

    it('does not quote simple strings', async () => {
      await storage.save(mockCommand1);

      expect(mockAdapter.write).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining('description: Review code for issues')
      );
    });
  });

  describe('empty metadata handling', () => {
    it('adds blank line in frontmatter when no metadata exists', async () => {
      const commandNoMetadata: SlashCommand = {
        id: 'cmd-simple',
        name: 'simple',
        content: 'Just a prompt',
      };

      await storage.save(commandNoMetadata);

      const writeCall = mockAdapter.write.mock.calls[0];
      const writtenContent = writeCall[1] as string;

      expect(writtenContent).toBe('---\nname: simple\n---\nJust a prompt');
    });

    it('produces parseable frontmatter even with no metadata', async () => {
      const commandNoMetadata: SlashCommand = {
        id: 'cmd-simple',
        name: 'simple',
        content: 'Just a prompt',
      };

      await storage.save(commandNoMetadata);

      const writeCall = mockAdapter.write.mock.calls[0];
      const writtenContent = writeCall[1] as string;

      // Simulate loading it back - should parse correctly
      mockAdapter.read.mockResolvedValue(writtenContent);
      mockAdapter.listFilesRecursive.mockResolvedValue(['.claude/commands/simple.md']);
      const loaded = await storage.loadAll();

      expect(loaded).toHaveLength(1);
      expect(loaded[0].content).toBe('Just a prompt');
    });

    it('does not add extra blank line when metadata exists', async () => {
      await storage.save(mockCommand1);

      const writeCall = mockAdapter.write.mock.calls[0];
      const writtenContent = writeCall[1] as string;

      // Should not have double newlines between description and ---
      expect(writtenContent).not.toMatch(/description: .*\n\n---/);
    });
  });
});
