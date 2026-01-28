/**
 * PluginManager - Discover and manage Claude Code plugins.
 *
 * Plugins are discovered from two sources:
 * - installed_plugins.json: provides install paths for scanning agents
 * - settings.json: provides enabled state (global + project)
 *
 * Merge logic for enabled state:
 * - All plugins with `true` from either scope are discoverable
 * - Project `false` can disable a globally-enabled plugin
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { CCSettingsStorage } from '../storage/CCSettingsStorage';
import type { ClaudianPlugin, InstalledPluginsFile, PluginScope } from '../types';

const INSTALLED_PLUGINS_PATH = path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json');
const GLOBAL_SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');

interface SettingsFile {
  enabledPlugins?: Record<string, boolean>;
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

function extractPluginName(pluginId: string): string {
  // Plugin ID format: "plugin-name@source"
  const atIndex = pluginId.indexOf('@');
  if (atIndex > 0) {
    return pluginId.substring(0, atIndex);
  }
  return pluginId;
}

export class PluginManager {
  private ccSettingsStorage: CCSettingsStorage;
  private vaultPath: string;
  private plugins: ClaudianPlugin[] = [];

  constructor(vaultPath: string, ccSettingsStorage: CCSettingsStorage) {
    this.vaultPath = vaultPath;
    this.ccSettingsStorage = ccSettingsStorage;
  }

  /**
   * Load plugins from installed_plugins.json and settings.json files.
   * - Install paths come from installed_plugins.json
   * - Enabled state comes from settings.json (merged global + project)
   */
  async loadPlugins(): Promise<void> {
    // Read installed plugins for paths
    const installedPlugins = readJsonFile<InstalledPluginsFile>(INSTALLED_PLUGINS_PATH);

    // Read enabled state from settings
    const globalSettings = readJsonFile<SettingsFile>(GLOBAL_SETTINGS_PATH);
    const projectSettings = await this.loadProjectSettings();

    const globalEnabled = globalSettings?.enabledPlugins ?? {};
    const projectEnabled = projectSettings?.enabledPlugins ?? {};

    const plugins: ClaudianPlugin[] = [];

    // Process each installed plugin
    if (installedPlugins?.plugins) {
      for (const [pluginId, entries] of Object.entries(installedPlugins.plugins)) {
        if (!entries || entries.length === 0) continue;

        // Use the first (most recent) entry for install path
        const entry = entries[0];

        // Determine enabled state from settings
        const globalValue = globalEnabled[pluginId];
        const projectValue = projectEnabled[pluginId];

        // Scope reflects where the plugin was installed (from installed_plugins.json)
        const scope: PluginScope = entry.scope === 'project' ? 'project' : 'user';

        // Determine enabled state:
        // - Project `false` always disables (even if globally enabled)
        // - Otherwise, use the most specific setting
        let enabled: boolean;
        if (projectValue === false) {
          enabled = false;
        } else if (projectValue === true) {
          enabled = true;
        } else if (globalValue === true) {
          enabled = true;
        } else if (globalValue === false) {
          enabled = false;
        } else {
          // Not in settings - default to enabled if installed
          enabled = true;
        }

        plugins.push({
          id: pluginId,
          name: extractPluginName(pluginId),
          enabled,
          scope,
          installPath: entry.installPath,
        });
      }
    }

    // Sort: project first, then user; alphabetically within each group
    this.plugins = plugins.sort((a, b) => {
      if (a.scope !== b.scope) {
        return a.scope === 'project' ? -1 : 1;
      }
      return a.id.localeCompare(b.id);
    });
  }

  private async loadProjectSettings(): Promise<SettingsFile | null> {
    const projectSettingsPath = path.join(this.vaultPath, '.claude', 'settings.json');
    return readJsonFile(projectSettingsPath);
  }

  /**
   * Get all discovered plugins.
   * Returns a copy of the plugins array.
   */
  getPlugins(): ClaudianPlugin[] {
    return [...this.plugins];
  }

  hasPlugins(): boolean {
    return this.plugins.length > 0;
  }

  hasEnabledPlugins(): boolean {
    return this.plugins.some((p) => p.enabled);
  }

  getEnabledCount(): number {
    return this.plugins.filter((p) => p.enabled).length;
  }

  /**
   * Get a stable key representing enabled plugin configuration.
   * Used to detect changes that require restarting the persistent query.
   */
  getPluginsKey(): string {
    const enabledPlugins = this.plugins
      .filter((p) => p.enabled)
      .sort((a, b) => a.id.localeCompare(b.id));

    if (enabledPlugins.length === 0) {
      return '';
    }

    return enabledPlugins.map((p) => p.id).join('|');
  }

  /**
   * Toggle a plugin's enabled state.
   * Writes to project .claude/settings.json so CLI respects the state.
   */
  async togglePlugin(pluginId: string): Promise<void> {
    const plugin = this.plugins.find((p) => p.id === pluginId);
    if (!plugin) {
      return;
    }

    const newEnabled = !plugin.enabled;
    plugin.enabled = newEnabled;

    await this.ccSettingsStorage.setPluginEnabled(pluginId, newEnabled);
  }

  async enablePlugin(pluginId: string): Promise<void> {
    const plugin = this.plugins.find((p) => p.id === pluginId);
    if (!plugin || plugin.enabled) {
      return;
    }

    plugin.enabled = true;
    await this.ccSettingsStorage.setPluginEnabled(pluginId, true);
  }

  async disablePlugin(pluginId: string): Promise<void> {
    const plugin = this.plugins.find((p) => p.id === pluginId);
    if (!plugin || !plugin.enabled) {
      return;
    }

    plugin.enabled = false;
    await this.ccSettingsStorage.setPluginEnabled(pluginId, false);
  }
}
