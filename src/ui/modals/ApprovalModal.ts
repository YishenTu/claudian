/**
 * Claudian - Approval modal for Safe mode tool permission prompts.
 */

import type { App } from 'obsidian';
import { Modal, setIcon } from 'obsidian';

import { getToolIcon } from '../../core/tools/toolIcons';

export type ApprovalDecision = 'allow' | 'allow-always' | 'deny';

export interface ApprovalModalOptions {
  showAlwaysAllow?: boolean;
  title?: string;
}

/** Modal dialog for approving tool actions in Safe mode. */
export class ApprovalModal extends Modal {
  private toolName: string;
  private description: string;
  private resolve: (value: ApprovalDecision) => void;
  private resolved = false;
  private options: ApprovalModalOptions;

  constructor(
    app: App,
    toolName: string,
    _input: Record<string, unknown>,
    description: string,
    resolve: (value: ApprovalDecision) => void,
    options: ApprovalModalOptions = {}
  ) {
    super(app);
    this.toolName = toolName;
    this.description = description;
    this.resolve = resolve;
    this.options = options;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('claudian-approval-modal');
    this.setTitle(this.options.title ?? 'Permission required');

    const infoEl = contentEl.createDiv({ cls: 'claudian-approval-info' });

    const toolEl = infoEl.createDiv({ cls: 'claudian-approval-tool' });
    const iconEl = toolEl.createSpan({ cls: 'claudian-approval-icon' });
    iconEl.setAttribute('aria-hidden', 'true');
    setIcon(iconEl, getToolIcon(this.toolName));
    toolEl.createSpan({ text: this.toolName, cls: 'claudian-approval-tool-name' });

    const descEl = contentEl.createDiv({ cls: 'claudian-approval-desc' });
    descEl.setText(this.description);

    const buttonsEl = contentEl.createDiv({ cls: 'claudian-approval-buttons' });

    const denyBtn = buttonsEl.createEl('button', {
      text: 'Deny',
      cls: 'claudian-approval-btn claudian-deny-btn',
      attr: { 'aria-label': `Deny ${this.toolName} action` }
    });
    denyBtn.addEventListener('click', () => this.handleDecision('deny'));

    const allowBtn = buttonsEl.createEl('button', {
      text: 'Allow once',
      cls: 'claudian-approval-btn claudian-allow-btn',
      attr: { 'aria-label': `Allow ${this.toolName} action once` }
    });
    allowBtn.addEventListener('click', () => this.handleDecision('allow'));

    if (this.options.showAlwaysAllow ?? true) {
      const alwaysBtn = buttonsEl.createEl('button', {
        text: 'Always allow',
        cls: 'claudian-approval-btn claudian-always-btn',
        attr: { 'aria-label': `Always allow ${this.toolName} actions` }
      });
      alwaysBtn.addEventListener('click', () => this.handleDecision('allow-always'));
    }

    denyBtn.focus();
  }

  private handleDecision(decision: ApprovalDecision) {
    if (!this.resolved) {
      this.resolved = true;
      this.resolve(decision);
      this.close();
    }
  }

  onClose() {
    if (!this.resolved) {
      this.resolved = true;
      this.resolve('deny');
    }
    this.contentEl.empty();
  }
}
