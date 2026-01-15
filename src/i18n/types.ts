/**
 * i18n type definitions
 */

// Available locales
export type Locale = 'en' | 'zh-CN' | 'zh-TW' | 'ja' | 'ko' | 'de' | 'fr' | 'es' | 'ru' | 'pt';

/**
 * Translation key type - represents all valid translation keys
 * This is a union of all possible dot-notation keys from the translation files
 */
export type TranslationKey =
  // Common UI elements
  | 'common.save'
  | 'common.cancel'
  | 'common.delete'
  | 'common.edit'
  | 'common.add'
  | 'common.remove'
  | 'common.clear'
  | 'common.clearAll'
  | 'common.loading'
  | 'common.error'
  | 'common.success'
  | 'common.warning'
  | 'common.confirm'
  | 'common.settings'
  | 'common.advanced'
  | 'common.enabled'
  | 'common.disabled'
  | 'common.platform'

  // Settings - Customization
  | 'settings.title'
  | 'settings.customization'
  | 'settings.userName.name'
  | 'settings.userName.desc'
  | 'settings.excludedTags.name'
  | 'settings.excludedTags.desc'
  | 'settings.mediaFolder.name'
  | 'settings.mediaFolder.desc'
  | 'settings.systemPrompt.name'
  | 'settings.systemPrompt.desc'
  | 'settings.autoTitle.name'
  | 'settings.autoTitle.desc'
  | 'settings.titleModel.name'
  | 'settings.titleModel.desc'
  | 'settings.titleModel.auto'
  | 'settings.navMappings.name'
  | 'settings.navMappings.desc'

  // Settings - Hotkeys
  | 'settings.hotkeys'
  | 'settings.inlineEditHotkey.name'
  | 'settings.inlineEditHotkey.descNoKey'
  | 'settings.inlineEditHotkey.descWithKey'
  | 'settings.inlineEditHotkey.btnSet'
  | 'settings.inlineEditHotkey.btnChange'
  | 'settings.openChatHotkey.name'
  | 'settings.openChatHotkey.descNoKey'
  | 'settings.openChatHotkey.descWithKey'
  | 'settings.openChatHotkey.btnSet'
  | 'settings.openChatHotkey.btnChange'
  | 'settings.newTabHotkey.name'
  | 'settings.newTabHotkey.descNoKey'
  | 'settings.newTabHotkey.descWithKey'
  | 'settings.newTabHotkey.btnSet'
  | 'settings.newTabHotkey.btnChange'
  | 'settings.newSessionHotkey.name'
  | 'settings.newSessionHotkey.descNoKey'
  | 'settings.newSessionHotkey.descWithKey'
  | 'settings.newSessionHotkey.btnSet'
  | 'settings.newSessionHotkey.btnChange'
  | 'settings.closeTabHotkey.name'
  | 'settings.closeTabHotkey.descNoKey'
  | 'settings.closeTabHotkey.descWithKey'
  | 'settings.closeTabHotkey.btnSet'
  | 'settings.closeTabHotkey.btnChange'

  // Settings - Slash Commands
  | 'settings.slashCommands.name'
  | 'settings.slashCommands.desc'

  // Settings - MCP Servers
  | 'settings.mcpServers.name'
  | 'settings.mcpServers.desc'

  // Settings - Plugins
  | 'settings.plugins.name'
  | 'settings.plugins.desc'

  // Settings - Safety
  | 'settings.safety'
  | 'settings.loadUserSettings.name'
  | 'settings.loadUserSettings.desc'
  | 'settings.enableBlocklist.name'
  | 'settings.enableBlocklist.desc'
  | 'settings.blockedCommands.name'
  | 'settings.blockedCommands.desc'
  | 'settings.blockedCommands.unixName'
  | 'settings.blockedCommands.unixDesc'
  | 'settings.exportPaths.name'
  | 'settings.exportPaths.desc'

  // Settings - Environment
  | 'settings.environment'
  | 'settings.customVariables.name'
  | 'settings.customVariables.desc'
  | 'settings.envSnippets.name'
  | 'settings.envSnippets.addBtn'
  | 'settings.envSnippets.editBtn'
  | 'settings.envSnippets.deleteBtn'
  | 'settings.envSnippets.useBtn'
  | 'settings.envSnippets.noSnippets'
  | 'settings.envSnippets.modal.title'
  | 'settings.envSnippets.modal.name'
  | 'settings.envSnippets.modal.namePlaceholder'
  | 'settings.envSnippets.modal.description'
  | 'settings.envSnippets.modal.descPlaceholder'
  | 'settings.envSnippets.modal.envVars'
  | 'settings.envSnippets.modal.envVarsPlaceholder'
  | 'settings.envSnippets.modal.save'
  | 'settings.envSnippets.modal.cancel'

  // Settings - Advanced
  | 'settings.advanced'
  | 'settings.show1MModel.name'
  | 'settings.show1MModel.desc'
  | 'settings.maxTabs.name'
  | 'settings.maxTabs.desc'
  | 'settings.maxTabs.warning'
  | 'settings.maxTabs.range'
  | 'settings.cliPath.name'
  | 'settings.cliPath.desc'
  | 'settings.cliPath.descWindows'
  | 'settings.cliPath.descUnix'
  | 'settings.cliPath.validation.notExist'
  | 'settings.cliPath.validation.isDirectory'

  // Settings - Language
  | 'settings.language.name'
  | 'settings.language.desc'
  | 'settings.language.en'
  | 'settings.language.zh-CN'
  | 'settings.language.zh-TW'
  | 'settings.language.ja'
  | 'settings.language.ko'
  | 'settings.language.de'
  | 'settings.language.fr'
  | 'settings.language.es'
  | 'settings.language.ru'
  | 'settings.language.pt';
