import type {
  CollabComposerReferencePort,
  CollabComposerReferenceSubscription,
} from '@/core/collab';
import type {
  ComposerDropdownItem,
  ComposerDropdownSource,
  ComposerDropdownValueItem,
  ComposerSelectionAction,
  ComposerTriggerMatch,
} from '@/shared/composer-dropdown';

export class CollabTicketReferenceSource implements ComposerDropdownSource {
  readonly id = 'collab-tickets';
  readonly inputLoadPolicy = 'debounced';

  private readonly listeners = new Set<() => void>();
  private invalidationGeneration = 0;
  private currentQuery: string | null = null;
  private readonly selectionSubscription: CollabComposerReferenceSubscription;

  constructor(private readonly references: CollabComposerReferencePort) {
    this.selectionSubscription = references.subscribeSelection(() => {
      this.invalidationGeneration += 1;
      for (const listener of this.listeners) listener();
    });
  }

  destroy(): void {
    this.selectionSubscription.dispose();
    this.listeners.clear();
  }

  async load(
    match: ComposerTriggerMatch,
    signal: AbortSignal,
  ): Promise<readonly ComposerDropdownItem[]> {
    return this.#loadPage(match.query, signal);
  }

  async #loadPage(queryText: string, signal: AbortSignal, continuation?: { projectId: string; generation: number; cursor: string }): Promise<readonly ComposerDropdownItem[]> {
    this.#setQuery(queryText);
    const generation = this.invalidationGeneration;
    const selection = await this.references.getSelection(signal);
    if (!selection) return [];
    const cursor = continuation?.projectId === selection.projectId && continuation.generation === generation ? continuation.cursor : undefined;
    const collection = await this.references.readOpenTicketPage({ projectId: selection.projectId, ...(cursor ? { cursor } : {}) }, signal);
    const currentSelection = await this.references.getSelection(signal);
    if (
      generation !== this.invalidationGeneration
      || currentSelection?.projectId !== selection.projectId
    ) {
      throw new DOMException('The selected Collab Project changed.', 'AbortError');
    }
    const query = queryText.toLocaleLowerCase();
    const items: ComposerDropdownItem[] = collection.items
      .filter(ticket => (
        String(ticket.number).includes(query)
        || ticket.title.toLocaleLowerCase().includes(query)
      ))
      .map(ticket => ({
        detail: collection.stale ? 'Offline cache' : ticket.title,
        icon: 'circle-dot',
        id: `collab-ticket:${ticket.ticketId}`,
        kind: 'value' as const,
        label: `#${ticket.number} ${ticket.title}`,
        replacement: `#${ticket.number} `,
      }));
    if (collection.nextCursor) {
      if (items.length === 0) items.push({ id: 'page-empty', kind: 'status', state: 'empty', label: 'No matches on this page' });
      const next = { projectId: selection.projectId, generation, cursor: collection.nextCursor };
      items.push({
        id: 'collab-tickets-next', kind: 'folder', label: 'More tickets',
        detail: queryText ? 'Search the next page' : 'Show the next page',
        load: (nextQuery, nextSignal) => this.#loadPage(nextQuery, nextSignal, next),
      });
    }
    return items;
  }

  match(input: string, cursor: number): ComposerTriggerMatch | null {
    if (!this.references.isAvailable()) {
      this.#setQuery(null);
      return null;
    }
    const before = input.slice(0, cursor);
    const index = before.lastIndexOf('#');
    if (index < 0 || (index > 0 && !/\s/.test(before[index - 1]))) { this.#setQuery(null); return null; }
    const query = before.slice(index + 1);
    if (/\s/.test(query)) { this.#setQuery(null); return null; }
    this.#setQuery(query);
    return {
      atInputStart: index === 0,
      end: cursor,
      query,
      start: index,
      trigger: '#',
    };
  }

  #setQuery(query: string | null): void {
    if (query === this.currentQuery) return;
    this.currentQuery = query;
    this.invalidationGeneration += 1;
  }

  select(
    item: ComposerDropdownValueItem,
    _match: ComposerTriggerMatch,
  ): ComposerSelectionAction {
    return { kind: 'replace', text: item.replacement };
  }

  subscribeInvalidation(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
