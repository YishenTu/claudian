import type { CollabTicketDetail, CollabTicketSummary } from '@claudian-collab/protocol';

import type { MarkdownDraftSelection } from '@/features/collab/shared/markdown/MarkdownDraftEditor';
import { MutationIntentStore } from '@/features/collab/shared/MutationIntentStore';

export type TicketMutationKind = 'comment' | 'content' | 'create' | 'status';

interface TicketContentBaseline {
  readonly title: string;
  readonly body: string;
  readonly revision: number;
}

export interface MarkdownDraftState {
  readonly mode: 'edit' | 'preview';
  readonly selection: MarkdownDraftSelection;
  readonly value: string;
}

export interface TicketCreateDraft {
  readonly body: MarkdownDraftState;
  readonly focusedField: string | null;
  readonly kind: 'create';
  readonly title: string;
}

interface TicketEditDraft {
  readonly body: MarkdownDraftState;
  readonly baseline: TicketContentBaseline;
  readonly expectedRevision: number;
  readonly title: string;
}

export interface TicketDetailDraft {
  readonly comment: MarkdownDraftState | null;
  readonly edit: TicketEditDraft | null;
  readonly focusedField: string | null;
  readonly kind: 'detail';
}

export type TicketPanelDraft = TicketCreateDraft | TicketDetailDraft;

interface TicketMutation {
  readonly kind: TicketMutationKind;
  readonly intentId: string | undefined;
  readonly submittedDraft: TicketPanelDraft | null;
}

type TicketWriteState =
  | { readonly status: 'idle' }
  | { readonly status: 'writing'; readonly mutation: TicketMutation }
  | { readonly status: 'failed' }
  | { readonly status: 'created'; readonly ticketId: string; readonly opening: boolean }
  | { readonly status: 'acknowledged'; readonly mutation: TicketMutation; readonly ticket?: Pick<CollabTicketSummary, 'revision' | 'title'> };

/** Transient editing state, owned by one Ticket detail session. */
export class TicketEditorState {
  readonly mutationIntents = new MutationIntentStore<TicketMutationKind>();
  draft: TicketPanelDraft | null = null;
  private latest: CollabTicketDetail | null = null;
  private contentAttempt: TicketDetailDraft['edit'] = null;
  private write: TicketWriteState = { status: 'idle' };
  private read: 'idle' | 'loading' | 'failed' = 'idle';
  private staleWrite = false;

  get mutationsBlocked(): boolean {
    return this.write.status === 'writing' || this.write.status === 'acknowledged'
      || this.write.status === 'created' || this.staleWrite;
  }

  get presentation(): 'created' | 'saving' | 'savedRefreshing' | 'savedRefreshFailed' | 'loadFailed' | 'saveFailed' | null {
    if (this.write.status === 'created') return 'created';
    if (this.write.status === 'writing') return 'saving';
    if (this.write.status === 'acknowledged') {
      return this.read === 'failed' ? 'savedRefreshFailed' : 'savedRefreshing';
    }
    if (this.read === 'failed') return 'loadFailed';
    if (this.write.status === 'failed') return 'saveFailed';
    return null;
  }

  get canRetryRead(): boolean {
    return this.read === 'failed' && this.write.status !== 'writing' && this.write.status !== 'created';
  }

  beginMutation(kind: TicketMutationKind, intentId: string | undefined): boolean {
    if (this.mutationsBlocked) return false;
    if (kind === 'content') this.contentAttempt = this.edit;
    this.write = { status: 'writing', mutation: { kind, intentId, submittedDraft: this.draft } };
    return true;
  }

  acknowledgeMutation(ticket?: Pick<CollabTicketSummary, 'revision' | 'title'>): void {
    if (this.write.status !== 'writing') return;
    const mutation = this.write.mutation;
    this.mutationIntents.clear(mutation.kind, mutation.intentId);
    this.write = { status: 'acknowledged', mutation, ...(ticket ? { ticket } : {}) };
    this.read = 'loading';
  }

  acknowledgeCreation(ticketId: string): void {
    if (this.write.status !== 'writing') return;
    const { kind, intentId } = this.write.mutation;
    this.mutationIntents.clear(kind, intentId);
    this.write = { status: 'created', ticketId, opening: false };
  }

  get canOpenCreated(): boolean {
    return this.write.status === 'created' && !this.write.opening;
  }

  beginOpenCreated(): string | null {
    if (this.write.status !== 'created' || this.write.opening) return null;
    this.write = { ...this.write, opening: true };
    return this.write.ticketId;
  }

  finishOpenCreated(): void {
    if (this.write.status === 'created') this.write = { ...this.write, opening: false };
  }

  failMutation(stale: boolean): void {
    if (this.write.status !== 'writing') return;
    if (stale) {
      const { kind, intentId } = this.write.mutation;
      this.mutationIntents.clear(kind, intentId);
      if (kind === 'content') this.contentAttempt = null;
    }
    this.staleWrite = stale;
    this.write = { status: 'failed' };
  }

  beginRead(): void {
    this.read = 'loading';
  }

  failRead(): void {
    this.read = 'failed';
  }

