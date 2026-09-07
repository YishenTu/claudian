import type { CollabTicketAcceptedRelation, CollabTicketComment, CollabTicketDetail } from '@claudian-collab/protocol';

import type { CollabChangeTicketStatusRequest, CollabCoordinationSnapshot, CollabCreateTicketRequest, CollabFeaturePort, CollabProjectSnapshot, CollabResult, CollabUpdateTicketContentRequest } from '@/core/collab';
import {
  CollabCommentComposer,
  renderCollabComment,
} from '@/features/collab/shared/markdown/CollabCommentUI';
import {
  MarkdownDraftEditor,
  type MarkdownDraftMemberSuggestion,
  type MarkdownDraftSelection,
  type MarkdownDraftTicketSuggestion,
} from '@/features/collab/shared/markdown/MarkdownDraftEditor';
import { renderMarkdownWithTicketReferences } from '@/features/collab/shared/markdown/MarkdownTicketReferences';
import type { MutationIntentStore } from '@/features/collab/shared/MutationIntentStore';
import { t } from '@/i18n/i18n';

export type TicketMutationKind = 'comment' | 'content' | 'create' | 'status';

export interface TicketEditorPanelOptions {
  readonly onCreated: (ticketId: string) => Promise<void> | void;
  readonly onDetailLoaded?: (detail: CollabTicketDetail) => void;
  readonly onOpenTicket?: (ticketNumber: number) => Promise<void> | void;
  readonly port: Pick<
    CollabFeaturePort,
    | 'addTicketComment'
    | 'closeTicket'
    | 'createTicket'
    | 'readSnapshot'
    | 'readTicket'
    | 'reopenTicket'
    | 'updateTicketContent'
  >;
  readonly projectId: string;
  readonly renderMarkdown: (markdown: string, host: HTMLElement) => Promise<void>;
  readonly mutationIntents: MutationIntentStore<TicketMutationKind>;
  readonly ticketId?: string;
}

type TicketActivity =
  | {
    readonly at: string;
    readonly comment: CollabTicketComment;
    readonly id: string;
    readonly kind: 'comment';
  }
  | {
    readonly at: string;
    readonly id: string;
    readonly kind: 'relation';
    readonly relation: CollabTicketAcceptedRelation;
  };

interface MarkdownDraftState {
  readonly mode: 'edit' | 'preview';
  readonly selection: MarkdownDraftSelection;
  readonly value: string;
}

interface TicketCreateDraft {
  readonly body: MarkdownDraftState;
  readonly focusedField: string | null;
  readonly kind: 'create';
  readonly title: string;
}

interface TicketEditDraft {
  readonly body: MarkdownDraftState;
  readonly expectedRevision: number;
  readonly title: string;
}

interface TicketDetailDraft {
  readonly comment: MarkdownDraftState | null;
  readonly edit: TicketEditDraft | null;
  readonly focusedField: string | null;
  readonly kind: 'detail';
}

type TicketPanelDraft = TicketCreateDraft | TicketDetailDraft;

interface PendingTicketMutationAcknowledgement {
  readonly contentRevision: number | undefined;
  readonly intentId: string | undefined;
  readonly kind: TicketMutationKind;
  readonly submittedDraft: TicketPanelDraft | null;
}

export class TicketEditorPanel {
  private controller: AbortController | null = null;
  private destroyed = false;
  private editExpectedRevision: number | null = null;
  private readonly markdownEditorsByField = new Map<string, MarkdownDraftEditor>();
  private readonly markdownEditors = new Set<MarkdownDraftEditor>();
  private mutationInFlight: TicketMutationKind | null = null;
  private pendingMutationAcknowledgement: PendingTicketMutationAcknowledgement | null = null;
  private readGeneration = 0;
  private refreshLoop: Promise<boolean> | null = null;
  private refreshRequested = false;
  private retainedDraft: TicketPanelDraft | null = null;

  constructor(
    private readonly rootEl: HTMLElement,
    private readonly options: TicketEditorPanelOptions,
  ) {}

  async open(): Promise<boolean> {
    this.retainedDraft = null;
    return this.load(null, false);
  }

  async refresh(): Promise<boolean> {
    if (this.destroyed) return false;
    this.refreshRequested = true;
    this.refreshLoop ??= this.runRefreshLoop().finally(() => {
      this.refreshLoop = null;
    });
    return this.refreshLoop;
  }

