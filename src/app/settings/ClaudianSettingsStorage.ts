import {
  CLAUDIAN_SETTINGS_PATH,
  LEGACY_CLAUDIAN_SETTINGS_PATH,
} from '../../core/bootstrap/StoragePaths';
import {
  normalizeHiddenCommandList,
  normalizeHiddenProviderCommands,
} from '../../core/providers/commands/hiddenCommands';
import {
  getSharedEnvironmentVariables,
  inferEnvironmentSnippetScope,
  resolveEnvironmentSnippetScope,
} from '../../core/providers/providerEnvironment';
import type { VaultFileAdapter } from '../../core/storage/VaultFileAdapter';
import type {
  ClaudianSettings,
  EnvironmentScope,
  EnvSnippet,
  HiddenProviderCommands,
  ProviderConfigMap,
} from '../../core/types/settings';
import {
  getClaudeProviderSettings,
  updateClaudeProviderSettings,
} from '../../providers/claude/settings';
import {
  getCodexProviderSettings,
  updateCodexProviderSettings,
} from '../../providers/codex/settings';
import {
  getCursorProviderSettings,
  updateCursorProviderSettings,
} from '../../providers/cursor/settings';
import { DEFAULT_CLAUDIAN_SETTINGS } from './defaultSettings';

export {
  CLAUDIAN_SETTINGS_PATH,
  LEGACY_CLAUDIAN_SETTINGS_PATH,
};

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
  'environmentVariables',
  'lastEnvHash',
  'lastCodexEnvHash',
] as const;

function stripLegacyFields(settings: Record<string, unknown>): Record<string, unknown> {
  const {
    activeConversationId: _activeConversationId,
    show1MModel: _show1MModel,
    hiddenSlashCommands: _hiddenSlashCommands,
    slashCommands: _slashCommands,
    allowExternalAccess: _allowExternalAccess,
    allowedExportPaths: _allowedExportPaths,
    enableBlocklist: _enableBlocklist,
    blockedCommands: _blockedCommands,
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
    environmentVariables: _environmentVariables,
    lastEnvHash: _lastEnvHash,
    lastCodexEnvHash: _lastCodexEnvHash,
    ...cleaned
  } = settings;
  return cleaned;
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

function isEnvironmentScope(value: unknown): value is EnvironmentScope {
  return value === 'shared' || (typeof value === 'string' && value.startsWith('provider:'));
}

function normalizeContextLimits(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const result: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'number' && Number.isFinite(entry) && entry > 0) {
      result[key] = entry;
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeEnvSnippets(value: unknown): EnvSnippet[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const snippets: EnvSnippet[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }

    const candidate = item as Record<string, unknown>;
    if (
      typeof candidate.id !== 'string'
      || typeof candidate.name !== 'string'
      || typeof candidate.description !== 'string'
      || typeof candidate.envVars !== 'string'
    ) {
      continue;
    }

    snippets.push({
      id: candidate.id,
      name: candidate.name,
      description: candidate.description,
      envVars: candidate.envVars,
      scope: resolveEnvironmentSnippetScope(
        candidate.envVars,
        isEnvironmentScope(candidate.scope)
          ? candidate.scope
          : inferEnvironmentSnippetScope(candidate.envVars),
      ),
      contextLimits: normalizeContextLimits(candidate.contextLimits),
    });
  }

  return snippets;
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
    const settingsPath = await this.getLoadPath();
    if (!settingsPath) {
      return this.getDefaults();
    }

    const content = await this.adapter.read(settingsPath);
    const stored = JSON.parse(content) as Record<string, unknown>;
    const hiddenProviderCommands = mergeLegacyClaudeHiddenCommands(
      normalizeHiddenProviderCommands(stored.hiddenProviderCommands),
      stored.hiddenSlashCommands,
    );
    const envSnippets = normalizeEnvSnippets(stored.envSnippets);
    const providerConfigs = normalizeProviderConfigs(stored.providerConfigs);
    const legacyProviderSettings = {
      ...stored,
      hiddenProviderCommands,
      providerConfigs,
    };
    const storedWithoutLegacy = stripLegacyFields({
      ...legacyProviderSettings,
    });

    const legacyNormalized = {
      ...storedWithoutLegacy,
      sharedEnvironmentVariables: getSharedEnvironmentVariables(legacyProviderSettings),
      envSnippets,
      hiddenProviderCommands,
      providerConfigs,
    };

    const merged = {
      ...this.getDefaults(),
      ...legacyNormalized,
    } as StoredClaudianSettings;

    updateClaudeProviderSettings(
      merged as unknown as Record<string, unknown>,
      getClaudeProviderSettings(legacyProviderSettings),
    );
    updateCodexProviderSettings(
      merged as unknown as Record<string, unknown>,
      getCodexProviderSettings(legacyProviderSettings),
    );
    updateCursorProviderSettings(
      merged as unknown as Record<string, unknown>,
      getCursorProviderSettings(legacyProviderSettings),
    );

    if (
      settingsPath !== CLAUDIAN_SETTINGS_PATH
      || (
      hasLegacyTopLevelProviderFields(stored)
      || 'show1MModel' in stored
      || 'slashCommands' in stored
      || 'hiddenSlashCommands' in stored
      || 'activeConversationId' in stored
      || 'allowExternalAccess' in stored
      || 'allowedExportPaths' in stored
      || 'enableBlocklist' in stored
      || 'blockedCommands' in stored
      || JSON.stringify(envSnippets) !== JSON.stringify(stored.envSnippets ?? [])
      )
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
    await this.deleteLegacyFileIfPresent();
  }

  async exists(): Promise<boolean> {
    if (await this.adapter.exists(CLAUDIAN_SETTINGS_PATH)) {
      return true;
    }

    return this.adapter.exists(LEGACY_CLAUDIAN_SETTINGS_PATH);
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
    const current = await this.load();
    updateClaudeProviderSettings(
      current as unknown as Record<string, unknown>,
      { environmentHash: hash },
    );
    await this.save(current);
  }

  private getDefaults(): StoredClaudianSettings {
    return DEFAULT_CLAUDIAN_SETTINGS;
  }

  private async getLoadPath(): Promise<string | null> {
    if (await this.adapter.exists(CLAUDIAN_SETTINGS_PATH)) {
      return CLAUDIAN_SETTINGS_PATH;
    }

    if (await this.adapter.exists(LEGACY_CLAUDIAN_SETTINGS_PATH)) {
      return LEGACY_CLAUDIAN_SETTINGS_PATH;
    }

    return null;
  }

  private async deleteLegacyFileIfPresent(): Promise<void> {
    if (await this.adapter.exists(LEGACY_CLAUDIAN_SETTINGS_PATH)) {
      await this.adapter.delete(LEGACY_CLAUDIAN_SETTINGS_PATH);
    }
  }
}
