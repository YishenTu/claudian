/**
 * PluginManager - Discover and manage Claude Code plugins from settings.json files.
 *
 * Plugins are discovered from enabledPlugins in:
 * - Global: ~/.claude/settings.json (scope: 'user')
 * - Project: vault/.claude/settings.json (scope: 'project')
 *
 * Merge logic:
 * - All plugins with `true` from either scope are discoverable
 * - Project `false` can disable a globally-enabled plugin
 * - Project plugins take precedence for scope assignment
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { CCSettingsStorage } from '../storage/CCSettingsStorage';
import type { ClaudianPlugin, PluginScope } from '../types';

const GLOBAL_SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');

interface SettingsFile {
  enabledPlugins?: Record<string, boolean>;
}

function readSettingsFile(filePath: string): SettingsFile | null {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as SettingsFile;
  } catch {
    return null;
  }
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
   * Load plugins from global and project settings.json files.
   * Implements merge logic: union of enabled plugins, project `false` disables.
   */
  async loadPlugins(): Promise<void> {
    const globalSettings = readSettingsFile(GLOBAL_SETTINGS_PATH);
    const projectSettings = await this.loadProjectSettings();

    const globalEnabled = globalSettings?.enabledPlugins ?? {};
    const projectEnabled = projectSettings?.enabledPlugins ?? {};

    // Collect all plugin IDs from both sources
    const allPluginIds = new Set<string>([
      ...Object.keys(globalEnabled),
      ...Object.keys(projectEnabled),
    ]);

    const plugins: ClaudianPlugin[] = [];

    for (const id of allPluginIds) {
      const globalValue = globalEnabled[id];
      const projectValue = projectEnabled[id];

      // Determine scope: project takes precedence if it has the plugin
      let scope: PluginScope;
      if (projectValue !== undefined) {
        scope = 'project';
      } else {
        scope = 'user';
      }

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
      } else {
        // Plugin was explicitly set to false globally and not overridden by project
        enabled = false;
      }

      // Only include plugins that are enabled or were explicitly disabled
      // (we want to show disabled plugins in the UI for re-enabling)
      if (globalValue !== undefined || projectValue !== undefined) {
        plugins.push({ id, enabled, scope });
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
    return readSettingsFile(projectSettingsPath);
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
