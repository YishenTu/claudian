import { DEFAULT_REASONING_VALUE } from '../../core/providers/reasoning';
import type { ClaudianSettings, ProviderConfigMap } from '../../core/types/settings';

/**
 * Application defaults. Provider-owned defaults are assembled by the composition
 * root and injected, so app settings never import concrete providers.
 */
export function createDefaultClaudianSettings(providerConfigs: ProviderConfigMap): ClaudianSettings {
  return structuredClone({ ...DEFAULT_CLAUDIAN_SETTINGS, providerConfigs });
}

/** Provider-neutral defaults; `providerConfigs` stays empty until providers inject theirs. */
export const DEFAULT_CLAUDIAN_SETTINGS: ClaudianSettings = {
  userName: '',

  permissionMode: 'auto',

  model: 'haiku',
  effortLevel: DEFAULT_REASONING_VALUE,
  serviceTier: 'default',
  enableAutoTitleGeneration: true,
  titleGenerationLocale: '',
  titleGenerationModel: '',

  excludedTags: [],
  mediaFolder: '',
  systemPrompt: '',

  sharedEnvironmentVariables: '',
  envSnippets: [],
  customContextLimits: {},

  keyboardNavigation: {
    scrollUpKey: 'w',
    scrollDownKey: 's',
    focusInputKey: 'i',
  },
  requireCommandOrControlEnterToSend: false,

  locale: 'en',

  providerConfigs: {},

  settingsProvider: 'claude',
  lastSelectedChatModel: null,
  savedProviderModel: {},
  savedProviderEffort: {},
  savedProviderServiceTier: {},
  savedProviderPermissionMode: {},
  pendingProviderSessionInvalidations: {},

  enableAutoScroll: true,
  showMessageTimestamps: false,
  deferMathRenderingDuringStreaming: true,
  expandFileEditsByDefault: false,
  chatViewPlacement: 'right-sidebar',
  enableZenMode: true,
  enableDualPane: true,
  dualPaneSide: 'right',
  restoreTabsOnStartup: true,
  skillsSynced: false,
  sessionManagerOrganization: 'list',
  sessionManagerSort: 'last-updated',
  sessionAutoArchiveAfter: 'off',
  pinnedLinkedContentPaths: [],

  hiddenCommands: [],
};
