import { Notice } from 'obsidian';

import type { ConversationBranchResult } from '@/core/execution';
import { extractUserDisplayContent } from '@/core/prompt/promptContext';
import type { ChatMessage } from '@/core/types';
import type { ComposerDraft, ComposerDraftController } from '@/features/chat/composer/ComposerDraftController';
import type { ChatExecutionCoordinator } from '@/features/chat/execution/ChatExecutionCoordinator';
import type { MessageRenderer } from '@/features/chat/rendering/MessageRenderer';
import type { ChatState } from '@/features/chat/state/ChatState';
import type { TabSession } from '@/features/chat/tabs/TabSession';

export interface ConversationBranchingDeps {
  state: ChatState;
  setRewinding(value: boolean): void;
  renderer: Pick<MessageRenderer, 'refreshBranchButtons' | 'refreshBranchButtonState'>;
  drafts: Pick<ComposerDraftController, 'destination' | 'capture' | 'restore'>;
  session: Pick<TabSession, 'canNavigateConversation' | 'runConversationNavigation'>;
  getMessagesEl: () => HTMLElement;
  getExecutionCoordinator: () => ChatExecutionCoordinator | null;
  ensureExecutionInitialized?: () => Promise<boolean>;
  getSelectedModel?: () => string | null;
  isDisposed?: () => boolean;
  /** Persists the current conversation state. */
  save: () => Promise<void>;
  /** Replaces the rendered transcript, optionally resyncing welcome visibility to the state. */
  renderTranscript: (messages: ChatMessage[], syncWelcomeVisibility: boolean) => void;
}

type BranchDraft = { conversationId: string; message: ChatMessage; previousDraft: ComposerDraft; scrollTop: number };
type BranchState =
  | { kind: 'idle' }
  | { kind: 'preview'; draft: BranchDraft }
  | { kind: 'committing'; draft?: BranchDraft }
  | { kind: 'recovery'; draft?: BranchDraft };

/**
 * Sole owner of the tab's conversation-branch state. Editing an earlier prompt previews the
 * transcript before it and holds the prompt as a draft; the next main turn commits that draft
 * as a provider branch. A branch whose persistence is uncertain stays in recovery and later
 * attempts reconcile instead of replaying the navigation.
 */
export class ConversationBranching {
  #state: BranchState = { kind: 'idle' };

  constructor(private readonly deps: ConversationBranchingDeps) {}

  get hasDraft(): boolean {
    return this.#state.kind !== 'idle';
  }

  /** Forgets branch state when the tab loads another conversation or a new chat. */
  reset(): void {
    this.#state = { kind: 'idle' };
  }

  async navigate(messageId: string, branchMessageId?: string): Promise<void> {
    const { state, drafts, session: navigation } = this.deps;
    if (drafts.destination !== 'main') {
      new Notice('Collapse side chat before changing conversation branches.');
      return;
    }
    if (!navigation.canNavigateConversation) return;
    if (this.#state.kind === 'recovery') {
      await navigation.runConversationNavigation(signal => this.#changeBranch(undefined, undefined, signal));
      return;
    }
    const messages = state.messages;
    const message = messages.find(item => item.id === messageId);
    const conversationId = state.currentConversationId;
    if (!conversationId || !message || message.role !== 'user' || message.isInterrupt || message.isRebuiltContext) return;
    if (messages.find(item => item.role === 'user' && !item.isInterrupt && !item.isRebuiltContext) === message) return;
    if (!message.userMessageId) {
      new Notice('Branching is available after this prompt is saved.');
      return;
    }
    const previousDraft = drafts.capture('main');
    if (previousDraft.content.trim() || previousDraft.images.length) {
      new Notice('Save or clear your draft before changing conversation branches.');
      return;
    }
    if (!branchMessageId) {
      this.#state = { kind: 'preview', draft: { conversationId, message, previousDraft,
        scrollTop: this.deps.getMessagesEl().scrollTop } };
      const content = message.displayContent ?? extractUserDisplayContent(message.content) ?? message.content;
      this.deps.renderTranscript(messages.slice(0, messages.indexOf(message)), false);
      drafts.restore('main', { content, images: message.images }, { focus: true, notify: true });
      return;
    }
    await navigation.runConversationNavigation(signal => this.#changeBranch(message, branchMessageId, signal));
  }

