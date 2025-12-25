/**
 * Storage module barrel export.
 */

export { SESSIONS_PATH, SessionStorage } from './SessionStorage';
export { SETTINGS_PATH, SettingsStorage, type StoredSettings } from './SettingsStorage';
export { COMMANDS_PATH, SlashCommandStorage } from './SlashCommandStorage';
export {
  CLAUDE_PATH,
  type PluginState,
  StorageService,
} from './StorageService';
export { VaultFileAdapter } from './VaultFileAdapter';
