import path from 'node:path';

export function resolveObsidianPluginPath(vaultPath, manifest) {
  const pluginId = typeof manifest?.id === 'string' ? manifest.id.trim() : '';
  if (!vaultPath || !pluginId) return null;
  return path.join(vaultPath, '.obsidian', 'plugins', pluginId);
}