  /** Leaves a branch preview, restoring the full transcript, the prior draft, and scroll. */
  cancelDraft(): void {
    if (this.#state.kind !== 'preview') return;
    const { draft } = this.#state;
    this.#state = { kind: 'idle' };
    const { state } = this.deps;
    if (this.deps.isDisposed?.() || state.currentConversationId !== draft.conversationId) return;
    this.deps.drafts.restore('main', draft.previousDraft);
    this.deps.renderTranscript(state.messages, true);
    this.deps.getMessagesEl().scrollTop = draft.scrollTop;
  }

  /** Runs inside the already admitted main turn, without taking a second operation. */
  async commitDraft(signal?: AbortSignal): Promise<ConversationBranchResult> {
    const branch = this.#state;
    if (branch.kind === 'idle') return { status: 'committed', messages: this.deps.state.messages };
    if (branch.kind === 'committing') return { status: 'failed', error: 'Branch navigation is in progress.' };
    if (branch.kind === 'recovery') return this.#changeBranch(undefined, undefined, signal);
    if (this.deps.state.currentConversationId !== branch.draft.conversationId
      || !this.deps.state.messages.includes(branch.draft.message)) return { status: 'failed', error: 'Conversation changed.' };
    return this.#changeBranch(branch.draft.message, undefined, signal);
  }

  /** Refreshes native prompt ids and sibling branches for the saved transcript. */
  async refreshMetadata(): Promise<void> {
    const { state } = this.deps;
    const conversationId = state.currentConversationId;
    const coordinator = this.deps.getExecutionCoordinator();
    if (!coordinator?.supportsConversationBranches || state.isStreaming) return;
    const branchState = await coordinator.getConversationBranches(state.messages).catch(() => null);
    if (!branchState) return;
    const { branches, userMessageIds } = branchState;
    if (state.currentConversationId !== conversationId || coordinator !== this.deps.getExecutionCoordinator()) return;
    for (const message of state.messages) {
      if (!message.userMessageId && userMessageIds[message.id]) message.userMessageId = userMessageIds[message.id];
      if (message.userMessageId && branches[message.userMessageId]) message.treeBranches = branches[message.userMessageId];
    }
    this.deps.renderer.refreshBranchButtons(state.messages);
  }

  async #changeBranch(message?: ChatMessage, branchMessageId?: string, signal?: AbortSignal): Promise<ConversationBranchResult> {
    const { state, renderer } = this.deps;
    const conversationId = state.currentConversationId;
    if (!conversationId) return { status: 'failed', error: 'Conversation is missing.' };
    const previous = this.#state;
    let draft = previous.kind === 'idle' ? undefined : previous.draft;
    let coordinator: ChatExecutionCoordinator | null = null;
    const isCurrent = () => !this.deps.isDisposed?.() && state.currentConversationId === conversationId
      && (!coordinator || coordinator === this.deps.getExecutionCoordinator());
    this.#state = { kind: 'committing', draft };
    this.deps.setRewinding(true);
    let result: ConversationBranchResult = { status: 'failed', error: 'Execution is unavailable.' };
    try {
      if (this.deps.ensureExecutionInitialized && !await this.deps.ensureExecutionInitialized()) return result;
      coordinator = this.deps.getExecutionCoordinator();
      if (!coordinator || !isCurrent()) return result;
      const request = { configuration: { model: this.deps.getSelectedModel?.() ?? undefined,
        systemInstructions: { kind: 'provider-default' as const } }, signal };
      result = message
        ? await coordinator.navigateConversationBranch({ ...request, userMessageId: message.userMessageId!, branchMessageId })
        : await coordinator.reconcileConversationBranch(request);
      if (!isCurrent()) return { status: 'failed', error: 'Conversation changed.' };
      // Recover once immediately. Further retries use reconciliation, never replay the navigation.
      if (result.status === 'recovery-required') {
        const recovered = await coordinator.reconcileConversationBranch(request);
        result = recovered.status === 'committed' || recovered.status === 'cancelled' ? recovered : { status: 'recovery-required',
          error: 'error' in recovered ? recovered.error : 'Branch recovery was cancelled.' };
      }
      if (!isCurrent()) return { status: 'failed', error: 'Conversation changed.' };
      if ((result.status === 'committed' || result.status === 'cancelled') && result.messages) {
        state.messages = result.messages;
        state.usage = result.usage ?? null;
        if (result.status === 'cancelled' && draft) {
          const restored = state.messages.find(item => item.userMessageId === draft!.message.userMessageId);
          draft = restored ? { ...draft, message: restored } : undefined;
        }
        const messages = state.messages;
        const visible = result.status === 'cancelled' && draft
          ? messages.slice(0, messages.indexOf(draft.message)) : messages;
        this.deps.renderTranscript(visible, true);
        try { await this.deps.save(); }
        catch (error) { result = { status: 'recovery-required', messages: result.messages, error: String(error) }; }
      }
      if (!isCurrent()) return { status: 'failed', error: 'Conversation changed.' };
      if (result.status === 'failed' || result.status === 'recovery-required') new Notice(result.error);
      return result;
    } catch (error) {
      result = { status: 'recovery-required', error: String(error) };
      new Notice(`Could not reconcile conversation branch: ${result.error}`);
      return result;
    } finally {
      if (!isCurrent()) this.#state = { kind: 'idle' };
      else if (result.status === 'committed') this.#state = { kind: 'idle' };
      else if (result.status === 'recovery-required' || (previous.kind === 'recovery' && result.status === 'failed')) {
        this.#state = { kind: 'recovery', draft };
      } else this.#state = draft ? { kind: 'preview', draft } : { kind: 'idle' };
      this.deps.setRewinding(false);
      renderer.refreshBranchButtonState();
    }
  }
}
