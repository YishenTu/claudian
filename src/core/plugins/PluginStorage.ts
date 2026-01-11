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
 * Validate a single plugin entry from the registry.
 */
function isValidPluginEntry(entry: unknown): entry is InstalledPluginEntry {
  if (typeof entry !== 'object' || entry === null) return false;
  const e = entry as Record<string, unknown>;
  return (
    typeof e.installPath === 'string' &&
    typeof e.version === 'string' &&
    typeof e.installedAt === 'string' &&
    (e.scope === undefined || ['user', 'project', 'local'].includes(e.scope as string))
  );
}

/**
 * Parse an installed_plugins.json file.
 * Returns { data, error } to distinguish parse failures from missing/empty files.
 */
function parseInstalledPluginsFile(content: string): { data: InstalledPluginsFile | null; error?: string } {
  try {
    const data = JSON.parse(content);
    if (typeof data !== 'object' || data === null) {
      return { data: null, error: 'Invalid format: expected object at root' };
    }
    if (typeof data.version !== 'number') {
      return { data: null, error: 'Invalid format: missing or invalid version field' };
    }
    if (typeof data.plugins !== 'object' || data.plugins === null) {
      return { data: null, error: 'Invalid format: missing or invalid plugins field' };
    }

    // Validate and filter individual plugin entries
    for (const [pluginId, entries] of Object.entries(data.plugins)) {
      if (!Array.isArray(entries)) {
        continue;
      }
      // Filter out invalid entries silently
      data.plugins[pluginId] = entries.filter((entry) => isValidPluginEntry(entry));
    }

    return { data: data as InstalledPluginsFile };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown parse error';
    return { data: null, error: `JSON parse error: ${message}` };
  }
}

/**
 * Read and parse a JSON file safely.
 * Returns { data, error } to enable callers to distinguish missing files from parse errors.
 */
function readJsonFile<T>(filePath: string): { data: T | null; error?: string } {
  try {
    if (!fs.existsSync(filePath)) return { data: null };
    const content = fs.readFileSync(filePath, 'utf-8');
    return { data: JSON.parse(content) as T };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    return { data: null, error: errorMessage };
  }
}

/**
 * Pick the newest entry from a list of plugin entries.
 * Order: lastUpdated > installedAt > version
 */
type SemverIdentifier = number | string;

type ParsedSemver = {
  core: number[];
  prerelease: SemverIdentifier[];
  valid: boolean;
};

const NUMERIC_IDENTIFIER_RE = /^[0-9]+$/;

function parseSemver(version: string): ParsedSemver {
  const trimmed = version.trim();
  const normalized = trimmed.startsWith('v') || trimmed.startsWith('V') ? trimmed.slice(1) : trimmed;
  const [coreAndPre] = normalized.split('+', 1);
  const [corePart, prereleasePart] = coreAndPre.split('-', 2);

  if (!corePart) {
    return { core: [], prerelease: [], valid: false };
  }

  const coreSegments = corePart.split('.');
  const core: number[] = [];

  for (const segment of coreSegments) {
    if (!segment || !NUMERIC_IDENTIFIER_RE.test(segment)) {
      return { core: [], prerelease: [], valid: false };
    }
    core.push(Number(segment));
  }

  const prerelease = prereleasePart
    ? prereleasePart.split('.').map((id) => (NUMERIC_IDENTIFIER_RE.test(id) ? Number(id) : id))
    : [];

  return { core, prerelease, valid: true };
}

function comparePrerelease(
  a: SemverIdentifier[],
  b: SemverIdentifier[]
): number {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;

  const maxLen = Math.max(a.length, b.length);
  for (let i = 0; i < maxLen; i++) {
    const aId = a[i];
    const bId = b[i];

    if (aId === undefined) return -1;
    if (bId === undefined) return 1;
    if (aId === bId) continue;

    const aIsNumber = typeof aId === 'number';
    const bIsNumber = typeof bId === 'number';

    if (aIsNumber && bIsNumber) {
      return aId > bId ? 1 : -1;
    }
    if (aIsNumber !== bIsNumber) {
      return aIsNumber ? -1 : 1;
    }
    return String(aId).localeCompare(String(bId));
  }

  return 0;
}

function compareSemver(a: string, b: string): number {
  const parsedA = parseSemver(a);
  const parsedB = parseSemver(b);

  if (!parsedA.valid || !parsedB.valid) {
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  }

  const maxLen = Math.max(3, parsedA.core.length, parsedB.core.length);
  for (let i = 0; i < maxLen; i++) {
    const aVal = parsedA.core[i] ?? 0;
    const bVal = parsedB.core[i] ?? 0;
    if (aVal > bVal) return 1;
    if (aVal < bVal) return -1;
  }

  return comparePrerelease(parsedA.prerelease, parsedB.prerelease);
}

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
    return compareSemver(current.version, newest.version) > 0 ? current : newest;
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
    const { data: manifest, error } = readJsonFile<PluginManifest>(singleManifestPath);
    if (manifest) {
      return {
        manifest,
        pluginPath: pluginDir,
      };
    }
    if (error) {
      return {
        manifest: null,
        pluginPath: '',
        error: `Failed to read plugin.json: ${error}`,
      };
    }
  }

  // Try marketplace manifest (multi-plugin)
  const marketplaceManifestPath = path.join(pluginDir, MARKETPLACE_MANIFEST_FILE);
  if (fs.existsSync(marketplaceManifestPath)) {
    const { data: marketplaceManifest, error } = readJsonFile<MarketplaceManifest>(marketplaceManifestPath);
    if (error) {
      return {
        manifest: null,
        pluginPath: '',
        error: `Failed to read marketplace.json: ${error}`,
      };
    }
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

    const { data: pluginsFile } = parseInstalledPluginsFile(content);
    if (!pluginsFile) {
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
    } catch {
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
      } catch {
        // Skip invalid command files gracefully
      }
    }
  } catch {
    // Return empty array if directory listing fails
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
