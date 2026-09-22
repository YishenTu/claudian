import {
  BUILT_IN_COMMANDS,
  detectBuiltInCommand,
  getBuiltInCommandsForDropdown,
  isBuiltInCommandSupported,
} from '@/core/commands/builtInCommands';

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

    it('detects /fast command', () => {
      const result = detectBuiltInCommand('/fast');
      expect(result).not.toBeNull();
      expect(result?.command.name).toBe('fast');
      expect(result?.command.action).toBe('fast');
      expect(result?.args).toBe('');
    });

    it('leaves provider-restricted commands to other providers', () => {
      expect(detectBuiltInCommand('/fast', 'claude')).toBeNull();
      expect(detectBuiltInCommand('/fast', 'codex')?.command.action).toBe('fast');
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

  });

  describe('isBuiltInCommandSupported', () => {
    it('returns true for universal commands on any provider', () => {
      const clearCmd = BUILT_IN_COMMANDS.find((c) => c.name === 'clear')!;
      expect(isBuiltInCommandSupported(clearCmd, 'claude')).toBe(true);
      expect(isBuiltInCommandSupported(clearCmd, 'codex')).toBe(true);
    });

    it('returns false for provider-restricted commands on other providers', () => {
      const resumeCmd = BUILT_IN_COMMANDS.find((c) => c.name === 'resume')!;
      expect(isBuiltInCommandSupported(resumeCmd, { supportsNativeHistory: true })).toBe(true);
      expect(isBuiltInCommandSupported(
        resumeCmd,
        { supportsNativeHistory: false, supportsFork: true },
      )).toBe(false);
    });

    it('uses provider capabilities for provider-specific commands', () => {
      const forkCmd = BUILT_IN_COMMANDS.find((c) => c.name === 'fork')!;
      expect(isBuiltInCommandSupported(
        forkCmd,
        { supportsNativeHistory: true, supportsFork: true },
      )).toBe(true);
      expect(isBuiltInCommandSupported(
        forkCmd,
        { supportsNativeHistory: true, supportsFork: false },
      )).toBe(false);
    });

    it('enforces explicit provider restrictions', () => {
      const fastCmd = BUILT_IN_COMMANDS.find((c) => c.name === 'fast')!;
      expect(isBuiltInCommandSupported(fastCmd, 'codex')).toBe(true);
      expect(isBuiltInCommandSupported(fastCmd, 'claude')).toBe(false);
      expect(isBuiltInCommandSupported(fastCmd, {
        providerId: 'codex',
        supportsNativeHistory: true,
        supportsFork: true,
      })).toBe(true);
    });
  });

});
