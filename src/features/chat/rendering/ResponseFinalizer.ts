import type { ChatMessage } from '@/core/types';
import { setupDisclosureButton } from '@/features/chat/rendering/collapsible';
import {
  appendInterruptLabel,
  formatWorkDuration,
  getResponseElementKind,
  getResponseLayout,
  getStopHookElapsedSeconds,
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

    const { blocks, answer, canCollapse, interrupted, automaticTurn, notificationPredecessor,
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
        const previousChildren = previousContent ? Array.from(previousContent.children) as HTMLElement[] : [];
        // A Stop hook inside an earlier message splits the turn there, keeping that message's reply in place.
        return previousContent === workContentEl
          || (!interrupted && previousChildren.some(child => getResponseElementKind(child) === 'hook'))
          ? previousChildren : [el];
      });
      const children = Array.from(contentEl.children) as HTMLElement[];
      // An interrupted turn has no answer; its partial text and indicator fold too.
      const textEls = interrupted ? [] : children.filter(child => isAnswerElement(child));
      const answerEls = new Set(textEls.slice(-finalBlockCount));
      if (interrupted) {
        // Fallback tool calls can follow the answer in the DOM without belonging to the answer.
        let folded = [...earlierEls, ...children.filter(child => !answerEls.has(child))];
        // An automatic turn's triggering notification stays outside its fold, like a prompt.
        if (automaticTurn) {
          const trigger = folded.findIndex(el => el.parentElement !== workContentEl || getResponseElementKind(el) !== 'notification');
          folded = folded.slice(trigger < 0 ? folded.length : trigger);
        }
        // A lone indicator stays visible, as a replayed marker without output does.
        if (folded.some(el => getResponseElementKind(el) !== 'interrupt')) {
          this.#collapsedResponses.add(msgEl);
          const before = automaticTurn ? folded.find(el => el.parentElement === workContentEl) ?? null : workContentEl.firstChild;
          this.#fold(msg, workContentEl, before, folded, appendInterruptLabel);
        }
      } else {
        const segments = splitAtStopHooks([...earlierEls, ...children], msg.durationSeconds);
        segments.forEach((segment, index) => {
          // A reply that ended the turn before a Stop hook stays visible, as the final answer does.
          const answers = segment.next ? trailingAnswers(segment.els) : answerEls;
          const folded = segment.els.filter(el => !answers.has(el));
          if (folded.length === 0 && segment.durationSeconds === undefined) return;
          this.#collapsedResponses.add(msgEl);
          const label = segment.durationSeconds === undefined ? t('chat.worked')
            : t('chat.zen.workedFor', { duration: formatWorkDuration(segment.durationSeconds) });
          // Work after a Stop hook folds right after it; the first segment's work folds before its reply,
          // which can sit in an earlier message than the final answer.
          const before = segment.hook ? segment.hook.nextSibling
            : segments.length > 1 ? segment.els.find(el => answers.has(el)) ?? segments[1].hook! : workContentEl.firstChild;
          const parent = segment.hook?.parentElement
            ?? (segments.length > 1 && before ? before.parentElement! : workContentEl);
          this.#fold(msg, parent, before, folded, label);
        });
      }
    }

    if (interrupted) return { answer: null };
    return { answer: canCollapse ? answer
      : blocks.filter(block => block.type === 'text').map(block => block.content).join('\n\n') || msg.content };
  }

  /** Moves elements into a collapsed disclosure placed before `before` in `parent`. */
  #fold(
    msg: ChatMessage,
    parent: HTMLElement,
    before: Node | null,
    folded: readonly HTMLElement[],
    label: string | ((header: HTMLElement) => void),
  ): void {
    const wrapper = parent.createDiv({ cls: 'claudian-work', attr: { 'data-work-message-id': msg.id } });
    parent.insertBefore(wrapper, before);
    const history = this.#createDisclosure(wrapper, 'claudian-work-history', label);
    for (const el of folded) {
      // An interrupted turn's header is its interrupt indicator, which the body no longer repeats.
      if (getResponseElementKind(el) === 'interrupt') el.remove();
      else history.appendChild(el);
    }
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

function isAnswerElement(element: HTMLElement): boolean {
  const kind = getResponseElementKind(element);
  return kind === 'text' || kind === 'citations';
}

/** The text run ending a segment: the reply that ended the turn there. */
function trailingAnswers(elements: readonly HTMLElement[]): Set<HTMLElement> {
  let start = elements.length;
  while (start > 0 && isAnswerElement(elements[start - 1])) start--;
  return new Set(elements.slice(start));
}

interface WorkSegment {
  /** The Stop hook this segment's work followed; absent for the first segment. */
  readonly hook?: HTMLElement;
  readonly els: HTMLElement[];
  /** Whether a later Stop hook ends this segment. */
  next: boolean;
  durationSeconds?: number;
}

/**
 * Splits a completed turn's elements at each Stop hook, which stays visible between the
 * segments. Each segment's time runs from the previous hook (or the turn's start) to its
 * own end; it is unknown when the turn's duration or a bounding hook's time is.
 */
function splitAtStopHooks(elements: readonly HTMLElement[], totalSeconds: number | undefined): WorkSegment[] {
  const segments: WorkSegment[] = [{ els: [], next: false }];
  const bounds: Array<number | undefined> = [0];
  for (const el of elements) {
    if (getResponseElementKind(el) !== 'hook') {
      segments[segments.length - 1].els.push(el);
      continue;
    }
    segments[segments.length - 1].next = true;
    segments.push({ hook: el, els: [], next: false });
    bounds.push(getStopHookElapsedSeconds(el));
  }
  bounds.push(totalSeconds);
  segments.forEach((segment, index) => {
    const start = bounds[index];
    const end = bounds[index + 1];
    if (start !== undefined && end !== undefined) segment.durationSeconds = Math.max(0, end - start);
  });
  return segments;
}
