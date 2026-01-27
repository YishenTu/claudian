import type { App } from 'obsidian';
import { Modal, setIcon } from 'obsidian';

import { getToolIcon } from '../../core/tools';
import type { ApprovalDecision } from '../../core/types';

export type { ApprovalDecision };

export interface ApprovalModalOptions {
  showAlwaysAllow?: boolean;
  title?: string;
  decisionReason?: string;
  blockedPath?: string;
}

export class ApprovalModal extends Modal {
  private toolName: string;
  private description: string;
  private resolve: (value: ApprovalDecision) => void;
  private resolved = false;
  private options: ApprovalModalOptions;
  private buttons: HTMLButtonElement[] = [];
  private currentButtonIndex = 0;
  private documentKeydownHandler: ((e: KeyboardEvent) => void) | null = null;

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

    if (this.options.decisionReason) {
      const reasonEl = infoEl.createDiv({ cls: 'claudian-approval-reason' });
      reasonEl.setText(this.options.decisionReason);
    }

    if (this.options.blockedPath) {
      const pathEl = infoEl.createDiv({ cls: 'claudian-approval-blocked-path' });
      pathEl.setText(this.options.blockedPath);
    }

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

    let alwaysAllowBtn: HTMLButtonElement | null = null;
    if (this.options.showAlwaysAllow ?? true) {
      alwaysAllowBtn = buttonsEl.createEl('button', {
        text: 'Always allow',
        cls: 'claudian-approval-btn claudian-always-btn',
        attr: { 'aria-label': `Always allow ${this.toolName} actions` }
      });
      alwaysAllowBtn.addEventListener('click', () => this.handleDecision('allow-always'));
    }

    this.buttons = [denyBtn, allowBtn];
    if (alwaysAllowBtn) {
      this.buttons.push(alwaysAllowBtn);
    }
    this.currentButtonIndex = 0;
    this.focusCurrentButton();
    this.attachDocumentHandler();
  }

  private handleDecision(decision: ApprovalDecision) {
    if (!this.resolved) {
      this.resolved = true;
      this.resolve(decision);
      this.close();
    }
  }

  private attachDocumentHandler(): void {
    this.detachDocumentHandler();
    this.documentKeydownHandler = (e: KeyboardEvent) => {
      if (!this.isNavigationKey(e)) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      this.handleNavigationKey(e);
    };
    document.addEventListener('keydown', this.documentKeydownHandler, true);
  }

  private detachDocumentHandler(): void {
    if (this.documentKeydownHandler) {
      document.removeEventListener('keydown', this.documentKeydownHandler, true);
      this.documentKeydownHandler = null;
    }
  }

  private isNavigationKey(e: KeyboardEvent): boolean {
    return (
      e.key === 'ArrowUp' ||
      e.key === 'ArrowDown' ||
      e.key === 'ArrowLeft' ||
      e.key === 'ArrowRight' ||
      e.key === 'Tab'
    );
  }

  private handleNavigationKey(e: KeyboardEvent): void {
    if (!this.buttons.length) return;

    let direction = 0;
    switch (e.key) {
      case 'ArrowUp':
      case 'ArrowLeft':
        direction = -1;
        break;
      case 'ArrowDown':
      case 'ArrowRight':
        direction = 1;
        break;
      case 'Tab':
        direction = e.shiftKey ? -1 : 1;
        break;
      default:
        return;
    }

    const total = this.buttons.length;
    this.currentButtonIndex = (this.currentButtonIndex + direction + total) % total;
    this.focusCurrentButton();
  }

  private focusCurrentButton(): void {
    const button = this.buttons[this.currentButtonIndex];
    button?.focus();
  }

  onClose() {
    this.detachDocumentHandler();
    if (!this.resolved) {
      this.resolved = true;
      // User pressed Escape or clicked outside - cancel/interrupt
      this.resolve('cancel');
    }
    this.contentEl.empty();
  }
}
