import type {
  CollabDetailViewPort,
  CollabTicketDetailViewState,
} from '@/features/collab/detail/CollabDetailContracts';
import {
  TicketReferenceResolver,
} from '@/features/collab/detail/sessions/TicketReferenceResolver';
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
  private readonly ticketReferences: TicketReferenceResolver;

  constructor(private readonly options: TicketDetailSessionOptions) {
    this.ticketReferences = new TicketReferenceResolver(options.port);
  }

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
    return this.state?.projectId === state.projectId
      && this.state.ticketId === state.ticketId;
  }

  async open(state: CollabTicketDetailViewState): Promise<void> {
    if (this.destroyed) return;
    if (this.matches(state) && this.panel) {
      await this.panel.refresh();
      return;
    }
    this.ticketReferences.cancel();
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
          state,
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
    return this.panel?.refresh().then(() => undefined) ?? Promise.resolve();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.ticketReferences.cancel();
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

  private async openTicketReference(
    state: CollabTicketDetailViewState,
    ticketNumber: number,
  ): Promise<void> {
    const openTicketInNewTab = this.options.openTicketInNewTab;
    if (!openTicketInNewTab) return;
    await this.ticketReferences.openReference(
      state.projectId,
      ticketNumber,
      openTicketInNewTab,
      () => this.isCurrent(state),
    );
  }
}
