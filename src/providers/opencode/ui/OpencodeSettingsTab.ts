import * as fs from 'fs';
import { Setting } from 'obsidian';

import { ProviderSettingsCoordinator } from '../../../core/providers/ProviderSettingsCoordinator';
import type {
  ProviderSettingsTabRenderer,
  ProviderSettingsTabRendererContext,
} from '../../../core/providers/types';
import { t } from '../../../i18n/i18n';
import { renderEnvironmentSettingsSection } from '../../../shared/settings/EnvironmentSettingsSection';
import {
  type ProviderModelPickerModel,
  type ProviderModelPickerState,
  renderProviderModelPicker,
} from '../../../shared/settings/ProviderModelPicker';
import { getHostnameKey } from '../../../utils/env';
import { expandHomePath } from '../../../utils/path';
import { maybeGetOpencodeWorkspaceServices } from '../app/OpencodeWorkspaceServices';
import { clearOpencodeDiscoveryState } from '../discoveryState';
import { sameStringList } from '../internal/compareCollections';
import {
  buildOpencodeBaseModels,
  encodeOpencodeModelId,
  type OpencodeDiscoveredModel,
  splitOpencodeModelLabel,
} from '../models';
import { OpencodeChatRuntime } from '../runtime/OpencodeChatRuntime';
import {
  getOpencodeProviderSettings,
  normalizeOpencodeVisibleModels,
  OPENCODE_DEFAULT_ENVIRONMENT_VARIABLES,
  updateOpencodeProviderSettings,
} from '../settings';
import { OpencodeAgentSettings } from './OpencodeAgentSettings';

const OPENCODE_METADATA_WARMUP_DB = ':memory:';

