import type {
  ProviderChatUIConfig,
  ProviderReasoningOption,
  ProviderUIOption,
} from '../../../core/providers/types';
import { getCursorModelOptions } from '../modelOptions';
import {
  DEFAULT_CURSOR_MODEL_SET,
  DEFAULT_CURSOR_PRIMARY_MODEL,
} from '../types/models';

const DEFAULT_CONTEXT_WINDOW = 200_000;

function looksLikeCursorModel(model: string): boolean {
  if (DEFAULT_CURSOR_MODEL_SET.has(model)) {
    return true;
  }
  return /^composer-/i.test(model) || model === 'auto';
}

export const cursorChatUIConfig: ProviderChatUIConfig = {
  getModelOptions(settings: Record<string, unknown>): ProviderUIOption[] {
    return getCursorModelOptions(settings);
  },

  ownsModel(model: string, settings: Record<string, unknown>): boolean {
    if (getCursorModelOptions(settings).some(option => option.value === model)) {
      return true;
    }
    return looksLikeCursorModel(model);
  },

  isAdaptiveReasoningModel(_model: string, _settings: Record<string, unknown>): boolean {
    return false;
  },

  getReasoningOptions(_model: string, _settings: Record<string, unknown>): ProviderReasoningOption[] {
    return [];
  },

  getDefaultReasoningValue(_model: string, _settings: Record<string, unknown>): string {
    return '';
  },

  getContextWindowSize(): number {
    return DEFAULT_CONTEXT_WINDOW;
  },

  isDefaultModel(model: string): boolean {
    return DEFAULT_CURSOR_MODEL_SET.has(model);
  },

  applyModelDefaults(_model: string, _settings: unknown): void {
    // No model-specific side effects for Cursor MVP.
  },

  normalizeModelVariant(model: string, settings: Record<string, unknown>): string {
    if (getCursorModelOptions(settings).some(option => option.value === model)) {
      return model;
    }
    return DEFAULT_CURSOR_PRIMARY_MODEL;
  },

  getCustomModelIds(envVars: Record<string, string>): Set<string> {
    const ids = new Set<string>();
    if (envVars.CURSOR_MODEL && !DEFAULT_CURSOR_MODEL_SET.has(envVars.CURSOR_MODEL)) {
      ids.add(envVars.CURSOR_MODEL);
    }
    return ids;
  },
};
