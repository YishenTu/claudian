import { Notice } from 'obsidian';

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
      attr: { type: 'text', value: currentTitle, 'aria-label': 'Conversation title' },
    });

    this.#mountInput(titleEl, input);
    input.addEventListener('click', event => event.stopPropagation());
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
        new Notice('Failed to rename conversation');
      });
    };
    input.addEventListener('blur', requestFinish);
    input.addEventListener('keydown', (e) => {
      // Check !e.isComposing for IME support (Chinese, Japanese, Korean, etc.)
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        e.stopPropagation();
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

  /** Keeps the current editor while a list refresh rebuilds the row around it. */
  preserveWithin(container: HTMLElement): (() => void) | undefined {
    const active = this.#active;
    if (!active || !container.contains(active.input)) return undefined;
    const conversationId = active.input.closest('[data-conversation-id]')?.getAttribute('data-conversation-id');
    if (!conversationId) return undefined;
    const { input } = active;
    const focused = input.ownerDocument.activeElement === input;
    const selection = [input.selectionStart, input.selectionEnd, input.selectionDirection] as const;
    input.remove();
    return () => {
      if (this.#active !== active) return;
      const row = Array.from(container.querySelectorAll<HTMLElement>('[data-conversation-id]'))
        .find(item => item.getAttribute('data-conversation-id') === conversationId);
      const title = row?.querySelector('.claudian-history-item-title');
      if (!title) {
        this.#active = null;
        return;
      }
      this.#mountInput(title, input);
      if (focused) {
        input.focus({ preventScroll: true });
        input.setSelectionRange(selection[0], selection[1], selection[2] ?? undefined);
      }
    };
  }

  #mountInput(title: Element, input: HTMLInputElement): void {
    const content = title.closest('.claudian-history-item-content');
    content?.removeAttribute('role');
    content?.removeAttribute('tabindex');
    title.replaceWith(input);
  }

  /** Forgets an editor inside `container` that a rerender is about to discard without blur. */
  releaseWithin(container: HTMLElement): void {
    if (this.#active && container.contains(this.#active.input)) {
      this.#active = null;
    }
  }
}
