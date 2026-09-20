import '@/providers';

import {
  BUILT_IN_COMMANDS,
  getBuiltInCommandsForDropdown,
} from '@/core/commands/builtInCommands';

describe('getBuiltInCommandsForDropdown - provider filtering', () => {

  it('excludes Codex-only commands for the Claude provider', () => {
    const commands = getBuiltInCommandsForDropdown('claude');
    expect(commands.length).toBe(BUILT_IN_COMMANDS.length - 1);
    expect(commands.map(c => c.name)).toContain('clear');
    expect(commands.map(c => c.name)).toContain('resume');
    expect(commands.map(c => c.name)).toContain('fork');
    expect(commands.map(c => c.name)).not.toContain('fast');
  });

  it('returns only commands supported by codex capabilities', () => {
    const commands = getBuiltInCommandsForDropdown('codex');
    expect(commands.length).toBe(6);
    expect(commands.map(c => c.name)).toEqual([
      'clear',
      'resume',
      'fork',
      'fast',
      'side',
      'instruction',
    ]);
  });
});
