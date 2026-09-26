import { getVaultPath } from '../../utils/path';
import type { AuxiliaryExecutionContext } from '../auxiliary/AuxiliaryExecutionContext';
import { InlineEditService as SharedInlineEditService } from '../auxiliary/InlineEditService';
import { RoutedTitleGenerationService } from '../auxiliary/RoutedTitleGenerationService';
import { TitleGenerationService as SharedTitleGenerationService } from '../auxiliary/TitleGenerationService';
import type {
  ProviderExecutionBackend,
  ProviderInteractionPort,
} from '../execution';
import { resolveTitleGenerationLocale } from '../prompt/titleGeneration';
import { findAvailableModelOption } from './models/modelOptions';
import { ProviderModelUnavailableError } from './models/ProviderModelUnavailableError';
import { decodeProviderModelSelectionId } from './modelSelection';
import type { ProviderHost } from './ProviderHost';
import { ProviderWorkspaceRegistry } from './ProviderWorkspaceRegistry';
import {
  DEFAULT_CHAT_PROVIDER_ID,
  type InlineEditService,
  type ProviderCapabilities,
  type ProviderChatUIConfig,
  type ProviderConversationHistoryService,
  type ProviderId,
  type ProviderModelPolicy,
  type ProviderRegistration,
  type ProviderSettingsReconciler,
  type ProviderSettingsStorageAdapter,
  type ProviderSubagentAdapter,
  type ProviderSubagentHistoryService,
  type ProviderTaskResultInterpreter,
  type ProviderUIOption,
  type TitleGenerationService,
} from './types';

/**
 * Registry for chat-facing provider services.
 *
 * Bootstrap concerns (default settings, shared storage, CLI resolution,
 * workspace command/agent services) are composed explicitly in `main.ts`
 * through `src/core/bootstrap/` and `src/providers/<id>/app/`.
 */
export class ProviderRegistry {
  private static registrations: Partial<Record<ProviderId, ProviderRegistration>> = {};

  static register(
    providerId: ProviderId,
    registration: ProviderRegistration,
  ): void {
    this.registrations[providerId] = registration;
  }

  private static getProviderRegistration(providerId: ProviderId): ProviderRegistration {
    const registration = this.registrations[providerId];
    if (!registration) {
      throw new Error(`Provider "${providerId}" is not registered.`);
    }
    return registration;
  }

  static createExecutionBackend(
    plugin: ProviderHost,
    providerId: ProviderId = DEFAULT_CHAT_PROVIDER_ID,
  ): ProviderExecutionBackend {
    return this.getProviderRegistration(providerId).createExecutionBackend(plugin);
  }

  static createSubagentHistoryService(
    plugin: ProviderHost,
    providerId: ProviderId = DEFAULT_CHAT_PROVIDER_ID,
  ): ProviderSubagentHistoryService | null {
    const factory = this.getProviderRegistration(providerId).createSubagentHistoryService;
    return factory?.(plugin) ?? null;
  }

  static createTitleGenerationService(plugin: ProviderHost, providerId?: ProviderId): TitleGenerationService {
    if (!providerId) {
      return new RoutedTitleGenerationService({
        resolveProviderId: () => this.resolveTitleGenerationSelection(plugin.settings)?.providerId ?? null,
        initializeProvider: provider => ProviderWorkspaceRegistry.ensureInitialized(
          plugin, provider, 'title-generation',
        ),
        createService: provider => this.createTitleGenerationService(plugin, provider),
      });
    }
    const registration = this.getProviderRegistration(providerId);
    return new SharedTitleGenerationService({
      ...this.createAuxiliaryExecutionContext(plugin, providerId),
      resolveLocale: () => resolveTitleGenerationLocale(plugin.settings),
      resolveModel: () => {
        const selection = this.resolveTitleGenerationSelection(plugin.settings);
        if (!selection || selection.providerId !== providerId) {
          throw new ProviderModelUnavailableError(registration.displayName);
        }
        return selection.model;
      },
    });
  }

