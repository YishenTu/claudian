/**
 * ExtensionManager - Discover and manage Gemini CLI extensions.
 *
 * Extensions are discovered from two sources:
 * - installed_extensions.json: install paths for scanning agents
 * - settings.json: enabled state (project overrides global)
 */

import * as fs from 'fs';
import { Notice } from 'obsidian';
import * as os from 'os';
import * as path from 'path';

import type { GeminiCLISettingsStorage } from '../storage/CCSettingsStorage';
import type { ExtensionScope,GeminianExtension, InstalledExtensionEntry, InstalledExtensionsFile } from '../types';

const INSTALLED_EXTENSIONS_PATH = path.join(os.homedir(), '.gemini', 'extensions', 'installed_extensions.json');
const GLOBAL_SETTINGS_PATH = path.join(os.homedir(), '.gemini', 'settings.json');

interface SettingsFile {
  enabledExtensions?: Record<string, boolean>;
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

function selectInstalledExtensionEntry(
  entries: InstalledExtensionEntry[],
  normalizedVaultPath: string
): InstalledExtensionEntry | null {
  for (const entry of entries) {
    if (entry.scope !== 'project') continue;
    if (!entry.projectPath) continue;
    if (normalizePathForComparison(entry.projectPath) === normalizedVaultPath) {
      return entry;
    }
  }

  return entries.find(e => e.scope === 'user') ?? null;
}

function extractExtensionName(extensionId: string): string {
  const atIndex = extensionId.indexOf('@');
  if (atIndex > 0) {
    return extensionId.substring(0, atIndex);
  }
  return extensionId;
}

export class PluginManager {
  private geminiCliSettingsStorage: GeminiCLISettingsStorage;
  private vaultPath: string;
  private extensions: GeminianExtension[] = [];

  constructor(vaultPath: string, geminiCliSettingsStorage: GeminiCLISettingsStorage) {
    this.vaultPath = vaultPath;
    this.geminiCliSettingsStorage = geminiCliSettingsStorage;
  }

  async loadExtensions(): Promise<void> {
    const installedExtensions = readJsonFile<InstalledExtensionsFile>(INSTALLED_EXTENSIONS_PATH);
    const globalSettings = readJsonFile<SettingsFile>(GLOBAL_SETTINGS_PATH);
    const projectSettings = await this.loadProjectSettings();

    const globalEnabled = globalSettings?.enabledExtensions ?? {};
    const projectEnabled = projectSettings?.enabledExtensions ?? {};

    const extensions: GeminianExtension[] = [];
    const normalizedVaultPath = normalizePathForComparison(this.vaultPath);

    if (installedExtensions?.extensions) {
      for (const [extensionId, entries] of Object.entries(installedExtensions.extensions)) {
        if (!entries || entries.length === 0) continue;

        const entriesArray = Array.isArray(entries) ? entries : [entries];
        if (!Array.isArray(entries)) {
          new Notice(`Geminian: extension "${extensionId}" has malformed entry in installed_extensions.json (expected array, got ${typeof entries})`);
        }
        const entry = selectInstalledExtensionEntry(entriesArray, normalizedVaultPath);
        if (!entry) continue;

        const scope: ExtensionScope = entry.scope === 'project' ? 'project' : 'user';

        const enabled = projectEnabled[extensionId] ?? globalEnabled[extensionId] ?? true;

        extensions.push({
          id: extensionId,
          name: extractExtensionName(extensionId),
          enabled,
          scope,
          installPath: entry.installPath,
        });
      }
    }

    this.extensions = extensions.sort((a, b) => {
      if (a.scope !== b.scope) {
        return a.scope === 'project' ? -1 : 1;
      }
      return a.id.localeCompare(b.id);
    });
  }

  private async loadProjectSettings(): Promise<SettingsFile | null> {
    const projectSettingsPath = path.join(this.vaultPath, '.gemini', 'settings.json');
    return readJsonFile(projectSettingsPath);
  }

  getExtensions(): GeminianExtension[] {
    return [...this.extensions];
  }

  hasExtensions(): boolean {
    return this.extensions.length > 0;
  }

  hasEnabledExtensions(): boolean {
    return this.extensions.some((e) => e.enabled);
  }

  getEnabledCount(): number {
    return this.extensions.filter((e) => e.enabled).length;
  }

  /** Used to detect changes that require restarting the persistent query. */
  getExtensionsKey(): string {
    const enabledExtensions = this.extensions
      .filter((e) => e.enabled)
      .sort((a, b) => a.id.localeCompare(b.id));

    if (enabledExtensions.length === 0) {
      return '';
    }

    return enabledExtensions.map((e) => `${e.id}:${e.installPath}`).join('|');
  }

  /** Writes to project .gemini/settings.json so CLI respects the state. */
  async toggleExtension(extensionId: string): Promise<void> {
    const extension = this.extensions.find((e) => e.id === extensionId);
    if (!extension) {
      return;
    }

    const newEnabled = !extension.enabled;
    extension.enabled = newEnabled;

    await this.geminiCliSettingsStorage.setExtensionEnabled(extensionId, newEnabled);
  }

  async enableExtension(extensionId: string): Promise<void> {
    const extension = this.extensions.find((e) => e.id === extensionId);
    if (!extension || extension.enabled) {
      return;
    }

    extension.enabled = true;
    await this.geminiCliSettingsStorage.setExtensionEnabled(extensionId, true);
  }

  async disableExtension(extensionId: string): Promise<void> {
    const extension = this.extensions.find((e) => e.id === extensionId);
    if (!extension || !extension.enabled) {
      return;
    }

    extension.enabled = false;
    await this.geminiCliSettingsStorage.setExtensionEnabled(extensionId, false);
  }

  // Backwards-compatible aliases
  /** @deprecated Use loadExtensions() */
  async loadPlugins(): Promise<void> { return this.loadExtensions(); }
  /** @deprecated Use getExtensions() */
  getPlugins(): GeminianExtension[] { return this.getExtensions(); }
  /** @deprecated Use hasExtensions() */
  hasPlugins(): boolean { return this.hasExtensions(); }
  /** @deprecated Use hasEnabledExtensions() */
  hasEnabledPlugins(): boolean { return this.hasEnabledExtensions(); }
  /** @deprecated Use getExtensionsKey() */
  getPluginsKey(): string { return this.getExtensionsKey(); }
  /** @deprecated Use toggleExtension() */
  async togglePlugin(id: string): Promise<void> { return this.toggleExtension(id); }
  /** @deprecated Use enableExtension() */
  async enablePlugin(id: string): Promise<void> { return this.enableExtension(id); }
  /** @deprecated Use disableExtension() */
  async disablePlugin(id: string): Promise<void> { return this.disableExtension(id); }
}
