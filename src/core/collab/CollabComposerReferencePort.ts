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

export interface CollabComposerReferenceSubscription {
  dispose(): void;
}

export interface CollabComposerReferencePort {
  getSelection(signal?: AbortSignal): Promise<CollabComposerSelection | null>;
  listMemberChanges(
    projectId: string,
    signal?: AbortSignal,
  ): Promise<CollabComposerReferenceCollection<CollabComposerMemberChange>>;
  listOpenTickets(
    projectId: string,
    signal?: AbortSignal,
  ): Promise<CollabComposerReferenceCollection<CollabComposerTicket>>;
  subscribeSelection(
    listener: (selection: CollabComposerSelection | null) => void,
  ): CollabComposerReferenceSubscription;
}
