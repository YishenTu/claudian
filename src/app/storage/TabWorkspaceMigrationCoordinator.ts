import { TAB_WORKSPACE_VIEW_STATE_KEY } from '../../core/bootstrap/tabManagerState';
import type { AppTabManagerState } from '../../core/providers/types';
import { VIEW_TYPE_CLAUDIAN } from '../../core/types';

export interface TabWorkspaceStateDeliveryRegistration {
  readonly declarationsReady: boolean;
  readonly waitUntilDeclarationsReady: Promise<void>;
}

interface LegacyTabWorkspaceStorage {
  getTabManagerState(): Promise<AppTabManagerState | null>;
  clearTabManagerState(): Promise<void>;
}

interface TabWorkspaceLeaf {
  readonly view: unknown;
  getViewState?(): { state?: unknown };
}

interface TabWorkspaceHost {
  readonly layoutReady: boolean;
  getLeavesOfType(type: string): readonly TabWorkspaceLeaf[];
  onLayoutReady(callback: () => unknown): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Coordinates the one-time global-to-view tab-state migration across every
 * Claudian leaf participating in Obsidian's startup layout restoration.
 */
export class TabWorkspaceMigrationCoordinator {
  private readonly deliveredRuntimeViews = new WeakSet<object>();
  private readonly declarationsReadyPromise: Promise<void>;
  private resolveDeclarationsReady!: () => void;
  private declarationsReady = false;
  private hasViewScopedState = false;
  private legacyStateClaimed = false;
  private migrationCompletion: Promise<void> | null = null;

  constructor(
    private readonly storage: LegacyTabWorkspaceStorage,
    private readonly workspace: TabWorkspaceHost,
    private readonly isRuntimeView: (view: unknown) => boolean,
  ) {
    this.declarationsReadyPromise = new Promise(resolve => {
      this.resolveDeclarationsReady = resolve;
    });

    if (workspace.layoutReady) {
      this.refreshDeclarations();
    } else {
      workspace.onLayoutReady(() => this.refreshDeclarations());
    }
  }

  registerStateDelivery(
    view: object,
    hasViewScopedState: boolean,
  ): TabWorkspaceStateDeliveryRegistration {
    this.deliveredRuntimeViews.add(view);
    this.hasViewScopedState ||= hasViewScopedState;
    this.retireLegacyStateWhenSuperseded();
    this.refreshDeclarations();

    return {
      declarationsReady: this.declarationsReady,
      waitUntilDeclarationsReady: this.declarationsReadyPromise,
    };
  }

  async claimLegacyState(): Promise<AppTabManagerState | null> {
    await this.declarationsReadyPromise;
    if (this.hasViewScopedState) return null;
    if (this.legacyStateClaimed) return null;

    this.legacyStateClaimed = true;
    return this.storage.getTabManagerState();
  }

  async completeMigration(): Promise<void> {
    this.migrationCompletion ??= this.storage.clearTabManagerState();
    await this.migrationCompletion;
  }

  private refreshDeclarations(): void {
    if (this.declarationsReady || !this.workspace.layoutReady) return;

    const allRuntimeViewsDelivered = this.workspace
      .getLeavesOfType(VIEW_TYPE_CLAUDIAN)
      .every((leaf) => {
        if (this.isRuntimeView(leaf.view)) {
          return isRecord(leaf.view) && this.deliveredRuntimeViews.has(leaf.view);
        }

        const state = leaf.getViewState?.().state;
        if (isRecord(state) && TAB_WORKSPACE_VIEW_STATE_KEY in state) {
          this.hasViewScopedState = true;
        }
        return true;
      });
    if (!allRuntimeViewsDelivered) return;

    this.retireLegacyStateWhenSuperseded();
    this.declarationsReady = true;
    this.resolveDeclarationsReady();
  }

  private retireLegacyStateWhenSuperseded(): void {
    if (!this.hasViewScopedState) return;
    void this.completeMigration().catch(() => undefined);
  }
}
