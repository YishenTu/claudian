import {
  type CollabComposerMemberChange,
  type CollabComposerReferenceCollection,
  type CollabComposerReferencePort,
  type CollabComposerReferenceSubscription,
  type CollabComposerSelection,
  type CollabComposerTicket,
  type CollabFeaturePort,
  type CollabFeatureState,
  type CollabFeatureSubscription,
  type CollabResult,
  resolveEffectiveCollabProjectId,
} from '@/core/collab';

type ResolveCollabFeaturePort = () => Promise<CollabFeaturePort | null>;

export class CollabComposerReferenceService implements CollabComposerReferencePort {
  private disposed = false;
  private featureSubscription: CollabFeatureSubscription | null = null;
  private readonly listeners = new Set<(selection: CollabComposerSelection | null) => void>();
  private featureSelectionGeneration = 0;
  private hasSelectionSnapshot = false;
  private lastSelection: CollabComposerSelection | null = null;

  constructor(
    private readonly resolveFeature: ResolveCollabFeaturePort,
    private readonly isEnabled: () => boolean = () => true,
  ) {}

  async getSelection(signal?: AbortSignal): Promise<CollabComposerSelection | null> {
    if (!this.isEnabled()) return null;
    this.throwIfUnavailable(signal);
    if (this.hasSelectionSnapshot) return this.lastSelection;
    const feature = await this.resolve(signal);
    if (!feature) return null;
    this.ensureFeatureSubscription(feature);
    const selectionGeneration = this.featureSelectionGeneration;
    const projection = this.unwrap(await feature.readProjectSelection({ signal }), signal);
    if (selectionGeneration !== this.featureSelectionGeneration && this.hasSelectionSnapshot) {
      return this.lastSelection;
    }
    const selected = projection.projects.find(project => project.id === projection.selectedProjectId);
    const selection = selected
      ? { projectId: selected.id, projectName: selected.name }
      : null;
    this.publishSelection(selection);
    return selection;
  }

  async listMemberChanges(
    projectId: string,
    signal?: AbortSignal,
  ): Promise<CollabComposerReferenceCollection<CollabComposerMemberChange>> {
    const feature = await this.requireFeature(signal);
    const coordination = this.unwrap(await feature.readSnapshot(projectId, { signal }), signal);
    const activeMembers = coordination.snapshot.members.filter(member => member.status === 'active');
    const requestsByMember = new Map(
      coordination.snapshot.openRequests.map(request => [request.memberId, request] as const),
    );
    return {
      items: activeMembers.map(member => ({
        currentMember: member.id === coordination.snapshot.currentMember.id,
        displayName: member.displayName,
        memberId: member.id,
        requestId: requestsByMember.get(member.id)?.id ?? '',
      })),
      source: coordination.source,
      stale: coordination.stale,
    };
  }

  async listOpenTickets(
    projectId: string,
    signal?: AbortSignal,
  ): Promise<CollabComposerReferenceCollection<CollabComposerTicket>> {
    const feature = await this.requireFeature(signal);
    const tickets: CollabComposerTicket[] = [];
    const visitedCursors = new Set<string>();
    let cursor: string | undefined;
    let source: 'cache' | 'online' = 'online';
    let stale = false;
    do {
      this.throwIfUnavailable(signal);
      const projection = this.unwrap(await feature.listTickets({
        ...(cursor ? { cursor } : {}),
        limit: 100,
        projectId,
        status: 'open',
      }, { signal }), signal);
      tickets.push(...projection.page.tickets.map(ticket => ({
        number: ticket.number,
        ticketId: ticket.id,
        title: ticket.title,
      })));
      if (projection.source === 'cache') source = 'cache';
      stale ||= projection.stale;
      cursor = projection.page.nextCursor;
      if (cursor && visitedCursors.has(cursor)) {
        throw new Error('Collab ticket pagination returned a repeated cursor.');
      }
      if (cursor) visitedCursors.add(cursor);
    } while (cursor);
    return {
      items: tickets,
      source,
      stale,
    };
  }

  subscribeSelection(
    listener: (selection: CollabComposerSelection | null) => void,
  ): CollabComposerReferenceSubscription {
    if (this.disposed) return { dispose: () => undefined };
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  refreshAvailability(): void {
    if (this.disposed) return;
    this.featureSelectionGeneration += 1;
    this.featureSubscription?.dispose();
    this.featureSubscription = null;
    const shouldNotify = this.hasSelectionSnapshot
      || this.lastSelection !== null
      || this.isEnabled();
    this.hasSelectionSnapshot = !this.isEnabled();
    this.lastSelection = null;
    if (shouldNotify) {
      for (const listener of this.listeners) listener(null);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.featureSubscription?.dispose();
    this.featureSubscription = null;
    this.listeners.clear();
  }

  private async requireFeature(signal?: AbortSignal): Promise<CollabFeaturePort> {
    if (!this.isEnabled()) {
      throw new DOMException('Collab is disabled in this Vault.', 'AbortError');
    }
    const feature = await this.resolve(signal);
    if (feature) return feature;
    throw new Error('Collab is unavailable in this Vault.');
  }

  private async resolve(signal?: AbortSignal): Promise<CollabFeaturePort | null> {
    this.throwIfUnavailable(signal);
    const feature = await this.resolveFeature();
    this.throwIfUnavailable(signal);
    if (feature) this.ensureFeatureSubscription(feature);
    return feature;
  }

  private ensureFeatureSubscription(feature: CollabFeaturePort): void {
    if (this.featureSubscription || this.disposed) return;
    let initialState = true;
    this.featureSubscription = feature.subscribe(state => {
      if (initialState) {
        initialState = false;
        return;
      }
      this.handleFeatureState(state);
    });
  }

  private handleFeatureState(state: CollabFeatureState): void {
    this.featureSelectionGeneration += 1;
    const selectedProjectId = resolveEffectiveCollabProjectId(
      state.projects,
      state.selectedProjectId,
    );
    const selected = state.projects.find(project => project.id === selectedProjectId);
    this.publishSelection(selected
      ? { projectId: selected.id, projectName: selected.name }
      : null);
  }

  private publishSelection(selection: CollabComposerSelection | null): void {
    if (!this.hasSelectionSnapshot) {
      this.hasSelectionSnapshot = true;
      this.lastSelection = selection;
      return;
    }
    if (
      this.lastSelection?.projectId === selection?.projectId
      && this.lastSelection?.projectName === selection?.projectName
    ) return;
    this.lastSelection = selection;
    for (const listener of this.listeners) listener(selection);
  }

  private unwrap<T>(result: CollabResult<T>, signal?: AbortSignal): T {
    if (result.status === 'success') return result.value;
    if (result.status === 'cancelled') {
      throw new DOMException('The Collab reference read was cancelled.', 'AbortError');
    }
    this.throwIfUnavailable(signal);
    throw result.error;
  }

  private throwIfUnavailable(signal?: AbortSignal): void {
    if (signal?.aborted || this.disposed || !this.isEnabled()) {
      throw new DOMException('The Collab reference read was cancelled.', 'AbortError');
    }
  }
}
