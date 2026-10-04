import { createDefaultClaudianSettings } from '@/app/settings/defaultSettings';
import { getBuiltInProviderDefaultConfigs } from '@/providers/defaultProviderConfigs';

/** Application defaults with the built-in provider defaults that the composition root injects. */
export const DEFAULT_CLAUDIAN_SETTINGS = createDefaultClaudianSettings(getBuiltInProviderDefaultConfigs());
