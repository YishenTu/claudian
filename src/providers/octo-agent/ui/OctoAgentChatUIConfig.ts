import type {
  ProviderChatUIConfig,
  ProviderPermissionModeToggleConfig,
  ProviderReasoningOption,
  ProviderUIOption,
} from '../../../core/providers/types';
import { OCTO_AGENT_PROVIDER_ICON } from '../../../shared/icons';

const OCTO_AGENT_MODEL: ProviderUIOption = {
  description: 'Runs through the local octo-agent server',
  label: 'Octo Agent',
  value: 'octo-agent/kimi-for-coding',
};

const DEFAULT_CONTEXT_WINDOW = 200_000;

const OCTO_AGENT_PERMISSION_MODE_TOGGLE: ProviderPermissionModeToggleConfig = {
  activeLabel: 'All tools',
  activeValue: 'auto',
  inactiveLabel: 'Read-only',
  inactiveValue: 'interactive',
};

export const octoAgentChatUIConfig: ProviderChatUIConfig = {
  getModelOptions(): ProviderUIOption[] {
    return [OCTO_AGENT_MODEL];
  },

  ownsModel(model: string): boolean {
    return model === 'octo-agent' || model === 'octo-agent/octo-agent' || model.startsWith('octo-agent/');
  },

  isAdaptiveReasoningModel(): boolean {
    return false;
  },

  getReasoningOptions(): ProviderReasoningOption[] {
    return [];
  },

  getDefaultReasoningValue(): string {
    return 'off';
  },

  getContextWindowSize(
    _model: string,
    customLimits?: Record<string, number>,
  ): number {
    return customLimits?.['octo-agent'] ?? DEFAULT_CONTEXT_WINDOW;
  },

  isDefaultModel(model: string): boolean {
    return model === 'octo-agent' || model === 'octo-agent/kimi-for-coding';
  },

  applyModelDefaults(model: string, settings: unknown): void {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      return;
    }
    const settingsBag = settings as Record<string, unknown>;
    if (model === 'octo-agent' || model === 'octo-agent/kimi-for-coding' || model.startsWith('octo-agent/')) {
      settingsBag.model = model;
    }
  },

  normalizeModelVariant(model: string, _settings: Record<string, unknown>): string {
    if (model === 'octo-agent' || model === 'octo-agent/kimi-for-coding' || model.startsWith('octo-agent/')) {
      return model;
    }
    return 'octo-agent/kimi-for-coding';
  },

  getCustomModelIds(): Set<string> {
    return new Set<string>();
  },

  getPermissionModeToggle(): ProviderPermissionModeToggleConfig | null {
    return OCTO_AGENT_PERMISSION_MODE_TOGGLE;
  },

  resolvePermissionMode(settings: Record<string, unknown>): string | null {
    return typeof settings.permissionMode === 'string' ? settings.permissionMode : 'auto';
  },

  applyPermissionMode(value: string, settings: unknown): void {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      return;
    }
    (settings as Record<string, unknown>).permissionMode = value;
  },

  getProviderIcon() {
    return OCTO_AGENT_PROVIDER_ICON;
  },
};
