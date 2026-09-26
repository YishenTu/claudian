import type { App } from 'obsidian';

import type { SharedAppStorage } from '../core/bootstrap/storage';
import type { ProviderHost } from '../core/providers/ProviderHost';
import type { ProviderId } from '../core/providers/types';
import type {
  ClaudianSettings,
  StoredChatModelSelection,
} from '../core/types';

/** Application capabilities consumed by user-facing features. */
export interface FeatureHost {
  readonly app: App;
  readonly providerHost: ProviderHost;
  readonly settings: ClaudianSettings;
  readonly storage: SharedAppStorage;

  getMainAgentDynamicSystemPromptSections?(): Promise<readonly string[]>;

  getCommittedSettings(): Readonly<ClaudianSettings>;

  mutateSettings(
    mutation: (settings: ClaudianSettings) => void | Promise<void>,
  ): Promise<void>;
  getActiveEnvironmentVariables(providerId?: ProviderId): string;
  getAgentSkillResourceGeneration(): number;
  notifyAgentSkillsChanged(): Promise<void>;
  notifyProviderChatOptionsChanged(providerId: ProviderId): void;

  /** Selected execution context, without exposing a chat view or runtime. */
  getActiveModelSelection(): StoredChatModelSelection | null;
}
