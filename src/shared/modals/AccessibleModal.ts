import { type App, Modal } from 'obsidian';

let nextTitleId = 0;

/** Names a dialog from its visible title, or an explicit label for titleless dialogs. */
export function setModalAccessibility(modalEl: HTMLElement, title: HTMLElement | string): void {
  modalEl.setAttribute('role', 'dialog');
  modalEl.setAttribute('aria-modal', 'true');
  if (typeof title === 'string') {
    modalEl.removeAttribute('aria-labelledby');
    modalEl.setAttribute('aria-label', title);
  } else {
    title.id ||= `claudian-modal-title-${++nextTitleId}`;
    modalEl.removeAttribute('aria-label');
    modalEl.setAttribute('aria-labelledby', title.id);
  }
}

/** Supplies dialog semantics while the host retains focus, keyboard and close handling. */
export class AccessibleModal extends Modal {
  constructor(app: App) {
    super(app);
    setModalAccessibility(this.modalEl, this.titleEl);
  }
}
