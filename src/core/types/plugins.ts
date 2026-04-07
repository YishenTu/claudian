export type PluginScope = 'user' | 'project';

export interface PluginInfo {
  id: string;
  name: string;
  enabled: boolean;
  scope: PluginScope;
  installPath: string;
}
