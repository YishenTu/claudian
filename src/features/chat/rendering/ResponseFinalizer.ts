import type { ChatMessage } from '@/core/types';
import { setupDisclosureButton } from '@/features/chat/rendering/collapsible';
import {
  appendInterruptLabel,
  formatWorkDuration,
  getResponseElementKind,
  getResponseLayout,
  markResponseElement,
} from '@/features/chat/rendering/ResponseLayout';
import { t } from '@/i18n/i18n';

// Disclosure ids stay unique across every renderer sharing the document.
let nextHistoryId = 0;

/**
 * Folds a completed response's work into a "Worked" disclosure, an interrupted
 * response entirely into an "Interrupted" one, and renders
 * task notifications as disclosures; each response collapses at most once.
 */
export class ResponseFinalizer {
  readonly #collapsedResponses = new WeakSet<HTMLElement>();

  constructor(
    private readonly findMessageEl: (id: string) => HTMLElement | null,
    private readonly renderContent: (el: HTMLElement, markdown: string) => Promise<void>,
  ) {}

  /**
   * Reparents completed output without replacing live tool or Markdown elements.
   * Returns the answer the response toolbar acts on (null for an interrupted
   * response, which has none), or null when the response was already collapsed.
   */
  finalize(
    msgEl: HTMLElement,
    contentEl: HTMLElement,
    msg: ChatMessage,
    messages: ChatMessage[],
    collapse: boolean,
    index?: number,
  ): { answer: string | null } | null {
    if (this.#collapsedResponses.has(msgEl)) return null;

    const { blocks, finalText, canCollapse, interrupted, automaticTurn, notificationPredecessor,
      automaticNotification, earlierMessages, hasContinuation, finalBlockCount } = getResponseLayout(msg, messages, collapse, index);
    const precedingNotificationHistory = notificationPredecessor
      ? this.findMessageEl(notificationPredecessor.id)?.querySelector<HTMLElement>(
        '.claudian-task-notification .claudian-work-history',
      ) ?? null : null;
    if (automaticNotification && canCollapse) {
      let history: HTMLElement | null = precedingNotificationHistory;
      for (const child of Array.from(contentEl.children) as HTMLElement[]) {
        if (getResponseElementKind(child) === 'notification') {
          history = child.querySelector<HTMLElement>('.claudian-work-history');
        } else if (history && getResponseElementKind(child) !== 'text'
          && getResponseElementKind(child) !== 'citations') {
          history.appendChild(child);
        }
      }
    }
    if (interrupted || (canCollapse && !automaticNotification)) {
      // Keep the disclosure at the start of its response and fold consumed
      // notifications with the work around them, preserving transcript order.
      const workContentEl = hasContinuation && earlierMessages.length
        ? this.findMessageEl(earlierMessages[0].id)?.querySelector<HTMLElement>('.claudian-message-content') ?? contentEl : contentEl;
      const earlierEls = earlierMessages.flatMap(message => {
        const el = this.findMessageEl(message.id);
        if (!el) return [];
        const previousContent = el.querySelector<HTMLElement>('.claudian-message-content');
        return previousContent === workContentEl ? Array.from(previousContent.children) as HTMLElement[] : [el];
      });
      const children = Array.from(contentEl.children) as HTMLElement[];
      // An interrupted turn has no answer; its partial text and indicator fold too.
      const textEls = interrupted ? [] : children.filter(child => getResponseElementKind(child) === 'text'
        || getResponseElementKind(child) === 'citations');
      const answerEls = new Set(textEls.slice(-finalBlockCount));
      // Fallback tool calls can follow the answer in the DOM without belonging to the answer.
      let folded = [...earlierEls, ...children.filter(child => !answerEls.has(child))];
      // An automatic turn's triggering notification stays outside its fold, like a prompt.
      if (automaticTurn) {
        const trigger = folded.findIndex(el => el.parentElement !== workContentEl || getResponseElementKind(el) !== 'notification');
        folded = folded.slice(trigger < 0 ? folded.length : trigger);
      }
      // A lone indicator stays visible, as a replayed marker without output does.
      const hasWork = interrupted
        ? folded.some(el => getResponseElementKind(el) !== 'interrupt')
        : folded.length > 0 || msg.durationSeconds !== undefined;
      if (hasWork) {
        this.#collapsedResponses.add(msgEl);
        const wrapper = workContentEl.createDiv({
          cls: 'claudian-work', attr: { 'data-work-message-id': msg.id },
        });
        workContentEl.insertBefore(wrapper, automaticTurn
          ? folded.find(el => el.parentElement === workContentEl) ?? null : workContentEl.firstChild);
        // An interrupted turn's header is its interrupt indicator, which the body no longer repeats.
        const label = interrupted ? appendInterruptLabel
          : msg.durationSeconds === undefined ? t('chat.worked')
            : t('chat.zen.workedFor', { duration: formatWorkDuration(msg.durationSeconds) });
        const history = this.#createDisclosure(wrapper, 'claudian-work-history', label);
        for (const el of folded) {
          if (getResponseElementKind(el) === 'interrupt') el.remove();
          else history.appendChild(el);
        }
      }
    }

    if (interrupted) return { answer: null };
    return { answer: canCollapse ? finalText
      : blocks.filter(block => block.type === 'text').map(block => block.content).join('\n\n') || msg.content };
  }

  /** A collapsed notification whose Markdown renders on first expansion. */
  renderTaskNotification(contentEl: HTMLElement, content: string): void {
    const wrapper = markResponseElement(contentEl.createDiv({ cls: 'claudian-task-notification' }), 'notification');
    const history = this.#createDisclosure(wrapper, 'claudian-task-notification', t('chat.taskNotification'), () => {
      void this.renderContent(body, content);
    });
    const body = history.createDiv({ text: content });
  }

  #createDisclosure(
    wrapper: HTMLElement,
    idPrefix: string,
    label: string | ((header: HTMLElement) => void),
    onFirstExpand?: () => void,
  ): HTMLElement {
    const header = wrapper.createEl('button', { cls: 'claudian-work-header' });
    if (typeof label === 'string') header.setText(label);
    else label(header);
    const history = wrapper.createDiv({
      cls: 'claudian-work-history', attr: { id: `${idPrefix}-${nextHistoryId++}` },
    });
    setupDisclosureButton(header, history, { onFirstExpand });
    return history;
  }
}
