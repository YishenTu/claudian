import type { CollabTicketStatus, CollabTicketSummary } from '@claudian-collab/protocol';
import { setIcon } from 'obsidian';

import type { CollabFeaturePort, CollabLocalProjectSummary } from '@/core/collab';
import { t } from '@/i18n/i18n';
import {
  type LatestTaskHandle,
  LatestTaskScope,
} from '@/shared/async/LatestTaskScope';

export interface TicketListPanelOptions {
  readonly focus?: TicketFocusPort;
  readonly onCreate: () => void;
  readonly onOpen: (ticket: CollabTicketSummary) => Promise<void> | void;
  readonly port: CollabFeaturePort;
  readonly project: CollabLocalProjectSummary;
}

export interface TicketFocus {
  readonly projectId: string;
  readonly ticketId: string;
}

export interface TicketFocusPort {
  read(): TicketFocus | null;
  subscribe(listener: () => void): { dispose(): void };
}

export class TicketListPanel {
  private active = false;
  private destroyed = false;
  private dirty = true;
  private readonly focusSubscription: { dispose(): void } | null;
  private listRevision = 0;
  private readonly readTasks = new LatestTaskScope();
  private readOnly = false;
  private status: CollabTicketStatus = 'open';
  private readonly subscription: { dispose(): void };

  constructor(
    private readonly rootEl: HTMLElement,
    private readonly options: TicketListPanelOptions,
  ) {
    this.focusSubscription = options.focus?.subscribe(() => {
      if (!this.destroyed) this.syncFocusedTicket();
    }) ?? null;
    this.subscription = options.port.subscribe(() => {
      if (this.destroyed) return;
      this.dirty = true;
      if (this.active) void this.refresh();
    });
  }