  private async runRefreshLoop(): Promise<boolean> {
    let loaded = false;
    while (this.refreshRequested && !this.destroyed) {
      this.refreshRequested = false;
      const draft = this.currentDraft();
      this.retainedDraft = draft;
      loaded = await this.load(draft, true);
    }
    return loaded;
  }

  private async load(
    draft: TicketPanelDraft | null,
    refreshing: boolean,
  ): Promise<boolean> {
    if (this.destroyed) return false;
    this.cancel();
    const generation = ++this.readGeneration;
    const controller = new AbortController();
    this.controller = controller;
    if (!refreshing) this.renderMessage(t('collab.tickets.loading'));
    const [snapshotResult, ticketResult] = await Promise.all([
      this.options.port.readSnapshot(this.options.projectId, {
        signal: controller.signal,
      }),
      this.options.ticketId
        ? this.options.port.readTicket(
          this.options.projectId,
          this.options.ticketId,
          { signal: controller.signal },
        )
        : Promise.resolve(null),
    ]);
    if (controller.signal.aborted || generation !== this.readGeneration || this.destroyed) {
      return false;
    }
    if (
      snapshotResult.status !== 'success'
      || (ticketResult !== null && ticketResult.status !== 'success')
    ) {
      if (!refreshing) this.renderMessage(t('collab.tickets.loadFailed'), true);
      return false;
    }
    const latestDraft = refreshing ? this.currentDraft() : draft;
    const acknowledgement = this.pendingMutationAcknowledgement;
    const renderedDraft = acknowledgement
      ? this.draftAfterMutation(
        latestDraft,
        acknowledgement.submittedDraft,
        acknowledgement.kind,
        acknowledgement.contentRevision,
      )
      : latestDraft;
    this.retainedDraft = renderedDraft;
    if (ticketResult === null) {
      this.renderCreate(
        snapshotResult.value,
        renderedDraft?.kind === 'create' ? renderedDraft : null,
      );
    } else {
      const coordination = ticketResult.value.stale
        ? {
          ...snapshotResult.value,
          source: 'cache' as const,
          stale: true,
          syncState: { ...snapshotResult.value.syncState, status: 'offline' as const },
        }
        : snapshotResult.value;
      this.renderDetail(
        ticketResult.value.detail,
        coordination,
        renderedDraft?.kind === 'detail' ? renderedDraft : null,
      );
      this.options.onDetailLoaded?.(ticketResult.value.detail);
    }
    if (acknowledgement && this.pendingMutationAcknowledgement === acknowledgement) {
      this.pendingMutationAcknowledgement = null;
      this.mutationInFlight = null;
      this.options.mutationIntents.clear(acknowledgement.kind, acknowledgement.intentId);
      this.syncMutationPresentation();
    }
    return true;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.refreshRequested = false;
    this.cancel();
    this.destroyMarkdownEditors();
    this.rootEl.replaceChildren();
  }

  private renderCreate(
    coordination: CollabCoordinationSnapshot,
    draft: TicketCreateDraft | null,
  ): void {
    if (!this.isWritable(coordination)) {
      this.renderOfflineReadOnly(t('collab.tickets.offlineCreateUnavailable'));
      return;
    }
    const snapshot = coordination.snapshot;
    this.resetRoot();
    const form = this.rootEl.createEl('form', { cls: 'claudian-collab-ticket-editor' });
    form.createEl('h2', { text: t('collab.tickets.createTitle') });
    const title = this.textInput(form, t('collab.tickets.title'), 'ticket-title');
    title.value = draft?.title ?? '';
    const body = this.markdownEditor(
      form,
      t('collab.tickets.body'),
      'ticket-body',
      draft?.body.value ?? '',
      snapshot,
      draft?.body,
    );
    title.required = true;
    const status = form.createDiv({
      attr: { 'aria-live': 'polite' },
      cls: 'claudian-collab-ticket-editor-status',
    });
    const submit = form.createEl('button', {
      attr: { type: 'submit' },
      cls: 'mod-cta',
      text: t('collab.tickets.create'),
    });
    form.addEventListener('submit', event => {
      event.preventDefault();
      if (!title.reportValidity() || !this.requireMarkdown(body)) return;
      const bodyValue = body.getValue();
      void this.submitCreate({
        body: bodyValue,
        intentId: this.options.mutationIntents.intent('create', {
          body: bodyValue,
          projectId: this.options.projectId,
          title: title.value,
        }),
        projectId: this.options.projectId,
        title: title.value,
      }, submit, status);
    });
    this.syncMutationPresentation();
    this.restoreFocus(draft?.focusedField ?? null);
  }

