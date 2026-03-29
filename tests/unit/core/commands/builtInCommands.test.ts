import {
  BUILT_IN_COMMANDS,
  detectBuiltInCommand,
  getBuiltInCommandsForDropdown,
  isBuiltInCommandSupported,
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

    it('detects /resume command', () => {
      const result = detectBuiltInCommand('/resume');
      expect(result).not.toBeNull();
      expect(result?.command.name).toBe('resume');
      expect(result?.command.action).toBe('resume');
      expect(result?.args).toBe('');
    });

    it('detects /fork command', () => {
      const result = detectBuiltInCommand('/fork');
      expect(result).not.toBeNull();
      expect(result?.command.name).toBe('fork');
      expect(result?.command.action).toBe('fork');
      expect(result?.args).toBe('');
    });

    it('detects /fork case-insensitively', () => {
      expect(detectBuiltInCommand('/FORK')).not.toBeNull();
      expect(detectBuiltInCommand('/Fork')).not.toBeNull();
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

    it('has resume command', () => {
      const resumeCmd = BUILT_IN_COMMANDS.find((c) => c.name === 'resume');
      expect(resumeCmd).toBeDefined();
      expect(resumeCmd?.action).toBe('resume');
      expect(resumeCmd?.description).toBe('Resume a previous conversation');
    });

    it('has fork command without args', () => {
      const forkCmd = BUILT_IN_COMMANDS.find((c) => c.name === 'fork');
      expect(forkCmd).toBeDefined();
      expect(forkCmd?.action).toBe('fork');
      expect(forkCmd?.hasArgs).toBeUndefined();
    });

    it('clear has no provider restriction', () => {
      const clearCmd = BUILT_IN_COMMANDS.find((c) => c.name === 'clear');
      expect(clearCmd?.providers).toBeUndefined();
    });

    it('add-dir is restricted to claude', () => {
      const cmd = BUILT_IN_COMMANDS.find((c) => c.name === 'add-dir');
      expect(cmd?.providers).toEqual(['claude']);
    });

    it('resume is restricted to claude', () => {
      const cmd = BUILT_IN_COMMANDS.find((c) => c.name === 'resume');
      expect(cmd?.providers).toEqual(['claude']);
    });

    it('fork is restricted to claude', () => {
      const cmd = BUILT_IN_COMMANDS.find((c) => c.name === 'fork');
      expect(cmd?.providers).toEqual(['claude']);
    });
  });

  describe('getBuiltInCommandsForDropdown - provider filtering', () => {
    it('returns all commands when no providerId is given', () => {
      const commands = getBuiltInCommandsForDropdown();
      expect(commands.length).toBe(BUILT_IN_COMMANDS.length);
    });

    it('returns all commands for claude provider', () => {
      const commands = getBuiltInCommandsForDropdown('claude');
      expect(commands.length).toBe(BUILT_IN_COMMANDS.length);
      expect(commands.map(c => c.name)).toContain('clear');
      expect(commands.map(c => c.name)).toContain('add-dir');
      expect(commands.map(c => c.name)).toContain('resume');
      expect(commands.map(c => c.name)).toContain('fork');
    });

    it('returns only universal commands for codex provider', () => {
      const commands = getBuiltInCommandsForDropdown('codex');
      const names = commands.map(c => c.name);
      expect(names).toContain('clear');
      expect(names).not.toContain('add-dir');
      expect(names).not.toContain('resume');
      expect(names).not.toContain('fork');
    });

    it('returns only universal commands for unknown provider', () => {
      const commands = getBuiltInCommandsForDropdown('codex');
      expect(commands.length).toBe(1);
      expect(commands[0].name).toBe('clear');
    });
  });

  describe('isBuiltInCommandSupported', () => {
    it('returns true for universal commands on any provider', () => {
      const clearCmd = BUILT_IN_COMMANDS.find((c) => c.name === 'clear')!;
      expect(isBuiltInCommandSupported(clearCmd, 'claude')).toBe(true);
      expect(isBuiltInCommandSupported(clearCmd, 'codex')).toBe(true);
    });

    it('returns false for provider-restricted commands on other providers', () => {
      const resumeCmd = BUILT_IN_COMMANDS.find((c) => c.name === 'resume')!;
      expect(isBuiltInCommandSupported(resumeCmd, 'claude')).toBe(true);
      expect(isBuiltInCommandSupported(resumeCmd, 'codex')).toBe(false);
    });
  });

});
