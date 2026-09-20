import { Notice } from 'obsidian';

import type { ApprovalDecision } from '../../../core/types';
import { type InlineAskQuestionConfig, InlineAskUserQuestion } from './InlineAskUserQuestion';
import { setToolIcon } from './ToolCallRenderer';

const APPROVAL_OPTION_MAP: Record<string, ApprovalDecision> = {
  'Deny': 'deny',
  'Allow once': 'allow',
  'Always allow': 'allow-always',
};

export interface InlineApprovalDecisionOption {
  label: string;
  description?: string;
  value: string;
  decision?: ApprovalDecision;
}

export interface InlineApprovalOptions {
  decisionReason?: string;
  blockedPath?: string;
  agentID?: string;
  decisionOptions?: InlineApprovalDecisionOption[];
  additionalPermissions?: unknown;
}

const DEFAULT_APPROVAL_DECISION_OPTIONS: InlineApprovalDecisionOption[] =
  Object.entries(APPROVAL_OPTION_MAP).map(([label, decision]) => ({
    decision,
    label,
    value: label,
  }));

export interface InlineInteractionPromptsDeps {
  /** Element that receives the inline prompt. */
  getPromptParentEl(): HTMLElement | null;
  /** Optional element hidden for the lifetime of a visible prompt. */
  getSuppressedEl?(): HTMLElement | null;
  onBeforeShow?(): void;
}

/**
 * Inline approval/question presentation shared by every destination that owns a
 * provider interaction port. It holds no execution or persistence authority.
 */
export class InlineInteractionPrompts {
  private approvalInline: InlineAskUserQuestion | null = null;
  private questionInline: InlineAskUserQuestion | null = null;
  private suppressDepth = 0;

  constructor(private readonly deps: InlineInteractionPromptsDeps) {}

  async requestApproval(
    toolName: string,
    _input: Record<string, unknown>,
    description: string,
    approvalOptions?: InlineApprovalOptions,
  ): Promise<ApprovalDecision> {
    const parentEl = this.#requireParentEl();
    const headerEl = parentEl.createDiv({ cls: 'claudian-ask-approval-info' });
    headerEl.remove();

    const toolEl = headerEl.createDiv({ cls: 'claudian-ask-approval-tool' });
    const iconEl = toolEl.createSpan({ cls: 'claudian-ask-approval-icon' });
    iconEl.setAttribute('aria-hidden', 'true');
    setToolIcon(iconEl, toolName);
    toolEl.createSpan({ cls: 'claudian-ask-approval-tool-name', text: toolName });

    if (approvalOptions?.decisionReason) {
      headerEl.createDiv({ cls: 'claudian-ask-approval-reason', text: approvalOptions.decisionReason });
    }
    if (approvalOptions?.blockedPath) {
      headerEl.createDiv({ cls: 'claudian-ask-approval-blocked-path', text: approvalOptions.blockedPath });
    }
    if (approvalOptions?.agentID) {
      headerEl.createDiv({ cls: 'claudian-ask-approval-agent', text: `Agent: ${approvalOptions.agentID}` });
    }

    const descriptionEl = headerEl.createDiv({
      cls: 'claudian-ask-approval-desc',
      text: description,
    });
    descriptionEl.setAttribute('aria-label', `${toolName} approval details`);
    descriptionEl.setAttribute('role', 'region');
    descriptionEl.setAttribute('tabindex', '0');
    descriptionEl.addEventListener('keydown', (event) => {
      if (
        event.key === 'ArrowDown'
        || event.key === 'ArrowUp'
        || event.key === 'Enter'
      ) {
        event.stopPropagation();
      }
    });

    const decisionOptions = approvalOptions?.decisionOptions ?? DEFAULT_APPROVAL_DECISION_OPTIONS;
    const optionDecisionMap = new Map<string, ApprovalDecision>();
    const questionOptions = decisionOptions.map((option, index) => {
      const value = option.value || `approval-option-${index}`;
      if (option.decision) {
        optionDecisionMap.set(value, option.decision);
      }
      return {
        description: option.description ?? '',
        label: option.label,
        value,
      };
    });

    const result = await this.#showInline(
      parentEl,
      { questions: [{ isOther: false, isSecret: false, options: questionOptions, question: 'Allow this action?' }] },
      (inline) => { this.approvalInline = inline; },
      undefined,
      { headerEl, immediateSelect: true, showCustomInput: false, title: 'Permission required' },
    );

    if (!result) return 'cancel';
    const selected = Object.values(result)[0];
    const selectedValue = Array.isArray(selected) ? selected[0] : selected;
    if (typeof selectedValue !== 'string') {
      new Notice(`Unexpected approval selection: "${String(selectedValue)}"`);
      return 'cancel';
    }

    return optionDecisionMap.get(selectedValue)
      ?? { type: 'select-option', value: selectedValue };
  }

  askUserQuestion(
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, string | string[]> | null> {
    return this.#showInline(
      this.#requireParentEl(),
      input,
      (inline) => { this.questionInline = inline; },
      signal,
    );
  }

  dismissApproval(): void {
    if (this.approvalInline) {
      this.approvalInline.destroy();
      this.approvalInline = null;
    }
  }

  dismiss(kind: 'approval' | 'question'): void {
    if (kind === 'approval') {
      this.dismissApproval();
      return;
    }
    this.questionInline?.destroy();
    this.questionInline = null;
  }

  dismissAll(): void {
    this.dismissApproval();
    this.questionInline?.destroy();
    this.questionInline = null;
    this.resetSuppression();
  }

  resetSuppression(): void {
    if (this.suppressDepth <= 0) return;
    this.suppressDepth = 0;
    this.deps.getSuppressedEl?.()?.removeClass('claudian-hidden');
  }

  #showInline(
    parentEl: HTMLElement,
    input: Record<string, unknown>,
    setPending: (inline: InlineAskUserQuestion | null) => void,
    signal?: AbortSignal,
    config?: InlineAskQuestionConfig,
  ): Promise<Record<string, string | string[]> | null> {
    this.deps.onBeforeShow?.();
    this.#suppress();

    return new Promise((resolve, reject) => {
      const inline = new InlineAskUserQuestion(
        parentEl,
        input,
        (result) => {
          setPending(null);
          this.#restore();
          resolve(result);
        },
        signal,
        config,
      );
      setPending(inline);
      try {
        inline.render();
      } catch (error) {
        setPending(null);
        this.#restore();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  #requireParentEl(): HTMLElement {
    const parentEl = this.deps.getPromptParentEl();
    if (!parentEl) {
      throw new Error('Inline interaction host is detached from DOM');
    }
    return parentEl;
  }

  #suppress(): void {
    const el = this.deps.getSuppressedEl?.();
    if (!el) return;
    this.suppressDepth += 1;
    el.addClass('claudian-hidden');
  }

  #restore(): void {
    const el = this.deps.getSuppressedEl?.();
    if (!el || this.suppressDepth <= 0) return;
    this.suppressDepth -= 1;
    if (this.suppressDepth === 0) el.removeClass('claudian-hidden');
  }
}
