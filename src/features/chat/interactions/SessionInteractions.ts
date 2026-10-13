import { Notice } from 'obsidian';

import { TOOL_ASK_USER_QUESTION } from '@/core/tools/toolNames';
import type { ApprovalDecision, AskUserAnswers, ToolCallInfo } from '@/core/types';
import { type InlineAskQuestionConfig, InlineAskUserQuestion } from '@/features/chat/interactions/InlineAskUserQuestion';
import { QuestionInteractionState } from '@/features/chat/interactions/QuestionInteractionState';
import { setToolIcon } from '@/features/chat/rendering/tools/toolContentPrimitives';
import { t } from '@/i18n/i18n';

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
}

function getDefaultApprovalDecisionOptions(): InlineApprovalDecisionOption[] {
  return [
    { decision: 'deny', label: t('chat.approval.deny'), value: 'Deny' },
    { decision: 'allow', label: t('chat.approval.allowOnce'), value: 'Allow once' },
    { decision: 'allow-always', label: t('chat.approval.alwaysAllow'), value: 'Always allow' },
  ];
}

export interface SessionInteractionsDeps {
  /** Element that receives the inline prompt. */
  getPromptParentEl(): HTMLElement | null;
  /** Optional element hidden for the lifetime of a visible prompt. */
  getSuppressedEl?(): HTMLElement | null;
  /** Returns a restoration callback bound to the presentation being suppressed. */
  onBeforeShow?(): (() => void) | void;
}

interface AsyncQuestionDelivery {
  answer(tool: ToolCallInfo, answers: AskUserAnswers, signal: AbortSignal): Promise<void>;
  onChange(tool: ToolCallInfo): void;
}

interface PendingPrompt {
  readonly input: Record<string, unknown>;
  readonly state: QuestionInteractionState;
  readonly config?: InlineAskQuestionConfig;
  readonly createHeader?: (parent: HTMLElement) => HTMLElement;
  readonly resolve: (answers: Record<string, string | string[]> | null) => void;
  readonly signal?: AbortSignal;
  readonly abort: () => void;
  inline: InlineAskUserQuestion | null;
  readonly asyncQuestion?: { tool: ToolCallInfo; abort: AbortController };
}

/** Session-owned requests, answer drafts and delivery; widgets are optional presentation. */
export class SessionInteractions {
  private readonly pending = new Map<string, PendingPrompt>();
  private active = true;
  private asyncDelivery: AsyncQuestionDelivery | null = null;
  private readonly listeners = new Set<() => void>();
  /** The most recently shown prompt's restore; it belongs to the newest response being suppressed. */
  #restorePresentation: (() => void) | void = undefined;

