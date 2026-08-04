import type {
  ProviderChatUIConfig,
  ProviderPermissionModeToggleConfig,
} from '../../../core/providers/types';
import { t } from '../../../i18n/i18n';
import { buildInitialOmpUsageInfo } from '../execution/OmpExecutionSession';
import {
  decodeOmpModelId,
  encodeOmpModelId,
} from '../models';
import { getOmpProviderSettings } from '../settings';

export const ompChatUIConfig: ProviderChatUIConfig = {
  getModelOptions(settings) {
    const provider = getOmpProviderSettings(settings);
    const discovered = new Map(provider.discoveredModels.map(model => [model.rawId, model]));
    return [...provider.visibleModels].reverse().flatMap(rawId => {
      const model = discovered.get(rawId);
      return model ? [{
        description: model.description ?? 'OMP ACP runtime',
        label: model.label,
        value: encodeOmpModelId(rawId),
      }] : [];
    });
  },
  getDefaultModel: settings => {
    const rawId = getOmpProviderSettings(settings).visibleModels[0];
    return rawId ? encodeOmpModelId(rawId) : null;
  },
  ownsModel: model => decodeOmpModelId(model) !== null,
  isAdaptiveReasoningModel: (_model, settings) => getOmpProviderSettings(settings).thinking !== null,
  getReasoningOptions: (_model, settings) => getOmpProviderSettings(settings).thinking?.options.map(option => ({
    ...(option.description ? { description: option.description } : {}),
    label: option.name,
    value: option.id,
  })) ?? [],
  getDefaultReasoningValue: (_model, settings) => getOmpProviderSettings(settings).thinking?.currentValue ?? 'default',
  getInitialUsage(model) {
    return buildInitialOmpUsageInfo(decodeOmpModelId(model) ?? undefined);
  },
  getContextWindowSize: (_model, customLimits) => customLimits?.omp ?? 200_000,
  isDefaultModel: model => decodeOmpModelId(model) !== null,
  applyModelDefaults: () => undefined,
  normalizeModelVariant: model => model,
  getCustomModelIds: () => new Set<string>(),
  getPermissionModeToggle: (): ProviderPermissionModeToggleConfig => ({
    inactiveValue: 'normal',
    inactiveLabel: t('settings.omp.safe'),
    activeValue: 'yolo',
    activeLabel: t('settings.omp.yolo'),
  }),
  resolvePermissionMode(settings) {
    return settings.permissionMode === 'yolo' ? 'yolo' : 'normal';
  },
  applyPermissionMode(value, settings) {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return;
    const target = settings as Record<string, unknown>;
    target.permissionMode = value === 'yolo' ? 'yolo' : 'normal';
  },
};
