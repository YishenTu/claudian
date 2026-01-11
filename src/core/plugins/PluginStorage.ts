/**
 * PluginStorage - Read Claude Code plugins from global registry.
 *
 * Reads installed_plugins.json from ~/.claude/plugins/ and filters
 * entries by projectPath against the current vault.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { normalizePathForComparison } from '../../utils/path';
import { parseSlashCommandContent } from '../../utils/slashCommand';
import type {
  ClaudeModel,
  ClaudianPlugin,
  InstalledPluginEntry,
  InstalledPluginsFile,
  MarketplaceManifest,
  PluginManifest,
  PluginScope,
  SlashCommand,
} from '../types';

/** Path to the global installed plugins registry. */
const INSTALLED_PLUGINS_PATH = path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json');

/** Plugin manifest filename (single-plugin). */
const PLUGIN_MANIFEST_FILE = 'plugin.json';

/** Marketplace manifest filename (multi-plugin). */
const MARKETPLACE_MANIFEST_FILE = 'marketplace.json';

/** Plugin directory name. */
const PLUGIN_DIR_NAME = '.claude-plugin';

/**
 * Parse an installed_plugins.json file.
 */
function parseInstalledPluginsFile(content: string): InstalledPluginsFile | null {
  try {
    const data = JSON.parse(content);
    if (typeof data !== 'object' || data === null) return null;
    if (typeof data.version !== 'number') return null;
    if (typeof data.plugins !== 'object' || data.plugins === null) return null;
    return data as InstalledPluginsFile;
  } catch {
    return null;
  }
}

/**
 * Read and parse a JSON file safely.
 */
function readJsonFile<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

/**
 * Pick the newest entry from a list of plugin entries.
 * Order: lastUpdated > installedAt > version
 */
function pickNewestEntry(entries: InstalledPluginEntry[]): InstalledPluginEntry | null {
  if (entries.length === 0) return null;
  if (entries.length === 1) return entries[0];

  return entries.reduce((newest, current) => {
    // Compare by lastUpdated first
    const newestDate = newest.lastUpdated ?? newest.installedAt;
    const currentDate = current.lastUpdated ?? current.installedAt;

    if (currentDate > newestDate) return current;
    if (currentDate < newestDate) return newest;

    // Fall back to version comparison
    return current.version > newest.version ? current : newest;
  });
}

/**
 * Determine scope based on projectPath.
 * User scope: projectPath equals home directory
 * Project/Local scope: projectPath is a specific subdirectory
 */
function determineScope(entry: InstalledPluginEntry): PluginScope {
  if (!entry.projectPath) return entry.scope ?? 'user';

  const homeDir = normalizePathForComparison(os.homedir());
  const entryPath = normalizePathForComparison(entry.projectPath);

  // If projectPath equals home directory, it's user-scoped
  if (entryPath === homeDir) {
    return 'user';
  }

  // Otherwise, use the declared scope (project or local)
  return entry.scope ?? 'project';
}

/**
 * Determine plugin status based on install path and manifest validity.
 */
function determinePluginStatus(
  installPathExists: boolean,
  manifestError: string | undefined
): 'available' | 'unavailable' | 'invalid-manifest' {
  if (!installPathExists) {
    return 'unavailable';
  }
  if (manifestError) {
    return 'invalid-manifest';
  }
  return 'available';
}

/**
 * Check if a plugin entry should be included for the given vault.
 * User-scoped plugins are always included.
 * Project/Local-scoped plugins are only included if projectPath matches the vault.
 */
function shouldIncludeEntry(entry: InstalledPluginEntry, vaultPath: string): boolean {
  const scope = determineScope(entry);

  // User-scoped plugins apply globally
  if (scope === 'user') {
    return true;
  }

  // Project/Local plugins must match the current vault
  if (!entry.projectPath) return false;

  const normalizedVault = normalizePathForComparison(vaultPath);
  const normalizedProjectPath = normalizePathForComparison(entry.projectPath);

  // Exact match or vault is a descendant of projectPath (allows ancestor match)
  return (
    normalizedVault === normalizedProjectPath ||
    normalizedVault.startsWith(normalizedProjectPath + '/')
  );
}

/**
 * Load plugin manifest (single-plugin or marketplace).
 */
function loadPluginManifest(installPath: string, pluginId: string): {
  manifest: PluginManifest | null;
  pluginPath: string;
  error?: string;
} {
  const pluginDir = path.join(installPath, PLUGIN_DIR_NAME);

  // Check if plugin directory exists
  if (!fs.existsSync(pluginDir)) {
    return {
      manifest: null,
      pluginPath: '',
      error: 'Plugin directory not found',
    };
  }

  // Try single-plugin manifest first
  const singleManifestPath = path.join(pluginDir, PLUGIN_MANIFEST_FILE);
  if (fs.existsSync(singleManifestPath)) {
    const manifest = readJsonFile<PluginManifest>(singleManifestPath);
    if (manifest) {
      return {
        manifest,
        pluginPath: pluginDir,
      };
    }
  }

  // Try marketplace manifest (multi-plugin)
  const marketplaceManifestPath = path.join(pluginDir, MARKETPLACE_MANIFEST_FILE);
  if (fs.existsSync(marketplaceManifestPath)) {
    const marketplaceManifest = readJsonFile<MarketplaceManifest>(marketplaceManifestPath);
    if (marketplaceManifest?.plugins) {
      // Find the matching plugin entry by pluginId
      // Plugin ID format: "name@marketplace" - we need to match by name
      const pluginName = pluginId.replace(/@.*$/, ''); // Remove @source suffix

      const matchingPlugin = marketplaceManifest.plugins.find((p) => {
        const normalizedName = p.name.toLowerCase().replace(/\s+/g, '-');
        return normalizedName === pluginName.toLowerCase();
      });

      if (matchingPlugin) {
        // Use the source field to determine the plugin path
        const pluginPath = matchingPlugin.source
          ? path.join(pluginDir, matchingPlugin.source)
          : pluginDir;

        return {
          manifest: {
            name: matchingPlugin.name,
            description: matchingPlugin.description,
          },
          pluginPath,
        };
      }

      // If no specific match, use the first plugin
      if (marketplaceManifest.plugins.length > 0) {
        const firstPlugin = marketplaceManifest.plugins[0];
        const pluginPath = firstPlugin.source
          ? path.join(pluginDir, firstPlugin.source)
          : pluginDir;

        return {
          manifest: {
            name: firstPlugin.name,
            description: firstPlugin.description,
          },
          pluginPath,
        };
      }
    }
  }

  return {
    manifest: null,
    pluginPath: '',
    error: 'Invalid or missing manifest',
  };
}

