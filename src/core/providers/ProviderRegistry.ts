import type { Plugin } from 'obsidian';

import type ClaudianPlugin from '../../main';
import { PROVIDER_REGISTRATIONS } from '../../providers';
import type { ChatRuntime } from '../runtime';
import type { ClaudianSettings } from '../types';
import {
  type AppAgentManager,
  type AppPluginManager,
  type AppStorageService,
  type CreateChatRuntimeOptions,
  DEFAULT_CHAT_PROVIDER_ID,
  type InlineEditService,
  type InstructionRefineService,
  type ProviderCapabilities,
  type ProviderChatUIConfig,
  type ProviderCliResolver,
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

  static createCliResolver(providerId: ProviderId = DEFAULT_CHAT_PROVIDER_ID): ProviderCliResolver {
    return getProviderRegistration(providerId).createCliResolver();
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

  static getDefaultSettings(providerId: ProviderId = DEFAULT_CHAT_PROVIDER_ID): ClaudianSettings {
    return getProviderRegistration(providerId).defaultSettings;
  }

  static createStorageService(plugin: Plugin, providerId: ProviderId = DEFAULT_CHAT_PROVIDER_ID): AppStorageService {
    return getProviderRegistration(providerId).createStorageService(plugin);
  }

  static createPluginManager(vaultPath: string, storage: AppStorageService, providerId: ProviderId = DEFAULT_CHAT_PROVIDER_ID): AppPluginManager {
    return getProviderRegistration(providerId).createPluginManager(vaultPath, storage);
  }

  static createAgentManager(vaultPath: string, pluginManager: AppPluginManager, providerId: ProviderId = DEFAULT_CHAT_PROVIDER_ID): AppAgentManager {
    return getProviderRegistration(providerId).createAgentManager(vaultPath, pluginManager);
  }

  static getRegisteredProviderIds(): ProviderId[] {
    return Object.keys(PROVIDER_REGISTRATIONS) as ProviderId[];
  }
}
