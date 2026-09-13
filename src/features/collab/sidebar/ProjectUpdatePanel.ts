import type { CollabFeaturePort, CollabProjectUpdateInspection, CollabProjectUpdateOperation, CollabPublicationReview } from '@/core/collab';
import { t } from '@/i18n/i18n';

export interface ProjectUpdatePanelOptions {
  readonly projectId: string;
  readonly port: Pick<CollabFeaturePort, 'updateProject'>;
  readonly onReview: (review: CollabPublicationReview) => void;
  readonly onConflict: (operationId: string) => void;
  readonly onCompletePublish: (operation: Extract<CollabProjectUpdateOperation, { kind: 'publish' }>) => void;
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
    this.root.hidden = !inspection || inspection.action.kind === 'none';
    if (this.root.hidden || !inspection) return;
    const { operation, action, freshness } = inspection;
    this.root.createSpan({ text: this.#failed ? t('collab.update.failed')
      : operation.kind === 'publish' ? t('collab.update.publishPending')
      : operation.kind === 'update-conflict' ? t('collab.update.conflictPending')
      : operation.kind === 'update-recovery' ? t('collab.update.recoveryPending')
      : operation.kind === 'update-review' ? t('collab.update.reviewPending')
      : inspection.incoming === 'included' ? t('collab.update.syncRequired') : t('collab.update.available') });
    if (freshness !== 'fresh') this.root.createSpan({ text: t('collab.update.reconnect') });
    if (operation.kind === 'update-conflict') {
      const conflicts = this.#button(t('collab.conflict.title'));
      conflicts.addEventListener('click', () => {
        if (this.#active && !this.#destroyed) this.options.onConflict(operation.conflictOperationId);
      });
    }
    const label = action.kind === 'sync' ? t('collab.update.syncAction')
      : action.kind === 'review-update' ? t('collab.update.review')
      : action.kind === 'continue-update' ? t('collab.update.continue')
      : action.kind === 'complete-publish' ? t('collab.update.finishPublish') : t('collab.update.action');
    const button = this.#button(this.#pending ? t('collab.update.updating') : label);
    button.disabled ||= !action.enabled;
    button.addEventListener('click', () => {
      if (!this.#active || this.#pending || this.#destroyed || !action.enabled) return;
      if (action.kind === 'complete-publish' && operation.kind === 'publish') this.options.onCompletePublish(operation);
      else if (action.kind === 'review-update' && operation.kind === 'update-review') this.options.onReview(operation.review);
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
      if (this.#destroyed) return;
      if (result.status === 'success') {
        this.#failed = false;
        if (this.#active && this.#inspection?.freshness === 'fresh'
          && result.value.state === 'review-required' && result.value.review) this.options.onReview(result.value.review);
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
