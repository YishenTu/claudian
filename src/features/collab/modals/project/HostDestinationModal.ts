import type { CollabMember, CollabMemberId } from '@claudian-collab/protocol';
import { type App, Modal } from 'obsidian';

import { t } from '@/i18n/i18n';

export interface HostDestinationModalOptions {
  readonly members: readonly CollabMember[];
  readonly onSelect: (memberId: CollabMemberId) => void;
  readonly onClosed: () => void;
}

export class HostDestinationModal extends Modal {
  #opened = false;
  #members: readonly CollabMember[];

  constructor(app: App, private readonly options: HostDestinationModalOptions) {
    super(app);
    this.#members = options.members;
  }

  onOpen(): void {
    this.#opened = true;
    this.setTitle(t('collab.access.transferHost'));
    this.modalEl.classList.add('claudian-collab-modal--filled-actions');
    this.#render();
  }

  setMembers(members: readonly CollabMember[]): void {
    if (members.length === this.#members.length && members.every((member, index) => (
      member.id === this.#members[index].id && member.displayName === this.#members[index].displayName
    ))) return;
    this.#members = members;
    if (this.#opened) this.#render();
  }

  onClose(): void {
    this.#opened = false;
    this.contentEl.replaceChildren();
    this.options.onClosed();
  }

  #render(): void {
    const active = this.contentEl.ownerDocument.activeElement;
    const focusedMemberId = active && this.contentEl.contains(active)
      ? (active as HTMLElement).dataset.memberId : undefined;
    this.contentEl.replaceChildren();
    const list = this.contentEl.createEl('ul', { cls: 'claudian-collab-access-list' });
    for (const member of this.#members) {
      const row = list.createEl('li', { cls: 'claudian-collab-access-member' });
      const button = row.createEl('button', {
        attr: { type: 'button', 'data-member-id': member.id },
        text: member.displayName,
      });
      button.addEventListener('click', () => {
        if (!this.#opened || !this.#members.some(current => current.id === member.id)) return;
        this.close();
        this.options.onSelect(member.id);
      });
    }
    if (focusedMemberId) {
      const buttons = Array.from(list.querySelectorAll('button'));
      (buttons.find(button => button.dataset.memberId === focusedMemberId) ?? buttons[0])?.focus();
    }
  }
}
