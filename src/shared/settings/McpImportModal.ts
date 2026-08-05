import type { App } from 'obsidian';
import { Modal, Notice } from 'obsidian';

export type McpConfigImportHandler = (config: string) => Promise<boolean>;

export class McpImportModal extends Modal {
  private pastedConfig = '';
  private submitting = false;
  private submitButtonEl: HTMLButtonElement | null = null;

  constructor(
    app: App,
    private readonly onImport: McpConfigImportHandler,
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle('Import mcp configuration');
    this.modalEl.addClass('claudian-mcp-modal');

    this.contentEl.createEl('p', {
      text: 'Paste an mcp server JSON configuration below.',
    });

    const textarea = this.contentEl.createEl('textarea', {
      cls: 'claudian-mcp-import-textarea',
      attr: {
        'aria-label': 'Mcp configuration JSON',
        placeholder: '{\n  "mcpServers": {\n    "server-name": { "command": "..." }\n  }\n}',
      },
    });
    textarea.rows = 12;
    textarea.addEventListener('input', () => {
      this.pastedConfig = textarea.value;
    });
    textarea.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.isComposing) {
        event.preventDefault();
        void this.submit();
      }
    });

    const buttonContainer = this.contentEl.createDiv({ cls: 'claudian-mcp-buttons' });
    const cancelButton = buttonContainer.createEl('button', {
      text: 'Cancel',
      cls: 'claudian-cancel-btn',
    });
    cancelButton.addEventListener('click', () => this.close());

    this.submitButtonEl = buttonContainer.createEl('button', {
      text: 'Import',
      cls: 'claudian-save-btn mod-cta',
    });
    this.submitButtonEl.addEventListener('click', () => {
      void this.submit();
    });

    textarea.focus();
  }

  onClose(): void {
    this.contentEl.empty();
    this.submitButtonEl = null;
  }

  private async submit(): Promise<void> {
    const config = this.pastedConfig.trim();
    if (!config) {
      new Notice('Paste an mcp configuration first');
      return;
    }
    if (this.submitting) {
      return;
    }

    this.submitting = true;
    if (this.submitButtonEl) {
      this.submitButtonEl.disabled = true;
    }
    try {
      if (await this.onImport(config)) {
        this.close();
      }
    } finally {
      this.submitting = false;
      if (this.submitButtonEl) {
        this.submitButtonEl.disabled = false;
      }
    }
  }
}
