// Legacy / old vault-root paths that never change regardless of config dir.
// These are used only for migration — data is read from them then deleted.
export const OLD_CLAUDIAN_SETTINGS_PATH = '.claudian/claudian-settings.json';
export const LEGACY_CLAUDIAN_SETTINGS_PATH = '.claude/claudian-settings.json';
export const LEGACY_SESSIONS_PATH = '.claude/sessions';
export const OLD_SESSIONS_PATH = '.claudian/sessions';

/** Vault-relative path to this plugin's storage directory. */
export function getClaudianPluginPath(configDir: string): string {
  return `${configDir}/plugins/realclaudian`;
}