  setActive(active: boolean): void {
    if (this.destroyed) return;
    this.active = active;
    if (active) {
      if (this.dirty) void this.refresh();
    } else {
      if (this.readTasks.active) this.dirty = true;
      this.cancel();
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.active = false;
    this.listRevision += 1;
    this.readTasks.close();
    this.focusSubscription?.dispose();
    this.subscription.dispose();
    this.rootEl.replaceChildren();
  }

  async refresh(): Promise<void> {
    if (!this.active || this.destroyed) return;
    this.cancel();
    const revision = this.listRevision;
    const task = this.readTasks.start();
    try {
      this.renderShell(this.options.project.connectionStatus !== 'connected');
      this.rootEl.createDiv({
        cls: 'claudian-collab-ticket-list-status',
        text: t('collab.tickets.loading'),
      });
      const result = await this.options.port.listTickets({
        projectId: this.options.project.id,
        status: this.status,
      }, { signal: task.signal });
      const snapshotResult = result.status === 'success'
        ? null
        : await this.options.port.readSnapshot(this.options.project.id, {
          signal: task.signal,
        });
      if (!this.isCurrent(task, revision)) return;
      if (result.status === 'success') this.dirty = false;
      const ticketReadOnly = result.status === 'success' && result.value.stale;
      const readOnly = ticketReadOnly || (snapshotResult?.status === 'success'
        ? snapshotResult.value.source === 'cache' || snapshotResult.value.stale
        : this.options.project.connectionStatus !== 'connected');
      this.renderShell(readOnly);
      const content = this.rootEl.createDiv({ cls: 'claudian-collab-ticket-list-content' });
      if (result.status !== 'success') {
        const knownEmpty = this.hasFreshEmptyOpenSnapshot(snapshotResult);
        if (knownEmpty) {
          content.setText(t('collab.tickets.empty'));
          return;
        }
        content.classList.add('claudian-collab-ticket-list-status');
        if (readOnly) {
          content.setText(t('collab.tickets.offlineCacheUnavailable'));
        } else {
          content.classList.add('is-error');
          content.setText(t('collab.tickets.loadFailed'));
        }
        return;
      }
      if (result.value.page.tickets.length === 0) {
        content.createDiv({
          cls: 'claudian-collab-ticket-list-status',
          text: t('collab.tickets.empty'),
        });
        return;
      }
      const items = content.createDiv({ cls: 'claudian-collab-ticket-list' });
      this.appendRows(items, result.value.page.tickets);
      if (result.value.page.nextCursor) {
        this.renderLoadMore(items, result.value.page.nextCursor, revision);
      }
    } finally {
      task.complete();
    }
  }

  private hasFreshEmptyOpenSnapshot(
    result: Awaited<ReturnType<CollabFeaturePort['readSnapshot']>> | null,
  ): boolean {
    if (this.status !== 'open') return false;
    return result !== null
      && result.status === 'success'
      && result.value.source === 'online'
      && !result.value.stale
      && result.value.snapshot.openTicketCount === 0;
  }

  private appendRows(
    items: HTMLElement,
    tickets: readonly CollabTicketSummary[],
  ): void {
    for (const ticket of tickets) {
      const button = items.createEl('button', {
        attr: {
          'data-ticket-id': ticket.id,
          type: 'button',
        },
        cls: 'claudian-collab-ticket-list-item',
      });
      button.createSpan({
        cls: 'claudian-collab-ticket-title',
        text: ticket.title,
      });
      button.createSpan({
        cls: 'claudian-collab-ticket-number',
        text: `#${ticket.number}`,
      });
      button.addEventListener('click', () => {
        const opening = this.options.onOpen(ticket);
        if (opening) {
          void opening.then(
            () => this.syncFocusedTicket(),
            () => this.syncFocusedTicket(),
          );
        } else {
          this.syncFocusedTicket();
        }
      });
    }
    this.syncFocusedTicket();
  }

  private syncFocusedTicket(): void {
    const focus = this.options.focus?.read() ?? null;
    const focusedTicketId = focus?.projectId === this.options.project.id
      ? focus.ticketId
      : null;
    for (const button of this.rootEl.querySelectorAll<HTMLElement>('[data-ticket-id]')) {
      if (button.dataset.ticketId === focusedTicketId) {
        button.setAttribute('aria-current', 'true');
      } else {
        button.removeAttribute('aria-current');
      }
    }
  }

  private renderLoadMore(
    items: HTMLElement,
    cursor: string,
    revision: number,
  ): void {
    const button = this.rootEl.createEl('button', {
      attr: { 'data-action': 'load-more-tickets', type: 'button' },
      cls: 'claudian-collab-ticket-load-more',
      text: t('collab.tickets.loadMore'),
    });
    button.addEventListener('click', () => {
      void this.loadMore(items, cursor, revision, button);
    });
  }

  private async loadMore(
    items: HTMLElement,
    cursor: string,
    revision: number,
    button: HTMLButtonElement,
  ): Promise<void> {
    if (!this.active || this.destroyed || revision !== this.listRevision) return;
    const task = this.readTasks.start();
    button.disabled = true;
    try {
      const result = await this.options.port.listTickets({
        cursor,
        projectId: this.options.project.id,
        status: this.status,
      }, { signal: task.signal });
      if (!this.isCurrent(task, revision)) return;
      if (result.status !== 'success') {
        button.disabled = false;
        this.rootEl.querySelector('[data-state="ticket-page-error"]')?.remove();
        this.rootEl.createDiv({
          attr: { 'data-state': 'ticket-page-error' },
          cls: `claudian-collab-ticket-list-status${this.readOnly ? '' : ' is-error'}`,
          text: this.readOnly
            ? t('collab.tickets.offlineCacheUnavailable')
            : t('collab.tickets.loadFailed'),
        });
        return;
      }
      button.remove();
      this.rootEl.querySelector('[data-state="ticket-page-error"]')?.remove();
      if (result.value.stale) this.enterReadOnly();
      this.appendRows(items, result.value.page.tickets);
      if (result.value.page.nextCursor) {
        this.renderLoadMore(items, result.value.page.nextCursor, revision);
      }
    } finally {
      task.complete();
    }
  }

  private isCurrent(task: LatestTaskHandle, revision: number): boolean {
    return this.active
      && !this.destroyed
      && revision === this.listRevision
      && task.isCurrent();
  }

  private renderShell(readOnly = false): void {
    this.readOnly = readOnly;
    this.rootEl.replaceChildren();
    const header = this.rootEl.createDiv({ cls: 'claudian-collab-ticket-list-header' });
    header.createEl('h4', { text: t('collab.tickets.sectionTitle') });
    const actions = header.createDiv({ cls: 'claudian-collab-ticket-list-actions' });
    const filter = actions.createEl('button', {
      attr: {
        'data-ticket-status': this.status,
        type: 'button',
      },
      cls: 'claudian-collab-ticket-filter',
      text: this.status === 'open'
        ? t('collab.tickets.open')
        : t('collab.tickets.closed'),
    });
    filter.addEventListener('click', () => {
      this.status = this.status === 'open' ? 'closed' : 'open';
      void this.refresh();
    });
    const add = actions.createEl('button', {
      attr: {
        'aria-label': t('collab.tickets.add'),
        'data-action': 'add-ticket',
        title: t('collab.tickets.add'),
        type: 'button',
      },
      cls: 'clickable-icon claudian-collab-ticket-add',
    });
    add.disabled = readOnly;
    setIcon(add, 'plus');
    add.addEventListener('click', this.options.onCreate);
    if (readOnly) {
      this.rootEl.createDiv({
        attr: { 'data-state': 'ticket-offline-read-only' },
        cls: 'claudian-collab-ticket-connection-state',
        text: t('collab.tickets.offlineReadOnly'),
      });
    }
  }

  private enterReadOnly(): void {
    if (this.readOnly) return;
    this.readOnly = true;
    const add = this.rootEl.querySelector<HTMLButtonElement>('[data-action="add-ticket"]');
    if (add) add.disabled = true;
    const state = this.rootEl.createDiv({
      attr: { 'data-state': 'ticket-offline-read-only' },
      cls: 'claudian-collab-ticket-connection-state',
      text: t('collab.tickets.offlineReadOnly'),
    });
    this.rootEl.querySelector('.claudian-collab-ticket-list-header')?.after(state);
  }

  private cancel(): void {
    this.listRevision += 1;
    this.readTasks.cancel();
  }
}
