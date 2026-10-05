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
  #active: { cancel: () => void; input: HTMLInputElement } | null = null;

  begin(item: HTMLElement, request: InlineRenameRequest): void {
    const titleEl = item.querySelector<HTMLElement>('.claudian-history-item-title');
    if (!titleEl) return;

    const { currentTitle } = request;
    const input = item.createEl('input', {
      cls: 'claudian-rename-input',
      attr: { type: 'text', value: currentTitle },
    });

    titleEl.replaceWith(input);
    input.focus();
    input.select();

    let isFinishing = false;
    const cancel = (): void => {
      input.value = currentTitle;
      input.blur();
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
        request.onFinished();
      } finally {
        isFinishing = false;
      }
    };

    input.addEventListener('blur', () => {
      if (this.#active?.input === input) {
        this.#active = null;
      }
      void finish().catch(() => {
        new Notice('Failed to rename conversation');
      });
    });
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
    this.#active = null;
    if (active.input.isConnected === false) return false;

    active.cancel();
    return true;
  }

  /** Forgets an editor inside `container` that a rerender is about to discard without blur. */
  releaseWithin(container: HTMLElement): void {
    if (this.#active && container.contains(this.#active.input)) {
      this.#active = null;
    }
  }
}
