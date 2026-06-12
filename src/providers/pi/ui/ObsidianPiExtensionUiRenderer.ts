import { type App, Modal, Notice } from 'obsidian';

import type {
  PiExtensionUiConfirmRequest,
  PiExtensionUiEditorRequest,
  PiExtensionUiInputRequest,
  PiExtensionUiNotifyRequest,
  PiExtensionUiRenderer,
  PiExtensionUiSelectRequest,
  PiExtensionUiSetEditorTextRequest,
  PiExtensionUiSetStatusRequest,
  PiExtensionUiSetTitleRequest,
  PiExtensionUiSetWidgetRequest,
} from './PiExtensionUiRenderer';

export class ObsidianPiExtensionUiRenderer implements PiExtensionUiRenderer {
  constructor(private readonly app: App) {}

  async select(
    request: PiExtensionUiSelectRequest,
    signal: AbortSignal,
  ): Promise<{ cancelled?: boolean; value?: string }> {
    return new PiSelectModal(this.app, request, signal).openAndWait();
  }

  async confirm(
    request: PiExtensionUiConfirmRequest,
    signal: AbortSignal,
  ): Promise<{ cancelled?: boolean; confirmed?: boolean }> {
    return new PiConfirmModal(this.app, request, signal).openAndWait();
  }

  async input(
    request: PiExtensionUiInputRequest,
    signal: AbortSignal,
  ): Promise<{ cancelled?: boolean; value?: string }> {
    return new PiTextModal(this.app, request, signal, false).openAndWait();
  }

  async editor(
    request: PiExtensionUiEditorRequest,
    signal: AbortSignal,
  ): Promise<{ cancelled?: boolean; value?: string }> {
    return new PiTextModal(this.app, request, signal, true).openAndWait();
  }

  notify(request: PiExtensionUiNotifyRequest): void {
    new Notice(getDisplayText(request));
  }

  setStatus(_request: PiExtensionUiSetStatusRequest): void {}
  setWidget(_request: PiExtensionUiSetWidgetRequest): void {}
  setTitle(_request: PiExtensionUiSetTitleRequest): void {}
  setEditorText(_request: PiExtensionUiSetEditorTextRequest): void {}
}

function getDisplayText(request: Record<string, unknown>): string {
  const message = typeof request.message === 'string' ? request.message.trim() : '';
  const title = typeof request.title === 'string' ? request.title.trim() : '';
  return message || title || 'Pi extension notification.';
}

function getTitle(request: Record<string, unknown>, fallback: string): string {
  return typeof request.title === 'string' && request.title.trim()
    ? request.title.trim()
    : fallback;
}

function getMessage(request: Record<string, unknown>): string {
  return typeof request.message === 'string' ? request.message.trim() : '';
}

interface PiSelectOption {
  label: string;
  value: string;
}

function getSelectOptions(request: Record<string, unknown>): PiSelectOption[] {
  const rawOptions = Array.isArray(request.options) ? request.options : [];
  return rawOptions.flatMap((option): PiSelectOption[] => {
    if (typeof option === 'string' && option.trim()) {
      return [{ label: option.trim(), value: option.trim() }];
    }
    if (!option || typeof option !== 'object' || Array.isArray(option)) {
      return [];
    }

    const record = option as Record<string, unknown>;
    const value = typeof record.value === 'string' ? record.value.trim() : '';
    const label = typeof record.label === 'string' && record.label.trim()
      ? record.label.trim()
      : value;
    return value ? [{ label, value }] : [];
  });
}

abstract class PiExtensionModal<TResult extends Record<string, unknown>> extends Modal {
  private done = false;
  private resolve!: (result: TResult) => void;
  private readonly resultPromise = new Promise<TResult>((resolve) => {
    this.resolve = resolve;
  });

  constructor(
    app: App,
    protected readonly request: Record<string, unknown>,
    private readonly signal: AbortSignal,
  ) {
    super(app);
  }

