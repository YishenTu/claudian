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

  private readonly listeners = new Set<() => void>();
  private selectionGeneration = 0;
  private readonly selectionSubscription: CollabComposerReferenceSubscription;

  constructor(private readonly references: CollabComposerReferencePort) {
    this.selectionSubscription = references.subscribeSelection(() => {
      this.selectionGeneration += 1;
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
    const selection = await this.references.getSelection(signal);
    if (!selection) return [];
    const generation = this.selectionGeneration;
    const collection = await this.references.listOpenTickets(selection.projectId, signal);
    const currentSelection = await this.references.getSelection(signal);
    if (
      generation !== this.selectionGeneration
      || currentSelection?.projectId !== selection.projectId
    ) {
      throw new DOMException('The selected Collab Project changed.', 'AbortError');
    }
    const query = match.query.toLocaleLowerCase();
    return collection.items
      .filter(ticket => (
        String(ticket.number).includes(query)
        || ticket.title.toLocaleLowerCase().includes(query)
      ))
      .map(ticket => ({
        detail: collection.stale ? 'Offline cache' : ticket.title,
        icon: 'circle-dot',
        id: `collab-ticket:${ticket.ticketId}`,
        kind: 'value',
        label: `#${ticket.number} ${ticket.title}`,
        replacement: `#${ticket.number} `,
      }));
  }

  match(input: string, cursor: number): ComposerTriggerMatch | null {
    const before = input.slice(0, cursor);
    const index = before.lastIndexOf('#');
    if (index < 0 || (index > 0 && !/\s/.test(before[index - 1]))) return null;
    const query = before.slice(index + 1);
    if (/\s/.test(query)) return null;
    return {
      atInputStart: index === 0,
      end: cursor,
      query,
      start: index,
      trigger: '#',
    };
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
