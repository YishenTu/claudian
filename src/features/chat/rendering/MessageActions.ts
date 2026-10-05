import { Menu, Notice, setIcon } from 'obsidian';

import type { ChatRewindMode } from '@/core/execution';
import type { ProviderCapabilities } from '@/core/providers/types';
import type { ChatMessage } from '@/core/types';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import { findRewindContext } from '@/features/chat/conversation/rewind';
import { getResponseElementKind } from '@/features/chat/rendering/ResponseLayout';
import { formatConversationDirectoryTitle } from '@/features/chat/utils/conversationDirectoryTitle';
import { t } from '@/i18n/i18n';
import { bindCopyFeedback } from '@/shared/components/CopyableCodeFence';

export interface MessageActionCallbacks {
  rewind?: (messageId: string, mode?: ChatRewindMode) => Promise<void>;
  fork?: (messageId: string) => Promise<void>;
  branches?: {
    navigate(messageId: string, branchMessageId?: string): Promise<void>;
    isBusy(): boolean;
  };
}

function runAction(action: () => Promise<void>): void {
  void action().catch(() => {
    // UI actions already surface expected failures locally.
  });
}

/** Rounds to tenths before splitting so 119.96s reads "2m 0s", not "1m 60s". */
function formatTurnDuration(durationMs: number): string {
  const tenths = Math.round(durationMs / 100);
  const seconds = `${(tenths % 600) / 10}s`;
  return tenths < 600 ? seconds : `${Math.floor(tenths / 600)}m ${seconds}`;
}

/**
 * Owns each message's action toolbar: copy, rewind, fork and branch controls,
 * timestamps and the table-of-contents title, plus the live user messages whose
 * rewind and branch actions still await their saved identity.
 */
export class MessageActions {
  readonly #pendingLiveMessages = new Map<string, HTMLElement>();

  constructor(
    private readonly plugin: Pick<ChatFeatureHost, 'settings'>,
    private readonly messagesEl: HTMLElement,
    private readonly getCapabilities: () => ProviderCapabilities,
    private readonly callbacks: MessageActionCallbacks,
  ) {}

  /** Image-only prompts keep a bubble only when it can carry branch controls. */
  get branchesEnabled(): boolean {
    return !!this.callbacks.branches && !!this.getCapabilities().supportsConversationBranches;
  }

  /** A full-session fork is offered only on the latest response. */
  retireFullSessionForks(): void {
    if (this.getCapabilities().forkMode === 'full-session') {
      this.messagesEl.querySelectorAll('.claudian-message-fork-btn').forEach(button => button.remove());
    }
  }

  /**
   * Adds a user prompt's toolbar. Live prompts wait for their saved identity
   * (see `refreshActionButtons`); replayed prompts get rewind immediately.
   */
  decorateUserMessage(
    msgEl: HTMLElement,
    msg: ChatMessage,
    text: string,
    replay?: { allMessages?: ChatMessage[]; index?: number },
  ): void {
    if (text) {
      this.#addUserCopyButton(msgEl, text);
      this.applyTocTitle(msgEl, text);
    }
    if (!replay) {
      if (this.callbacks.rewind || this.callbacks.fork || this.callbacks.branches) {
        this.#pendingLiveMessages.set(msg.id, msgEl);
      }
      this.#addBranchButtons(msgEl, msg, true);
    } else {
      this.#addBranchButtons(msgEl, msg);
      const { allMessages, index } = replay;
      if (msg.userMessageId && this.callbacks.rewind && allMessages && index !== undefined
        && findRewindContext(allMessages, index).hasResponse) {
        this.#addRewindButton(msgEl, msg.id);
      }
    }
    this.appendTimestamp(msgEl, msg.timestamp);
  }

