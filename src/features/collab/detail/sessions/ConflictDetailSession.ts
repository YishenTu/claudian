import type {
  CollabConflictDetailViewState,
  CollabDetailConflictPanel,
  CollabDetailConflictPanelFactory,
  CollabDetailViewPort,
} from '@/features/collab/detail/CollabDetailContracts';

export interface ConflictDetailSessionOptions {
  readonly factory: CollabDetailConflictPanelFactory;
  readonly port: CollabDetailViewPort;
  readonly rootEl: HTMLElement;
}

export class ConflictDetailSession {
  private destroyed = false;
  private panel: CollabDetailConflictPanel | null = null;
  private state: CollabConflictDetailViewState | null = null;

  constructor(private readonly options: ConflictDetailSessionOptions) {}

  matches(state: CollabConflictDetailViewState): boolean {
    return this.state?.projectId === state.projectId
      && this.state.operationId === state.operationId
      && this.state.location === state.location
      && this.state.requestId === state.requestId;
  }

  async open(state: CollabConflictDetailViewState): Promise<void> {
    if (this.destroyed) return;
    this.state = state;
    this.options.rootEl.replaceChildren();
    this.panel?.destroy();
    const panel = this.options.factory(this.options.rootEl, this.options.port, {
      location: state.location,
    });
    this.panel = panel;
    await panel.open(state.operationId);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.panel?.destroy();
    this.panel = null;
    this.options.rootEl.replaceChildren();
  }
}