export const opencodeSettingsTabRenderer: ProviderSettingsTabRenderer = {
  render(container, context) {
    const opencodeWorkspace = maybeGetOpencodeWorkspaceServices();
    const settingsBag = context.plugin.settings as unknown as Record<string, unknown>;
    const opencodeSettings = getOpencodeProviderSettings(settingsBag);
    const hostnameKey = getHostnameKey();

    new Setting(container).setName('Setup').setHeading();

    new Setting(container)
      .setName(t('settings.providerEnablement.name', { provider: 'OpenCode' }))
      .setDesc(t('settings.providerEnablement.desc', { provider: 'OpenCode' }))
      .addToggle((toggle) =>
        toggle
          .setValue(opencodeSettings.enabled)
          .onChange(async (value) => {
            await context.plugin.mutateSettings((settings) => {
              ProviderSettingsCoordinator.applyProviderEnablement(settings, 'opencode', value);
            });
            context.refreshModelSelectors();
            context.refreshTitleGenerationModelOptions();
          })
      );

    const cliPathSetting = new Setting(container)
      .setName('CLI path')
      .setDesc('Optional absolute path to the OpenCode CLI for this computer. Leave empty to use `opencode` from PATH.');

    const validationEl = container.createDiv({
      cls: 'claudian-cli-path-validation claudian-setting-validation claudian-setting-validation-error claudian-hidden',
    });
    const cliPathsByHost = { ...opencodeSettings.cliPathsByHost };
    const currentValue = opencodeSettings.cliPathsByHost[hostnameKey] || '';
    let cliPathInputEl: HTMLInputElement | null = null;

    const updateCliPathValidation = (value: string, inputEl?: HTMLInputElement): boolean => {
      const error = validateCliPath(value);
      if (error) {
        validationEl.setText(error);
        validationEl.toggleClass('claudian-hidden', false);
        inputEl?.toggleClass('claudian-input-error', true);
        return false;
      }

      validationEl.toggleClass('claudian-hidden', true);
      inputEl?.toggleClass('claudian-input-error', false);
      return true;
    };

    const recycleOpencodeRuntime = async (): Promise<void> => {
      await context.plugin.recycleProviderRuntimes?.('opencode');
    };

    const persistCliPath = async (value: string): Promise<boolean> => {
      if (!updateCliPathValidation(value, cliPathInputEl ?? undefined)) {
        return false;
      }

      const trimmed = value.trim();
      if (trimmed) {
        cliPathsByHost[hostnameKey] = trimmed;
      } else {
        delete cliPathsByHost[hostnameKey];
      }

      await context.plugin.mutateSettings((settings) => {
        updateOpencodeProviderSettings(settings, { cliPathsByHost: { ...cliPathsByHost } });
        clearOpencodeDiscoveryState(settings);
      });
      opencodeWorkspace?.cliResolver?.reset();
      await recycleOpencodeRuntime();
      return true;
    };

    cliPathSetting.addText((text) => {
      text
        .setPlaceholder(process.platform === 'win32'
          ? 'C:\\Users\\you\\AppData\\Roaming\\npm\\opencode.cmd'
          : '/usr/local/bin/opencode')
        .setValue(currentValue)
        .onChange(async (value) => {
          await persistCliPath(value);
        });
      text.inputEl.addClass('claudian-settings-cli-path-input');
      cliPathInputEl = text.inputEl;
      updateCliPathValidation(currentValue, text.inputEl);
    });

    new Setting(container).setName('Models').setHeading();
    renderOpencodeModelPicker(container, context, settingsBag);

    new Setting(container).setName(t('settings.agentSkills.sectionTitle')).setHeading();
    context.renderAgentSkillSettings(container, 'opencode');

    new Setting(container).setName('Commands').setHeading();
    context.renderHiddenProviderCommandSetting(container, 'opencode', {
      name: 'Hidden Commands and Skills',
      desc: 'Hide specific OpenCode commands and skills from the dropdown. Enter names without the leading slash, one per line.',
      placeholder: 'compact\nreview\nfix',
    });

    if (opencodeWorkspace?.agentStorage) {
      new Setting(container).setName('Subagents').setHeading();

      const subagentsDesc = container.createDiv({ cls: 'claudian-sp-settings-desc' });
      subagentsDesc.createEl('p', {
        cls: 'setting-item-description',
        text: 'Manage vault-level OpenCode subagents from .opencode/agent/ and legacy .opencode/agents/. New entries are saved as subagent-only files and appear in the @mention menu.',
      });

      const subagentsContainer = container.createDiv({ cls: 'claudian-slash-commands-container' });
      new OpencodeAgentSettings(
        subagentsContainer,
        opencodeWorkspace.agentStorage,
        context.plugin.app,
        async () => {
          await opencodeWorkspace.refreshAgentMentions?.();
          await recycleOpencodeRuntime();
        },
      );
    }

    renderEnvironmentSettingsSection({
      container,
      plugin: context.plugin,
      scope: 'provider:opencode',
      heading: 'Environment',
      name: 'Environment Variables',
      desc: 'Extra environment variables passed to OpenCode. `OPENCODE_ENABLE_EXA=1` is enabled by default.',
      placeholder: `${OPENCODE_DEFAULT_ENVIRONMENT_VARIABLES}\nOPENCODE_DB=/path/to/opencode.db`,
      renderCustomContextLimits: (target) => context.renderCustomContextLimits(target, 'opencode'),
    });
  },
};