  /** The response toolbar copies the final answer, leaving per-block copy inside history. */
  decorateResponse(
    msgEl: HTMLElement,
    contentEl: HTMLElement,
    msg: ChatMessage,
    messages: ChatMessage[],
    copyText: string,
  ): void {
    const toolbar = this.#getOrCreateToolbar(msgEl);
    toolbar.empty();
    for (const child of Array.from(contentEl.children)) {
      if (getResponseElementKind(child as HTMLElement) === 'text') {
        child.querySelector('.claudian-text-copy-btn')?.remove();
      }
    }
    if (copyText.trim()) this.addTextCopyButton(toolbar, copyText);
    if (this.callbacks.fork && msg.assistantMessageId
      && (this.getCapabilities().forkMode !== 'full-session' || messages.at(-1)?.id === msg.id)) {
      this.#addForkButton(msgEl, msg.id);
    }
    const stats = msg.turnStats;
    if (msg.role === 'assistant' && !msg.isInterrupt && stats && this.getCapabilities().supportsResponseThroughput) {
      const rate = (stats.outputTokens / (stats.durationMs / 1000)).toFixed(1);
      // Obsidian renders aria-label as its tooltip; a title would duplicate it.
      toolbar.createSpan({
        cls: 'claudian-response-throughput', text: `${rate} tok/s`,
        attr: { 'aria-label': `${stats.outputTokens.toLocaleString()} tokens · ${formatTurnDuration(stats.durationMs)}` },
      });
    }
    this.appendTimestamp(msgEl, msg.role === 'user' ? msg.timestamp : msg.completedAt);
  }

  appendTimestamp(msgEl: HTMLElement, timestampMs: number | undefined): void {
    if (timestampMs === undefined) return;
    msgEl.setAttribute('data-message-timestamp', String(timestampMs));
    const toolbar = this.#getOrCreateToolbar(msgEl);
    toolbar.querySelector<HTMLElement>('.claudian-message-timestamp')?.remove();
    if (this.plugin.settings?.showMessageTimestamps !== true) {
      return;
    }

    const timestampEl = toolbar.createDiv({ cls: 'claudian-message-timestamp' });
    const timestamp = new Date(timestampMs);
    const label = timestamp.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    timestampEl.setText(label);
    timestampEl.setAttribute('aria-label', timestamp.toLocaleString(undefined, { hourCycle: 'h23' }));
  }

  refreshTimestamps(): void {
    for (const msgEl of this.messagesEl.querySelectorAll<HTMLElement>('[data-message-timestamp]')) {
      this.appendTimestamp(msgEl, Number(msgEl.getAttribute('data-message-timestamp')));
    }
  }

  applyTocTitle(msgEl: HTMLElement, text: string): void {
    const tocTitle = formatConversationDirectoryTitle(text);
    if (tocTitle) {
      msgEl.setAttribute('data-toc-title', tocTitle);
    } else {
      msgEl.removeAttribute('data-toc-title');
    }
  }

  /** Adds a copy button that copies `markdown` and briefly shows "Copied!". */
  addTextCopyButton(textEl: HTMLElement, markdown: string): void {
    const copyBtn = textEl.createEl('button', {
      cls: 'claudian-text-copy-btn',
      attr: {
        'aria-label': 'Copy message',
        type: 'button',
      },
    });
    setIcon(copyBtn, 'copy');
    this.#bindCopy(copyBtn, markdown);
  }

  /** Adds rewind once a live prompt's response makes it eligible. */
  refreshActionButtons(msg: ChatMessage, allMessages?: ChatMessage[], index?: number): void {
    this.refreshBranchButtons([msg]);
    if (!msg.userMessageId || !allMessages || index === undefined
      || !findRewindContext(allMessages, index).hasResponse) return;
    const msgEl = this.#pendingLiveMessages.get(msg.id);
    if (!msgEl) return;
    if (this.callbacks.rewind && !msgEl.querySelector('.claudian-message-rewind-btn')) {
      this.#addRewindButton(msgEl, msg.id);
    }
    this.#pendingLiveMessages.delete(msg.id);
  }

