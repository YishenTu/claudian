import type { Conversation } from '../types';
import { ProviderRegistry } from './ProviderRegistry';
import type { ProviderChatUIConfig, ProviderId } from './types';

export interface SettingsReconciliationResult {
  changed: boolean;
  invalidatedConversations: Conversation[];
}

const PROJECTION_KEYS = new Set([
  'model',
  'effortLevel',
  'serviceTier',
  'thinkingBudget',
  'permissionMode',
]);

type ProviderProjectionMap = Partial<Record<string, string>>;

function getSettingsProviderId(settings: Record<string, unknown>): ProviderId {
  return ProviderRegistry.resolveSettingsProviderId(settings);
}

function ensureProjectionMap(
  settings: Record<string, unknown>,
  key:
  | 'savedProviderModel'
  | 'savedProviderEffort'
  | 'savedProviderServiceTier'
  | 'savedProviderThinkingBudget'
  | 'savedProviderPermissionMode',
): ProviderProjectionMap {
  const current = settings[key];
  if (current && typeof current === 'object') {
    return current;
  }

  const next: ProviderProjectionMap = {};
  settings[key] = next;
  return next;
}

function cloneProviderSettings(settings: Record<string, unknown>): Record<string, unknown> {
  return {
    ...settings,
    savedProviderModel: { ...(settings.savedProviderModel as ProviderProjectionMap | undefined) },
    savedProviderEffort: { ...(settings.savedProviderEffort as ProviderProjectionMap | undefined) },
    savedProviderServiceTier: { ...(settings.savedProviderServiceTier as ProviderProjectionMap | undefined) },
    savedProviderThinkingBudget: { ...(settings.savedProviderThinkingBudget as ProviderProjectionMap | undefined) },
    savedProviderPermissionMode: { ...(settings.savedProviderPermissionMode as ProviderProjectionMap | undefined) },
  };
}

function normalizeToggleValue(
  value: unknown,
  allowedValues: Set<string>,
): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  return allowedValues.has(value) ? value : undefined;
}

function mergeProviderSettings(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): void {
  for (const [key, value] of Object.entries(source)) {
    if (PROJECTION_KEYS.has(key)) {
      continue;
    }
    target[key] = value;
  }
}

function normalizeReasoningValue(
  uiConfig: ProviderChatUIConfig,
  settings: Record<string, unknown>,
  model: string,
  value: unknown,
): string {
  const allowedValues = new Set(uiConfig.getReasoningOptions(model, settings).map(option => option.value));
  if (typeof value === 'string' && allowedValues.has(value)) {
    return value;
  }
  return uiConfig.getDefaultReasoningValue(model, settings);
}

function normalizeProviderModel(
  uiConfig: ProviderChatUIConfig,
  settings: Record<string, unknown>,
  model: string | undefined,
): string | undefined {
  if (!model) {
    return undefined;
  }
  return uiConfig.normalizeModelVariant(model, settings);
}

export class ProviderSettingsCoordinator {
  static handleEnvironmentChange(
    settings: Record<string, unknown>,
    providerIds: ProviderId[],
  ): boolean {
    let anyChanged = false;
    for (const providerId of providerIds) {
      const reconciler = ProviderRegistry.getSettingsReconciler(providerId);
      if (reconciler.handleEnvironmentChange?.(settings)) {
        anyChanged = true;
      }
    }
    return anyChanged;
  }

  static reconcileTitleGenerationModelSelection(settings: Record<string, unknown>): boolean {
    const currentModel = typeof settings.titleGenerationModel === 'string'
      ? settings.titleGenerationModel
      : '';
    if (!currentModel) {
      return false;
    }

    const isValid = ProviderRegistry.getRegisteredProviderIds().some((providerId) =>
      ProviderRegistry.getChatUIConfig(providerId)
        .getModelOptions(settings)
        .some((option) => option.value === currentModel)
    );
    if (isValid) {
      return false;
    }

    settings.titleGenerationModel = '';
    return true;
  }

  static normalizeProviderSelection(settings: Record<string, unknown>): boolean {
    const next = getSettingsProviderId(settings);

    if (settings.settingsProvider === next) {
      return false;
    }

    settings.settingsProvider = next;
    return true;
  }

  static getProviderSettingsSnapshot<T extends Record<string, unknown>>(
    settings: T,
    providerId: ProviderId,
  ): T {
    const snapshot = cloneProviderSettings(settings) as T;
    this.projectProviderState(snapshot, providerId);
    return snapshot;
  }

  static commitProviderSettingsSnapshot(
    settings: Record<string, unknown>,
    providerId: ProviderId,
    snapshot: Record<string, unknown>,
  ): void {
    this.persistProjectedProviderState(snapshot, providerId);

    if (providerId === getSettingsProviderId(settings)) {
      Object.assign(settings, snapshot);
      return;
    }

    mergeProviderSettings(settings, snapshot);
  }

