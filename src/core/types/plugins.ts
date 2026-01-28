/**
 * Claudian - Claude Code Plugin type definitions
 *
 * Plugins are discovered from enabledPlugins in settings.json files.
 * Global: ~/.claude/settings.json
 * Project: vault/.claude/settings.json
 */

export type PluginScope = 'user' | 'project';

/** A discovered Claude Code plugin with its state. */
export interface ClaudianPlugin {
  /** Plugin ID from enabledPlugins key (e.g., "plugin-name@source"). */
  id: string;
  /** Whether the plugin is enabled (merged result from global + project settings). */
  enabled: boolean;
  /** Where the plugin was discovered from (for UI grouping). */
  scope: PluginScope;
}
