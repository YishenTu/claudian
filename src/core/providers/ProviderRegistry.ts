import type ClaudianPlugin from '../../main';
import { PROVIDER_REGISTRATIONS } from '../../providers';
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
  type ProviderTaskResultInterpreter,
  type TitleGenerationService,
} from './types';

function getProviderRegistration(providerId: ProviderId): ProviderRegistration {
  const registration = PROVIDER_REGISTRATIONS[providerId];
  if (!registration) {
    throw new Error(`Provider "${providerId}" is not registered.`);
  }
  return registration;
}

/**
 * Registry for chat-facing provider services.
 *
 * Bootstrap concerns (default settings, shared storage, CLI resolution,
 * plugin/agent management) are handled explicitly in `main.ts` through
 * `src/core/bootstrap/` and `src/providers/claude/app/`.
 */
export class ProviderRegistry {
  static createChatRuntime(options: CreateChatRuntimeOptions): ChatRuntime {
    const providerId = options.providerId ?? DEFAULT_CHAT_PROVIDER_ID;
    return getProviderRegistration(providerId).createRuntime(options);
  }

  static createTitleGenerationService(plugin: ClaudianPlugin, providerId: ProviderId = DEFAULT_CHAT_PROVIDER_ID): TitleGenerationService {
    return getProviderRegistration(providerId).createTitleGenerationService(plugin);
  }

  static createInstructionRefineService(plugin: ClaudianPlugin, providerId: ProviderId = DEFAULT_CHAT_PROVIDER_ID): InstructionRefineService {
    return getProviderRegistration(providerId).createInstructionRefineService(plugin);
  }

  static createInlineEditService(plugin: ClaudianPlugin, providerId: ProviderId = DEFAULT_CHAT_PROVIDER_ID): InlineEditService {
    return getProviderRegistration(providerId).createInlineEditService(plugin);
  }

  static getConversationHistoryService(
    providerId: ProviderId = DEFAULT_CHAT_PROVIDER_ID,
  ): ProviderConversationHistoryService {
    return getProviderRegistration(providerId).historyService;
  }

  static getTaskResultInterpreter(
    providerId: ProviderId = DEFAULT_CHAT_PROVIDER_ID,
  ): ProviderTaskResultInterpreter {
    return getProviderRegistration(providerId).taskResultInterpreter;
  }

  static getCapabilities(providerId: ProviderId = DEFAULT_CHAT_PROVIDER_ID): ProviderCapabilities {
    return getProviderRegistration(providerId).capabilities;
  }

  static getChatUIConfig(providerId: ProviderId = DEFAULT_CHAT_PROVIDER_ID): ProviderChatUIConfig {
    return getProviderRegistration(providerId).chatUIConfig;
  }

  static getSettingsReconciler(providerId: ProviderId = DEFAULT_CHAT_PROVIDER_ID): ProviderSettingsReconciler {
    return getProviderRegistration(providerId).settingsReconciler;
  }

  static getRegisteredProviderIds(): ProviderId[] {
    return Object.keys(PROVIDER_REGISTRATIONS) as ProviderId[];
  }

  static getEnabledProviderIds(settings: Record<string, unknown>): ProviderId[] {
    return this.getRegisteredProviderIds()
      .filter(providerId => getProviderRegistration(providerId).isEnabled(settings))
      .sort((a, b) => (
        getProviderRegistration(a).blankTabOrder - getProviderRegistration(b).blankTabOrder
      ));
  }

  static getProviderDisplayName(providerId: ProviderId): string {
    return getProviderRegistration(providerId).displayName;
  }
}
