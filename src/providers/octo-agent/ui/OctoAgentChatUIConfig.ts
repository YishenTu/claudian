import type {
  ProviderChatUIConfig,
  ProviderPermissionModeToggleConfig,
  ProviderReasoningOption,
  ProviderUIOption,
} from '../../../core/providers/types';
import { OCTO_AGENT_PROVIDER_ICON } from '../../../shared/icons';
import {
  isValidClaudianPermissionMode,
  toClaudianPermissionMode,
} from '../permissionMode';

const OCTO_AGENT_MODEL: ProviderUIOption = {
  description: 'Runs through the local octo-agent server',
  label: 'Octo Agent',
  value: 'octo-agent/kimi-for-coding',
};

const DEFAULT_CONTEXT_WINDOW = 200_000;

const OCTO_AGENT_PERMISSION_MODE_TOGGLE: ProviderPermissionModeToggleConfig = {
  activeLabel: 'All tools',
  activeValue: 'yolo',
  inactiveLabel: 'Read-only',
  inactiveValue: 'normal',
};

export const octoAgentChatUIConfig: ProviderChatUIConfig = {
  getModelOptions(settings: Record<string, unknown>): ProviderUIOption[] {
    const cached = settings.octoAgentModels as ProviderUIOption[] | undefined;
    if (cached && cached.length > 0) {
      return cached;
    }
    return [OCTO_AGENT_MODEL];
  },

  ownsModel(model: string, _settings: Record<string, unknown>): boolean {
    return model === 'octo-agent' || model === 'octo-agent/octo-agent' || model.startsWith('octo-agent/');
  },

  isAdaptiveReasoningModel(_model: string, _settings: Record<string, unknown>): boolean {
    return false;
  },

  getReasoningOptions(_model: string, _settings: Record<string, unknown>): ProviderReasoningOption[] {
    return [];
  },

  getDefaultReasoningValue(_model: string, _settings: Record<string, unknown>): string {
    return 'off';
  },

  getContextWindowSize(
    _model: string,
    customLimits?: Record<string, number>,
    _settings?: Record<string, unknown>,
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

  normalizeModelVariant(model: string, settings: Record<string, unknown>): string {
    const cached = settings.octoAgentModels as ProviderUIOption[] | undefined;
    if (cached && cached.length > 0) {
      if (cached.some((option) => option.value === model)) {
        return model;
      }
      const defaultOption = cached.find((option) => option.value === 'octo-agent/kimi-for-coding') ?? cached[0];
      return defaultOption?.value ?? 'octo-agent/kimi-for-coding';
    }
    if (model === 'octo-agent' || model === 'octo-agent/kimi-for-coding' || model.startsWith('octo-agent/')) {
      return model;
    }
    return 'octo-agent/kimi-for-coding';
  },

  getCustomModelIds(_envVars: Record<string, string>): Set<string> {
    return new Set<string>();
  },

  getPermissionModeToggle(): ProviderPermissionModeToggleConfig | null {
    return OCTO_AGENT_PERMISSION_MODE_TOGGLE;
  },

  resolvePermissionMode(settings: Record<string, unknown>): string | null {
    const value = typeof settings.permissionMode === 'string' ? settings.permissionMode : 'yolo';
    if (isValidClaudianPermissionMode(value)) {
      return value;
    }
    return toClaudianPermissionMode(value);
  },

  applyPermissionMode(value: string, settings: unknown): void {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      return;
    }
    const normalized = isValidClaudianPermissionMode(value)
      ? value
      : toClaudianPermissionMode(value);
    (settings as Record<string, unknown>).permissionMode = normalized;
  },

  getProviderIcon() {
    return OCTO_AGENT_PROVIDER_ICON;
  },
};
