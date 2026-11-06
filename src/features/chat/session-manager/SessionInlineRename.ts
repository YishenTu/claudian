import { Notice } from 'obsidian';

import { t } from '@/i18n/i18n';

export interface InlineRenameRequest {
  currentTitle: string;
  /** Persists a changed, non-empty title. */
  rename: (title: string) => Promise<void>;
  /** Restores the row once editing ends, whether or not the title changed. */
  onFinished: () => void;
}

/**
 * The single in-progress inline title editor of a session list. Blur or Enter commits; Escape
 * or {@link cancel} restores the original title without persisting.
 */
export class SessionInlineRename {
  #active: { cancel: () => boolean; input: HTMLInputElement } | null = null;

  begin(item: HTMLElement, request: InlineRenameRequest): void {
    const titleEl = item.querySelector<HTMLElement>('.claudian-history-item-title');
    if (!titleEl) return;

    const { currentTitle } = request;
    const input = item.createEl('input', {
      cls: 'claudian-rename-input',
      attr: { type: 'text', value: currentTitle, 'aria-label': t('chat.sessionManager.conversationTitle') },
    });

    titleEl.replaceWith(input);
    input.focus();
    input.select();

    let isFinishing = false;
    const cancel = (): boolean => {
      if (isFinishing) return false;
      input.value = currentTitle;
      if (input.ownerDocument.activeElement === input) input.blur();
      else requestFinish();
      return true;
    };
    this.#active = { cancel, input };
    const finish = async (): Promise<void> => {
      if (isFinishing) return;
      isFinishing = true;
      try {
        const newTitle = input.value.trim();
        if (newTitle && newTitle !== currentTitle) {
          await request.rename(newTitle);
        }
        if (this.#active?.input === input) this.#active = null;
        request.onFinished();
      } finally {
        isFinishing = false;
      }
    };

    const requestFinish = (): void => {
      void finish().catch(() => {
        new Notice(t('chat.sessionManager.failedToRenameConversation'));
      });
    };
    input.addEventListener('blur', requestFinish);
    input.addEventListener('keydown', (e) => {
      // Check !e.isComposing for IME support (Chinese, Japanese, Korean, etc.)
      if (e.key === 'Enter' && !e.isComposing) {
        input.blur();
      } else if (e.key === 'Escape' && !e.isComposing) {
        e.preventDefault();
        e.stopPropagation();
        cancel();
      }
    });
  }

  /** Cancels a connected editor; returns false when none was active. */
  cancel(): boolean {
    const active = this.#active;
    if (!active) return false;
    if (active.input.isConnected === false) {
      this.#active = null;
      return false;
    }

    return active.cancel();
  }

  /** Forgets an editor inside `container` that a rerender is about to discard without blur. */
  releaseWithin(container: HTMLElement): void {
    if (this.#active && container.contains(this.#active.input)) {
      this.#active = null;
    }
  }
}
