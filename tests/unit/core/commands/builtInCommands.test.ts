/**
 * Tests for built-in slash commands.
 */

import {
  BUILT_IN_COMMANDS,
  detectBuiltInCommand,
  getBuiltInCommandsForDropdown,
} from '../../../../src/core/commands/builtInCommands';

describe('builtInCommands', () => {
  describe('detectBuiltInCommand', () => {
    it('detects /clear command', () => {
      const result = detectBuiltInCommand('/clear');
      expect(result).not.toBeNull();
      expect(result?.command.name).toBe('clear');
      expect(result?.command.action).toBe('clear');
      expect(result?.args).toBe('');
    });

    it('detects /new command as alias for clear', () => {
      const result = detectBuiltInCommand('/new');
      expect(result).not.toBeNull();
      expect(result?.command.name).toBe('clear');
      expect(result?.command.action).toBe('clear');
    });

    it('is case-insensitive', () => {
      expect(detectBuiltInCommand('/CLEAR')).not.toBeNull();
      expect(detectBuiltInCommand('/Clear')).not.toBeNull();
      expect(detectBuiltInCommand('/NEW')).not.toBeNull();
    });

    it('detects command with trailing whitespace', () => {
      const result = detectBuiltInCommand('/clear ');
      expect(result).not.toBeNull();
      expect(result?.command.name).toBe('clear');
      expect(result?.args).toBe('');
    });

    it('detects command with arguments', () => {
      const result = detectBuiltInCommand('/clear some arguments');
      expect(result).not.toBeNull();
      expect(result?.command.name).toBe('clear');
      expect(result?.args).toBe('some arguments');
    });

    it('detects /add-dir command with path argument', () => {
      const result = detectBuiltInCommand('/add-dir /path/to/dir');
      expect(result).not.toBeNull();
      expect(result?.command.name).toBe('add-dir');
      expect(result?.command.action).toBe('add-dir');
      expect(result?.args).toBe('/path/to/dir');
    });

    it('detects /add-dir command with home path', () => {
      const result = detectBuiltInCommand('/add-dir ~/projects');
      expect(result).not.toBeNull();
      expect(result?.command.name).toBe('add-dir');
      expect(result?.args).toBe('~/projects');
    });

    it('returns null for non-slash input', () => {
      expect(detectBuiltInCommand('clear')).toBeNull();
      expect(detectBuiltInCommand('hello /clear')).toBeNull();
    });

    it('returns null for unknown commands', () => {
      expect(detectBuiltInCommand('/unknown')).toBeNull();
      expect(detectBuiltInCommand('/foo')).toBeNull();
    });

    it('returns null for empty input', () => {
      expect(detectBuiltInCommand('')).toBeNull();
      expect(detectBuiltInCommand('   ')).toBeNull();
    });

    it('returns null for just slash', () => {
      expect(detectBuiltInCommand('/')).toBeNull();
    });
  });

  describe('getBuiltInCommandsForDropdown', () => {
    it('returns all built-in commands with proper format', () => {
      const commands = getBuiltInCommandsForDropdown();

      expect(commands.length).toBe(BUILT_IN_COMMANDS.length);

      const clearCmd = commands.find((c) => c.name === 'clear');
      expect(clearCmd).toBeDefined();
      expect(clearCmd?.id).toBe('builtin:clear');
      expect(clearCmd?.description).toBe('Start a new conversation');
      expect(clearCmd?.content).toBe('');
    });

    it('returns commands compatible with SlashCommand interface', () => {
      const commands = getBuiltInCommandsForDropdown();

      for (const cmd of commands) {
        expect(cmd).toHaveProperty('id');
        expect(cmd).toHaveProperty('name');
        expect(cmd).toHaveProperty('description');
        expect(cmd).toHaveProperty('content');
      }
    });
  });

  describe('BUILT_IN_COMMANDS', () => {
    it('has clear command with new alias', () => {
      const clearCmd = BUILT_IN_COMMANDS.find((c) => c.name === 'clear');
      expect(clearCmd).toBeDefined();
      expect(clearCmd?.aliases).toContain('new');
      expect(clearCmd?.action).toBe('clear');
    });

    it('has add-dir command that accepts args', () => {
      const addDirCmd = BUILT_IN_COMMANDS.find((c) => c.name === 'add-dir');
      expect(addDirCmd).toBeDefined();
      expect(addDirCmd?.action).toBe('add-dir');
      expect(addDirCmd?.hasArgs).toBe(true);
      expect(addDirCmd?.description).toBe('Add external context directory');
    });
  });
});
