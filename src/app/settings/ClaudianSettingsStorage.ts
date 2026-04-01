import {
  normalizeHiddenCommandList,
  normalizeHiddenProviderCommands,
} from '../../core/providers/commands/hiddenCommands';
import type { VaultFileAdapter } from '../../core/storage/VaultFileAdapter';
import type {
  ClaudianSettings,
  HiddenProviderCommands,
  PlatformBlockedCommands,
  ProviderConfigMap,
} from '../../core/types/settings';
import { getDefaultBlockedCommands } from '../../core/types/settings';
import {
  getClaudeProviderSettings,
  updateClaudeProviderSettings,
} from '../../providers/claude/settings';
import {
  getCodexProviderSettings,
  updateCodexProviderSettings,
} from '../../providers/codex/settings';
import { DEFAULT_CLAUDIAN_SETTINGS } from './defaultSettings';

export const CLAUDIAN_SETTINGS_PATH = '.claude/claudian-settings.json';

export type StoredClaudianSettings = ClaudianSettings;

const LEGACY_TOP_LEVEL_PROVIDER_FIELDS = [
  'claudeSafeMode',
  'codexSafeMode',
  'claudeCliPath',
  'claudeCliPathsByHost',
  'codexCliPath',
  'codexCliPathsByHost',
  'codexReasoningSummary',
  'loadUserClaudeSettings',
  'codexEnabled',
  'lastClaudeModel',
  'enableChrome',
  'enableBangBash',
  'enableOpus1M',
  'enableSonnet1M',
] as const;

function stripLegacyFields(settings: Record<string, unknown>): Record<string, unknown> {
  const {
    activeConversationId: _activeConversationId,
    show1MModel: _show1MModel,
    hiddenSlashCommands: _hiddenSlashCommands,
    slashCommands: _slashCommands,
    allowExternalAccess: _allowExternalAccess,
    allowedExportPaths: _allowedExportPaths,
    claudeSafeMode: _claudeSafeMode,
    codexSafeMode: _codexSafeMode,
    claudeCliPath: _claudeCliPath,
    claudeCliPathsByHost: _claudeCliPathsByHost,
    codexCliPath: _codexCliPath,
    codexCliPathsByHost: _codexCliPathsByHost,
    codexReasoningSummary: _codexReasoningSummary,
    loadUserClaudeSettings: _loadUserClaudeSettings,
    codexEnabled: _codexEnabled,
    lastClaudeModel: _lastClaudeModel,
    enableChrome: _enableChrome,
    enableBangBash: _enableBangBash,
    enableOpus1M: _enableOpus1M,
    enableSonnet1M: _enableSonnet1M,
    ...cleaned
  } = settings;
  return cleaned;
}

function normalizeCommandList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) {
    return [...fallback];
  }

  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function normalizeBlockedCommands(value: unknown): PlatformBlockedCommands {
  const defaults = getDefaultBlockedCommands();

  if (Array.isArray(value)) {
    return {
      unix: normalizeCommandList(value, defaults.unix),
      windows: [...defaults.windows],
    };
  }

  if (!value || typeof value !== 'object') {
    return defaults;
  }

  const candidate = value as Record<string, unknown>;
  return {
    unix: normalizeCommandList(candidate.unix, defaults.unix),
    windows: normalizeCommandList(candidate.windows, defaults.windows),
  };
}

function normalizeProviderConfigs(value: unknown): ProviderConfigMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const result: ProviderConfigMap = {};
  for (const [providerId, config] of Object.entries(value as Record<string, unknown>)) {
    if (config && typeof config === 'object' && !Array.isArray(config)) {
      result[providerId] = { ...(config as Record<string, unknown>) };
    }
  }
  return result;
}

function hasLegacyTopLevelProviderFields(stored: Record<string, unknown>): boolean {
  return LEGACY_TOP_LEVEL_PROVIDER_FIELDS.some((key) => key in stored);
}

function mergeLegacyClaudeHiddenCommands(
  hiddenProviderCommands: HiddenProviderCommands,
  legacyHiddenSlashCommands: unknown,
): HiddenProviderCommands {
  const legacyCommands = normalizeHiddenCommandList(legacyHiddenSlashCommands);
  if (legacyCommands.length === 0 || hiddenProviderCommands.claude) {
    return hiddenProviderCommands;
  }

  return {
    ...hiddenProviderCommands,
    claude: legacyCommands,
  };
}

export class ClaudianSettingsStorage {
  constructor(private adapter: VaultFileAdapter) {}

  async load(): Promise<StoredClaudianSettings> {
    if (!(await this.adapter.exists(CLAUDIAN_SETTINGS_PATH))) {
      return this.getDefaults();
    }

    const content = await this.adapter.read(CLAUDIAN_SETTINGS_PATH);
    const stored = JSON.parse(content) as Record<string, unknown>;
    const hiddenProviderCommands = mergeLegacyClaudeHiddenCommands(
      normalizeHiddenProviderCommands(stored.hiddenProviderCommands),
      stored.hiddenSlashCommands,
    );
    const providerConfigs = normalizeProviderConfigs(stored.providerConfigs);
    const legacyProviderSettings = {
      ...stored,
      hiddenProviderCommands,
      providerConfigs,
    };

    const merged = {
      ...this.getDefaults(),
      ...stripLegacyFields(legacyProviderSettings),
      blockedCommands: normalizeBlockedCommands(stored.blockedCommands),
      hiddenProviderCommands,
      providerConfigs,
    } as StoredClaudianSettings;

    updateClaudeProviderSettings(
      merged as unknown as Record<string, unknown>,
      getClaudeProviderSettings(legacyProviderSettings),
    );
    updateCodexProviderSettings(
      merged as unknown as Record<string, unknown>,
      getCodexProviderSettings(legacyProviderSettings),
    );

    if (
      hasLegacyTopLevelProviderFields(stored)
      || 'show1MModel' in stored
      || 'slashCommands' in stored
      || 'hiddenSlashCommands' in stored
      || 'activeConversationId' in stored
      || 'allowExternalAccess' in stored
      || 'allowedExportPaths' in stored
    ) {
      await this.save(merged);
    }

    return merged;
  }

  async save(settings: StoredClaudianSettings): Promise<void> {
    const content = JSON.stringify(
      stripLegacyFields(settings as unknown as Record<string, unknown>),
      null,
      2,
    );
    await this.adapter.write(CLAUDIAN_SETTINGS_PATH, content);
  }

  async exists(): Promise<boolean> {
    return this.adapter.exists(CLAUDIAN_SETTINGS_PATH);
  }

  async update(updates: Partial<StoredClaudianSettings>): Promise<void> {
    const current = await this.load();
    await this.save({ ...current, ...updates });
  }

  async setLastModel(model: string, isCustom: boolean): Promise<void> {
    if (isCustom) {
      await this.update({ lastCustomModel: model });
      return;
    }

    const current = await this.load();
    updateClaudeProviderSettings(
      current as unknown as Record<string, unknown>,
      { lastModel: model },
    );
    await this.save(current);
  }

  async setLastEnvHash(hash: string): Promise<void> {
    await this.update({ lastEnvHash: hash });
  }

  private getDefaults(): StoredClaudianSettings {
    return DEFAULT_CLAUDIAN_SETTINGS;
  }
}
