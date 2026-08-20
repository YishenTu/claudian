import type {
  CollabListTicketsRequest,
  CollabOperationOptions,
  CollabResult,
  CollabTicketPageProjection,
} from '@/core/collab';
import { CLAUDIAN_COLLAB_LIMITS } from '@/core/collab/ClaudianCollabConstants';

export interface TicketReferenceResolverPort {
  listTickets(
    request: CollabListTicketsRequest,
    options?: CollabOperationOptions,
  ): Promise<CollabResult<CollabTicketPageProjection>>;
}

/**
 * Detail-owned Ticket-reference navigation lane. At most one lookup is in
 * flight per resolver: a newer click, session destroy, or state replacement
 * cancels the older one, and ownership is rechecked before a tab is opened.
 */
export class TicketReferenceResolver {
  private controller: AbortController | null = null;

  constructor(private readonly port: TicketReferenceResolverPort) {}

  cancel(): void {
    this.controller?.abort();
    this.controller = null;
  }

  async openReference(
    projectId: string,
    ticketNumber: number,
    openTicketInNewTab: (projectId: string, ticketId: string) => Promise<void>,
    isCurrent: () => boolean,
  ): Promise<void> {
    this.cancel();
    const controller = new AbortController();
    this.controller = controller;
    const ticketId = await this.findTicketId(projectId, ticketNumber, controller.signal);
    if (
      ticketId === null
      || controller.signal.aborted
      || this.controller !== controller
      || !isCurrent()
    ) return;
    await openTicketInNewTab(projectId, ticketId);
  }

  private async findTicketId(
    projectId: string,
    ticketNumber: number,
    signal: AbortSignal,
  ): Promise<string | null> {
    for (const status of ['open', 'closed'] as const) {
      let cursor: string | undefined;
      const visitedCursors = new Set<string>();
      do {
        if (signal.aborted) return null;
        const result = await this.port.listTickets({
          ...(cursor ? { cursor } : {}),
          limit: CLAUDIAN_COLLAB_LIMITS.maxTicketPageSize,
          projectId,
          status,
        }, { signal });
        if (result.status !== 'success') break;
        const ticket = result.value.page.tickets.find(
          candidate => candidate.number === ticketNumber,
        );
        if (ticket) return ticket.id;
        cursor = result.value.page.nextCursor;
        if (cursor && visitedCursors.has(cursor)) break;
        if (cursor) visitedCursors.add(cursor);
      } while (cursor);
    }
    return null;
  }
}
