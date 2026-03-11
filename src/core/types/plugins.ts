export type ExtensionScope = 'user' | 'project';

export interface GeminianExtension {
  /** e.g., "extension-name@source" */
  id: string;
  name: string;
  enabled: boolean;
  scope: ExtensionScope;
  installPath: string;
}

export interface InstalledExtensionEntry {
  scope: 'user' | 'project';
  installPath: string;
  version: string;
  installedAt: string;
  lastUpdated: string;
  gitCommitSha?: string;
  projectPath?: string;
}

export interface InstalledExtensionsFile {
  version: number;
  extensions: Record<string, InstalledExtensionEntry[]>;
}

// Backwards-compatible aliases
/** @deprecated Use ExtensionScope */
export type PluginScope = ExtensionScope;
/** @deprecated Use GeminianExtension */
export type GeminianPlugin = GeminianExtension;
/** @deprecated Use InstalledExtensionEntry */
export type InstalledPluginEntry = InstalledExtensionEntry;
/** @deprecated Use InstalledExtensionsFile */
export type InstalledPluginsFile = InstalledExtensionsFile;
