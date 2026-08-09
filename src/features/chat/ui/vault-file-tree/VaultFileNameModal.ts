import type { App, ButtonComponent, TAbstractFile, TextComponent } from 'obsidian';
import { Modal, Notice, Setting } from 'obsidian';

export type VaultFileNameSubmitResult = string | null;

export type VaultFileNameModalOptions = {
  failureMessage: string;
  initialName: string;
  onSubmit: (name: string) => Promise<VaultFileNameSubmitResult>;
  submitLabel: string;
  title: string;
};

type ValidatedVaultFileName =
  | { name: string }
  | { error: string };

function validateVaultFileName(rawName: string): ValidatedVaultFileName {
  const name = rawName.trim();
  if (!name) return { error: 'Name cannot be empty' };
  if (name === '.' || name === '..') return { error: 'Name cannot be "." or ".."' };
  if (name.startsWith('.')) return { error: 'Name cannot start with "."' };
  if (/[/\\\0]/.test(name)) {
    return { error: 'Name cannot contain path separators' };
  }
  return { name };
}

export function joinVaultPath(parentPath: string, name: string): string {
  const normalizedParent = parentPath.replace(/\/+$/, '');
  return normalizedParent ? `${normalizedParent}/${name}` : name;
}

export function hasVaultPathConflict(
  app: App,
  targetPath: string,
  currentFile?: TAbstractFile,
): boolean {
  const targetKey = targetPath.toLowerCase();
  return app.vault.getAllLoadedFiles().some(file => (
    file !== currentFile && file.path.toLowerCase() === targetKey
  ));
}

class VaultFileNameModal extends Modal {
  private nameInput: TextComponent | null = null;
  private submitButton: ButtonComponent | null = null;
  private submitting = false;

  constructor(
    app: App,
    private readonly options: VaultFileNameModalOptions,
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle(this.options.title);
    this.modalEl.addClass('claudian-vault-file-name-modal');

    new Setting(this.contentEl)
      .setName('Name')
      .addText((input) => {
        this.nameInput = input.setValue(this.options.initialName);
        input.inputEl.setAttribute('aria-label', 'Name');
        input.inputEl.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter' || event.isComposing) return;
          event.preventDefault();
          void this.submit();
        });

        input.inputEl.ownerDocument.defaultView?.requestAnimationFrame(() => {
          input.inputEl.focus();
          input.inputEl.select();
        });
      });

    new Setting(this.contentEl)
      .addButton(button => button
        .setButtonText('Cancel')
        .onClick(() => this.close()))
      .addButton((button) => {
        this.submitButton = button
          .setButtonText(this.options.submitLabel)
          .setCta()
          .onClick(() => {
            void this.submit();
          });
      });
  }

  onClose(): void {
    this.contentEl.empty();
    this.nameInput = null;
    this.submitButton = null;
  }

  private async submit(): Promise<void> {
    if (this.submitting || !this.nameInput) return;

    const validatedName = validateVaultFileName(this.nameInput.getValue());
    if ('error' in validatedName) {
      new Notice(validatedName.error);
      return;
    }

    const nameInput = this.nameInput;
    const submitButton = this.submitButton;
    this.submitting = true;
    nameInput.setDisabled(true);
    submitButton?.setDisabled(true);

    try {
      const validationError = await this.options.onSubmit(validatedName.name);
      if (validationError) {
        new Notice(validationError);
        return;
      }
      this.close();
    } catch {
      new Notice(this.options.failureMessage);
    } finally {
      this.submitting = false;
      nameInput.setDisabled(false);
      submitButton?.setDisabled(false);
    }
  }
}

export function showVaultFileNameModal(app: App, options: VaultFileNameModalOptions): void {
  new VaultFileNameModal(app, options).open();
}