export class PluginStorage {
  private vaultPath: string;

  constructor(vaultPath: string) {
    this.vaultPath = vaultPath;
  }

  /**
   * Load all plugins from the global registry.
   * Filters by projectPath against the current vault.
   */
  loadPlugins(): ClaudianPlugin[] {
    // Read the global registry
    const content = this.readInstalledPluginsFile();
    if (!content) {
      return [];
    }

    const pluginsFile = parseInstalledPluginsFile(content);
    if (!pluginsFile) {
      console.error('[PluginStorage] Failed to parse installed_plugins.json');
      return [];
    }

    const plugins: ClaudianPlugin[] = [];

    for (const [pluginId, entries] of Object.entries(pluginsFile.plugins)) {
      // Filter entries for this vault
      const applicableEntries = entries.filter((entry) =>
        shouldIncludeEntry(entry, this.vaultPath)
      );

      if (applicableEntries.length === 0) {
        continue;
      }

      // Pick the newest entry
      const entry = pickNewestEntry(applicableEntries);
      if (!entry) continue;

      // Load manifest and determine plugin path
      const { manifest, pluginPath, error } = loadPluginManifest(entry.installPath, pluginId);

      const scope = determineScope(entry);

      // Check if install path exists
      const installPathExists = fs.existsSync(entry.installPath);

      const status = determinePluginStatus(installPathExists, error);
      const errorMessage = !installPathExists ? 'Plugin directory not found' : error;

      plugins.push({
        id: pluginId,
        name: manifest?.name ?? pluginId,
        description: manifest?.description,
        version: entry.version,
        installPath: entry.installPath,
        pluginPath: pluginPath || entry.installPath,
        scope,
        projectPath: entry.projectPath,
        enabled: false, // Will be set by PluginManager
        status,
        error: errorMessage,
      });
    }

    // Sort: project/local first, then user
    return plugins.sort((a, b) => {
      const scopeOrder = { local: 0, project: 1, user: 2 };
      return scopeOrder[a.scope] - scopeOrder[b.scope];
    });
  }

  /**
   * Read the installed_plugins.json file.
   */
  private readInstalledPluginsFile(): string | null {
    try {
      if (!fs.existsSync(INSTALLED_PLUGINS_PATH)) {
        return null;
      }
      return fs.readFileSync(INSTALLED_PLUGINS_PATH, 'utf-8');
    } catch (err) {
      console.error('[PluginStorage] Failed to read installed_plugins.json:', err);
      return null;
    }
  }
}

/**
 * Load slash commands from a plugin install directory.
 * Looks for commands in {installPath}/commands/*.md
 */
export function loadPluginCommands(
  installPath: string,
  pluginName: string
): SlashCommand[] {
  const commandsDir = path.join(installPath, 'commands');
  const commands: SlashCommand[] = [];

  if (!fs.existsSync(commandsDir)) {
    return commands;
  }

  try {
    const files = listMarkdownFilesRecursive(commandsDir);

    for (const filePath of files) {
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const command = parsePluginCommandFile(content, filePath, commandsDir, pluginName);
        if (command) {
          commands.push(command);
        }
      } catch (error) {
        console.error(`[PluginStorage] Failed to load plugin command from ${filePath}:`, error);
      }
    }
  } catch (error) {
    console.error(`[PluginStorage] Failed to list plugin commands in ${commandsDir}:`, error);
  }

  return commands;
}

/**
 * List all .md files recursively in a directory.
 */
function listMarkdownFilesRecursive(dir: string): string[] {
  const files: string[] = [];

  if (!fs.existsSync(dir)) {
    return files;
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listMarkdownFilesRecursive(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(fullPath);
    }
  }

  return files;
}

/**
 * Parse a plugin command file into a SlashCommand object.
 */
function parsePluginCommandFile(
  content: string,
  filePath: string,
  commandsDir: string,
  pluginName: string
): SlashCommand | null {
  const parsed = parseSlashCommandContent(content);

  // Get relative path from commands dir
  const relativePath = path.relative(commandsDir, filePath);
  const nameWithoutExt = relativePath.replace(/\.md$/, '').replace(/\\/g, '/');

  // Prefix with plugin name to namespace the command
  const name = `${pluginName.toLowerCase().replace(/\s+/g, '-')}:${nameWithoutExt}`;

  // Generate a unique ID for plugin commands
  const escapedName = name.replace(/-/g, '-_').replace(/:/g, '--');
  const id = `plugin-${escapedName}`;

  return {
    id,
    name,
    description: parsed.description,
    argumentHint: parsed.argumentHint,
    allowedTools: parsed.allowedTools,
    model: parsed.model as ClaudeModel | undefined,
    content: parsed.promptContent,
  };
}
