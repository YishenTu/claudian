import type { ProviderId } from '../../../core/providers/types';

export interface TabModelSelectionDraft {
  providerId: ProviderId;
  model: string | null;
}

export interface TabModelSelectionRequest {
  readonly revision: number;
}

export type TabModelSelectionResult =
  | {
    status: 'succeeded';
    isCurrent(): boolean;
  }
  | { status: 'superseded' };

export interface TabModelSelectionEffects {
  readDraft(): TabModelSelectionDraft;
  applyModel(model: string): void;
  applyProviderTarget(target: TabModelSelectionDraft): void;
  restoreDraft(draft: TabModelSelectionDraft): void;
  initializeProvider(providerId: ProviderId): Promise<void>;
}

interface PendingProviderTransition {
  promise: Promise<void>;
  providerId: ProviderId;
  stableDraft: TabModelSelectionDraft;
}

export class TabModelSelectionCoordinator {
  private latestRevision = 0;
  private pendingTransition: PendingProviderTransition | null = null;

  constructor(private readonly effects: TabModelSelectionEffects) {}

  beginRequest(): TabModelSelectionRequest {
    this.latestRevision += 1;
    return { revision: this.latestRevision };
  }

  isCurrent(request: TabModelSelectionRequest): boolean {
    return request.revision === this.latestRevision;
  }

  async selectBlank(
    request: TabModelSelectionRequest,
    target: TabModelSelectionDraft & { model: string },
  ): Promise<TabModelSelectionResult> {
    const pendingTransition = this.pendingTransition;
    if (pendingTransition) {
      if (pendingTransition.providerId === target.providerId) {
        this.effects.applyModel(target.model);
      }
      try {
        await pendingTransition.promise;
      } catch (error) {
        if (this.isCurrent(request)) {
          this.effects.restoreDraft(pendingTransition.stableDraft);
        }
        if (pendingTransition.providerId === target.providerId) {
          if (this.isCurrent(request)) {
            throw error;
          }
          return { status: 'superseded' };
        }
      }
      if (!this.isCurrent(request)) {
        return { status: 'superseded' };
      }
    }

    const previousDraft = this.effects.readDraft();
    if (target.providerId === previousDraft.providerId) {
      this.effects.applyModel(target.model);
      return this.succeeded(request);
    }

    this.effects.applyProviderTarget(target);
    const transition: PendingProviderTransition = {
      promise: this.effects.initializeProvider(target.providerId),
      providerId: target.providerId,
      stableDraft: previousDraft,
    };
    this.pendingTransition = transition;
    try {
      await transition.promise;
    } catch (error) {
      if (!this.isCurrent(request)) {
        return { status: 'superseded' };
      }
      this.effects.restoreDraft(previousDraft);
      throw error;
    } finally {
      if (this.pendingTransition === transition) {
        this.pendingTransition = null;
      }
    }

    return this.succeeded(request);
  }

  private succeeded(request: TabModelSelectionRequest): TabModelSelectionResult {
    return {
      status: 'succeeded',
      isCurrent: () => this.isCurrent(request),
    };
  }
}
