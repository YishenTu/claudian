export type PluginScope = 'user' | 'project';

export interface PluginInfo {
  id: string;
  name: string;
  enabled: boolean;
  scope: PluginScope;
  installPath: string;
}

export interface InstalledPluginEntry {
  scope: 'user' | 'project';
  installPath: string;
  version: string;
  installedAt: string;
  lastUpdated: string;
  gitCommitSha?: string;
  projectPath?: string;
}

export interface InstalledPluginsFile {
  version: number;
  plugins: Record<string, InstalledPluginEntry[]>;
}
