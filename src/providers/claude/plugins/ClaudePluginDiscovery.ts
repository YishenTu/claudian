/**
 * Read-only discovery of native Claude Code plugins for agent enumeration.
 *
 * Plugins are discovered from two sources:
 * - {CLAUDE_CONFIG_DIR}/plugins/installed_plugins.json: install paths for scanning agents
 * - settings.json: enabled state (project overrides global)
 */

import { promises as fs } from 'fs';
import { Notice } from 'obsidian';
import * as path from 'path';

import { resolveClaudeConfigDir } from '../config/ClaudeConfigDir';
import type { InstalledPluginEntry, InstalledPluginsFile, PluginInfo, PluginScope } from '../types/plugins';

interface SettingsFile {
  enabledPlugins?: Record<string, boolean>;
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

async function normalizePathForComparison(p: string): Promise<string> {
  try {
    const resolved = await fs.realpath(p);
    if (typeof resolved === 'string' && resolved.length > 0) {
      return resolved;
    }
  } catch {
    // ignore
  }

  return path.resolve(p);
}

async function selectInstalledPluginEntry(
  entries: InstalledPluginEntry[],
  normalizedVaultPath: string
): Promise<InstalledPluginEntry | null> {
  for (const entry of entries) {
    if (entry.scope !== 'project') continue;
    if (!entry.projectPath) continue;
    if (await normalizePathForComparison(entry.projectPath) === normalizedVaultPath) {
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

export class ClaudePluginDiscovery {
  private vaultPath: string;
  private resolveConfigDir: () => string;
  private plugins: PluginInfo[] = [];
  private loadPromise: Promise<void> | null = null;

  constructor(
    vaultPath: string,
    configDir: string | (() => string) = () => resolveClaudeConfigDir(),
  ) {
    this.vaultPath = vaultPath;
    this.resolveConfigDir = typeof configDir === 'function' ? configDir : () => configDir;
  }

  async loadPlugins(): Promise<void> {
    if (this.loadPromise) {
      return this.loadPromise;
    }
    const promise = this.#loadPluginsInternal();
    this.loadPromise = promise;
    try {
      await promise;
    } finally {
      if (this.loadPromise === promise) {
        this.loadPromise = null;
      }
    }
  }

  async #loadPluginsInternal(): Promise<void> {
    const configDir = this.resolveConfigDir();
    const [installedPlugins, globalSettings, projectSettings, normalizedVaultPath] = await Promise.all([
      readJsonFile<InstalledPluginsFile>(path.join(configDir, 'plugins', 'installed_plugins.json')),
      readJsonFile<SettingsFile>(path.join(configDir, 'settings.json')),
      this.#loadProjectSettings(),
      normalizePathForComparison(this.vaultPath),
    ]);

    const globalEnabled = globalSettings?.enabledPlugins ?? {};
    const projectEnabled = projectSettings?.enabledPlugins ?? {};

    const plugins: PluginInfo[] = [];
    if (installedPlugins?.plugins) {
      for (const [pluginId, entries] of Object.entries(installedPlugins.plugins)) {
        if (!entries || entries.length === 0) continue;

        const entriesArray = Array.isArray(entries) ? entries : [entries];
        if (!Array.isArray(entries)) {
          new Notice(`Claudian: plugin "${pluginId}" has malformed entry in installed_plugins.json (expected array, got ${typeof entries})`);
        }
        const entry = await selectInstalledPluginEntry(entriesArray, normalizedVaultPath);
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

  async #loadProjectSettings(): Promise<SettingsFile | null> {
    const projectSettingsPath = path.join(this.vaultPath, '.claude', 'settings.json');
    return readJsonFile(projectSettingsPath);
  }

  getPlugins(): PluginInfo[] {
    return [...this.plugins];
  }

}