  static resolveTitleGenerationSelection(settings: Record<string, unknown>): { providerId: ProviderId; model: string } | null {
    const titleModel = typeof settings.titleGenerationModel === 'string'
      ? settings.titleGenerationModel.trim()
      : '';
    if (!titleModel) return null;

    const candidates = this.getRegisteredProviderIds().flatMap(providerId => {
      if (!this.isEnabled(providerId, settings)) return [];
      const model = findAvailableModelOption(providerId, this.getModelPolicy(providerId), titleModel, settings);
      return model ? [{ providerId, model }] : [];
    });
    return candidates.length === 1 ? candidates[0] : null;
  }

  static createInlineEditService(plugin: ProviderHost, providerId: ProviderId = DEFAULT_CHAT_PROVIDER_ID): InlineEditService {
    return new SharedInlineEditService(
      this.createAuxiliaryExecutionContext(plugin, providerId),
    );
  }

  private static createAuxiliaryExecutionContext(
    plugin: ProviderHost,
    providerId: ProviderId,
  ): AuxiliaryExecutionContext {
    return {
      nativePersistence: this.getCapabilities(providerId).supportsEphemeralSessions
        ? 'disabled-if-supported'
        : 'provider-default',
      backend: this.createExecutionBackend(plugin, providerId),
      interactionPort: PASSIVE_AUXILIARY_INTERACTION_PORT,
      lifecycleRegistry: plugin.executionLifecycleRegistry,
      vaultWorkingDirectory: getVaultPath(plugin.app) ?? '.',
    };
  }

  static getConversationHistoryService(
    providerId: ProviderId = DEFAULT_CHAT_PROVIDER_ID,
  ): ProviderConversationHistoryService {
    return this.getProviderRegistration(providerId).historyService;
  }

  static getTaskResultInterpreter(
    providerId: ProviderId = DEFAULT_CHAT_PROVIDER_ID,
  ): ProviderTaskResultInterpreter {
    return this.getProviderRegistration(providerId).taskResultInterpreter;
  }

  static getSubagentAdapter(
    providerId: ProviderId = DEFAULT_CHAT_PROVIDER_ID,
  ): ProviderSubagentAdapter | null {
    return this.getProviderRegistration(providerId).subagentAdapter ?? null;
  }

  static getCapabilities(providerId: ProviderId = DEFAULT_CHAT_PROVIDER_ID): ProviderCapabilities {
    return this.getProviderRegistration(providerId).capabilities;
  }

  static getEnvironmentKeyPatterns(providerId: ProviderId): RegExp[] {
    return this.getProviderRegistration(providerId).environmentKeyPatterns ?? [];
  }

  static getModelPolicy(providerId: ProviderId = DEFAULT_CHAT_PROVIDER_ID): ProviderModelPolicy {
    return this.getProviderRegistration(providerId).modelPolicy;
  }

  static getChatUIConfig(providerId: ProviderId = DEFAULT_CHAT_PROVIDER_ID): ProviderChatUIConfig {
    return this.getProviderRegistration(providerId).chatUIConfig;
  }

  static getTitleGenerationModelOptions(
    settings: Record<string, unknown>,
  ): ProviderUIOption[] {
    const options: ProviderUIOption[] = [];
    const seenValues = new Set<string>();

    for (const providerId of this.getRegisteredProviderIds()) {
      if (!this.isEnabled(providerId, settings)) {
        continue;
      }

      for (const option of this.getModelPolicy(providerId).getModelOptions(settings)) {
        if (seenValues.has(option.value)) {
          continue;
        }
        seenValues.add(option.value);
        options.push({
          ...option,
          label: `${this.getProviderDisplayName(providerId)}: ${option.label}`,
        });
      }
    }

    return options;
  }

  static getSettingsReconciler(providerId: ProviderId = DEFAULT_CHAT_PROVIDER_ID): ProviderSettingsReconciler {
    return this.getProviderRegistration(providerId).settingsReconciler;
  }

