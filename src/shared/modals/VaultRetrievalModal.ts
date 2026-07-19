import type { App } from 'obsidian';
import { Modal, Notice, setIcon,TFile } from 'obsidian';

import type { VaultRetrievalResult } from '../../core/retrieval/VaultRetrievalService';

export interface VaultRetrievalModalOptions {
  title: string;
  query: string;
  results: VaultRetrievalResult[];
  prompt?: string;
  onAskAgent?: (prompt: string) => void;
}

/** Displays local retrieval sources and keeps every insight traceable. */
export class VaultRetrievalModal extends Modal {
  constructor(app: App, private readonly options: VaultRetrievalModalOptions) {
    super(app);
  }

  onOpen(): void {
    this.setTitle(this.options.title);
    this.modalEl.addClass('claudian-vault-retrieval-modal');

    const { contentEl } = this;
    contentEl.createDiv({
      cls: 'claudian-vault-retrieval-query',
      text: this.options.query ? `Sources for “${this.options.query}”` : 'Related vault sources',
    });

    if (this.options.results.length === 0) {
      contentEl.createDiv({
        cls: 'claudian-vault-retrieval-empty',
        text: 'No matching Markdown sources were found.',
      });
      return;
    }

    const list = contentEl.createDiv({ cls: 'claudian-vault-retrieval-list' });
    for (const [index, result] of this.options.results.entries()) {
      const item = list.createDiv({ cls: 'claudian-vault-retrieval-item' });
      const header = item.createDiv({ cls: 'claudian-vault-retrieval-item-header' });
      const openButton = header.createEl('button', {
        cls: 'claudian-vault-retrieval-source',
        attr: { type: 'button' },
      });
      setIcon(openButton, 'file-text');
      openButton.createSpan({ text: `[${index + 1}] ${result.path}${result.heading ? ` · ${result.heading}` : ''}` });
      openButton.addEventListener('click', () => {
        const file = this.app.vault.getAbstractFileByPath(result.path);
        if (!(file instanceof TFile)) {
          new Notice(`Could not open ${result.path}`);
          return;
        }
        void this.app.workspace.getLeaf().openFile(file);
      });

      item.createDiv({ cls: 'claudian-vault-retrieval-excerpt', text: result.excerpt });
      item.createDiv({
        cls: 'claudian-vault-retrieval-matches',
        text: `Matched: ${result.matchedTerms.join(', ')}`,
      });
    }

    if (this.options.prompt && this.options.onAskAgent) {
      const actions = contentEl.createDiv({ cls: 'claudian-vault-retrieval-actions' });
      const askButton = actions.createEl('button', {
        cls: 'mod-cta',
        text: 'Ask agent for an insight',
        attr: { type: 'button' },
      });
      askButton.addEventListener('click', () => {
        this.options.onAskAgent?.(this.options.prompt!);
        this.close();
      });
    }
  }

  onClose(): void {
    this.contentEl.empty();
    this.modalEl.removeClass('claudian-vault-retrieval-modal');
  }
}