  private renderDetail(
    detail: CollabTicketDetail,
    coordination: CollabCoordinationSnapshot,
    draft: TicketDetailDraft | null = null,
  ): void {
    this.resetRoot();
    const snapshot = coordination.snapshot;
    const ticket = detail.ticket;
    const current = snapshot.currentMember;
    const writable = this.isWritable(coordination);
    const canEdit = writable
      && (current.role === 'manager' || ticket.authorMemberId === current.id);
    const canChangeStatus = canEdit;
    const editing = canEdit && draft?.edit !== null && draft?.edit !== undefined;
    const editor = this.rootEl.createDiv({ cls: 'claudian-collab-ticket-editor' });
    if (!writable) {
      editor.createDiv({
        attr: { 'data-state': 'ticket-offline-read-only' },
        cls: 'claudian-collab-ticket-offline-read-only',
        text: t('collab.tickets.offlineReadOnly'),
      });
    }
    const titleRow = editor.createDiv({ cls: 'claudian-collab-ticket-detail-header' });
    const heading = titleRow.createEl('h2');
    heading.createSpan({
      cls: 'claudian-collab-ticket-detail-title',
      text: ticket.title,
    });
    heading.createSpan({
      cls: 'claudian-collab-ticket-detail-number',
      text: `#${ticket.number}`,
    });
    const statusButton = titleRow.createEl('button', {
      attr: {
        'data-action': 'toggle-ticket-status',
        'data-ticket-status': ticket.status,
        type: 'button',
      },
      cls: 'claudian-collab-ticket-status-toggle',
      text: ticket.status === 'open'
        ? t('collab.tickets.open')
        : t('collab.tickets.closed'),
    });
    statusButton.disabled = !canChangeStatus;
    if (canChangeStatus) {
      statusButton.addEventListener('click', () => {
        void this.changeStatus(
          ticket.status === 'open' ? 'close' : 'reopen',
          {
            expectedRevision: ticket.revision,
            intentId: this.options.mutationIntents.intent('status', {
              action: ticket.status === 'open' ? 'close' : 'reopen',
              expectedRevision: ticket.revision,
              projectId: this.options.projectId,
              ticketId: ticket.id,
            }),
            projectId: this.options.projectId,
            ticketId: ticket.id,
          },
          statusButton,
          mutationStatus,
        );
      });
    }
    const mutationStatus = editor.createDiv({
      attr: { 'aria-live': 'polite' },
      cls: 'claudian-collab-ticket-editor-status',
    });

    if (canEdit && !editing) {
      const edit = titleRow.createEl('button', {
        attr: { 'data-action': 'edit-ticket', type: 'button' },
        cls: 'claudian-collab-ticket-edit',
        text: t('common.edit'),
      });
      edit.addEventListener('click', () => {
        this.editExpectedRevision = ticket.revision;
        const comment = this.captureMarkdownDraft('ticket-comment');
        this.renderDetail(detail, coordination, {
          comment,
          edit: {
            body: {
              mode: 'edit',
              selection: { anchor: detail.body.length, head: detail.body.length },
              value: detail.body,
            },
            expectedRevision: ticket.revision,
            title: ticket.title,
          },
          focusedField: null,
          kind: 'detail',
        });
      });
    }

    if (editing && draft?.edit) {
      const editDraft = draft.edit;
      this.editExpectedRevision = editDraft.expectedRevision;
      const title = this.textInput(editor, t('collab.tickets.title'), 'ticket-title');
      title.required = true;
      title.value = editDraft.title;
      const body = this.markdownEditor(
        editor,
        t('collab.tickets.body'),
        'ticket-body',
        editDraft.body.value,
        snapshot,
        editDraft.body,
      );
      const editActions = editor.createDiv({ cls: 'claudian-collab-ticket-edit-actions' });
      const save = editActions.createEl('button', {
        attr: { 'data-action': 'save-ticket', type: 'button' },
        cls: 'mod-cta',
        text: t('collab.tickets.save'),
      });
      save.addEventListener('click', () => {
        if (!title.reportValidity() || !this.requireMarkdown(body)) return;
        void this.updateContent({
          body: body.getValue(),
          expectedRevision: editDraft.expectedRevision,
          intentId: this.options.mutationIntents.intent('content', {
            body: body.getValue(),
            expectedRevision: editDraft.expectedRevision,
            projectId: this.options.projectId,
            ticketId: ticket.id,
            title: title.value,
          }),
          projectId: this.options.projectId,
          ticketId: ticket.id,
          title: title.value,
        }, save, mutationStatus);
      });
      const cancel = editActions.createEl('button', {
        attr: { 'data-action': 'cancel-ticket-edit', type: 'button' },
        text: t('common.cancel'),
      });
      cancel.addEventListener('click', () => {
        this.options.mutationIntents.discard('content');
        this.editExpectedRevision = null;
        const nextDraft: TicketDetailDraft = {
          comment: this.captureMarkdownDraft('ticket-comment') ?? draft.comment,
          edit: null,
          focusedField: this.focusedField(),
          kind: 'detail',
        };
        this.retainedDraft = nextDraft;
        this.renderDetail(detail, coordination, nextDraft);
      });
    } else {
      const bodyPreview = editor.createDiv({ cls: 'claudian-collab-ticket-markdown' });
      this.renderMarkdown(detail.body, bodyPreview);
    }

    this.renderActivity(editor, detail, snapshot, mutationStatus, writable, draft?.comment ?? null);
    this.syncMutationPresentation();
    this.restoreFocus(draft?.focusedField ?? null);
  }

