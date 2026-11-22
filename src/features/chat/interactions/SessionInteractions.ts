import { Notice } from 'obsidian';

import type { ProviderApprovalInteractionRequest } from '@/core/execution';
import { TOOL_ASK_USER_QUESTION } from '@/core/tools/toolNames';
import type { ApprovalDecision, AskUserAnswers, ToolCallInfo } from '@/core/types';
import { askOptionValue, parseAskUserQuestions, validateAskUserAnswers } from '@/features/chat/interactions/askUserQuestions';
import { type InlineAskQuestionConfig, InlineAskUserQuestion } from '@/features/chat/interactions/InlineAskUserQuestion';
import { QuestionInteractionState } from '@/features/chat/interactions/QuestionInteractionState';
import { setToolIcon } from '@/features/chat/rendering/tools/toolContentPrimitives';
import { t } from '@/i18n/i18n';

/** What the approval prompt shows; the answer is the selected option's value. */
export type ApprovalPromptRequest = Pick<
  ProviderApprovalInteractionRequest,
  'interactionId' | 'toolName' | 'description' | 'decisionReason' | 'blockedPath' | 'decisionOptions'
>;

export interface SessionInteractionsDeps {
  /** Element that receives the inline prompt. */
  getPromptParentEl(): HTMLElement | null;
  /** Optional element hidden for the lifetime of a visible prompt. */
  getSuppressedEl?(): HTMLElement | null;
  /** Returns a restoration callback bound to the presentation being suppressed. */
  onBeforeShow?(): (() => void) | void;
  /** A request became pending, or stopped pending however it ended. */
  onPendingChanged?(interactionId: string, pending: boolean): void;
}

export interface PendingInteractionOption {
  readonly label: string;
  readonly value: string;
  readonly description?: string;
  /** What an approval option decides; absent for provider-specific options and questions. */
  readonly decision?: ApprovalDecision;
}

export interface PendingInteractionQuestion {
  readonly id?: string;
  readonly header: string;
  readonly question: string;
  readonly options: readonly PendingInteractionOption[];
  readonly multiSelect: boolean;
  /** Free-text answers are accepted. */
  readonly isOther: boolean;
  readonly isSecret: boolean;
}

/** A pending request as plain data, exactly as the prompt shows it. */
export interface PendingInteractionSnapshot {
  readonly interactionId: string;
  readonly kind: 'approval' | 'question';
  readonly toolName?: string;
  readonly description?: string;
  readonly decisionReason?: string;
  readonly blockedPath?: string;
  readonly questions: readonly PendingInteractionQuestion[];
}

interface AsyncQuestionDelivery {
  answer(tool: ToolCallInfo, answers: AskUserAnswers, signal: AbortSignal): Promise<void>;
  onChange(tool: ToolCallInfo): void;
}

/** What a pending prompt asks for; each kind carries only its own data. */
type PendingPromptKind =
  | { readonly kind: 'question' }
  | { readonly kind: 'async-question'; readonly asyncQuestion: { tool: ToolCallInfo; readonly abort: AbortController } }
  | { readonly kind: 'approval'; readonly approval: ApprovalPromptRequest };

type InlinePromptOptions = PendingPromptKind & {
  readonly input: Record<string, unknown>;
  readonly signal?: AbortSignal;
  readonly config?: InlineAskQuestionConfig;
};

