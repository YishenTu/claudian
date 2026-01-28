/**
 * PluginManager - Discover and manage Claude Code plugins.
 *
 * Plugins are discovered from two sources:
 * - installed_plugins.json: install paths for scanning agents
 * - settings.json: enabled state (project overrides global)
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { CCSettingsStorage } from '../storage/CCSettingsStorage';
import type { ClaudianPlugin, InstalledPluginEntry, InstalledPluginsFile, PluginScope } from '../types';

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

function normalizePathForComparison(p: string): string {
  try {
    const resolved = fs.realpathSync(p);
    if (typeof resolved === 'string' && resolved.length > 0) {
      return resolved;
    }
  } catch {
    // ignore
  }

  return path.resolve(p);
}

function selectInstalledPluginEntry(
  entries: InstalledPluginEntry[],
  normalizedVaultPath: string
): InstalledPluginEntry | null {
  for (const entry of entries) {
    if (entry.scope !== 'project') continue;
    if (!entry.projectPath) continue;
    if (normalizePathForComparison(entry.projectPath) === normalizedVaultPath) {
      return entry;
    }
  }

  return entries.find(e => e.scope === 'user') ?? null;
}

function extractPluginName(pluginId: string): string {
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

  async loadPlugins(): Promise<void> {
    const installedPlugins = readJsonFile<InstalledPluginsFile>(INSTALLED_PLUGINS_PATH);
    const globalSettings = readJsonFile<SettingsFile>(GLOBAL_SETTINGS_PATH);
    const projectSettings = await this.loadProjectSettings();

    const globalEnabled = globalSettings?.enabledPlugins ?? {};
    const projectEnabled = projectSettings?.enabledPlugins ?? {};

    const plugins: ClaudianPlugin[] = [];
    const normalizedVaultPath = normalizePathForComparison(this.vaultPath);

    if (installedPlugins?.plugins) {
      for (const [pluginId, entries] of Object.entries(installedPlugins.plugins)) {
        if (!entries || entries.length === 0) continue;

        const entry = selectInstalledPluginEntry(entries, normalizedVaultPath);
        if (!entry) continue;

        const scope: PluginScope = entry.scope === 'project' ? 'project' : 'user';

        // Project setting takes precedence, then global, then default enabled
        const enabled = projectEnabled[pluginId] ?? globalEnabled[pluginId] ?? true;

        plugins.push({
          id: pluginId,
          name: extractPluginName(pluginId),
          enabled,
          scope,
          installPath: entry.installPath,
        });
      }
    }

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

  /** Used to detect changes that require restarting the persistent query. */
  getPluginsKey(): string {
    const enabledPlugins = this.plugins
      .filter((p) => p.enabled)
      .sort((a, b) => a.id.localeCompare(b.id));

    if (enabledPlugins.length === 0) {
      return '';
    }

    return enabledPlugins.map((p) => `${p.id}:${p.installPath}`).join('|');
  }

  /** Writes to project .claude/settings.json so CLI respects the state. */
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
