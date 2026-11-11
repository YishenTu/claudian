import '@/providers';

import {
  BUILT_IN_COMMANDS,
  getBuiltInCommandsForDropdown,
} from '@/core/commands/builtInCommands';
import { SlashCommandSource } from '@/shared/composer-dropdown/SlashCommandSource';

describe('getBuiltInCommandsForDropdown - provider filtering', () => {

  it('excludes Codex-only commands for the Claude provider', () => {
    const commands = getBuiltInCommandsForDropdown('claude');
    expect(commands.length).toBe(BUILT_IN_COMMANDS.length - 1);
    expect(commands.map(c => c.name)).toContain('new');
    expect(commands.map(c => c.name)).toContain('sessions');
    expect(commands.map(c => c.name)).not.toContain('fast');
  });

  it('omits compact from the Antigravity dropdown while retaining supported built-ins', () => {
    const source = new SlashCommandSource({ providerId: 'antigravity' });
    try {
      const items = source.load({ atInputStart: true, end: 1, query: '', start: 0, trigger: '/' }, new AbortController().signal);
      expect(items.map(item => item.label)).toEqual(['/new', '/sessions']);
    } finally {
      source.destroy();
    }
  });

  it('returns only commands supported by codex capabilities', () => {
    const commands = getBuiltInCommandsForDropdown('codex');
    expect(commands.length).toBe(5);
    expect(commands.map(c => c.name)).toEqual([
      'new',
      'compact',
      'sessions',
      'fast',
      'side',
    ]);
  });
});
