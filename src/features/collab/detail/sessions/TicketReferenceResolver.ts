import type { ResolveTicketNumberRequest, ResolveTicketNumberResponse } from '@claudian-collab/protocol';

import type {
  CollabOperationOptions,
  CollabResult,
} from '@/core/collab';

export interface TicketReferenceResolverPort {
  resolveTicketNumber(
    request: ResolveTicketNumberRequest,
    options?: CollabOperationOptions,
  ): Promise<CollabResult<ResolveTicketNumberResponse>>;
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
    const ticketId = await this.#findTicketId(projectId, ticketNumber, controller.signal);
    if (
      ticketId === null
      || controller.signal.aborted
      || this.controller !== controller
      || !isCurrent()
    ) return;
    await openTicketInNewTab(projectId, ticketId);
  }

  async #findTicketId(
    projectId: string,
    ticketNumber: number,
    signal: AbortSignal,
  ): Promise<string | null> {
    if (signal.aborted) return null;
    const result = await this.port.resolveTicketNumber({ projectId, ticketNumber }, { signal });
    return result.status === 'success' ? result.value.ticketId : null;
  }
}
