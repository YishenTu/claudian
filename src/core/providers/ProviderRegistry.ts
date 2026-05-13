import type ClaudianPlugin from '../../main';
import type { ChatRuntime } from '../runtime/ChatRuntime';
import {
  type CreateChatRuntimeOptions,
  DEFAULT_CHAT_PROVIDER_ID,
  type InlineEditService,
  type InstructionRefineService,
  type ProviderCapabilities,
  type ProviderChatUIConfig,
  type ProviderConversationHistoryService,
  type ProviderId,
  type ProviderRegistration,
  type ProviderSettingsReconciler,
  type ProviderSubagentLifecycleAdapter,
  type ProviderTaskResultInterpreter,
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

  static createChatRuntime(options: CreateChatRuntimeOptions): ChatRuntime {
    const providerId = options.providerId ?? DEFAULT_CHAT_PROVIDER_ID;
    return this.getProviderRegistration(providerId).createRuntime(options);
  }

  static createTitleGenerationService(plugin: ClaudianPlugin, providerId: ProviderId = DEFAULT_CHAT_PROVIDER_ID): TitleGenerationService {
    return this.getProviderRegistration(providerId).createTitleGenerationService(plugin);
  }

  static createInstructionRefineService(plugin: ClaudianPlugin, providerId: ProviderId = DEFAULT_CHAT_PROVIDER_ID): InstructionRefineService {
    return this.getProviderRegistration(providerId).createInstructionRefineService(plugin);
  }

  static createInlineEditService(plugin: ClaudianPlugin, providerId: ProviderId = DEFAULT_CHAT_PROVIDER_ID): InlineEditService {
    return this.getProviderRegistration(providerId).createInlineEditService(plugin);
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

  static getSubagentLifecycleAdapter(
    providerId: ProviderId = DEFAULT_CHAT_PROVIDER_ID,
  ): ProviderSubagentLifecycleAdapter | null {
    return this.getProviderRegistration(providerId).subagentLifecycleAdapter ?? null;
  }

  static getCapabilities(providerId: ProviderId = DEFAULT_CHAT_PROVIDER_ID): ProviderCapabilities {
    return this.getProviderRegistration(providerId).capabilities;
  }

  static getEnvironmentKeyPatterns(providerId: ProviderId): RegExp[] {
    return this.getProviderRegistration(providerId).environmentKeyPatterns ?? [];
  }

  static getChatUIConfig(providerId: ProviderId = DEFAULT_CHAT_PROVIDER_ID): ProviderChatUIConfig {
    return this.getProviderRegistration(providerId).chatUIConfig;
  }

  static getSettingsReconciler(providerId: ProviderId = DEFAULT_CHAT_PROVIDER_ID): ProviderSettingsReconciler {
    return this.getProviderRegistration(providerId).settingsReconciler;
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

  static getProviderDisplayName(providerId: ProviderId): string {
    return this.getProviderRegistration(providerId).displayName;
  }

  static isEnabled(providerId: ProviderId, settings: Record<string, unknown>): boolean {
    return this.getProviderRegistration(providerId).isEnabled(settings);
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
      fallbackProviderId?: ProviderId;
    } = {},
  ): ProviderId {
    const providerIds = options.onlyEnabledProviders
      ? this.getEnabledProviderIds(settings)
      : this.getRegisteredProviderIds();
    const fallbackProviderId = (
      options.fallbackProviderId
      && (!options.onlyEnabledProviders || this.isEnabled(options.fallbackProviderId, settings))
    )
      ? options.fallbackProviderId
      : (options.onlyEnabledProviders
        ? this.resolveSettingsProviderId(settings)
        : DEFAULT_CHAT_PROVIDER_ID);

    for (const providerId of providerIds) {
      if (providerId === fallbackProviderId) {
        continue;
      }

      if (this.getChatUIConfig(providerId).ownsModel(model, settings)) {
        return providerId;
      }
    }

    return fallbackProviderId;
  }

  static getCustomModelIds(envVars: Record<string, string>): Set<string> {
    const ids = new Set<string>();
    for (const providerId of this.getRegisteredProviderIds()) {
      for (const modelId of this.getChatUIConfig(providerId).getCustomModelIds(envVars)) {
        ids.add(modelId);
      }
    }
    return ids;
  }
}
