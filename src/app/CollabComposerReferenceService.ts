import {
  type CollabComposerMemberChange,
  type CollabComposerReferenceCollection,
  type CollabComposerReferencePort,
  type CollabComposerReferenceSubscription,
  type CollabComposerSelection,
  type CollabComposerTicketPage,
  type CollabComposerTicketPageRequest,
  type CollabFeaturePort,
  type CollabFeatureState,
  type CollabFeatureSubscription,
  type CollabResult,
  resolveEffectiveCollabProjectId,
} from '@/core/collab';

type ResolveCollabFeaturePort = () => Promise<CollabFeaturePort | null>;

export class CollabComposerReferenceService implements CollabComposerReferencePort {
  private disposed = false;
  private availabilityGeneration = 0;
  private featureSubscription: CollabFeatureSubscription | null = null;
  private readonly listeners = new Set<(selection: CollabComposerSelection | null) => void>();
  private featureSelectionGeneration = 0;
  private hasSelectionSnapshot = false;
  private lastSelection: CollabComposerSelection | null = null;

  constructor(
    private readonly resolveFeature: ResolveCollabFeaturePort,
    private readonly isEnabled: () => boolean = () => true,
  ) {}

  isAvailable(): boolean {
    return !this.disposed && this.isEnabled();
  }

  async getSelection(signal?: AbortSignal): Promise<CollabComposerSelection | null> {
    if (!this.isEnabled()) return null;
    this.#throwIfUnavailable(signal);
    if (this.hasSelectionSnapshot) return this.lastSelection;
    const availability = this.availabilityGeneration;
    const feature = await this.resolve(signal);
    this.#throwIfUnavailable(signal, availability);
    if (!feature) return null;
    const selectionGeneration = this.featureSelectionGeneration;
    const projection = this.#unwrap(await feature.readProjectSelection({ signal }), signal, availability);
    if (selectionGeneration !== this.featureSelectionGeneration && this.hasSelectionSnapshot) {
      return this.lastSelection;
    }
    const selected = projection.projects.find(project => project.id === projection.selectedProjectId);
    const selection = selected
      ? { projectId: selected.id, projectName: selected.name }
      : null;
    this.#publishSelection(selection);
    return selection;
  }

  async listMemberChanges(
    projectId: string,
    signal?: AbortSignal,
  ): Promise<CollabComposerReferenceCollection<CollabComposerMemberChange>> {
    const availability = this.availabilityGeneration;
    const feature = await this.#requireFeature(signal);
    this.#throwIfUnavailable(signal, availability);
    const coordination = this.#unwrap(await feature.readSnapshot(projectId, { signal }), signal, availability);
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

  async readOpenTicketPage(
    request: CollabComposerTicketPageRequest,
    signal?: AbortSignal,
  ): Promise<CollabComposerTicketPage> {
    const availability = this.availabilityGeneration;
    const feature = await this.#requireFeature(signal);
    this.#throwIfUnavailable(signal, availability);
    const projection = this.#unwrap(await feature.listTickets({
      ...request, limit: 50, status: 'open',
    }, { signal }), signal, availability);
    if (request.cursor && projection.page.nextCursor === request.cursor) {
      throw new Error('Collab ticket pagination returned a repeated cursor.');
    }
    return {
      items: projection.page.tickets.map(ticket => ({ number: ticket.number, ticketId: ticket.id, title: ticket.title })),
      ...(projection.page.nextCursor ? { nextCursor: projection.page.nextCursor } : {}),
      source: projection.source,
      stale: projection.stale,
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
    this.availabilityGeneration += 1;
    this.featureSelectionGeneration += 1;
    this.featureSubscription?.dispose();
    this.featureSubscription = null;
    this.hasSelectionSnapshot = !this.isEnabled();
    this.lastSelection = null;
    for (const listener of this.listeners) listener(null);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.featureSubscription?.dispose();
    this.featureSubscription = null;
    this.listeners.clear();
  }

  async #requireFeature(signal?: AbortSignal): Promise<CollabFeaturePort> {
    if (!this.isEnabled()) {
      throw new DOMException('Collab is disabled in this Vault.', 'AbortError');
    }
    const feature = await this.resolve(signal);
    if (feature) return feature;
    throw new Error('Collab is unavailable in this Vault.');
  }

  private async resolve(signal?: AbortSignal): Promise<CollabFeaturePort | null> {
    this.#throwIfUnavailable(signal);
    const availability = this.availabilityGeneration;
    const feature = await this.resolveFeature();
    this.#throwIfUnavailable(signal, availability);
    if (feature) this.#ensureFeatureSubscription(feature);
    return feature;
  }

  #ensureFeatureSubscription(feature: CollabFeaturePort): void {
    if (this.featureSubscription || this.disposed) return;
    let initialState = true;
    const availability = this.availabilityGeneration;
    this.featureSubscription = feature.subscribe(state => {
      if (this.disposed || availability !== this.availabilityGeneration) return;
      if (initialState) {
        initialState = false;
        return;
      }
      this.#handleFeatureState(state);
    });
  }

  #handleFeatureState(state: CollabFeatureState): void {
    this.featureSelectionGeneration += 1;
    const selectedProjectId = resolveEffectiveCollabProjectId(
      state.projects,
      state.selectedProjectId,
    );
    const selected = state.projects.find(project => project.id === selectedProjectId);
    this.#publishSelection(selected
      ? { projectId: selected.id, projectName: selected.name }
      : null);
  }

  #publishSelection(selection: CollabComposerSelection | null): void {
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

  #unwrap<T>(result: CollabResult<T>, signal: AbortSignal | undefined, availability: number): T {
    this.#throwIfUnavailable(signal, availability);
    if (result.status === 'success') return result.value;
    if (result.status === 'cancelled') {
      throw new DOMException('The Collab reference read was cancelled.', 'AbortError');
    }
    this.#throwIfUnavailable(signal);
    throw result.error;
  }

  #throwIfUnavailable(signal?: AbortSignal, availability = this.availabilityGeneration): void {
    if (signal?.aborted || this.disposed || !this.isEnabled() || availability !== this.availabilityGeneration) {
      throw new DOMException('The Collab reference read was cancelled.', 'AbortError');
    }
  }
}
