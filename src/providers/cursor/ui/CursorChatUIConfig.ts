import type {
  ProviderChatUIConfig,
  ProviderPermissionModeToggleConfig,
} from '../../../core/providers/types';
import { t } from '../../../i18n/i18n';
import { buildInitialCursorUsageInfo } from '../execution/CursorExecutionSession';
import {
  decodeCursorModelId,
  encodeCursorModelId,
} from '../models';
import { getCursorProviderSettings } from '../settings';

export const cursorChatUIConfig: ProviderChatUIConfig = {
  getModelOptions(settings) {
    const provider = getCursorProviderSettings(settings);
    const discovered = new Map(provider.discoveredModels.map(model => [model.rawId, model]));
    return [...provider.visibleModels].reverse().flatMap(rawId => {
      const model = discovered.get(rawId);
      return model ? [{
        description: model.description ?? 'Cursor ACP runtime',
        label: model.label,
        value: encodeCursorModelId(rawId),
      }] : [];
    });
  },
  getDefaultModel: settings => {
    const rawId = getCursorProviderSettings(settings).visibleModels[0];
    return rawId ? encodeCursorModelId(rawId) : null;
  },
  ownsModel: model => decodeCursorModelId(model) !== null,
  isAdaptiveReasoningModel: () => false,
  getReasoningOptions: () => [],
  getDefaultReasoningValue: () => 'default',
  getInitialUsage(model) {
    return buildInitialCursorUsageInfo(decodeCursorModelId(model) ?? undefined);
  },
  getContextWindowSize: () => 200_000,
  isDefaultModel: model => decodeCursorModelId(model) !== null,
  applyModelDefaults: () => undefined,
  normalizeModelVariant: model => model,
  getCustomModelIds: () => new Set<string>(),
  getPermissionModeToggle: (): ProviderPermissionModeToggleConfig => ({
    inactiveValue: 'normal',
    inactiveLabel: t('settings.cursor.agent'),
    activeValue: 'ask',
    activeLabel: t('settings.cursor.ask'),
    planValue: 'plan',
    planLabel: t('settings.cursor.plan'),
  }),
  resolvePermissionMode(settings) {
    return settings.permissionMode === 'plan' || settings.permissionMode === 'ask'
      ? settings.permissionMode
      : 'normal';
  },
  applyPermissionMode(value, settings) {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return;
    const target = settings as Record<string, unknown>;
    target.permissionMode = value === 'plan' || value === 'ask' ? value : 'normal';
  },
};