  private renderActivity(
    editor: HTMLElement,
    detail: CollabTicketDetail,
    snapshot: CollabProjectSnapshot,
    mutationStatus: HTMLElement,
    writable: boolean,
    commentDraft: MarkdownDraftState | null,
  ): void {
    const activity = editor.createDiv({ cls: 'claudian-collab-ticket-activity' });
    const entries = this.activityEntries(detail);
    if (entries.length > 0) {
      activity.classList.add('has-entries');
      activity.createEl('h3', {
        text: t('collab.tickets.activity', { count: entries.length }),
      });
      const timeline = activity.createDiv({ cls: 'claudian-collab-ticket-timeline' });
      for (const entry of entries) {
        const kind = entry.kind === 'comment' ? 'comment' : entry.relation.kind;
        const item = timeline.createDiv({
          attr: {
            'data-activity-at': entry.at,
            'data-activity-kind': kind,
          },
          cls: `claudian-collab-ticket-activity-item is-${kind}`,
        });
        if (entry.kind === 'comment') {
          const member = snapshot.members.find(
            candidate => candidate.id === entry.comment.authorMemberId,
          );
          renderCollabComment(item, {
            authorName: member?.displayName ?? t('collab.team.unknownMember'),
            body: entry.comment.body,
            createdAt: entry.comment.createdAt,
          }, {
            ...(this.options.onOpenTicket ? { onOpenTicket: this.options.onOpenTicket } : {}),
            renderMarkdown: this.options.renderMarkdown,
          });
        } else {
          const metadata = item.createDiv({ cls: 'claudian-collab-comment-meta' });
          metadata.createEl('time', {
            attr: { datetime: entry.at },
            text: new Date(entry.at).toLocaleString(),
          });
          item.createDiv({
            cls: 'claudian-collab-ticket-relation-event',
            text: `${entry.relation.kind === 'resolves'
              ? t('collab.tickets.resolvedBy')
              : t('collab.tickets.referencedBy')} ${entry.relation.commitOid.slice(0, 8)}`,
          });
        }
      }
    }
    if (!writable) return;
    const composer = new CollabCommentComposer(activity, {
      actionName: 'ticket-comment',
      ariaLabel: t('collab.tickets.addComment'),
      dataField: 'ticket-comment',
      label: t('collab.tickets.addComment'),
      ...(this.options.onOpenTicket ? { onOpenTicket: this.options.onOpenTicket } : {}),
      onSubmit: (body, button) => this.addComment(
        detail.ticket.id,
        body,
        button,
        mutationStatus,
      ),
      renderMarkdown: this.options.renderMarkdown,
      statusEl: mutationStatus,
      submitAction: 'submit-ticket-comment',
      submitLabel: t('collab.tickets.comment'),
      memberSuggestions: this.memberSuggestions(snapshot),
      ticketSuggestions: this.ticketSuggestions(snapshot),
    });
    this.markdownEditors.add(composer.editor);
    this.markdownEditorsByField.set('ticket-comment', composer.editor);
    if (commentDraft) this.restoreMarkdownDraft(composer.editor, commentDraft);
  }