  static persistProjectedProviderState(
    settings: Record<string, unknown>,
    providerId: ProviderId = getSettingsProviderId(settings),
  ): void {
    const savedModel = ensureProjectionMap(settings, 'savedProviderModel');
    const savedEffort = ensureProjectionMap(settings, 'savedProviderEffort');
    const savedServiceTier = ensureProjectionMap(settings, 'savedProviderServiceTier');
    const savedBudget = ensureProjectionMap(settings, 'savedProviderThinkingBudget');
    const savedPermissionMode = ensureProjectionMap(settings, 'savedProviderPermissionMode');
    const uiConfig = ProviderRegistry.getChatUIConfig(providerId);
    const normalizedModel = normalizeProviderModel(
      uiConfig,
      settings,
      typeof settings.model === 'string' ? settings.model : undefined,
    );
    const projectedSettings = normalizedModel && normalizedModel !== settings.model
      ? { ...settings, model: normalizedModel }
      : settings;

    if (normalizedModel) {
      savedModel[providerId] = normalizedModel;
    }
    if (typeof settings.effortLevel === 'string') {
      savedEffort[providerId] = settings.effortLevel;
    }
    const serviceTierToggle = uiConfig.getServiceTierToggle?.(projectedSettings) ?? null;
    if (serviceTierToggle && typeof settings.serviceTier === 'string') {
      savedServiceTier[providerId] = settings.serviceTier;
    }
    if (typeof settings.thinkingBudget === 'string') {
      savedBudget[providerId] = settings.thinkingBudget;
    }
    if (typeof settings.permissionMode === 'string' && uiConfig.getPermissionModeToggle?.()) {
      savedPermissionMode[providerId] = settings.permissionMode;
    }
  }

  static projectProviderState(
    settings: Record<string, unknown>,
    providerId: ProviderId,
  ): void {
    const uiConfig = ProviderRegistry.getChatUIConfig(providerId);
    const savedModel = settings.savedProviderModel as ProviderProjectionMap | undefined;
    const savedEffort = settings.savedProviderEffort as ProviderProjectionMap | undefined;
    const savedServiceTier = settings.savedProviderServiceTier as ProviderProjectionMap | undefined;
    const savedBudget = settings.savedProviderThinkingBudget as ProviderProjectionMap | undefined;
    const savedPermissionMode = settings.savedProviderPermissionMode as ProviderProjectionMap | undefined;

    const shouldPreferCurrentProjection = providerId === getSettingsProviderId(settings);
    const currentModelRaw = typeof settings.model === 'string' ? settings.model : '';
    const currentModel = shouldPreferCurrentProjection
      ? (normalizeProviderModel(uiConfig, settings, currentModelRaw) ?? '')
      : currentModelRaw;
    const currentEffort = typeof settings.effortLevel === 'string' ? settings.effortLevel : undefined;
    const currentServiceTier = typeof settings.serviceTier === 'string' ? settings.serviceTier : undefined;
    const currentBudget = typeof settings.thinkingBudget === 'string' ? settings.thinkingBudget : undefined;
    const modelOptions = uiConfig.getModelOptions(settings);
    const isDefaultModelOfAnotherProvider = currentModel.length > 0
      && ProviderRegistry.getRegisteredProviderIds()
        .filter(id => id !== providerId)
        .some(id => ProviderRegistry.getChatUIConfig(id).isDefaultModel(currentModel));
    const canReuseCurrentModel = currentModel.length > 0
      && !isDefaultModelOfAnotherProvider
      && (
        shouldPreferCurrentProjection
        || modelOptions.some(option => option.value === currentModel)
      );
    const fallbackModel = canReuseCurrentModel
      ? currentModel
      : (modelOptions[0]?.value ?? currentModel);
    const savedModelValue = normalizeProviderModel(uiConfig, settings, savedModel?.[providerId]);
    const isSavedModelValid = savedModelValue !== undefined
      && modelOptions.some(option => option.value === savedModelValue);
    const model = (isSavedModelValid ? savedModelValue : undefined) ?? fallbackModel;
    const canReuseCurrentProjection = canReuseCurrentModel && model === currentModel;

    if (model) {
      settings.model = model;
      uiConfig.applyModelDefaults(model, settings);
    }

    const serviceTierToggle = uiConfig.getServiceTierToggle?.({
      ...settings,
      ...(model ? { model } : {}),
    }) ?? null;

    const isAdaptive = Boolean(model) && uiConfig.isAdaptiveReasoningModel(model, settings);

    if (savedEffort?.[providerId] !== undefined) {
      settings.effortLevel = savedEffort[providerId];
    } else if (canReuseCurrentProjection && currentEffort !== undefined) {
      settings.effortLevel = currentEffort;
    } else if (isAdaptive) {
      settings.effortLevel = uiConfig.getDefaultReasoningValue(model, settings);
    }

    if (isAdaptive) {
      settings.effortLevel = normalizeReasoningValue(uiConfig, settings, model, settings.effortLevel);
    }

    if (savedServiceTier?.[providerId] !== undefined) {
      settings.serviceTier = savedServiceTier[providerId];
    } else if (canReuseCurrentProjection && currentServiceTier !== undefined) {
      settings.serviceTier = currentServiceTier;
    } else {
      settings.serviceTier = serviceTierToggle?.inactiveValue ?? 'default';
    }

    const usesBudget = Boolean(model) && !isAdaptive;

    if (savedBudget?.[providerId] !== undefined) {
      settings.thinkingBudget = savedBudget[providerId];
    } else if (canReuseCurrentProjection && currentBudget !== undefined) {
      settings.thinkingBudget = currentBudget;
    } else if (usesBudget) {
      settings.thinkingBudget = uiConfig.getDefaultReasoningValue(model, settings);
    }

    if (usesBudget) {
      settings.thinkingBudget = normalizeReasoningValue(uiConfig, settings, model, settings.thinkingBudget);
    }

    const permissionToggle = uiConfig.getPermissionModeToggle?.() ?? null;
    if (!permissionToggle) {
      return;
    }

    const allowedPermissionModes = new Set([
      permissionToggle.inactiveValue,
      permissionToggle.activeValue,
      ...(permissionToggle.planValue ? [permissionToggle.planValue] : []),
    ]);
    const currentPermissionMode = normalizeToggleValue(settings.permissionMode, allowedPermissionModes);
    const derivedPermissionMode = normalizeToggleValue(
      uiConfig.resolvePermissionMode?.(settings),
      allowedPermissionModes,
    );
    const savedPermissionModeValue = normalizeToggleValue(
      savedPermissionMode?.[providerId],
      allowedPermissionModes,
    );

    const projectedPermissionMode = savedPermissionModeValue
      ?? derivedPermissionMode
      ?? (shouldPreferCurrentProjection ? currentPermissionMode : undefined)
      ?? currentPermissionMode;

    if (projectedPermissionMode !== undefined) {
      settings.permissionMode = projectedPermissionMode;
    }
  }

