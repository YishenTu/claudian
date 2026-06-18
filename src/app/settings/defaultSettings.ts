import { getDefaultHiddenProviderCommands } from '../../core/providers/commands/hiddenCommands';
import { type ClaudianSettings } from '../../core/types/settings';
import { getBuiltInProviderDefaultConfigs } from '../../providers/defaultProviderConfigs';

export const DEFAULT_CLAUDIAN_SETTINGS: ClaudianSettings = {
  userName: '',

  permissionMode: 'yolo',

  model: 'haiku',
  thinkingBudget: 'off',
  effortLevel: 'high',
  serviceTier: 'default',
  enableAutoTitleGeneration: true,
  titleGenerationModel: '',

  excludedTags: [],
  mediaFolder: '',
  systemPrompt: '',
  persistentExternalContextPaths: [],

  sharedEnvironmentVariables: '',
  envSnippets: [],
  customContextLimits: {},
  customModelAliases: {},

  keyboardNavigation: {
    scrollUpKey: 'w',
    scrollDownKey: 's',
    focusInputKey: 'i',
  },
  requireCommandOrControlEnterToSend: false,

  locale: 'en',

  providerConfigs: getBuiltInProviderDefaultConfigs(),

  settingsProvider: 'claude',
  savedProviderModel: {},
  savedProviderEffort: {},
  savedProviderServiceTier: {},
  savedProviderThinkingBudget: {},
  savedProviderPermissionMode: {},

  lastCustomModel: '',

  maxTabs: 3,
  enableAutoScroll: true,
  deferMathRenderingDuringStreaming: true,
  expandFileEditsByDefault: false,
  chatViewPlacement: 'right-sidebar',

  hiddenProviderCommands: getDefaultHiddenProviderCommands(),
};
