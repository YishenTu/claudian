import type { ProviderId } from '@/core/providers/types';
import type { ClaudianSettings } from '@/core/types';

import type { ChatViewHost } from '../ChatFeatureHost';

export interface ChatViewPublisherDeps {
  readonly views: { getAllViews(): readonly ChatViewHost[] };
  readonly zenMode: { reconcile(): void };
  readonly inactiveSessions: { request(): void };
  hasLoadedAllSessionMetadata(): boolean;
}

/** Fans committed application changes out to every mounted chat view. */
export class ChatViewPublisher {
  constructor(private readonly deps: ChatViewPublisherDeps) {}

  /**
   * Refreshes chat presentation after a settings commit. Every refresh is attempted; failures
   * are reported together and never roll the committed settings back.
   */
  publishSettings(settings: Readonly<ClaudianSettings>, previous: Readonly<ClaudianSettings>): void {
    const errors: unknown[] = [];
    const publish = (refresh: () => void): void => {
      try { refresh(); } catch (error) { errors.push(error); }
    };
    const timestampsChanged = settings.showMessageTimestamps !== previous.showMessageTimestamps;
    const layoutChanged = settings.enableDualPane !== previous.enableDualPane || settings.dualPaneSide !== previous.dualPaneSide;
    const commandsChanged = JSON.stringify(settings.hiddenCommands) !== JSON.stringify(previous.hiddenCommands);
    const contextChanged = JSON.stringify(settings.customContextLimits) !== JSON.stringify(previous.customContextLimits);
    if (timestampsChanged || layoutChanged || commandsChanged || contextChanged) {
      for (const view of this.deps.views.getAllViews()) {
        if (timestampsChanged) publish(() => view.refreshMessageTimestamps());
        if (layoutChanged) publish(() => view.refreshDualPaneLayout());
        if (commandsChanged) publish(() => view.updateHiddenCommands());
        if (contextChanged) publish(() => view.refreshModelSelector());
      }
    }
    if (settings.enableZenMode !== previous.enableZenMode) publish(() => this.deps.zenMode.reconcile());
    if (
      settings.sessionAutoArchiveAfter !== previous.sessionAutoArchiveAfter
      && this.deps.hasLoadedAllSessionMetadata()
    ) {
      this.deps.inactiveSessions.request();
    }
    if (errors.length > 0) throw new AggregateError(errors, 'Settings view publication failed.');
  }

  /** Projects a committed conversation-list change; a failing view never affects the others. */
  notifyConversationListChanged(): void {
    for (const view of this.deps.views.getAllViews()) {
      try {
        view.notifyConversationListChanged();
      } catch {
        // UI projection failures must not roll back a committed repository mutation.
      }
    }
  }

  refreshModelSelector(providerId: ProviderId): void {
    for (const view of this.deps.views.getAllViews()) {
      view.refreshModelSelector(providerId);
    }
  }

  invalidateProviderCommandCaches(providerIds: ProviderId[]): void {
    for (const view of this.deps.views.getAllViews()) {
      view.invalidateProviderCommandCaches(providerIds);
    }
  }
}
