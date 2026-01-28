/**
 * Claudian - Claude Code Plugin type definitions
 *
 * Plugins are discovered from:
 * - installed_plugins.json: install paths for scanning agents
 * - settings.json: enabled state
 */

export type PluginScope = 'user' | 'project';

/** A discovered Claude Code plugin with its state. */
export interface ClaudianPlugin {
  /** Plugin ID from enabledPlugins key (e.g., "plugin-name@source"). */
  id: string;
  /** Display name (extracted from plugin ID). */
  name: string;
  /** Whether the plugin is enabled (merged result from global + project settings). */
  enabled: boolean;
  /** Where the plugin was discovered from (for UI grouping). */
  scope: PluginScope;
  /** Install path for scanning agents directory. */
  installPath: string;
}

/** Entry in installed_plugins.json for each plugin version. */
export interface InstalledPluginEntry {
  scope: 'user' | 'project';
  installPath: string;
  version: string;
  installedAt: string;
  lastUpdated: string;
  gitCommitSha?: string;
  projectPath?: string;
}

/** Structure of ~/.claude/plugins/installed_plugins.json */
export interface InstalledPluginsFile {
  version: number;
  plugins: Record<string, InstalledPluginEntry[]>;
}
