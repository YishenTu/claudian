import { DEFAULT_REASONING_VALUE } from '@/core/providers/reasoning';
import type { ProviderModelPolicy } from '@/core/providers/types';

import { decodeDeepSeekModelId } from './models';
import { DEEPSEEK_PERMISSION_MODE_POLICY } from './permissionModes';
import { findDeepSeekModel, getDeepSeekProviderSettings, isDeepSeekModelSelectable, updateDeepSeekProviderSettings } from './settings';

export const deepseekModelPolicy: ProviderModelPolicy = {
  permissionModes: DEEPSEEK_PERMISSION_MODE_POLICY,
  ownsModel: model => decodeDeepSeekModelId(model) !== null,
  isDefaultModel: model => decodeDeepSeekModelId(model) !== null,
  getModelOptions(settings) {
    const current = getDeepSeekProviderSettings(settings);
    return current.visibleModels.map(id => {
      const model = findDeepSeekModel(current, id);
      return {
        value: id,
        label: model && model.available !== false
          ? current.modelAliases[id] ?? model.label : `${current.modelAliases[id] ?? model?.label ?? id} (unavailable)`,
        group: model?.provider,
        description: model?.description,
      };
    });
  },
  getDefaultModel(settings) {
    const current = getDeepSeekProviderSettings(settings);
    return current.visibleModels.find(id => isDeepSeekModelSelectable(current, id)) ?? null;
  },
  supportsReasoningEffort(model, settings) {
    return (findDeepSeekModel(getDeepSeekProviderSettings(settings), model)?.reasoning?.length ?? 0) > 0;
  },
  getReasoningOptions(model, settings) {
    return (findDeepSeekModel(getDeepSeekProviderSettings(settings), model)?.reasoning ?? [])
      .map(effort => ({ value: effort.id, label: effort.name }));
  },
  getDefaultReasoningValue(model, settings) {
    const current = getDeepSeekProviderSettings(settings);
    const efforts = findDeepSeekModel(current, model)?.reasoning ?? [];
    const preferred = current.preferredReasoningByModel[model];
    if (preferred && efforts.some(effort => effort.id === preferred)) return preferred;
    // Native rejects any other effort for a model advertising only Off (thinking disabled).
    return efforts.length > 0 && efforts.every(effort => effort.id === 'off') ? 'off' : DEFAULT_REASONING_VALUE;
  },
  applyModelDefaults(model, settings) {
    if (!settings || typeof settings !== 'object') return;
    const bag = settings as Record<string, unknown>;
    bag.model = model;
    bag.effortLevel = deepseekModelPolicy.getDefaultReasoningValue(model, bag);
  },
  applyModelProjectionDefaults(model, settings) {
    if (!settings || typeof settings !== 'object') return;
    const bag = settings as Record<string, unknown>;
    const value = getDeepSeekProviderSettings(bag).preferredReasoningByModel[model];
    if (value) bag.effortLevel = value;
  },
  applyReasoningSelection(model, value, settings) {
    if (!settings || typeof settings !== 'object' || !decodeDeepSeekModelId(model)) return;
    const bag = settings as Record<string, unknown>;
    updateDeepSeekProviderSettings(bag, {
      preferredReasoningByModel: { ...getDeepSeekProviderSettings(bag).preferredReasoningByModel, [model]: value },
    });
  },
  normalizeModelVariant: model => model,
  getCustomModelIds: () => new Set(),
};