  constructor(private readonly deps: SessionInteractionsDeps) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    listener();
    return () => this.listeners.delete(listener);
  }

  bindAsyncQuestions(delivery: AsyncQuestionDelivery): void {
    if (this.asyncDelivery) throw new Error('Async question delivery already bound');
    this.asyncDelivery = delivery;
  }

  updateAsyncQuestion(tool: ToolCallInfo): void {
    if (tool.name !== TOOL_ASK_USER_QUESTION || tool.input.replyMode !== 'user-message') return;
    const id = `async-question:${tool.id}`;
    const current = this.pending.get(id);
    const expired = tool.questionStatus === 'expired' || tool.status === 'error' || tool.status === 'blocked';
    if (current?.asyncQuestion) {
      current.asyncQuestion.tool = tool;
      if (expired || tool.resolvedAnswers) this.dismiss(id);
      return;
    }
    if (expired || tool.resolvedAnswers || !Array.isArray(tool.input.questions) || !tool.input.questions.length) return;
    const delivery = this.asyncDelivery;
    if (!delivery) throw new Error('Async question delivery is not bound');
    const question = { tool, abort: new AbortController() };
    tool.questionStatus = 'pending';
    delivery.onChange(tool);
    void this.#showInline(id, tool.input, question.abort.signal, {
      onSubmit: async answers => {
        if (question.abort.signal.aborted) throw new Error(t('chat.questions.expired'));
        await delivery.answer(question.tool, answers, question.abort.signal);
        if (!question.abort.signal.aborted) question.tool.resolvedAnswers = answers;
      },
    }, undefined, question);
  }

  /** Stop withdraws submitted answers; questions still waiting for input remain open. */
  cancelAsyncSubmissions(): void {
    for (const [id, entry] of this.pending) {
      if (entry.asyncQuestion && entry.state.submitting) this.dismiss(id);
    }
  }

  expireAsyncQuestions(): void {
    for (const [id, entry] of this.pending) {
      if (entry.asyncQuestion) this.dismiss(id);
    }
  }

  async requestApproval(
    interactionId: string,
    toolName: string,
    _input: Record<string, unknown>,
    description: string,
    approvalOptions?: InlineApprovalOptions,
    signal?: AbortSignal,
  ): Promise<ApprovalDecision> {
    const createHeader = (parentEl: HTMLElement): HTMLElement => {
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
        headerEl.createDiv({ cls: 'claudian-ask-approval-agent', text: t('chat.agent', { agent: approvalOptions.agentID }) });
      }

      const descriptionEl = headerEl.createDiv({
        cls: 'claudian-ask-approval-desc',
        text: description,
      });
      descriptionEl.setAttribute('aria-label', t('chat.approval.details', { tool: toolName }));
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

      return headerEl;
    };

    const decisionOptions = approvalOptions?.decisionOptions ?? getDefaultApprovalDecisionOptions();
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
      interactionId,
      { questions: [{ isOther: false, isSecret: false, options: questionOptions, question: t('chat.approval.question') }] },
      signal,
      { immediateSelect: true, showCustomInput: false, title: t('chat.approval.title') },
      createHeader,
    );

    if (!result) return 'cancel';
    const selected = Object.values(result)[0];
    const selectedValue = Array.isArray(selected) ? selected[0] : selected;
    if (typeof selectedValue !== 'string') {
      new Notice(t('chat.approval.unexpectedSelection', { value: String(selectedValue) }));
      return 'cancel';
    }

    return optionDecisionMap.get(selectedValue)
      ?? { type: 'select-option', value: selectedValue };
  }

  askUserQuestion(
    interactionId: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
    config?: InlineAskQuestionConfig,
  ): Promise<Record<string, string | string[]> | null> {
    return this.#showInline(
      interactionId,
      input,
      signal,
      config,
    );
  }

  get pendingCount(): number { return this.pending.size; }

  setActive(active: boolean): void {
    this.active = active;
    for (const [id, entry] of this.pending) {
      this.#mount(id, entry);
      entry.inline?.setVisible(active);
    }
    this.#syncSuppression();
  }

  detachPresentation(): void {
    for (const entry of this.pending.values()) {
      entry.inline?.disposePresentation();
      entry.inline = null;
    }
    this.#restorePresentation = undefined;
    this.#syncSuppression();
  }

  dismiss(interactionId: string): void {
    const entry = this.pending.get(interactionId);
    if (entry) this.#finish(interactionId, entry, null);
  }

  dismissAll(): void {
    for (const id of this.pending.keys()) this.dismiss(id);
  }

  #showInline(
    interactionId: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
    config?: InlineAskQuestionConfig,
    createHeader?: (parent: HTMLElement) => HTMLElement,
    asyncQuestion?: PendingPrompt['asyncQuestion'],
  ): Promise<Record<string, string | string[]> | null> {
    if (signal?.aborted) return Promise.resolve(null);
    if (this.pending.has(interactionId)) return Promise.reject(new Error(`Duplicate inline interaction: ${interactionId}`));
    const snapshot = structuredClone(input);
    return new Promise(resolve => {
      const entry: PendingPrompt = {
        input: snapshot, state: new QuestionInteractionState(), config, createHeader, resolve, signal, asyncQuestion,
        abort: () => this.#finish(interactionId, entry, null), inline: null,
      };
      entry.state.onChange = () => entry.inline?.refresh();
      this.pending.set(interactionId, entry);
      this.#publish();
      signal?.addEventListener('abort', entry.abort, { once: true });
      this.#mount(interactionId, entry);
    });
  }

  #mount(id: string, entry: PendingPrompt): void {
    if (entry.inline || entry.state.resolved) return;
    const parent = this.deps.getPromptParentEl();
    if (!parent) return;
    this.#restorePresentation = this.deps.onBeforeShow?.();
    const inline = new InlineAskUserQuestion(parent, entry.input,
      result => this.#finish(id, entry, result), undefined,
      { ...entry.config, state: entry.state, ...(entry.createHeader ? { headerEl: entry.createHeader(parent) } : {}) });
    entry.inline = inline;
    try {
      inline.render();
      inline.setVisible(this.active);
      this.#syncSuppression();
    } catch {
      inline.disposePresentation();
      entry.inline = null;
      this.#syncSuppression();
    }
  }

  #finish(id: string, entry: PendingPrompt, result: Record<string, string | string[]> | null): void {
    if (this.pending.get(id) !== entry) return;
    this.pending.delete(id);
    entry.state.resolved = true;
    entry.state.onChange = undefined;
    entry.signal?.removeEventListener('abort', entry.abort);
    entry.inline?.disposePresentation();
    entry.inline = null;
    if (entry.asyncQuestion) {
      const { tool, abort } = entry.asyncQuestion;
      abort.abort();
      tool.questionStatus = tool.resolvedAnswers ? undefined : 'expired';
      this.asyncDelivery?.onChange(tool);
    }
    this.#publish();
    this.#syncSuppression();
    if (this.pending.size === 0) this.#restorePresentation?.();
    entry.resolve(result);
  }

  #publish(): void {
    for (const listener of this.listeners) listener();
  }

  #syncSuppression(): void {
    const el = this.deps.getSuppressedEl?.();
    if (!el) return;
    if (this.active && [...this.pending.values()].some(entry => entry.inline !== null)) el.addClass('claudian-hidden');
    else el.removeClass('claudian-hidden');
  }
}
