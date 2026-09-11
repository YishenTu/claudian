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
    this.#inspection = inspection;
    this.#failed = false;
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
    this.root.hidden = !inspection || inspection.state === 'unknown' || inspection.state === 'current';
    if (this.root.hidden || !inspection) return;
    this.root.createSpan({ text: this.#failed ? t('collab.update.failed') : t('collab.update.available') });
    if (inspection.state === 'conflict') {
      const conflicts = this.#button(t('collab.conflict.title'));
      conflicts.addEventListener('click', () => {
        if (this.#active && !this.#destroyed) this.options.onConflict(inspection.conflictOperationId);
      });
    }
    const action = this.#button(this.#pending ? t('collab.update.updating')
      : inspection.state === 'review-required' ? t('collab.update.review')
      : inspection.state === 'conflict' || inspection.state === 'recovery-required' ? t('collab.update.continue')
      : t('collab.update.action'));
    action.addEventListener('click', () => {
      if (!this.#active || this.#pending || this.#destroyed) return;
      if (inspection.state === 'review-required') this.options.onReview(inspection.review);
      else void this.#update();
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
      if (this.#destroyed || !this.#inspection
        || this.#inspection.state === 'unknown' || this.#inspection.state === 'current') return;
      if (result.status === 'success') {
        if (result.value.state === 'review-required' && result.value.review) {
          this.#inspection = { state: 'review-required', review: result.value.review };
          if (this.#active) this.options.onReview(result.value.review);
        } else this.#inspection = { state: 'current' };
      } else if (result.status === 'conflict') {
        this.#inspection = { state: 'conflict', conflictOperationId: result.conflict.operationId };
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
