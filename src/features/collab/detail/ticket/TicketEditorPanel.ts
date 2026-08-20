import type { CollabTicketAcceptedRelation, CollabTicketComment, CollabTicketDetail } from '@claudian/collab-protocol';

import type { CollabChangeTicketStatusRequest, CollabCoordinationSnapshot, CollabCreateTicketRequest, CollabFeaturePort, CollabProjectSnapshot, CollabUpdateTicketContentRequest } from '@/core/collab';
import {
  CollabCommentComposer,
  renderCollabComment,
} from '@/features/collab/shared/markdown/CollabCommentUI';
import {
  MarkdownDraftEditor,
  type MarkdownDraftMemberSuggestion,
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

export class TicketEditorPanel {
  private controller: AbortController | null = null;
  private destroyed = false;
  private generation = 0;
  private readonly markdownEditors = new Set<MarkdownDraftEditor>();

  constructor(
    private readonly rootEl: HTMLElement,
    private readonly options: TicketEditorPanelOptions,
  ) {}

  async open(): Promise<boolean> {
    if (this.destroyed) return false;
    this.cancel();
    const generation = ++this.generation;
    const controller = new AbortController();
    this.controller = controller;
    this.renderMessage(t('collab.tickets.loading'));
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
    if (controller.signal.aborted || generation !== this.generation || this.destroyed) {
      return false;
    }
    if (
      snapshotResult.status !== 'success'
      || (ticketResult !== null && ticketResult.status !== 'success')
    ) {
      this.renderMessage(t('collab.tickets.loadFailed'), true);
      return false;
    }
    if (ticketResult === null) {
      this.renderCreate(snapshotResult.value);
    } else {
      const coordination = ticketResult.value.stale
        ? {
          ...snapshotResult.value,
          source: 'cache' as const,
          stale: true,
          syncState: { ...snapshotResult.value.syncState, status: 'offline' as const },
        }
        : snapshotResult.value;
      this.renderDetail(ticketResult.value.detail, coordination);
      this.options.onDetailLoaded?.(ticketResult.value.detail);
    }
    return true;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.cancel();
    this.destroyMarkdownEditors();
    this.rootEl.replaceChildren();
  }

  private renderCreate(coordination: CollabCoordinationSnapshot): void {
    if (!this.isWritable(coordination)) {
      this.renderOfflineReadOnly(t('collab.tickets.offlineCreateUnavailable'));
      return;
    }
    const snapshot = coordination.snapshot;
    this.resetRoot();
    const form = this.rootEl.createEl('form', { cls: 'claudian-collab-ticket-editor' });
    form.createEl('h2', { text: t('collab.tickets.createTitle') });
    const title = this.textInput(form, t('collab.tickets.title'), 'ticket-title');
    const body = this.markdownEditor(
      form,
      t('collab.tickets.body'),
      'ticket-body',
      '',
      snapshot,
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
  }

  private renderDetail(
    detail: CollabTicketDetail,
    coordination: CollabCoordinationSnapshot,
    editing = false,
  ): void {
    this.resetRoot();
    const snapshot = coordination.snapshot;
    const ticket = detail.ticket;
    const current = snapshot.currentMember;
    const writable = this.isWritable(coordination);
    const canEdit = writable
      && (current.role === 'manager' || ticket.authorMemberId === current.id);
    const canChangeStatus = canEdit;
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
      edit.addEventListener('click', () => this.renderDetail(detail, coordination, true));
    }

    if (editing) {
      const title = this.textInput(editor, t('collab.tickets.title'), 'ticket-title');
      title.required = true;
      title.value = ticket.title;
      const body = this.markdownEditor(
        editor,
        t('collab.tickets.body'),
        'ticket-body',
        detail.body,
        snapshot,
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
          expectedRevision: ticket.revision,
          intentId: this.options.mutationIntents.intent('content', {
            body: body.getValue(),
            expectedRevision: ticket.revision,
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
        this.renderDetail(detail, coordination);
      });
    } else {
      const bodyPreview = editor.createDiv({ cls: 'claudian-collab-ticket-markdown' });
      this.renderMarkdown(detail.body, bodyPreview);
    }

    this.renderActivity(editor, detail, snapshot, mutationStatus, writable);
  }

  private renderActivity(
    editor: HTMLElement,
    detail: CollabTicketDetail,
    snapshot: CollabProjectSnapshot,
    mutationStatus: HTMLElement,
    writable: boolean,
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
    const generation = this.generation;
    button.disabled = true;
    status.setText(t('collab.tickets.saving'));
    const result = await this.options.port.createTicket(request);
    if (this.destroyed || generation !== this.generation) return;
    if (result.status !== 'success') {
      button.disabled = false;
      status.setText(t('collab.tickets.saveFailed'));
      return;
    }
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

  private async mutate(
    control: HTMLButtonElement | HTMLSelectElement,
    status: HTMLElement,
    mutation: () => Promise<{ readonly status: string }>,
    intentKind: TicketMutationKind,
    intentId: string | undefined,
  ): Promise<void> {
    const generation = this.generation;
    control.disabled = true;
    status.setText(t('collab.tickets.saving'));
    const result = await mutation();
    if (this.destroyed || generation !== this.generation) return;
    if (result.status !== 'success') {
      control.disabled = false;
      status.setText(t('collab.tickets.saveFailed'));
      return;
    }
    if (await this.open()) this.options.mutationIntents.clear(intentKind, intentId);
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
  ): MarkdownDraftEditor {
    const fieldEl = root.createDiv({ cls: 'claudian-collab-ticket-field' });
    const headerEl = fieldEl.createDiv({ cls: 'claudian-collab-ticket-field-header' });
    headerEl.createSpan({ text: labelText });
    const toolbarEl = headerEl.createDiv();
    const editorEl = fieldEl.createDiv({ attr: { 'data-field': field } });
    const editor = new MarkdownDraftEditor(editorEl, {
      actionName: field,
      ariaLabel: labelText,
      initialValue,
      ...(this.options.onOpenTicket ? { onOpenTicket: this.options.onOpenTicket } : {}),
      placeholder: labelText,
      renderMarkdown: this.options.renderMarkdown,
      memberSuggestions: this.memberSuggestions(snapshot),
      ticketSuggestions: this.ticketSuggestions(snapshot),
      toolbarEl,
    });
    this.markdownEditors.add(editor);
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
    this.generation += 1;
    this.controller?.abort();
    this.controller = null;
  }

  private destroyMarkdownEditors(): void {
    for (const editor of this.markdownEditors) editor.destroy();
    this.markdownEditors.clear();
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
