import { Notice } from 'obsidian';

import type { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import type { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';
import type { ProviderId } from '@/core/providers/types';
import type { ClaudianSettings, Conversation } from '@/core/types';

import type { SettingsCoordinator } from './SettingsCoordinator';

export interface ProviderChatOptionsReconcilerDeps {
  readonly settings: Pick<SettingsCoordinator<ClaudianSettings>, 'mutateConditionally'>;
  readonly providers: Pick<typeof ProviderRegistry, 'getProviderDisplayName'>;
  readonly providerSettings: Pick<typeof ProviderSettingsCoordinator, 'reconcileTitleGenerationModelSelection'>;
  reconcileConversationModels(providerId: ProviderId): Promise<Conversation[]>;
  /** Title-model settings were reconciled; settings surfaces refresh their model options. */
  onSettingsReconciled(): void;
  onConversationsChanged(): void;
  /** Settings and conversations agree with the provider's options; chat refreshes its selectors. */
  onReconciled(providerId: ProviderId): void;
}

/**
 * Reconciles title-model settings and conversation model selections after a
 * provider's chat options change. Changes are serialized so a later provider
 * catalog never publishes before an earlier one has been reconciled.
 */
export class ProviderChatOptionsReconciler {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly deps: ProviderChatOptionsReconcilerDeps) {}

  notifyChanged(providerId: ProviderId): Promise<void> {
    const reconcile = (): Promise<void> => this.#reconcile(providerId);
    this.tail = this.tail.then(reconcile, reconcile);
    return this.tail;
  }

  async #reconcile(providerId: ProviderId): Promise<void> {
    const { deps } = this;
    let didReconcile = false;
    try {
      await deps.settings.mutateConditionally(
        settings => deps.providerSettings.reconcileTitleGenerationModelSelection(settings),
      );
      deps.onSettingsReconciled();
      const changedConversations = await deps.reconcileConversationModels(providerId);
      didReconcile = true;
      if (changedConversations.length > 0) {
        deps.onConversationsChanged();
      }
    } catch (error) {
      const providerName = deps.providers.getProviderDisplayName(providerId);
      new Notice(
        error instanceof Error
          ? `Failed to reconcile ${providerName} models: ${error.message}`
          : `Failed to reconcile ${providerName} models.`,
      );
    }
    if (didReconcile) {
      deps.onReconciled(providerId);
    }
  }
}