  /** Each provider's reconciler only processes its own conversations. */
  static reconcileAllProviders(
    settings: Record<string, unknown>,
    conversations: Conversation[],
  ): SettingsReconciliationResult {
    return this.reconcileProviders(
      settings,
      conversations,
      ProviderRegistry.getRegisteredProviderIds(),
    );
  }

  static reconcileProviders(
    settings: Record<string, unknown>,
    conversations: Conversation[],
    providerIds: ProviderId[],
  ): SettingsReconciliationResult {
    let anyChanged = false;
    const allInvalidated: Conversation[] = [];
    const settingsProvider = getSettingsProviderId(settings);

    for (const providerId of providerIds) {
      const reconciler = ProviderRegistry.getSettingsReconciler(providerId);
      const providerConversations = conversations.filter(c => c.providerId === providerId);
      const targetSettings = providerId === settingsProvider
        ? settings
        : cloneProviderSettings(settings);

      if (providerId !== settingsProvider) {
        this.projectProviderState(targetSettings, providerId);
      }

      const { changed, invalidatedConversations } = reconciler.reconcileModelWithEnvironment(
        targetSettings,
        providerConversations,
      );

      if (changed) {
        anyChanged = true;
        this.persistProjectedProviderState(targetSettings, providerId);
        if (providerId !== settingsProvider) {
          mergeProviderSettings(settings, targetSettings);
        }
      }
      allInvalidated.push(...invalidatedConversations);
    }

    if (this.reconcileTitleGenerationModelSelection(settings)) {
      anyChanged = true;
    }

    return { changed: anyChanged, invalidatedConversations: allInvalidated };
  }

  static normalizeAllModelVariants(settings: Record<string, unknown>): boolean {
    let anyChanged = false;
    const settingsProvider = getSettingsProviderId(settings);

    for (const providerId of ProviderRegistry.getRegisteredProviderIds()) {
      const reconciler = ProviderRegistry.getSettingsReconciler(providerId);
      const targetSettings = providerId === settingsProvider
        ? settings
        : cloneProviderSettings(settings);

      if (providerId !== settingsProvider) {
        this.projectProviderState(targetSettings, providerId);
      }

      const changed = reconciler.normalizeModelVariantSettings(targetSettings);
      if (changed) {
        anyChanged = true;
        this.persistProjectedProviderState(targetSettings, providerId);
        if (providerId !== settingsProvider) {
          mergeProviderSettings(settings, targetSettings);
        }
      }
    }

    if (this.reconcileTitleGenerationModelSelection(settings)) {
      anyChanged = true;
    }
    return anyChanged;
  }

  /**
   * Project the settings provider's saved values into the top-level
   * model/effortLevel/thinkingBudget fields.
   */
  static projectActiveProviderState(settings: Record<string, unknown>): void {
    this.projectProviderState(settings, getSettingsProviderId(settings));
  }
}
