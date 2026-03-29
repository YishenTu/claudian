import { getDefaultHiddenProviderCommands } from '../providers/commands/hiddenCommands';
import {
  type ClaudianSettings,
  getDefaultBlockedCommands,
} from '../types/settings';

/**
 * Shared application defaults.
 *
 * These are the authoritative default values for ClaudianSettings,
 * independent of any specific provider. Provider-specific defaults
 * (e.g. Claude model names) are chosen here because they must live
 * somewhere, but the shared layer does not "own" them in a semantic
 * sense — the active provider interprets the values.
 */
export const DEFAULT_CLAUDIAN_SETTINGS: ClaudianSettings = {
  // User preferences
  userName: '',

  // Security
  enableBlocklist: true,
  allowExternalAccess: false,
  blockedCommands: getDefaultBlockedCommands(),
  permissionMode: 'yolo',

  // Model & thinking (active-provider projection)
  model: 'haiku',
  thinkingBudget: 'off',
  effortLevel: 'high',
  enableAutoTitleGeneration: true,
  titleGenerationModel: '',
  enableChrome: false,
  enableBangBash: false,
  enableOpus1M: false,
  enableSonnet1M: false,

  // Content settings
  excludedTags: [],
  mediaFolder: '',
  systemPrompt: '',
  allowedExportPaths: ['~/Desktop', '~/Downloads'],
  persistentExternalContextPaths: [],

  // Environment
  environmentVariables: '',
  envSnippets: [],
  customContextLimits: {},

  // UI settings
  keyboardNavigation: {
    scrollUpKey: 'w',
    scrollDownKey: 's',
    focusInputKey: 'i',
  },

  // Internationalization
  locale: 'en',

  // CLI paths
  claudeCliPath: '',
  claudeCliPathsByHost: {},
  codexCliPath: '',
  codexCliPathsByHost: {},
  codexReasoningSummary: 'detailed',
  loadUserClaudeSettings: true,

  // Provider selection
  settingsProvider: 'claude',
  codexEnabled: false,
  savedProviderModel: {},
  savedProviderEffort: {},
  savedProviderThinkingBudget: {},

  // State
  lastClaudeModel: 'haiku',
  lastCustomModel: '',
  lastEnvHash: '',

  // UI preferences
  maxTabs: 3,
  tabBarPosition: 'input',
  enableAutoScroll: true,
  openInMainTab: false,

  // Provider command visibility
  hiddenProviderCommands: getDefaultHiddenProviderCommands(),
};