  refreshBranchButtons(messages: readonly ChatMessage[]): void {
    if (!this.branchesEnabled) return;
    const elements = new Map(Array.from(this.messagesEl.querySelectorAll<HTMLElement>('[data-message-id]'))
      .map(element => [element.dataset.messageId, element]));
    for (const message of messages) {
      const element = this.#pendingLiveMessages.get(message.id) ?? elements.get(message.id);
      if (element) this.#addBranchButtons(element, message, this.#pendingLiveMessages.has(message.id));
    }
    this.refreshBranchButtonState();
  }

  refreshBranchButtonState(): void {
    this.messagesEl.querySelectorAll<HTMLButtonElement>('[data-branch-action]').forEach(button => {
      this.#updateBranchButtonState(button);
    });
  }

  /** Drops a removed message's pending live actions. */
  forget(messageId: string): void {
    this.#pendingLiveMessages.delete(messageId);
  }

  clear(): void {
    this.#pendingLiveMessages.clear();
  }

  #bindCopy(copyBtn: HTMLElement, text: string): void {
    copyBtn.addEventListener('click', event => event.stopPropagation());
    bindCopyFeedback(
      copyBtn,
      () => text,
      () => {
        copyBtn.empty();
        copyBtn.setText('Copied!');
        copyBtn.classList.add('copied');
      },
      () => {
        copyBtn.empty();
        setIcon(copyBtn, 'copy');
        copyBtn.classList.remove('copied');
      },
    );
  }

  #updateBranchButtonState(button: HTMLButtonElement): void {
    const busy = !!this.callbacks.branches?.isBusy();
    const unavailable = button.dataset.branchUnavailable === 'true';
    button.disabled = busy || unavailable;
    // Obsidian uses aria-label for its tooltip; title would add a second one.
    button.setAttribute('aria-description', busy ? 'Wait for the current response to finish.'
      : unavailable ? button.dataset.branchUnavailableReason ?? '' : '');
  }

  #addBranchButtons(element: HTMLElement, message: ChatMessage, pendingNativeIdentity = false): void {
    const branchActions = this.callbacks.branches;
    if (!branchActions || !this.getCapabilities().supportsConversationBranches
      || message.role !== 'user' || (!message.treeBranches && !pendingNativeIdentity)) return;
    element.querySelectorAll('[data-branch-action], .claudian-branch-position, .claudian-branch-marker').forEach(child => child.remove());
    element.classList.remove('claudian-message-branched');
    const toolbar = this.#getOrCreateToolbar(element);
    if (element === this.messagesEl.querySelector('[data-role="user"]')) return;
    const anchor = toolbar.querySelector('.claudian-user-msg-copy-btn, .claudian-message-timestamp');
    const addButton = (label: string, icon: string, target?: string, unavailable = false, reason = '') => {
      const button = toolbar.createEl('button', {
        attr: { type: 'button', 'aria-label': label, 'data-branch-action': 'true', 'data-branch-unavailable': String(unavailable), 'data-branch-unavailable-reason': reason },
      });
      toolbar.insertBefore(button, anchor);
      setIcon(button, icon);
      this.#updateBranchButtonState(button);
      button.addEventListener('click', event => {
        event.stopPropagation();
        if (branchActions.isBusy() || unavailable) return;
        runAction(() => branchActions.navigate(message.id, target));
      });
    };
    const branches = message.treeBranches ?? [];
    const index = message.userMessageId ? branches.indexOf(message.userMessageId) : -1;
    if (branches.length > 1 && index >= 0) {
      element.classList.add('claudian-message-branched');
      const marker = element.querySelector('.claudian-message-content')?.createSpan({
        cls: 'claudian-branch-marker', attr: { 'aria-hidden': 'true' },
      });
      if (marker) setIcon(marker, 'git-branch');
      addButton('Previous branch', 'chevron-left', branches[index - 1], index === 0, 'No previous branch.');
      const position = toolbar.createSpan({ cls: 'claudian-branch-position', text: `${index + 1}/${branches.length}`,
        attr: { 'aria-label': `Branch ${index + 1} of ${branches.length}` } });
      toolbar.insertBefore(position, anchor);
      addButton('Next branch', 'chevron-right', branches[index + 1], index === branches.length - 1, 'No next branch.');
    }
    addButton('Branch from this prompt', 'git-branch', undefined, !message.userMessageId,
      'Branching is available after this prompt is saved.');
  }

  #getOrCreateToolbar(msgEl: HTMLElement): HTMLElement {
    const existing = Array.from(msgEl.children).find(child => child.classList.contains('claudian-user-msg-actions')) as HTMLElement | undefined;
    if (existing) return existing;
    return msgEl.createDiv({ cls: 'claudian-user-msg-actions claudian-message-actions' });
  }

  #addUserCopyButton(msgEl: HTMLElement, content: string): void {
    const toolbar = this.#getOrCreateToolbar(msgEl);
    const copyBtn = toolbar.createEl('button', {
      cls: 'claudian-user-msg-copy-btn',
      attr: { type: 'button' },
    });
    setIcon(copyBtn, 'copy');
    copyBtn.setAttribute('aria-label', 'Copy message');
    this.#bindCopy(copyBtn, content);
  }

  #addRewindButton(msgEl: HTMLElement, messageId: string): void {
    if (!this.getCapabilities().supportsRewind) return;
    const toolbar = this.#getOrCreateToolbar(msgEl);
    const btn = toolbar.createEl('button', {
      cls: 'claudian-message-rewind-btn',
      attr: { type: 'button' },
    });
    if (toolbar.firstChild !== btn) toolbar.insertBefore(btn, toolbar.firstChild);
    setIcon(btn, 'rotate-ccw');
    btn.setAttribute('aria-label', t('chat.rewind.ariaLabel'));
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.#showRewindMenu(e, messageId, btn);
    });
  }

  #showRewindMenu(
    event: MouseEvent,
    messageId: string,
    anchor: HTMLButtonElement,
  ): void {
    const menu = new Menu();
    this.#addRewindMenuItem(menu, messageId, 'conversation');
    this.#addRewindMenuItem(menu, messageId, 'code-and-conversation');
    if (event.detail > 0) {
      menu.showAtMouseEvent(event);
      return;
    }
    const rect = anchor.getBoundingClientRect();
    menu.showAtPosition({ x: rect.left, y: rect.bottom }, anchor.ownerDocument);
  }

  #addRewindMenuItem(menu: Menu, messageId: string, mode: ChatRewindMode): void {
    menu.addItem((item) => {
      item
        .setTitle(
          mode === 'conversation'
            ? t('chat.rewind.menuConversationOnly')
            : t('chat.rewind.menuCodeAndConversation')
        )
        .setIcon(mode === 'conversation' ? 'message-square' : 'rotate-ccw')
        .onClick(() => {
          runAction(async () => {
            try {
              await this.callbacks.rewind?.(messageId, mode);
            } catch (err) {
              new Notice(t('chat.rewind.failed', { error: err instanceof Error ? err.message : 'Unknown error' }));
            }
          });
        });
    });
  }

  #addForkButton(msgEl: HTMLElement, messageId: string): void {
    if (!this.getCapabilities().supportsFork) return;
    const toolbar = this.#getOrCreateToolbar(msgEl);
    const btn = toolbar.createEl('button', {
      cls: 'claudian-message-fork-btn',
      attr: { type: 'button' },
    });
    setIcon(btn, 'git-fork');
    btn.setAttribute('aria-label', t('chat.fork.ariaLabel'));
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      runAction(async () => {
        try {
          await this.callbacks.fork?.(messageId);
        } catch (err) {
          new Notice(t('chat.fork.failed', { error: err instanceof Error ? err.message : 'Unknown error' }));
        }
      });
    });
  }
}
