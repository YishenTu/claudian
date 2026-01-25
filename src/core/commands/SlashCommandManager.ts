/**
 * Claudian - Slash command manager
 *
 * Core logic for managing slash commands.
 * SDK handles all command expansion - this class only manages the command registry
 * for dropdown UI and command lookup.
 */

import type { SlashCommand } from '../types';

/** Manages slash command registry for dropdown UI. */
export class SlashCommandManager {
  private commands: Map<string, SlashCommand> = new Map();

  /** Registers commands from settings. */
  setCommands(commands: SlashCommand[]): void {
    this.commands.clear();
    for (const cmd of commands) {
      this.commands.set(cmd.name.toLowerCase(), cmd);
    }
  }

  /** Gets all registered commands. */
  getCommands(): SlashCommand[] {
    return Array.from(this.commands.values());
  }

  /** Gets a command by name. */
  getCommand(name: string): SlashCommand | undefined {
    return this.commands.get(name.toLowerCase());
  }

  /** Gets filtered commands matching a prefix, sorted alphabetically. */
  getMatchingCommands(prefix: string): SlashCommand[] {
    const prefixLower = prefix.toLowerCase();
    return this.getCommands()
      .filter(cmd =>
        cmd.name.toLowerCase().includes(prefixLower) ||
        cmd.description?.toLowerCase().includes(prefixLower)
      )
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 10);
  }
}
