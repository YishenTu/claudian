import { CLAUDIAN_COLLAB_LIMITS } from '@/core/collab/ClaudianCollabConstants';
import type {
  CollabDetailViewPort,
  CollabTicketDetailViewState,
} from '@/features/collab/detail/CollabDetailContracts';
import {
  TicketEditorPanel,
  type TicketMutationKind,
} from '@/features/collab/detail/ticket/TicketEditorPanel';
import { MutationIntentStore } from '@/features/collab/shared/MutationIntentStore';
import { t } from '@/i18n/i18n';

export interface TicketDetailSessionOptions {
  readonly navigate: (state: CollabTicketDetailViewState) => Promise<void>;
  readonly openTicketInNewTab?: (projectId: string, ticketId: string) => Promise<void>;
  readonly port: CollabDetailViewPort;
  readonly renderMarkdown: (markdown: string, host: HTMLElement) => Promise<void>;
  readonly rootEl: HTMLElement;
}

interface LoadedTicketIdentity {
  readonly number: number;
  readonly projectId: string;
  readonly ticketId: string;
  readonly title: string;
}

export class TicketDetailSession {
  private destroyed = false;
  private loaded: LoadedTicketIdentity | null = null;
  private readonly mutationIntents = new MutationIntentStore<TicketMutationKind>();
  private panel: TicketEditorPanel | null = null;
  private state: CollabTicketDetailViewState | null = null;

  constructor(private readonly options: TicketDetailSessionOptions) {}

  get displayText(): string {
    const state = this.state;
    const loaded = this.loaded;
    if (
      state?.ticketId
      && loaded?.projectId === state.projectId
      && loaded.ticketId === state.ticketId
    ) {
      return `${loaded.title} #${loaded.number}`;
    }
    return t('collab.tickets.editorTitle');
  }

  matches(state: CollabTicketDetailViewState): boolean {
    return this.state?.projectId === state.projectId;
  }

  async open(state: CollabTicketDetailViewState): Promise<void> {
    if (this.destroyed) return;
    this.state = state;
    this.options.rootEl.replaceChildren();
    this.panel?.destroy();
    const panel = new TicketEditorPanel(this.options.rootEl, {
      onCreated: async ticketId => {
        if (!this.isCurrent(state)) return;
        await this.options.navigate({ kind: 'ticket', projectId: state.projectId, ticketId });
      },
      onDetailLoaded: detail => {
        if (!this.isCurrent(state) || state.ticketId !== detail.ticket.id) return;
        this.loaded = {
          number: detail.ticket.number,
          projectId: state.projectId,
          ticketId: detail.ticket.id,
          title: detail.ticket.title,
        };
      },
      ...(this.options.openTicketInNewTab ? {
        onOpenTicket: (ticketNumber: number) => this.openTicketReference(
          state.projectId,
          ticketNumber,
        ),
      } : {}),
      port: this.options.port,
      projectId: state.projectId,
      renderMarkdown: this.options.renderMarkdown,
      mutationIntents: this.mutationIntents,
      ...(state.ticketId ? { ticketId: state.ticketId } : {}),
    });
    this.panel = panel;
    await panel.open();
  }

  refresh(): Promise<void> {
    const state = this.state;
    return state ? this.open(state) : Promise.resolve();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.panel?.destroy();
    this.panel = null;
    this.mutationIntents.clearAll();
    this.options.rootEl.replaceChildren();
  }

  private isCurrent(state: CollabTicketDetailViewState): boolean {
    return !this.destroyed
      && this.state?.projectId === state.projectId
      && this.state.ticketId === state.ticketId;
  }

  private async openTicketReference(projectId: string, ticketNumber: number): Promise<void> {
    const openTicket = this.options.openTicketInNewTab;
    if (!openTicket) return;
    const ticketId = await this.findTicketId(projectId, ticketNumber);
    if (ticketId) await openTicket(projectId, ticketId);
  }

  private async findTicketId(projectId: string, ticketNumber: number): Promise<string | null> {
    for (const status of ['open', 'closed'] as const) {
      let cursor: string | undefined;
      const visitedCursors = new Set<string>();
      do {
        const result = await this.options.port.listTickets({
          ...(cursor ? { cursor } : {}),
          limit: CLAUDIAN_COLLAB_LIMITS.maxTicketPageSize,
          projectId,
          status,
        });
        if (result.status !== 'success') break;
        const match = result.value.page.tickets.find(ticket => ticket.number === ticketNumber);
        if (match) return match.id;
        cursor = result.value.page.nextCursor;
        if (cursor && visitedCursors.has(cursor)) break;
        if (cursor) visitedCursors.add(cursor);
      } while (cursor);
    }
    return null;
  }
}
