import type { ProviderId } from '@/core/providers/types';
import type { ChatSessionRuntime, SessionIdentity, TurnCancelOptions } from '@/features/chat/sessions/ChatSessionRuntime';
import type { TabLifecycleState } from '@/features/chat/tabs/ChatTab';
import type { TabIdentity } from '@/features/chat/tabs/TabIdentity';
import type { TurnCancelReason, TurnCoordinator } from '@/features/chat/turns/TurnCoordinator';

/** The identity fields a tab owns; conversation, provider, and draft model belong to its session. */
export type TabPresentationIdentity = Pick<TabIdentity, 'id' | 'lifecycleState' | 'label'>;

/** A tab's presentation identity and projections of its independently owned session. */
export class TabSession {
  private userClaimed = false;
  private sealedIdentity: SessionIdentity | null = null;

  constructor(
    private readonly identity: TabPresentationIdentity,
    readonly runtime: ChatSessionRuntime,
  ) {}

  get id(): string { return this.identity.id; }
  get lifecycleState(): TabLifecycleState { return this.identity.lifecycleState; }
  get label(): string | null { return this.identity.label ?? null; }
  get isUserClaimed(): boolean { return this.userClaimed; }
  get providerId(): ProviderId | null { return (this.sealedIdentity ?? this.runtime).providerId; }
  get conversationId(): string | null { return (this.sealedIdentity ?? this.runtime).conversationId; }
  get draftModel(): string | null { return (this.sealedIdentity ?? this.runtime).draftModel; }
  get turns(): TurnCoordinator { return this.runtime.turns; }
  get acceptsIntents(): boolean { return this.runtime.acceptsIntents; }
  get canNavigateConversation(): boolean { return this.runtime.canNavigateConversation; }
  get hasActiveTurn(): boolean { return this.runtime.hasActiveTurn; }
  get hasBackgroundWork(): boolean { return this.runtime.hasBackgroundWork; }
  get hasMainBackgroundWork(): boolean { return this.runtime.hasMainBackgroundWork; }
  get isWorking(): boolean { return this.runtime.isWorking; }

  cancelTurn(reason: TurnCancelReason, options?: TurnCancelOptions): boolean {
    return this.runtime.cancelTurn(reason, options);
  }
  selectDraft(providerId: ProviderId | null, model: string | null): void {
    this.runtime.selectDraft(providerId, model);
  }
  setConversationId(conversationId: string | null): void { this.runtime.setConversationId(conversationId); }
  enqueueBackgroundWork(work: () => Promise<void>, independent = false): Promise<void> | null {
    return this.runtime.enqueueBackgroundWork(work, independent);
  }

  /** Freezes the session identity this tab reports into the view's final shutdown snapshot. */
  sealIdentity(): void {
    this.sealedIdentity = { conversationId: this.conversationId, providerId: this.providerId, draftModel: this.draftModel };
  }
  /** Labels and retention belong to the tab, never the conversation it displays. */
  setLabel(label: string | null): boolean {
    if (this.label === label) return false;
    if (label === null) delete this.identity.label;
    else this.identity.label = label;
    return true;
  }
  commitAdmission(): void {
    if (this.lifecycleState === 'provisional') this.identity.lifecycleState = 'open';
  }
  beginClose(): void { this.identity.lifecycleState = 'closing'; }
  claimUserOwnership(): void { this.userClaimed = true; }
}
