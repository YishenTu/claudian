import type { CollabFeaturePort, CollabProjectUpdateInspection, CollabPublicationReview } from '@/core/collab';
import { t } from '@/i18n/i18n';

export interface ProjectUpdatePanelOptions {
  readonly projectId: string;
  readonly port: Pick<CollabFeaturePort, 'updateProject'>;
  readonly onReview: (review: CollabPublicationReview) => void;
  readonly onConflict: (operationId: string) => void;
  readonly refresh: () => void;
}

export class ProjectUpdatePanel {
  #active = true;
  #destroyed = false;
  #pending = false;
  #failed = false;
  #inspection: CollabProjectUpdateInspection | undefined;

  constructor(private readonly root: HTMLElement, private readonly options: ProjectUpdatePanelOptions) {
    root.classList.add('claudian-collab-project-update');
    this.#render();
  }

  adopt(inspection: CollabProjectUpdateInspection | undefined): void {
    if (inspection?.action.kind !== this.#inspection?.action.kind) this.#failed = false;
    this.#inspection = inspection;
    this.#render();
  }

  setActive(active: boolean): void {
    this.#active = active;
    this.#render();
  }

  destroy(): void {
    this.#destroyed = true;
    this.root.remove();
  }

  #render(): void {
    if (this.#destroyed) return;
    this.root.replaceChildren();
    const inspection = this.#inspection;
    this.root.hidden = !inspection || inspection.action.kind === 'none'
      || inspection.action.kind === 'complete-publish';
    if (this.root.hidden || !inspection) return;
    const { operation, action } = inspection;
    if (operation.kind === 'update-conflict') {
      const conflicts = this.#button(t('collab.update.conflictAction'));
      conflicts.addEventListener('click', () => {
        if (this.#active && !this.#destroyed) this.options.onConflict(operation.conflictOperationId);
      });
    }
    const label = this.#failed ? t('collab.access.retry')
      : action.kind === 'continue-update' ? t('collab.update.resumeAction')
      : t('collab.update.reviewAction');
    const button = this.#button(label);
    button.disabled ||= !action.enabled;
    button.setAttribute('aria-busy', String(this.#pending));
    if (!action.enabled && inspection.freshness !== 'fresh') button.title = t('collab.update.reconnect');
    else if (this.#failed) button.title = t('collab.update.failed');
    button.addEventListener('click', () => {
      if (!this.#active || this.#pending || this.#destroyed || !action.enabled) return;
      if (action.kind === 'review-update' && operation.kind === 'update-review') {
        if (operation.review.files.length > 0) this.options.onReview(operation.review);
        else void this.#update();
      } else void this.#update();
    });
  }

  #button(text: string): HTMLButtonElement {
    const button = this.root.createEl('button', { text, attr: { type: 'button' } });
    button.disabled = this.#pending || !this.#active;
    return button;
  }

  async #update(): Promise<void> {
    this.#pending = true;
    this.#failed = false;
    this.#render();
    try {
      const result = await this.options.port.updateProject(this.options.projectId);
      if (this.#destroyed) return;
      if (result.status === 'success') {
        this.#failed = false;
        if (this.#active && this.#inspection?.freshness === 'fresh'
          && result.value.state === 'review-required' && result.value.review?.files.length) this.options.onReview(result.value.review);
      } else if (result.status === 'conflict') {
        if (this.#active) this.options.onConflict(result.conflict.operationId);
      } else this.#failed = true;
    } catch {
      this.#failed = true;
    } finally {
      this.#pending = false;
      if (!this.#destroyed) {
        this.#render();
        this.options.refresh();
      }
    }
  }
}
