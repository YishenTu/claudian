import {
  BUILT_IN_COMMANDS,
  detectBuiltInCommand,
  getBuiltInCommandsForDropdown,
  isBuiltInCommandSupported,
} from '@/core/commands/builtInCommands';

describe('builtInCommands', () => {
  it('uses fast-mode capability rather than a provider name for detection and display', () => {
    const capable = { providerId: 'test-provider', supportsFastMode: true };
    const incapable = { providerId: 'codex', supportsFastMode: false };
    expect(detectBuiltInCommand('/fast', capable)?.command.action).toBe('fast');
    expect(getBuiltInCommandsForDropdown(capable).map(command => command.name)).toContain('fast');
    expect(detectBuiltInCommand('/fast', incapable)).toBeNull();
    expect(getBuiltInCommandsForDropdown(incapable).map(command => command.name)).not.toContain('fast');
  });

  describe('detectBuiltInCommand', () => {
    it('detects /new command', () => {
      const result = detectBuiltInCommand('/new');
      expect(result).not.toBeNull();
      expect(result?.command.name).toBe('new');
      expect(result?.command.action).toBe('clear');
      expect(result?.args).toBe('');
    });

    it('detects /clear command as alias for new', () => {
      const result = detectBuiltInCommand('/clear');
      expect(result).not.toBeNull();
      expect(result?.command.name).toBe('new');
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
      expect(result?.command.name).toBe('new');
      expect(result?.args).toBe('');
    });

    it('detects command with arguments', () => {
      const result = detectBuiltInCommand('/clear some arguments');
      expect(result).not.toBeNull();
      expect(result?.command.name).toBe('new');
      expect(result?.args).toBe('some arguments');
    });

    it('returns null for non-slash input', () => {
      expect(detectBuiltInCommand('clear')).toBeNull();
      expect(detectBuiltInCommand('hello /clear')).toBeNull();
    });

    it('returns null for unknown commands', () => {
      expect(detectBuiltInCommand('/unknown')).toBeNull();
      expect(detectBuiltInCommand('/foo')).toBeNull();
      expect(detectBuiltInCommand('/fork', { supportsFork: true })).toBeNull();
    });

    it('returns null for empty input', () => {
      expect(detectBuiltInCommand('')).toBeNull();
      expect(detectBuiltInCommand('   ')).toBeNull();
    });

    it('returns null for just slash', () => {
      expect(detectBuiltInCommand('/')).toBeNull();
    });

    it('detects /sessions command', () => {
      const result = detectBuiltInCommand('/sessions');
      expect(result).not.toBeNull();
      expect(result?.command.name).toBe('sessions');
      expect(result?.command.action).toBe('resume');
      expect(result?.args).toBe('');
    });

    it('detects /resume command as alias for sessions', () => {
      const result = detectBuiltInCommand('/resume');
      expect(result).not.toBeNull();
      expect(result?.command.name).toBe('sessions');
      expect(result?.command.action).toBe('resume');
    });

    it('detects /fast command', () => {
      const result = detectBuiltInCommand('/fast');
      expect(result).not.toBeNull();
      expect(result?.command.name).toBe('fast');
      expect(result?.command.action).toBe('fast');
      expect(result?.args).toBe('');
    });

    it('leaves unsupported commands to provider handling', () => {
      expect(detectBuiltInCommand('/fast', 'claude')).toBeNull();
      expect(detectBuiltInCommand('/fast', { supportsFastMode: true })?.command.action).toBe('fast');
    });
  });

  describe('getBuiltInCommandsForDropdown', () => {
    it('returns all built-in commands with proper format', () => {
      const commands = getBuiltInCommandsForDropdown();

      expect(commands.length).toBe(BUILT_IN_COMMANDS.length);

      const clearCmd = commands.find((c) => c.name === 'new');
      expect(clearCmd).toBeDefined();
      expect(clearCmd?.id).toBe('builtin:new');
      expect(clearCmd?.aliases).toEqual(['clear']);
      expect(clearCmd?.description).toBe('Start a new conversation');
      expect(clearCmd?.content).toBe('');
    });

  });

  describe('isBuiltInCommandSupported', () => {
    it('returns true for universal commands on any provider', () => {
      const clearCmd = BUILT_IN_COMMANDS.find((c) => c.name === 'new')!;
      expect(isBuiltInCommandSupported(clearCmd, 'claude')).toBe(true);
      expect(isBuiltInCommandSupported(clearCmd, 'codex')).toBe(true);
    });

    it('returns false for provider-restricted commands on other providers', () => {
      const resumeCmd = BUILT_IN_COMMANDS.find((c) => c.name === 'sessions')!;
      expect(isBuiltInCommandSupported(resumeCmd, { supportsNativeHistory: true })).toBe(true);
      expect(isBuiltInCommandSupported(
        resumeCmd,
        { supportsNativeHistory: false, supportsFork: true },
      )).toBe(false);
    });

    it('uses provider capabilities for provider-specific commands', () => {
      const sideCmd = BUILT_IN_COMMANDS.find((c) => c.name === 'side')!;
      expect(isBuiltInCommandSupported(
        sideCmd,
        { supportsNativeHistory: true, supportsFork: true },
      )).toBe(true);
      expect(isBuiltInCommandSupported(
        sideCmd,
        { supportsNativeHistory: true, supportsFork: false },
      )).toBe(false);
    });

    it('requires an explicit fast capability', () => {
      const fastCmd = BUILT_IN_COMMANDS.find((c) => c.name === 'fast')!;
      expect(isBuiltInCommandSupported(fastCmd, { supportsFastMode: true })).toBe(true);
      expect(isBuiltInCommandSupported(fastCmd, 'claude')).toBe(false);
      expect(isBuiltInCommandSupported(fastCmd, {
        providerId: 'codex',
        supportsFastMode: true,
        supportsNativeHistory: true,
        supportsFork: true,
      })).toBe(true);
    });
  });

});