  openAndWait(): Promise<TResult> {
    if (this.signal.aborted) {
      return Promise.resolve(this.cancelledResult());
    }

    const abortHandler = (): void => {
      this.finish(this.cancelledResult());
      this.close();
    };
    this.signal.addEventListener('abort', abortHandler, { once: true });
    void this.resultPromise.finally(() => {
      this.signal.removeEventListener('abort', abortHandler);
    });
    this.open();
    return this.resultPromise;
  }

  override onOpen(): void {
    this.contentEl.empty();
    this.contentEl.addClass('claudian-pi-extension-modal');
    this.render();
  }

  override onClose(): void {
    this.finish(this.cancelledResult());
  }

  protected abstract cancelledResult(): TResult;
  protected abstract render(): void;

  protected finish(result: TResult): void {
    if (this.done) {
      return;
    }

    this.done = true;
    this.resolve(result);
  }

  protected renderHeader(fallbackTitle: string): void {
    this.contentEl.createEl('h2', { text: getTitle(this.request, fallbackTitle) });
    const message = getMessage(this.request);
    if (message) {
      this.contentEl.createEl('p', { text: message });
    }
  }
}

class PiSelectModal extends PiExtensionModal<{ cancelled?: boolean; value?: string }> {
  protected cancelledResult(): { cancelled: true } {
    return { cancelled: true };
  }

  protected render(): void {
    this.renderHeader('Pi extension');
    const options = getSelectOptions(this.request);
    const listEl = this.contentEl.createDiv({ cls: 'claudian-pi-extension-options' });
    for (const option of options) {
      const button = listEl.createEl('button', { text: option.label });
      button.addEventListener('click', () => {
        this.finish({ value: option.value });
        this.close();
      });
    }
    this.renderCancelButton();
  }

  private renderCancelButton(): void {
    const cancelButton = this.contentEl.createEl('button', { text: 'Cancel' });
    cancelButton.addEventListener('click', () => {
      this.finish({ cancelled: true });
      this.close();
    });
  }
}

class PiConfirmModal extends PiExtensionModal<{ cancelled?: boolean; confirmed?: boolean }> {
  protected cancelledResult(): { cancelled: true } {
    return { cancelled: true };
  }

  protected render(): void {
    this.renderHeader('Pi extension');
    const actionsEl = this.contentEl.createDiv({ cls: 'claudian-pi-extension-actions' });
    const confirmButton = actionsEl.createEl('button', { text: 'Confirm' });
    confirmButton.addEventListener('click', () => {
      this.finish({ confirmed: true });
      this.close();
    });
    const cancelButton = actionsEl.createEl('button', { text: 'Cancel' });
    cancelButton.addEventListener('click', () => {
      this.finish({ confirmed: false });
      this.close();
    });
  }
}

class PiTextModal extends PiExtensionModal<{ cancelled?: boolean; value?: string }> {
  constructor(
    app: App,
    request: Record<string, unknown>,
    signal: AbortSignal,
    private readonly multiline: boolean,
  ) {
    super(app, request, signal);
  }

  protected cancelledResult(): { cancelled: true } {
    return { cancelled: true };
  }

  protected render(): void {
    this.renderHeader('Pi extension');
    const initialValue = typeof this.request.value === 'string'
      ? this.request.value
      : typeof this.request.defaultValue === 'string'
      ? this.request.defaultValue
      : '';
    const input = this.multiline
      ? this.contentEl.createEl('textarea')
      : this.contentEl.createEl('input', { type: 'text' });
    input.value = initialValue;
    if (this.multiline) {
      (input as HTMLTextAreaElement).rows = 8;
    }

    const actionsEl = this.contentEl.createDiv({ cls: 'claudian-pi-extension-actions' });
    const submitButton = actionsEl.createEl('button', { text: 'Submit' });
    submitButton.addEventListener('click', () => {
      this.finish({ value: input.value });
      this.close();
    });
    const cancelButton = actionsEl.createEl('button', { text: 'Cancel' });
    cancelButton.addEventListener('click', () => {
      this.finish({ cancelled: true });
      this.close();
    });
    window.setTimeout(() => input.focus(), 0);
  }
}
