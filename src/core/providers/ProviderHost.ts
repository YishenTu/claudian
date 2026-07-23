import type { App } from 'obsidian';

import type { SharedAppStorage } from '../bootstrap/storage';
import type { ChatRuntime } from '../runtime/ChatRuntime';
import type { ClaudianSettings } from '../types';
import type { EnvironmentScope } from '../types/settings';
import type { ProviderCliResolutionContext, ProviderId } from './types';

/**
 * Application capabilities available to provider adapters.
 *
 * The host deliberately excludes plugin lifecycle, command registration, and
 * conversation ownership. Providers receive only the settings, environment,
 * path, CLI, storage, and interaction capabilities they currently consume.
 */
export interface ProviderHost {
  readonly app: App;
  readonly settings: ClaudianSettings;
  readonly storage: SharedAppStorage;
  readonly manifest?: { version?: string };

  saveSettings(): Promise<void>;
  mutateSettings(
    mutation: (settings: ClaudianSettings) => void | Promise<void>,
  ): Promise<void>;
  mutateSettingsConditionally(
    mutation: (settings: ClaudianSettings) => boolean | Promise<boolean>,
  ): Promise<void>;
  loadData(): Promise<unknown>;
  saveData(data: unknown): Promise<void>;
  normalizeModelVariantSettings(): boolean;

  getActiveEnvironmentVariables(providerId: ProviderId): string;
  getEnvironmentVariablesForScope(scope: EnvironmentScope): string;
  applyEnvironmentVariables(scope: EnvironmentScope, envText: string): Promise<void>;
  applyEnvironmentVariablesBatch(
    updates: Array<{ scope: EnvironmentScope; envText: string }>,
  ): Promise<void>;
  getResolvedProviderCliPath(
    providerId: ProviderId,
    context?: ProviderCliResolutionContext,
  ): Promise<string | null>;

  notifyProviderChatOptionsChanged(providerId: ProviderId): void;
  broadcastToActiveViewRuntimes?(
    action: (runtime: ChatRuntime) => Promise<void> | void,
  ): Promise<void>;
  broadcastToAllViewRuntimes?(
    action: (runtime: ChatRuntime) => Promise<void> | void,
  ): Promise<void>;
  recycleProviderRuntimes?(providerId: ProviderId): Promise<void>;
  mutateProviderSettingsAndRecycleRuntimes?(
    providerId: ProviderId,
    mutation: (settings: ClaudianSettings) => void | Promise<void>,
  ): Promise<void>;
}
