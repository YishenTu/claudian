export interface CollabComposerSelection {
  readonly projectId: string;
  readonly projectName: string;
}

export interface CollabComposerMemberChange {
  readonly currentMember: boolean;
  readonly displayName: string;
  readonly memberId: string;
  readonly requestId: string;
}

export interface CollabComposerTicket {
  readonly number: number;
  readonly ticketId: string;
  readonly title: string;
}

export interface CollabComposerReferenceCollection<T> {
  readonly items: readonly T[];
  readonly source: 'cache' | 'online';
  readonly stale: boolean;
}

export interface CollabComposerTicketPage extends CollabComposerReferenceCollection<CollabComposerTicket> {
  readonly nextCursor?: string;
}

export interface CollabComposerTicketPageRequest {
  readonly projectId: string;
  readonly cursor?: string;
}

export interface CollabComposerReferenceSubscription {
  dispose(): void;
}

export interface CollabComposerReferencePort {
  getSelection(signal?: AbortSignal): Promise<CollabComposerSelection | null>;
  listMemberChanges(
    projectId: string,
    signal?: AbortSignal,
  ): Promise<CollabComposerReferenceCollection<CollabComposerMemberChange>>;
  readOpenTicketPage(
    request: CollabComposerTicketPageRequest,
    signal?: AbortSignal,
  ): Promise<CollabComposerTicketPage>;
  subscribeSelection(
    listener: (selection: CollabComposerSelection | null) => void,
  ): CollabComposerReferenceSubscription;
}
