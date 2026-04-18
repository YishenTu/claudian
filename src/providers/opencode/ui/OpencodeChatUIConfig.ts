import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { ProviderChatUIConfig, ProviderIconSvg,ProviderReasoningOption } from '../../../core/providers/types';
import { getOpencodeProviderSettings } from '../settings';

const OPENCODE_ICON: ProviderIconSvg = {
  viewBox: '0 0 24 24',
  path: 'M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5',
};

let cachedModels: Array<{ value: string; label: string; description?: string; group?: string }> = [];
let cacheLoaded = false;

function getOpencodeConfigPath(): string {
  const home = os.homedir();
  switch (process.platform) {
    case 'darwin':
      return path.join(home, '.config', 'opencode', 'opencode.json');
    case 'win32':
      return path.join(process.env.APPDATA || home, 'opencode', 'opencode.json');
    default:
      return path.join(home, '.config', 'opencode', 'opencode.json');
  }
}

function loadModelsFromConfig(): Array<{ value: string; label: string; description?: string; group?: string }> {
  if (cacheLoaded) {
    return cachedModels;
  }

  try {
    const configPath = getOpencodeConfigPath();
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf-8');
      const config = JSON.parse(content);
      
      const models: Array<{ value: string; label: string; description?: string; group?: string }> = [];
      
      if (config.defaultModel) {
        models.push({
          value: config.defaultModel,
          label: config.defaultModel,
          description: 'Default',
          group: 'OpenCode',
        });
      }
      
      if (config.models && Array.isArray(config.models)) {
        for (const model of config.models) {
          if (typeof model === 'string') {
            models.push({
              value: model,
              label: model,
              group: 'OpenCode',
            });
          } else if (model.id) {
            models.push({
              value: model.id,
              label: model.name || model.id,
              description: model.description,
              group: 'OpenCode',
            });
          }
        }
      }
      
      if (models.length > 0) {
        cachedModels = models;
      }
    }
  } catch {
    // Ignore errors, use default
  }

  cacheLoaded = true;
  return cachedModels;
}

export const opencodeChatUIConfig: ProviderChatUIConfig = {
  getModelOptions(settings: Record<string, unknown>): Array<{ value: string; label: string; description?: string; group?: string }> {
    const providerSettings = getOpencodeProviderSettings(settings);
    if (!providerSettings.enabled) {
      return [];
    }

    const models = loadModelsFromConfig();
    if (models.length > 0) {
      return models;
    }

    return [{
      value: 'default',
      label: 'OpenCode (default)',
      description: 'Uses OpenCode configured model',
      group: 'OpenCode',
    }];
  },

  ownsModel(model: string, settings: Record<string, unknown>): boolean {
    const models = loadModelsFromConfig();
    if (models.length > 0) {
      return models.some(m => m.value === model);
    }
    const providerSettings = getOpencodeProviderSettings(settings);
    return providerSettings.enabled && model === 'default';
  },

  isAdaptiveReasoningModel(_model: string): boolean {
    return false;
  },

  getReasoningOptions(_model: string): ProviderReasoningOption[] {
    return [];
  },

  getDefaultReasoningValue(_model: string): string {
    return 'medium';
  },

  getContextWindowSize(_model: string, _customLimits?: Record<string, number>): number {
    return 200000;
  },

  isDefaultModel(model: string): boolean {
    return model === 'default';
  },

  applyModelDefaults(_model: string, _settings: unknown): void {
  },

  normalizeModelVariant(model: string, _settings: Record<string, unknown>): string {
    return model;
  },

  getCustomModelIds(_envVars: Record<string, string>): Set<string> {
    return new Set();
  },

  getPermissionModeToggle(): { inactiveValue: string; inactiveLabel: string; activeValue: string; activeLabel: string } | null {
    return null;
  },

  getServiceTierToggle(_settings: Record<string, unknown>): { inactiveValue: string; inactiveLabel: string; activeValue: string; activeLabel: string; description?: string } | null {
    return null;
  },

  isBangBashEnabled(_settings: Record<string, unknown>): boolean {
    return false;
  },

  getProviderIcon() {
    return OPENCODE_ICON;
  },
};