function renderOpencodeModelPicker(
  container: HTMLElement,
  context: ProviderSettingsTabRendererContext,
  settingsBag: Record<string, unknown>,
): void {
  const getState = (): ProviderModelPickerState => {
    const current = getOpencodeProviderSettings(settingsBag);
    return {
      aliases: current.modelAliases,
      discoveredCount: current.discoveredModels.length,
      models: buildOpencodePickerModels(current.discoveredModels, current.visibleModels),
      selectedIds: current.visibleModels,
    };
  };

  const warmModelMetadata = async (rawId: string): Promise<void> => {
    const runtime = new OpencodeChatRuntime(context.plugin);
    try {
      runtime.syncConversationState({
        providerState: { databasePath: OPENCODE_METADATA_WARMUP_DB },
        sessionId: null,
      });
      if (await runtime.warmModelMetadata(encodeOpencodeModelId(rawId))) {
        context.refreshModelSelectors();
      }
    } catch {
      // Metadata warmup is opportunistic; the first chat turn can still discover it.
    } finally {
      runtime.cleanup();
    }
  };

  renderProviderModelPicker({
    container,
    emptyCatalogText: 'Start OpenCode once to load its model catalog. Claudian will then let you pick visible models.',
    failedCatalogText: 'Could not load the OpenCode model catalog. Check the CLI path and login state, then try again.',
    getState,
    async loadCatalog() {
      const runtime = new OpencodeChatRuntime(context.plugin);
      try {
        runtime.syncConversationState({
          providerState: { databasePath: OPENCODE_METADATA_WARMUP_DB },
          sessionId: null,
        });
        const loaded = await runtime.ensureReady({ allowSessionCreation: true });
        const discoveredCount = getOpencodeProviderSettings(settingsBag).discoveredModels.length;
        if (!loaded) {
          return 'failed';
        }
        if (discoveredCount > 0) {
          context.refreshModelSelectors();
          return 'loaded';
        }
        return 'empty';
      } catch {
        return 'failed';
      } finally {
        runtime.cleanup();
      }
    },
    loadCatalogOnRender: true,
    loadingCatalogText: 'Loading OpenCode model catalog...',
    modifier: 'opencode',
    async onAliasesChange(modelAliases) {
      await context.plugin.mutateSettings((settings) => {
        updateOpencodeProviderSettings(settings, { modelAliases });
      });
      context.refreshModelSelectors();
    },
    onModelSelected: async (model) => warmModelMetadata(model.id),
    async onSelectedIdsChange(visibleModels) {
      const current = getOpencodeProviderSettings(settingsBag);
      const normalized = normalizeOpencodeVisibleModels(visibleModels, current.discoveredModels);
      if (sameStringList(current.visibleModels, normalized)) {
        return;
      }

      await context.plugin.mutateSettings((settings) => {
        updateOpencodeProviderSettings(settings, { visibleModels: normalized });
      });
      context.refreshModelSelectors();
    },
    providerName: 'OpenCode',
    settingDescription: 'Choose which OpenCode models are available in the chat selector. Filter by provider or type to search. OpenCode chat is unavailable when no models are selected.',
  });
}

function validateCliPath(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const expandedPath = expandHomePath(trimmed);
  if (!fs.existsSync(expandedPath)) {
    return 'Path does not exist';
  }
  if (!fs.statSync(expandedPath).isFile()) {
    return 'Path must point to a file';
  }
  return null;
}

function buildOpencodePickerModels(
  discoveredModels: OpencodeDiscoveredModel[],
  visibleModels: string[],
): ProviderModelPickerModel[] {
  const models: ProviderModelPickerModel[] = [];
  const discoveredIds = new Set<string>();

  for (const model of buildOpencodeBaseModels(discoveredModels)) {
    const { modelLabel, providerLabel } = splitOpencodeModelLabel(model.label || model.rawId);
    discoveredIds.add(model.rawId);
    models.push({
      description: model.description ?? '',
      id: model.rawId,
      isAvailable: true,
      name: modelLabel,
      providerKey: providerLabel.toLowerCase(),
      providerLabel,
    });
  }

  for (const rawId of visibleModels) {
    if (discoveredIds.has(rawId)) {
      continue;
    }

    const { modelLabel, providerLabel } = splitOpencodeModelLabel(rawId);
    models.push({
      id: rawId,
      isAvailable: false,
      name: modelLabel,
      providerKey: providerLabel.toLowerCase(),
      providerLabel,
      unavailableMessage: 'Not currently reported by OpenCode',
    });
  }

  return models.sort((left, right) => {
    const providerCmp = (left.providerLabel ?? '').localeCompare(right.providerLabel ?? '');
    if (providerCmp !== 0) {
      return providerCmp;
    }
    return left.name.localeCompare(right.name);
  });
}
