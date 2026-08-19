import type { CollabSidebarSurfaceController } from '@/features/FeatureHost';

export interface DeferredCollabSurfaceControllerOptions {
  readonly create: () => Promise<CollabSidebarSurfaceController>;
  readonly errorText: string;
  readonly loadingText: string;
}

export class DeferredCollabSurfaceController implements CollabSidebarSurfaceController {
  private active = false;
  private controller: CollabSidebarSurfaceController | null = null;
  private destroyed = false;
  private loadPromise: Promise<void> | null = null;
  private preloadRequested = false;
  private statusEl: HTMLDivElement | null = null;

  constructor(
    private readonly hostEl: HTMLElement,
    private readonly options: DeferredCollabSurfaceControllerOptions,
  ) {}

  setActive(active: boolean): void {
    if (this.destroyed) return;
    this.active = active;
    if (this.controller) {
      this.controller.setActive(active);
      return;
    }
    if (active && !this.loadPromise) this.startLoading();
  }

  preload(): void {
    if (this.destroyed) return;
    this.preloadRequested = true;
    if (this.controller) {
      this.controller.preload?.();
      return;
    }
    if (!this.loadPromise) this.startLoading();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.active = false;
    this.statusEl?.remove();
    this.statusEl = null;
    this.controller?.destroy();
    this.controller = null;
  }

  private startLoading(): void {
    this.statusEl = this.hostEl.createDiv({
      cls: 'claudian-collab-panel-status',
      text: this.options.loadingText,
    });
    const pending = this.load();
    this.loadPromise = pending;
    void pending.finally(() => {
      if (this.loadPromise === pending) this.loadPromise = null;
    });
  }

  private async load(): Promise<void> {
    try {
      const controller = await this.options.create();
      if (this.destroyed) {
        controller.destroy();
        return;
      }
      this.statusEl?.remove();
      this.statusEl = null;
      this.controller = controller;
      if (this.preloadRequested) controller.preload?.();
      controller.setActive(this.active);
    } catch {
      if (this.destroyed) return;
      if (this.statusEl) {
        this.statusEl.textContent = this.options.errorText;
        this.statusEl.classList.add('claudian-collab-panel-status--warning');
      }
    }
  }
}
