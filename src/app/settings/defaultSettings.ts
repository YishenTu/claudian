import { getDefaultHiddenProviderCommands } from '../../core/providers/commands/hiddenCommands';
import { DEFAULT_REASONING_VALUE } from '../../core/providers/reasoning';
import { type ClaudianSettings } from '../../core/types/settings';
import { getBuiltInProviderDefaultConfigs } from '../../providers/defaultProviderConfigs';

export const ENHANCED_DEFAULT_CODEX_MODEL = 'gpt-5.6-sol';

function getEnhancedProviderDefaultConfigs(): ClaudianSettings['providerConfigs'] {
  const providerConfigs = getBuiltInProviderDefaultConfigs();
  providerConfigs.codex = {
    ...providerConfigs.codex,
    enabled: true,
  };
  return providerConfigs;
}

export const DEFAULT_CLAUDIAN_SETTINGS: ClaudianSettings = {
  userName: '',

  // A fresh install must not grant an agent approval-free access to the whole
  // machine. Users can still opt into YOLO explicitly from the toolbar.
  permissionMode: 'normal',

  model: ENHANCED_DEFAULT_CODEX_MODEL,
  thinkingBudget: 'off',
  effortLevel: DEFAULT_REASONING_VALUE,
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

  providerConfigs: getEnhancedProviderDefaultConfigs(),

  settingsProvider: 'codex',
  savedProviderModel: {
    codex: ENHANCED_DEFAULT_CODEX_MODEL,
  },
  savedProviderEffort: {},
  savedProviderServiceTier: {},
  savedProviderThinkingBudget: {},
  savedProviderPermissionMode: {},
  pendingProviderSessionInvalidations: {},

  lastCustomModel: '',

  maxTabs: 3,
  enableAutoScroll: true,
  deferMathRenderingDuringStreaming: true,
  expandFileEditsByDefault: false,
  chatViewPlacement: 'right-sidebar',

  hiddenProviderCommands: getDefaultHiddenProviderCommands(),
};
