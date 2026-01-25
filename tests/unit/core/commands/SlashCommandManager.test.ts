/**
 * Tests for SlashCommandManager - command registry for dropdown UI.
 *
 * SDK handles all command expansion. This class only manages the registry.
 */

import { SlashCommandManager } from '@/core/commands/SlashCommandManager';
import type { SlashCommand } from '@/core/types';

describe('SlashCommandManager', () => {
  let manager: SlashCommandManager;

  beforeEach(() => {
    manager = new SlashCommandManager();
  });

  describe('setCommands', () => {
    it('should register commands', () => {
      const commands: SlashCommand[] = [
        { id: 'test', name: 'test', description: 'Test command', content: '' },
        { id: 'other', name: 'other', description: 'Other command', content: '' },
      ];
      manager.setCommands(commands);

      expect(manager.getCommands()).toHaveLength(2);
    });

    it('should clear previous commands when setting new ones', () => {
      manager.setCommands([
        { id: 'first', name: 'first', description: '', content: '' },
      ]);
      manager.setCommands([
        { id: 'second', name: 'second', description: '', content: '' },
      ]);

      const commands = manager.getCommands();
      expect(commands).toHaveLength(1);
      expect(commands[0].name).toBe('second');
    });
  });

  describe('getCommand', () => {
    it('should return command by name (case-insensitive)', () => {
      manager.setCommands([
        { id: 'test', name: 'MyCommand', description: 'Test', content: '' },
      ]);

      expect(manager.getCommand('mycommand')?.name).toBe('MyCommand');
      expect(manager.getCommand('MYCOMMAND')?.name).toBe('MyCommand');
      expect(manager.getCommand('MyCommand')?.name).toBe('MyCommand');
    });

    it('should return undefined for unknown command', () => {
      manager.setCommands([]);
      expect(manager.getCommand('unknown')).toBeUndefined();
    });
  });

  describe('getMatchingCommands', () => {
    beforeEach(() => {
      manager.setCommands([
        { id: 'commit', name: 'commit', description: 'Create a git commit', content: '' },
        { id: 'pr', name: 'pr', description: 'Create a pull request', content: '' },
        { id: 'clear', name: 'clear', description: 'Clear the conversation', content: '' },
        { id: 'review', name: 'review', description: 'Review code', content: '' },
        { id: 'commit-push', name: 'commit-push', description: 'Commit and push', content: '' },
      ]);
    });

    it('should filter by name prefix', () => {
      const matches = manager.getMatchingCommands('com');
      expect(matches.map(c => c.name)).toEqual(['commit', 'commit-push']);
    });

    it('should filter by description', () => {
      const matches = manager.getMatchingCommands('pull');
      expect(matches.map(c => c.name)).toEqual(['pr']);
    });

    it('should return sorted results', () => {
      const matches = manager.getMatchingCommands('');
      const names = matches.map(c => c.name);
      expect(names).toEqual([...names].sort());
    });

    it('should limit results to 10', () => {
      const manyCommands: SlashCommand[] = Array.from({ length: 15 }, (_, i) => ({
        id: `cmd${i}`,
        name: `cmd${i}`,
        description: '',
        content: '',
      }));
      manager.setCommands(manyCommands);

      const matches = manager.getMatchingCommands('cmd');
      expect(matches).toHaveLength(10);
    });

    it('should be case-insensitive', () => {
      const matches = manager.getMatchingCommands('COMMIT');
      expect(matches.map(c => c.name)).toEqual(['commit', 'commit-push']);
    });
  });

  describe('getCommands', () => {
    it('should return empty array when no commands registered', () => {
      expect(manager.getCommands()).toEqual([]);
    });

    it('should return all registered commands', () => {
      manager.setCommands([
        { id: 'a', name: 'a', description: '', content: '' },
        { id: 'b', name: 'b', description: '', content: '' },
      ]);

      expect(manager.getCommands()).toHaveLength(2);
    });
  });
});