type PendingPrompt = InlinePromptOptions & {
  readonly state: QuestionInteractionState;
  readonly resolve: (answers: Record<string, string | string[]> | null) => void;
  readonly abort: () => void;
  inline: InlineAskUserQuestion | null;
};

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
    if (current?.kind === 'async-question') {
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
    void this.#showInline(id, {
      kind: 'async-question',
      asyncQuestion: question,
      input: tool.input,
      signal: question.abort.signal,
      config: {
        onSubmit: async answers => {
          if (question.abort.signal.aborted) throw new Error(t('chat.questions.expired'));
          await delivery.answer(question.tool, answers, question.abort.signal);
          if (!question.abort.signal.aborted) question.tool.resolvedAnswers = answers;
        },
      },
    });
  }

  /** Stop withdraws submitted answers; questions still waiting for input remain open. */
  cancelAsyncSubmissions(): void {
    for (const [id, entry] of this.pending) {
      if (entry.kind === 'async-question' && entry.state.submitting) this.dismiss(id);
    }
  }

  expireAsyncQuestions(): void {
    for (const [id, entry] of this.pending) {
      if (entry.kind === 'async-question') this.dismiss(id);
    }
  }

  /** Resolves with the selected option's value, or null when the prompt is dismissed. */
  async requestApproval(request: ApprovalPromptRequest, signal?: AbortSignal): Promise<string | null> {
    const result = await this.#showInline(request.interactionId, {
      kind: 'approval',
      approval: request,
      input: { questions: [{
        isOther: false,
        isSecret: false,
        options: request.decisionOptions.map(option => ({
          description: option.description ?? '',
          label: option.label,
          value: option.value,
        })),
        question: t('chat.approval.question'),
      }] },
      signal,
      config: { immediateSelect: true, showCustomInput: false, title: t('chat.approval.title') },
    });

    if (!result) return null;
    const selected = Object.values(result)[0];
    const selectedValue = Array.isArray(selected) ? selected[0] : selected;
    if (typeof selectedValue !== 'string') {
      new Notice(t('chat.approval.unexpectedSelection', { value: String(selectedValue) }));
      return null;
    }
    return selectedValue;
  }

  askUserQuestion(
    interactionId: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
    config?: InlineAskQuestionConfig,
  ): Promise<Record<string, string | string[]> | null> {
    return this.#showInline(interactionId, { kind: 'question', input, signal, config });
  }

  get pendingCount(): number { return this.pending.size; }

  /** Pending requests in arrival order, including ones no presentation shows. */
  listPending(): PendingInteractionSnapshot[] {
    return [...this.pending].map(([interactionId, entry]) => snapshotPending(interactionId, entry));
  }

  /**
   * Answers a pending request as its prompt would. Rejects answers the prompt could not submit; an
   * async question resolves only after its answer is delivered and rejects when delivery fails.
   */
  async answer(interactionId: string, answers: AskUserAnswers): Promise<void> {
    const entry = this.pending.get(interactionId);
    if (!entry?.state.acceptsAnswer) {
      throw new Error(`Interaction "${interactionId}" is not awaiting an answer`);
    }
    const error = validateAskUserAnswers(parseAskUserQuestions(entry.input), answers, entry.config?.showCustomInput !== false);
    if (error) throw new Error(error);
    const result = structuredClone(answers);
    const submit = entry.config?.onSubmit;
    if (submit) {
      entry.state.beginSubmit();
      entry.state.onChange?.();
      try {
        await submit(result);
      } catch (submitError) {
        if (entry.state.failSubmit(submitError instanceof Error ? submitError.message : t('chat.questions.sendFailed'))) {
          entry.state.onChange?.();
        }
        throw submitError;
      }
    }
    this.#finish(interactionId, entry, result);
  }

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
    options: InlinePromptOptions,
  ): Promise<Record<string, string | string[]> | null> {
    const { signal } = options;
    if (signal?.aborted) return Promise.resolve(null);
    if (this.pending.has(interactionId)) return Promise.reject(new Error(`Duplicate inline interaction: ${interactionId}`));
    const input = structuredClone(options.input);
    return new Promise(resolve => {
      const entry: PendingPrompt = {
        ...options, input, state: new QuestionInteractionState(), resolve,
        abort: () => this.#finish(interactionId, entry, null), inline: null,
      };
      entry.state.onChange = () => entry.inline?.refresh();
      this.pending.set(interactionId, entry);
      this.#publish();
      this.deps.onPendingChanged?.(interactionId, true);
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
      { ...entry.config, state: entry.state, ...(entry.kind === 'approval' ? { headerEl: createApprovalHeader(parent, entry.approval) } : {}) });
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
    entry.state.resolve();
    entry.state.onChange = undefined;
    entry.signal?.removeEventListener('abort', entry.abort);
    entry.inline?.disposePresentation();
    entry.inline = null;
    if (entry.kind === 'async-question') {
      const { tool, abort } = entry.asyncQuestion;
      abort.abort();
      tool.questionStatus = tool.resolvedAnswers ? undefined : 'expired';
      this.asyncDelivery?.onChange(tool);
    }
    this.#publish();
    this.deps.onPendingChanged?.(id, false);
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

function createApprovalHeader(parentEl: HTMLElement, request: ApprovalPromptRequest): HTMLElement {
  const { toolName } = request;
  const headerEl = parentEl.createDiv({ cls: 'claudian-ask-approval-info' });
  headerEl.remove();

  const toolEl = headerEl.createDiv({ cls: 'claudian-ask-approval-tool' });
  const iconEl = toolEl.createSpan({ cls: 'claudian-ask-approval-icon' });
  iconEl.setAttribute('aria-hidden', 'true');
  setToolIcon(iconEl, toolName);
  toolEl.createSpan({ cls: 'claudian-ask-approval-tool-name', text: toolName });

  if (request.decisionReason) {
    headerEl.createDiv({ cls: 'claudian-ask-approval-reason', text: request.decisionReason });
  }
  if (request.blockedPath) {
    headerEl.createDiv({ cls: 'claudian-ask-approval-blocked-path', text: request.blockedPath });
  }

  const descriptionEl = headerEl.createDiv({
    cls: 'claudian-ask-approval-desc',
    text: request.description,
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
}

function snapshotPending(interactionId: string, entry: PendingPrompt): PendingInteractionSnapshot {
  const approval = entry.kind === 'approval' ? entry.approval : undefined;
  const questions = parseAskUserQuestions(entry.input).map((question): PendingInteractionQuestion => ({
    ...(question.id !== undefined ? { id: question.id } : {}),
    header: question.header,
    question: question.question,
    options: question.options.map((option): PendingInteractionOption => {
      const value = askOptionValue(option);
      const decision = approval?.decisionOptions.find(candidate => candidate.value === value)?.decision;
      return { label: option.label, value, description: option.description, ...(decision ? { decision } : {}) };
    }),
    multiSelect: question.multiSelect,
    isOther: question.isOther === true && entry.config?.showCustomInput !== false,
    isSecret: question.isSecret === true,
  }));
  if (!approval) return { interactionId, kind: 'question', questions };
  return {
    interactionId,
    kind: 'approval',
    toolName: approval.toolName,
    description: approval.description,
    ...(approval.decisionReason ? { decisionReason: approval.decisionReason } : {}),
    ...(approval.blockedPath ? { blockedPath: approval.blockedPath } : {}),
    questions,
  };
}