  static getSettingsStorageAdapter(providerId: ProviderId): ProviderSettingsStorageAdapter {
    const registration = this.getProviderRegistration(providerId);
    if (!('settingsStorage' in registration)) {
      throw new Error(`Provider "${providerId}" does not own settings storage normalization.`);
    }
    return registration.settingsStorage as ProviderSettingsStorageAdapter;
  }

  static getRegisteredProviderIds(): ProviderId[] {
    return Object.keys(this.registrations);
  }

  static getEnabledProviderIds(settings: Record<string, unknown>): ProviderId[] {
    return this.getRegisteredProviderIds()
      .filter(providerId => this.getProviderRegistration(providerId).isEnabled(settings))
      .sort((a, b) => (
        this.getProviderRegistration(a).blankTabOrder - this.getProviderRegistration(b).blankTabOrder
      ));
  }

  /** Provider order as presented from top to bottom in the blank-tab model selector. */
  static getBlankTabProviderIds(settings: Record<string, unknown>): ProviderId[] {
    return this.getEnabledProviderIds(settings).reverse();
  }

  static getProviderDisplayName(providerId: ProviderId): string {
    return this.getProviderRegistration(providerId).displayName;
  }

  static isEnabled(providerId: ProviderId, settings: Record<string, unknown>): boolean {
    return this.getProviderRegistration(providerId).isEnabled(settings);
  }

  static setEnabled(
    providerId: ProviderId,
    settings: Record<string, unknown>,
    enabled: boolean,
  ): void {
    const registration = this.getProviderRegistration(providerId);
    if (registration.setEnabled) {
      registration.setEnabled(settings, enabled);
      return;
    }

    if (registration.isEnabled(settings) !== enabled) {
      throw new Error(`Provider "${providerId}" enablement is not configurable.`);
    }
  }

  static resolveSettingsProviderId(settings: Record<string, unknown>): ProviderId {
    const current = settings.settingsProvider;
    if (typeof current === 'string') {
      const currentProvider = current;
      if (
        this.getRegisteredProviderIds().includes(currentProvider)
        && this.isEnabled(currentProvider, settings)
      ) {
        return currentProvider;
      }
    }

    if (this.isEnabled(DEFAULT_CHAT_PROVIDER_ID, settings)) {
      return DEFAULT_CHAT_PROVIDER_ID;
    }

    return this.getEnabledProviderIds(settings)[0] ?? DEFAULT_CHAT_PROVIDER_ID;
  }

  static resolveProviderForModel(
    model: string,
    settings: Record<string, unknown> = {},
    options: {
      onlyEnabledProviders?: boolean;
    } = {},
  ): ProviderId | null {
    const providerIds = options.onlyEnabledProviders
      ? this.getEnabledProviderIds(settings)
      : this.getRegisteredProviderIds();
    const decodedSelection = decodeProviderModelSelectionId(model);

    if (
      decodedSelection
      && providerIds.includes(decodedSelection.providerId)
      && (!options.onlyEnabledProviders || this.isEnabled(decodedSelection.providerId, settings))
    ) {
      return decodedSelection.providerId;
    }

    if (decodedSelection) return null;
    const owners = providerIds.filter(providerId => this.getModelPolicy(providerId).ownsModel(model, settings));
    return owners.length === 1 ? owners[0] : null;
  }

  static getCustomModelIds(envVars: Record<string, string>): Set<string> {
    const ids = new Set<string>();
    for (const providerId of this.getRegisteredProviderIds()) {
      for (const modelId of this.getModelPolicy(providerId).getCustomModelIds(envVars)) {
        ids.add(modelId);
      }
    }
    return ids;
  }
}

const PASSIVE_AUXILIARY_INTERACTION_PORT: ProviderInteractionPort = {
  requestApproval: async request => ({
    decision: 'cancel',
    interactionId: request.interactionId,
  }),
  askUserQuestion: async request => ({
    answers: null,
    interactionId: request.interactionId,
  }),
  dismissInteraction: () => undefined,
};