  private activityEntries(detail: CollabTicketDetail): readonly TicketActivity[] {
    const entries: TicketActivity[] = [
      ...detail.comments.comments.map(comment => ({
        at: comment.createdAt,
        comment,
        id: comment.id,
        kind: 'comment' as const,
      })),
      ...detail.acceptedRelations.acceptedRelations.map(relation => ({
        at: relation.acceptedAt,
        id: relation.id,
        kind: 'relation' as const,
        relation,
      })),
    ];
    return entries.sort((left, right) => (
      left.at.localeCompare(right.at) || left.id.localeCompare(right.id)
    ));
  }

  private renderMarkdown(markdown: string, host: HTMLElement): void {
    void renderMarkdownWithTicketReferences({
      host,
      markdown,
      ...(this.options.onOpenTicket ? { onOpenTicket: this.options.onOpenTicket } : {}),
      renderMarkdown: this.options.renderMarkdown,
    }).catch(() => {
      if (!this.destroyed && host.isConnected) host.setText(markdown);
    });
  }

  private async submitCreate(
    request: CollabCreateTicketRequest,
    button: HTMLButtonElement,
    status: HTMLElement,
  ): Promise<void> {
    if (this.mutationInFlight) return;
    this.mutationInFlight = 'create';
    this.syncMutationPresentation();
    status.setText(t('collab.tickets.saving'));
    const result = await this.options.port.createTicket(request);
    if (this.destroyed) return;
    if (result.status !== 'success') {
      this.mutationInFlight = null;
      this.syncMutationPresentation(true);
      return;
    }
    this.mutationInFlight = null;
    await this.options.onCreated(result.value.ticket.id);
    this.options.mutationIntents.clear('create', request.intentId);
  }

  private async updateContent(
    request: CollabUpdateTicketContentRequest,
    button: HTMLButtonElement,
    status: HTMLElement,
  ): Promise<void> {
    await this.mutate(
      button,
      status,
      () => this.options.port.updateTicketContent(request),
      'content',
      request.intentId,
      value => value.revision,
    );
  }

  private async changeStatus(
    action: 'close' | 'reopen',
    request: CollabChangeTicketStatusRequest,
    button: HTMLButtonElement,
    status: HTMLElement,
  ): Promise<void> {
    await this.mutate(
      button,
      status,
      () => (
        action === 'close'
          ? this.options.port.closeTicket(request)
          : this.options.port.reopenTicket(request)
      ),
      'status',
      request.intentId,
      value => value.revision,
    );
  }

  private async addComment(
    ticketId: string,
    body: string,
    button: HTMLButtonElement,
    status: HTMLElement,
  ): Promise<void> {
    const request = {
      body,
      intentId: this.options.mutationIntents.intent('comment', {
        body,
        projectId: this.options.projectId,
        ticketId,
      }),
      projectId: this.options.projectId,
      ticketId,
    };
    await this.mutate(
      button,
      status,
      () => this.options.port.addTicketComment(request),
      'comment',
      request.intentId,
    );
  }

  private async mutate<T>(
    control: HTMLButtonElement | HTMLSelectElement,
    status: HTMLElement,
    mutation: () => Promise<CollabResult<T>>,
    intentKind: TicketMutationKind,
    intentId: string | undefined,
    contentRevision?: (value: T) => number,
  ): Promise<void> {
    if (this.mutationInFlight) return;
    const submittedDraft = this.currentDraft();
    this.retainedDraft = submittedDraft;
    this.mutationInFlight = intentKind;
    if (!control.disabled) {
      control.dataset.mutationDisabled = 'true';
      control.disabled = true;
    }
    this.syncMutationPresentation();
    status.setText(t('collab.tickets.saving'));
    const result = await mutation();
    if (this.destroyed) return;
    if (result.status !== 'success') {
      this.mutationInFlight = null;
      this.syncMutationPresentation(true);
      return;
    }
    this.pendingMutationAcknowledgement = {
      contentRevision: contentRevision?.(result.value),
      intentId,
      kind: intentKind,
      submittedDraft,
    };
    await this.load(submittedDraft, true);
  }