  receiveRead(authoritative: boolean, detail?: CollabTicketDetail): void {
    this.read = 'idle';
    if (!authoritative) {
      if (this.write.status === 'acknowledged' || this.staleWrite) this.read = 'failed';
      return;
    }
    if (this.staleWrite) {
      this.staleWrite = false;
      this.write = { status: 'idle' };
    }
    if (this.write.status === 'acknowledged') {
      const { mutation, ticket } = this.write;
      if (ticket && detail && detail.ticket.revision < ticket.revision) {
        this.read = 'failed';
        return;
      }
      this.draft = this.draftAfterMutation(this.draft, mutation.submittedDraft, mutation.kind, ticket, detail);
      this.write = { status: 'idle' };
    }
  }

  dispose(): void {
    this.draft = null;
    this.latest = null;
    this.contentAttempt = null;
    this.mutationIntents.clearAll();
  }

  get edit(): TicketDetailDraft['edit'] {
    return this.draft?.kind === 'detail' ? this.draft.edit : null;
  }

  get diverged(): boolean {
    const edit = this.edit;
    return !!edit && !!this.latest && !this.retryingContent
      && !this.matchesBaseline(edit.baseline, this.latest);
  }

  private get retryingContent(): boolean {
    const edit = this.edit;
    return !!edit && !!this.contentAttempt
      && edit.expectedRevision === this.contentAttempt.expectedRevision
      && edit.title === this.contentAttempt.title
      && edit.body.value === this.contentAttempt.body.value;
  }

  observe(detail: CollabTicketDetail): void {
    this.latest = detail;
    const edit = this.edit;
    if (edit && this.draft?.kind === 'detail' && !this.contentAttempt
      && this.matchesBaseline(edit.baseline, detail)
      && detail.ticket.revision > edit.expectedRevision) {
      this.draft = {
        ...this.draft,
        edit: { ...edit, expectedRevision: detail.ticket.revision },
      };
    }
  }

  startEditing(detail: CollabTicketDetail): void {
    const previous = this.draft?.kind === 'detail' ? this.draft : null;
    this.contentAttempt = null;
    this.draft = {
      kind: 'detail',
      comment: previous?.comment ?? null,
      focusedField: null,
      edit: {
        baseline: { body: detail.body, title: detail.ticket.title, revision: detail.ticket.revision },
        expectedRevision: detail.ticket.revision,
        title: detail.ticket.title,
        body: {
          mode: 'edit', value: detail.body,
          selection: { anchor: detail.body.length, head: detail.body.length },
        },
      },
    };
  }

  reconcile(useLatest: boolean): void {
    const edit = this.edit;
    const detail = this.latest;
    if (!edit || !detail || this.draft?.kind !== 'detail') return;
    this.contentAttempt = null;
    this.mutationIntents.discard('content');
    this.draft = {
      ...this.draft,
      edit: {
        ...edit,
        baseline: { body: detail.body, title: detail.ticket.title, revision: detail.ticket.revision },
        expectedRevision: detail.ticket.revision,
        ...(useLatest ? {
          title: detail.ticket.title,
          body: { ...edit.body, value: detail.body, selection: { anchor: 0, head: 0 } },
        } : {}),
      },
    };
  }

  cancelEdit(): void {
    this.contentAttempt = null;
    this.mutationIntents.discard('content');
    if (this.draft?.kind === 'detail') this.draft = { ...this.draft, edit: null };
  }

  capture(visible: TicketPanelDraft | null): TicketPanelDraft | null {
    const retained = this.draft;
    if (!visible) return retained;
    this.draft = visible.kind === 'detail' && retained?.kind === 'detail'
      ? { ...visible, comment: visible.comment ?? retained.comment, edit: visible.edit ?? retained.edit }
      : visible;
    return this.draft;
  }

  private matchesBaseline(baseline: TicketContentBaseline, detail: CollabTicketDetail): boolean {
    return baseline.title === detail.ticket.title && baseline.body === detail.body;
  }

  private draftAfterMutation(
    draft: TicketPanelDraft | null,
    submittedDraft: TicketPanelDraft | null,
    kind: TicketMutationKind,
    ticket: Pick<CollabTicketSummary, 'revision' | 'title'> | undefined,
    detail: CollabTicketDetail | undefined,
  ): TicketPanelDraft | null {
    if (kind === 'content') this.contentAttempt = null;
    if (!draft || draft.kind !== 'detail') return null;
    const submitted = submittedDraft?.kind === 'detail' ? submittedDraft : null;
    const comment = kind === 'comment'
      && draft.comment
      && submitted?.comment
      && draft.comment.value === submitted.comment.value
      ? null
      : draft.comment;
    const editWasSubmitted = kind === 'content'
      && draft.edit
      && submitted?.edit
      && draft.edit.title === submitted.edit.title
      && draft.edit.body.value === submitted.edit.body.value
      && draft.edit.expectedRevision === submitted.edit.expectedRevision;
    const edit = editWasSubmitted
      ? null
      : draft.edit
        && kind === 'content'
        && submitted?.edit
        && ticket
        ? {
          ...draft.edit,
          baseline: {
            body: detail?.ticket.revision === ticket.revision ? detail.body : submitted.edit.body.value,
            title: ticket.title,
            revision: ticket.revision,
          },
          expectedRevision: ticket.revision,
        }
        : draft.edit;
    const next = {
      ...draft,
      comment,
      edit,
    };
    return next.comment || next.edit ? next : null;
  }

}
