import { TFile } from 'obsidian';

import { SlashCommandManager } from '@/core/commands';
import type { SlashCommand } from '@/core/types';
import { parseSlashCommandContent } from '@/utils/slashCommand';

function createMockApp(files: Record<string, string>) {
  return {
    vault: {
      getAbstractFileByPath: jest.fn((p: string) => {
        if (!(p in files)) {
          return null;
        }
        return new (TFile as any)(p);
      }),
      read: jest.fn(async (file: TFile) => files[file.path] ?? ''),
    },
  } as any;
}

describe('SlashCommandManager', () => {
  describe('detectCommand', () => {
    it('should detect registered commands and parse args', () => {
      const app = createMockApp({});
      const manager = new SlashCommandManager(app, '/vault');

      const commands: SlashCommand[] = [
        { id: '1', name: 'test', content: 'Hello' },
        { id: '2', name: 'review-code', content: 'Hi' },
      ];
      manager.setCommands(commands);

      expect(manager.detectCommand('/test one two')).toEqual({ commandName: 'test', args: 'one two' });
      expect(manager.detectCommand('/review-code  a   b ')).toEqual({ commandName: 'review-code', args: 'a   b' });
      expect(manager.detectCommand('   /review-code arg')).toBeNull(); // Leading whitespace not allowed
      expect(manager.detectCommand('@note.md /test')).toBeNull(); // Command not at start
      expect(manager.detectCommand('/unknown arg')).toBeNull();
    });
  });

  describe('parseSlashCommandContent', () => {
    it('should parse frontmatter with CRLF and multiline arrays', () => {
      const content = [
        '---\r',
        'description: "Desc"\r',
        "argument-hint: '<file>'\r",
        'model: sonnet\r',
        'allowed-tools:\r',
        '  - Read\r',
        '  - "Write"\r',
        '---\r',
        '\r',
        'Hello',
      ].join('\n');

      const parsed = parseSlashCommandContent(content);
      expect(parsed.description).toBe('Desc');
      expect(parsed.argumentHint).toBe('<file>');
      expect(parsed.model).toBe('sonnet');
      expect(parsed.allowedTools).toEqual(['Read', 'Write']);
      expect(parsed.promptContent.trim()).toBe('Hello');
    });
  });

  describe('expandCommand', () => {
    it('should replace $ARGUMENTS and positional args', async () => {
      const app = createMockApp({});
      const manager = new SlashCommandManager(app, '/vault');

      const command: SlashCommand = {
        id: '1',
        name: 'args',
        content: 'All: $ARGUMENTS\nFirst: $1\nSecond: $2\nThird: $3',
      };

      const result = await manager.expandCommand(command, 'one "two words"');
      expect(result.expandedPrompt).toBe('All: one "two words"\nFirst: one\nSecond: two words\nThird:');
    });

    it('should auto-append args when no placeholders exist', async () => {
      const app = createMockApp({ 'note.md': 'Note content here' });
      const manager = new SlashCommandManager(app, '/vault');

      const command: SlashCommand = {
        id: '1',
        name: 'summary',
        content: 'Summarize this:',
      };

      const result = await manager.expandCommand(command, '@note.md');
      expect(result.expandedPrompt).toBe('Summarize this:\n\nNote content here');
    });

    it('should not auto-append when args are empty', async () => {
      const app = createMockApp({});
      const manager = new SlashCommandManager(app, '/vault');

      const command: SlashCommand = {
        id: '1',
        name: 'status',
        content: 'Show status',
      };

      const result = await manager.expandCommand(command, '');
      expect(result.expandedPrompt).toBe('Show status');
    });

    it('should not auto-append when $ARGUMENTS placeholder exists', async () => {
      const app = createMockApp({ 'note.md': 'Note content' });
      const manager = new SlashCommandManager(app, '/vault');

      const command: SlashCommand = {
        id: '1',
        name: 'review',
        content: 'Review: $ARGUMENTS\nEnd.',
      };

      const result = await manager.expandCommand(command, '@note.md');
      expect(result.expandedPrompt).toBe('Review: Note content\nEnd.');
    });

    it('should resolve @file references with boundary rules', async () => {
      const app = createMockApp({
        'foo.md': 'FOO',
        'bar.md': 'BAR',
      });
      const manager = new SlashCommandManager(app, '/vault');

      const command: SlashCommand = {
        id: '1',
        name: 'files',
        content: [
          'Email: user@example.com',
          'Ref: @foo.md',
          'Paren: (@bar.md)',
          'WordPrefix: foo@baz.md',
        ].join('\n'),
      };

      const result = await manager.expandCommand(command, '');
      expect(result.expandedPrompt).toContain('Email: user@example.com');
      expect(result.expandedPrompt).toContain('Ref: FOO');
      expect(result.expandedPrompt).toContain('Paren: (BAR)');
      expect(result.expandedPrompt).toContain('WordPrefix: foo@baz.md');
    });

    it('should not execute inline bash from referenced file content', async () => {
      const app = createMockApp({
        'foo.md': '!`echo injected`',
      });

      const bashRunner = jest.fn(async () => 'SHOULD_NOT_RUN');
      const manager = new SlashCommandManager(app, '/vault', { bashRunner });

      const command: SlashCommand = {
        id: '1',
        name: 'file-only',
        content: '@foo.md',
      };

      const result = await manager.expandCommand(command, '', { bash: { enabled: true } });
      expect(result.expandedPrompt).toBe('!`echo injected`');
      expect(bashRunner).not.toHaveBeenCalled();
    });

    it('should block inline bash before execution', async () => {
      const app = createMockApp({});
      const bashRunner = jest.fn(async () => 'OUT');
      const manager = new SlashCommandManager(app, '/vault', { bashRunner });

      const command: SlashCommand = {
        id: '1',
        name: 'blocked',
        content: '!`rm -rf /`',
      };

      const result = await manager.expandCommand(command, '', {
        bash: {
          enabled: true,
          shouldBlockCommand: () => true,
        },
      });

      expect(result.expandedPrompt).toBe('[Blocked]');
      expect(result.errors.some((e) => e.includes('blocked by blocklist'))).toBe(true);
      expect(bashRunner).not.toHaveBeenCalled();
    });

    it('should require approval for inline bash when configured', async () => {
      const app = createMockApp({});
      const bashRunner = jest.fn(async () => 'OUT');
      const manager = new SlashCommandManager(app, '/vault', { bashRunner });

      const command: SlashCommand = {
        id: '1',
        name: 'approve',
        content: '!`echo hi`',
      };

      const denied = await manager.expandCommand(command, '', {
        bash: {
          enabled: true,
          requestApproval: async () => false,
        },
      });
      expect(denied.expandedPrompt).toBe('[Denied]');
      expect(bashRunner).not.toHaveBeenCalled();

      const allowed = await manager.expandCommand(command, '', {
        bash: {
          enabled: true,
          requestApproval: async () => true,
        },
      });
      expect(allowed.expandedPrompt).toBe('OUT');
      expect(bashRunner).toHaveBeenCalled();
    });
  });
});