  private textInput(root: HTMLElement, labelText: string, field: string): HTMLInputElement {
    const label = root.createEl('label', { cls: 'claudian-collab-ticket-field' });
    label.createSpan({ text: labelText });
    return label.createEl('input', {
      attr: { 'data-field': field, type: 'text' },
    });
  }

  private markdownEditor(
    root: HTMLElement,
    labelText: string,
    field: string,
    initialValue: string,
    snapshot: CollabProjectSnapshot,
    draft?: MarkdownDraftState,
  ): MarkdownDraftEditor {
    const fieldEl = root.createDiv({ cls: 'claudian-collab-ticket-field' });
    const headerEl = fieldEl.createDiv({ cls: 'claudian-collab-ticket-field-header' });
    headerEl.createSpan({ text: labelText });
    const toolbarEl = headerEl.createDiv();
    const editorEl = fieldEl.createDiv({ attr: { 'data-field': field } });
    const editor = new MarkdownDraftEditor(editorEl, {
      actionName: field,
      ariaLabel: labelText,
      ...(draft ? { initialMode: draft.mode } : {}),
      initialValue,
      ...(this.options.onOpenTicket ? { onOpenTicket: this.options.onOpenTicket } : {}),
      placeholder: labelText,
      renderMarkdown: this.options.renderMarkdown,
      memberSuggestions: this.memberSuggestions(snapshot),
      ticketSuggestions: this.ticketSuggestions(snapshot),
      toolbarEl,
    });
    this.markdownEditors.add(editor);
    this.markdownEditorsByField.set(field, editor);
    if (draft) editor.setSelection(draft.selection.anchor, draft.selection.head);
    return editor;
  }

  private requireMarkdown(editor: MarkdownDraftEditor): boolean {
    const valid = editor.getValue().trim().length > 0;
    editor.setInvalid(!valid);
    if (!valid) editor.focus();
    return valid;
  }

  private renderMessage(message: string, error = false): void {
    this.resetRoot();
    this.rootEl.createDiv({
      cls: `claudian-collab-ticket-editor-status${error ? ' is-error' : ''}`,
      text: message,
    });
  }

  private renderOfflineReadOnly(message: string): void {
    this.resetRoot();
    this.rootEl.createDiv({
      attr: { 'data-state': 'ticket-offline-read-only' },
      cls: 'claudian-collab-ticket-offline-read-only',
      text: message,
    });
  }

  private cancel(): void {
    this.readGeneration += 1;
    this.controller?.abort();
    this.controller = null;
  }

  private destroyMarkdownEditors(): void {
    for (const editor of this.markdownEditors) editor.destroy();
    this.markdownEditors.clear();
    this.markdownEditorsByField.clear();
  }

  private captureDraft(): TicketPanelDraft | null {
    return this.options.ticketId
      ? this.captureDetailDraft()
      : this.captureCreateDraft();
  }

  private captureCreateDraft(): TicketCreateDraft | null {
    const title = this.rootEl.querySelector<HTMLInputElement>(
      '[data-field="ticket-title"]',
    );
    const body = this.captureMarkdownDraft('ticket-body');
    if (!title || !body) return null;
    return {
      body,
      focusedField: this.focusedField(),
      kind: 'create',
      title: title.value,
    };
  }

  private captureDetailDraft(): TicketDetailDraft | null {
    const comment = this.captureMarkdownDraft('ticket-comment');
    const title = this.rootEl.querySelector<HTMLInputElement>(
      '[data-field="ticket-title"]',
    );
    const body = this.captureMarkdownDraft('ticket-body');
    const edit = title && body && this.editExpectedRevision !== null
      ? {
        body,
        expectedRevision: this.editExpectedRevision,
        title: title.value,
      }
      : null;
    if (!comment && !edit) return null;
    return {
      comment,
      edit,
      focusedField: this.focusedField(),
      kind: 'detail',
    };
  }

