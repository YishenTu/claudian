/**
 * PluginManager - Manage Claude Code plugin state and SDK configuration.
 *
 * Coordinates plugin discovery from PluginStorage and manages enabled state.
 */

import type { ClaudianPlugin, SdkPluginConfig } from '../types';
import type { PluginStorage } from './PluginStorage';

export class PluginManager {
  private storage: PluginStorage;
  private plugins: ClaudianPlugin[] = [];
  private enabledPluginIds: Set<string> = new Set();

  constructor(storage: PluginStorage) {
    this.storage = storage;
  }

  /**
   * Get plugins that are both enabled and available.
   */
  private getActivePlugins(): ClaudianPlugin[] {
    return this.plugins.filter((plugin) => plugin.enabled && plugin.status === 'available');
  }

  /**
   * Set the list of enabled plugin IDs.
   * Call this before loadPlugins() to apply enabled state.
   */
  setEnabledPluginIds(ids: string[]): void {
    this.enabledPluginIds = new Set(ids);
    // Update enabled state for already-loaded plugins
    for (const plugin of this.plugins) {
      plugin.enabled = this.enabledPluginIds.has(plugin.id);
    }
  }

  /**
   * Load plugins from the registry and apply enabled state.
   */
  async loadPlugins(): Promise<void> {
    this.plugins = this.storage.loadPlugins();

    // Apply enabled state
    for (const plugin of this.plugins) {
      plugin.enabled = this.enabledPluginIds.has(plugin.id);
    }
  }

  /**
   * Get all discovered plugins.
   * Sorted: project/local first, then user.
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
   * Get IDs of plugins that are enabled but unavailable.
   * Use this for cleanup on startup.
   */
  getUnavailableEnabledPlugins(): string[] {
    return this.plugins
      .filter((plugin) => plugin.enabled && plugin.status !== 'available')
      .map((plugin) => plugin.id);
  }

  /**
   * Check if any plugins are enabled.
   */
  hasEnabledPlugins(): boolean {
    return this.getActivePlugins().length > 0;
  }

  /**
   * Get the count of enabled plugins.
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
   * Returns the updated enabled IDs array for saving to settings.
   */
  togglePlugin(pluginId: string): string[] {
    const plugin = this.plugins.find((p) => p.id === pluginId);
    if (!plugin) {
      return Array.from(this.enabledPluginIds);
    }

    if (plugin.enabled) {
      this.enabledPluginIds.delete(pluginId);
      plugin.enabled = false;
    } else {
      this.enabledPluginIds.add(pluginId);
      plugin.enabled = true;
    }

    return Array.from(this.enabledPluginIds);
  }

  /**
   * Enable a plugin by ID.
   * Returns the updated enabled IDs array for saving to settings.
   */
  enablePlugin(pluginId: string): string[] {
    const plugin = this.plugins.find((p) => p.id === pluginId);
    if (plugin && !plugin.enabled) {
      this.enabledPluginIds.add(pluginId);
      plugin.enabled = true;
    }
    return Array.from(this.enabledPluginIds);
  }

  /**
   * Disable a plugin by ID.
   * Returns the updated enabled IDs array for saving to settings.
   */
  disablePlugin(pluginId: string): string[] {
    const plugin = this.plugins.find((p) => p.id === pluginId);
    if (plugin && plugin.enabled) {
      this.enabledPluginIds.delete(pluginId);
      plugin.enabled = false;
    }
    return Array.from(this.enabledPluginIds);
  }

  /**
   * Check if there are any plugins available.
   */
  hasPlugins(): boolean {
    return this.plugins.length > 0;
  }

  /**
   * Get command directories for enabled and available plugins.
   * Returns array of { pluginName, commandsPath } for plugins that have commands.
   */
  getPluginCommandPaths(): Array<{ pluginName: string; commandsPath: string }> {
    return this.getActivePlugins().map((plugin) => ({
      pluginName: plugin.name,
      commandsPath: plugin.installPath, // Commands are at {installPath}/commands/
    }));
  }
}
