/**
 * PluginManager - Manage Claude Code plugin state and SDK configuration.
 *
 * Coordinates plugin discovery from PluginStorage and manages enabled state
 * via CC settings (.claude/settings.json) for CLI compatibility.
 *
 * Plugin enabled state:
 * - Plugins are enabled by default unless explicitly disabled
 * - Disabled state is stored in .claude/settings.json as enabledPlugins: { "id": false }
 * - This ensures the CLI respects Claudian's disable decisions
 */

import type { CCSettingsStorage } from '../storage/CCSettingsStorage';
import type { ClaudianPlugin, SdkPluginConfig } from '../types';
import type { PluginStorage } from './PluginStorage';

export class PluginManager {
  private pluginStorage: PluginStorage;
  private ccSettingsStorage: CCSettingsStorage;
  private plugins: ClaudianPlugin[] = [];
  /** Map of plugin ID to enabled state from CC settings. */
  private enabledState: Record<string, boolean> = {};

  constructor(pluginStorage: PluginStorage, ccSettingsStorage: CCSettingsStorage) {
    this.pluginStorage = pluginStorage;
    this.ccSettingsStorage = ccSettingsStorage;
  }

  /**
   * Get plugins that are both enabled and available.
   */
  private getActivePlugins(): ClaudianPlugin[] {
    return this.plugins.filter((plugin) => plugin.enabled && plugin.status === 'available');
  }

  /**
   * Check if a plugin is enabled based on CC settings.
   * Plugins are enabled by default unless explicitly set to false.
   */
  private isPluginEnabled(pluginId: string): boolean {
    const state = this.enabledState[pluginId];
    // Enabled by default unless explicitly disabled
    return state !== false;
  }

  /**
   * Apply enabled state to all plugins based on CC settings.
   */
  private applyEnabledState(): void {
    for (const plugin of this.plugins) {
      plugin.enabled = this.isPluginEnabled(plugin.id);
    }
  }

  /**
   * Load enabled state from CC settings.
   * Call this before or after loadPlugins().
   */
  async loadEnabledState(): Promise<void> {
    this.enabledState = await this.ccSettingsStorage.getEnabledPlugins();
    this.applyEnabledState();
  }

  /**
   * Load plugins from the registry and apply enabled state.
   */
  async loadPlugins(): Promise<void> {
    this.plugins = this.pluginStorage.loadPlugins();
    this.applyEnabledState();
  }

  /**
   * Get all discovered plugins.
   * Returns a copy of the plugins array (sorted by PluginStorage: project/local first, then user).
   */
  getPlugins(): ClaudianPlugin[] {
    return [...this.plugins];
  }

  /**
   * Get SDK plugin configs for enabled and available plugins.
   */
  getActivePluginConfigs(): SdkPluginConfig[] {
    return this.getActivePlugins().map((plugin) => ({
      type: 'local' as const,
      path: plugin.pluginPath,
    }));
  }

  /**
   * Check if any plugins are enabled and available.
   */
  hasEnabledPlugins(): boolean {
    return this.getActivePlugins().length > 0;
  }

  /**
   * Get the count of enabled and available plugins.
   */
  getEnabledCount(): number {
    return this.getActivePlugins().length;
  }

  /**
   * Get a stable key representing active plugin configuration.
   * Used to detect changes that require restarting the persistent query.
   */
  getPluginsKey(): string {
    const activePlugins = this.getActivePlugins().sort((a, b) => a.id.localeCompare(b.id));

    if (activePlugins.length === 0) {
      return '';
    }

    // Create a stable key from id and pluginPath
    return activePlugins.map((plugin) => `${plugin.id}:${plugin.pluginPath}`).join('|');
  }

  /**
   * Toggle a plugin's enabled state.
   * Writes to .claude/settings.json so CLI respects the state.
   */
  async togglePlugin(pluginId: string): Promise<void> {
    const plugin = this.plugins.find((p) => p.id === pluginId);
    if (!plugin) {
      return;
    }

    const newEnabled = !plugin.enabled;

    // Update local state
    this.enabledState[pluginId] = newEnabled;
    plugin.enabled = newEnabled;

    // Persist to CC settings
    await this.ccSettingsStorage.setPluginEnabled(pluginId, newEnabled);
  }

  /**
   * Enable a plugin by ID.
   * Writes to .claude/settings.json so CLI respects the state.
   */
  async enablePlugin(pluginId: string): Promise<void> {
    const plugin = this.plugins.find((p) => p.id === pluginId);
    if (!plugin || plugin.enabled) {
      return;
    }

    // Update local state
    this.enabledState[pluginId] = true;
    plugin.enabled = true;

    // Persist to CC settings
    await this.ccSettingsStorage.setPluginEnabled(pluginId, true);
  }

  /**
   * Disable a plugin by ID.
   * Writes to .claude/settings.json so CLI respects the state.
   */
  async disablePlugin(pluginId: string): Promise<void> {
    const plugin = this.plugins.find((p) => p.id === pluginId);
    if (!plugin || !plugin.enabled) {
      return;
    }

    // Update local state
    this.enabledState[pluginId] = false;
    plugin.enabled = false;

    // Persist to CC settings
    await this.ccSettingsStorage.setPluginEnabled(pluginId, false);
  }

  /**
   * Check if there are any plugins available.
   */
  hasPlugins(): boolean {
    return this.plugins.length > 0;
  }

  /**
   * Get install paths for enabled and available plugins.
   * Returns array of { pluginName, commandsPath } for each active plugin.
   * Note: Actual command existence is verified by loadPluginCommands().
   */
  getPluginCommandPaths(): Array<{ pluginName: string; commandsPath: string }> {
    return this.getActivePlugins().map((plugin) => ({
      pluginName: plugin.name,
      commandsPath: plugin.installPath, // The commands subdirectory is appended by loadPluginCommands()
    }));
  }
}
