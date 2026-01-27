/**
 * Claudian - Claude Code Plugin type definitions
 *
 * Types for discovering and managing Claude Code plugins from the global registry.
 */

export type PluginScope = 'user' | 'project' | 'local';

/** Entry in the installed_plugins.json file. */
export interface InstalledPluginEntry {
  scope: PluginScope;
  projectPath?: string;
  installPath: string;
  version: string;
  installedAt: string;
  lastUpdated?: string;
  gitCommitSha?: string;
}

/** Plugin manifest from plugin.json. */
export interface PluginManifest {
  name: string;
  description?: string;
  author?: {
    name?: string;
    email?: string;
  };
}

/** Marketplace manifest entry for multi-plugin packages. */
export interface MarketplacePluginEntry {
  name: string;
  description?: string;
  source: string;
}

/** Marketplace manifest from marketplace.json. */
export interface MarketplaceManifest {
  plugins: MarketplacePluginEntry[];
}

/** Structure of the installed_plugins.json file. */
export interface InstalledPluginsFile {
  version: number;
  plugins: Record<string, InstalledPluginEntry[]>;
}

export type PluginStatus = 'available' | 'unavailable' | 'invalid-manifest';

/** A discovered Claude Code plugin with its state. */
export interface ClaudianPlugin {
  /** Unique plugin ID (e.g., "plugin-name@marketplace"). */
  id: string;
  /** Display name from manifest. */
  name: string;
  description?: string;
  version: string;
  /** Path where the plugin is installed. */
  installPath: string;
  /** Path to the plugin entry point. */
  pluginPath: string;
  scope: PluginScope;
  /** Project path for project/local scoped plugins. */
  projectPath?: string;
  enabled: boolean;
  status: PluginStatus;
  /** Error message if unavailable or invalid. */
  error?: string;
}
