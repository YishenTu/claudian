import type {
  CollabComposerMemberChange,
  CollabComposerReferenceCollection,
  CollabComposerReferencePort,
  CollabComposerSelection,
  CollabComposerTicket,
} from '@/core/collab';
import { CollabMemberChangesFolder } from '@/features/chat/composer/CollabMemberChangesFolder';
import { CollabTicketReferenceSource } from '@/features/chat/composer/CollabTicketReferenceSource';

function createReferences(overrides: Partial<CollabComposerReferencePort> = {}): CollabComposerReferencePort {
  return {
    getSelection: jest.fn(async () => ({ projectId: 'project-1', projectName: 'Project One' })),
    listMemberChanges: jest.fn(async (): Promise<CollabComposerReferenceCollection<CollabComposerMemberChange>> => ({
      items: [],
      source: 'online',
      stale: false,
    })),
    listOpenTickets: jest.fn(async (): Promise<CollabComposerReferenceCollection<CollabComposerTicket>> => ({
      items: [],
      source: 'online',
      stale: false,
    })),
    subscribeSelection: jest.fn(() => ({ dispose: jest.fn() })),
    ...overrides,
  };
}

describe('Collab composer sources', () => {
  it("adds Member's Changes only when a Project is selected", async () => {
    const noSelection = createReferences({
      getSelection: jest.fn(async () => null),
    });
    expect(await new CollabMemberChangesFolder(noSelection).getRootItems(new AbortController().signal))
      .toEqual([]);

    const references = createReferences();
    const [folder] = await new CollabMemberChangesFolder(references)
      .getRootItems(new AbortController().signal);
    expect(folder?.label).toBe("Member's Changes");
  });

  it('resolves the current selection inside every folder load', async () => {
    let selection: CollabComposerSelection | null = {
      projectId: 'project-1',
      projectName: 'Project One',
    };
    const references = createReferences({
      getSelection: jest.fn(async () => selection),
      listMemberChanges: jest.fn(async (projectId: string) => ({
        items: [{
          currentMember: false,
          displayName: `Member of ${projectId}`,
          memberId: 'member-1',
          requestId: 'request-1',
        }],
        source: 'online' as const,
        stale: false,
      })),
    });
    const folder = new CollabMemberChangesFolder(references);
    const [root] = await folder.getRootItems(new AbortController().signal);

    selection = { projectId: 'project-2', projectName: 'Project Two' };
    const items = await root!.load('', new AbortController().signal);

    expect(items[0]?.label).toBe('Member of project-2');
  });

  it('inserts a pure-text Member Changes reference and disables duplicate names', async () => {
    const collection: CollabComposerReferenceCollection<{
      currentMember: boolean;
      displayName: string;
      memberId: string;
      requestId: string;
    }> = {
      items: [
        { currentMember: true, displayName: 'Alice', memberId: 'member-1', requestId: 'request-1' },
        { currentMember: false, displayName: 'Alex', memberId: 'member-2', requestId: 'request-2' },
        { currentMember: false, displayName: 'Alex', memberId: 'member-3', requestId: 'request-3' },
      ],
      source: 'online',
      stale: false,
    };
    const references = createReferences({
      listMemberChanges: jest.fn(async () => collection),
    });
    const [folder] = await new CollabMemberChangesFolder(references)
      .getRootItems(new AbortController().signal);
    const items = await folder!.load('', new AbortController().signal);
    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        detail: 'You',
        replacement: "@Alice's Changes ",
      }),
      expect.objectContaining({ label: 'Alex', disabled: true }),
    ]));
  });

  it('matches Ticket references only at a token boundary and inserts #number text', async () => {
    const references = createReferences({
      listOpenTickets: jest.fn(async (): Promise<CollabComposerReferenceCollection<CollabComposerTicket>> => ({
        items: [{ number: 12, ticketId: 'ticket-1', title: 'Fix composer menu' }],
        source: 'online',
        stale: false,
      })),
    });
    const source = new CollabTicketReferenceSource(references);
    expect(source.match('word#12', 7)).toBeNull();
    expect(source.match('# ', 2)).toBeNull();
    const match = source.match('Review #comp', 12)!;
    const [item] = await source.load(match, new AbortController().signal);
    expect(item).toEqual(expect.objectContaining({ replacement: '#12 ' }));
    source.destroy();
  });

  it('rejects a Ticket result after the selected Project changes', async () => {
    let selection: CollabComposerSelection | null = {
      projectId: 'project-1',
      projectName: 'Project One',
    };
    let listener: ((value: CollabComposerSelection | null) => void) | null = null;
    const references = createReferences({
      getSelection: jest.fn(async () => selection),
      listOpenTickets: jest.fn(async (): Promise<CollabComposerReferenceCollection<CollabComposerTicket>> => {
        selection = { projectId: 'project-2', projectName: 'Project Two' };
        listener?.(selection);
        return { items: [], source: 'online', stale: false };
      }),
      subscribeSelection: jest.fn(callback => {
        listener = callback;
        return { dispose: jest.fn() };
      }),
    });
    const source = new CollabTicketReferenceSource(references);
    const match = source.match('#', 1)!;
    await expect(source.load(match, new AbortController().signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    source.destroy();
  });
});