  private captureMarkdownDraft(field: string): MarkdownDraftState | null {
    const editor = this.markdownEditorsByField.get(field);
    if (!editor) return null;
    return {
      mode: editor.getMode(),
      selection: editor.getSelection(),
      value: editor.getValue(),
    };
  }

  private draftAfterMutation(
    draft: TicketPanelDraft | null,
    submittedDraft: TicketPanelDraft | null,
    kind: TicketMutationKind,
    contentRevision: number | undefined,
  ): TicketPanelDraft | null {
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
        && (kind === 'content' || kind === 'status')
        && contentRevision !== undefined
        ? { ...draft.edit, expectedRevision: contentRevision }
        : draft.edit;
    const next = {
      ...draft,
      comment,
      edit,
    };
    return next.comment || next.edit ? next : null;
  }

  private currentDraft(fallback = this.retainedDraft): TicketPanelDraft | null {
    const visible = this.captureDraft();
    if (!visible) return fallback;
    if (visible.kind === 'detail' && fallback?.kind === 'detail') {
      return {
        ...visible,
        comment: visible.comment ?? fallback.comment,
        edit: visible.edit ?? fallback.edit,
      };
    }
    return visible;
  }

  private focusedField(): string | null {
    const active = this.rootEl.ownerDocument.activeElement;
    if (!(active instanceof HTMLElement) || !this.rootEl.contains(active)) return null;
    const field = active.closest<HTMLElement>('[data-field]');
    return field?.dataset.field ?? null;
  }

  private restoreFocus(field: string | null): void {
    if (!field) return;
    const editor = this.markdownEditorsByField.get(field);
    if (editor) {
      editor.focus();
      return;
    }
    this.rootEl.querySelector<HTMLElement>(`[data-field="${field}"]`)?.focus();
  }

  private restoreMarkdownDraft(
    editor: MarkdownDraftEditor,
    draft: MarkdownDraftState,
  ): void {
    editor.setValue(draft.value);
    editor.setMode(draft.mode);
    editor.setSelection(draft.selection.anchor, draft.selection.head);
  }

  private syncMutationPresentation(failed = false): void {
    const selectors: Record<TicketMutationKind, string> = {
      comment: '[data-action="submit-ticket-comment"]',
      content: '[data-action="save-ticket"]',
      create: 'form button[type="submit"]',
      status: '[data-action="toggle-ticket-status"]',
    };
    for (const selector of Object.values(selectors)) {
      const control = this.rootEl.querySelector<HTMLButtonElement>(selector);
      if (!control) continue;
      if (this.mutationInFlight && !control.disabled) {
        control.dataset.mutationDisabled = 'true';
        control.disabled = true;
      } else if (control.dataset.mutationDisabled === 'true') {
        delete control.dataset.mutationDisabled;
        control.disabled = false;
      }
    }
    const status = this.rootEl.querySelector<HTMLElement>(
      '.claudian-collab-ticket-editor-status',
    );
    if (!status) return;
    if (this.mutationInFlight) status.setText(t('collab.tickets.saving'));
    else if (failed) status.setText(t('collab.tickets.saveFailed'));
  }

  private resetRoot(): void {
    this.destroyMarkdownEditors();
    this.rootEl.replaceChildren();
  }

  private ticketSuggestions(
    snapshot: CollabProjectSnapshot,
  ): readonly MarkdownDraftTicketSuggestion[] {
    return snapshot.ticketHighlights
      .filter(ticket => ticket.status === 'open')
      .map(ticket => ({ number: ticket.number, title: ticket.title }));
  }

  private memberSuggestions(
    snapshot: CollabProjectSnapshot,
  ): readonly MarkdownDraftMemberSuggestion[] {
    const activeMembers = snapshot.members
      .filter(member => member.status === 'active')
      .map(member => member.displayName.trim())
      .filter(displayName => displayName.length > 0);
    const counts = new Map<string, number>();
    for (const displayName of activeMembers) {
      counts.set(displayName, (counts.get(displayName) ?? 0) + 1);
    }
    return activeMembers
      .filter(displayName => counts.get(displayName) === 1)
      .map(displayName => ({ displayName }));
  }

  private isWritable(coordination: CollabCoordinationSnapshot): boolean {
    return coordination.source === 'online'
      && !coordination.stale
      && coordination.syncState.status === 'synchronized';
  }
}
