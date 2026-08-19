/** @jest-environment jsdom */

import 'obsidian';

import { type CollabTicketDetail } from '@claudian/collab-protocol';
import { EditorView } from '@codemirror/view';

import { type CollabCoordinationSnapshot } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';
import {
  TicketEditorPanel,
  type TicketEditorPanelOptions,
  type TicketMutationKind,
} from '@/features/collab/detail/ticket/TicketEditorPanel';
import { MutationIntentStore } from '@/features/collab/shared/MutationIntentStore';

const CREATED_AT = '2026-08-10T00:00:00.000Z';
const COMMENTED_EARLY_AT = '2026-08-10T00:01:00.000Z';
const ACCEPTED_AT = '2026-08-10T00:02:00.000Z';
const COMMENTED_LATE_AT = '2026-08-10T00:03:00.000Z';
const renderMarkdown = jest.fn(async (markdown: string, host: HTMLElement) => {
  host.setText(markdown);
});

function createTicketEditorPanel(
  root: HTMLElement,
  options: Omit<TicketEditorPanelOptions, 'mutationIntents'>,
): TicketEditorPanel {
  return new TicketEditorPanel(root, {
    ...options,
    mutationIntents: new MutationIntentStore<TicketMutationKind>(),
  });
}

describe('TicketEditorPanel', () => {
  beforeEach(() => {
    renderMarkdown.mockClear();
  });

  it('creates a ticket from the main editor and routes to its detail state', async () => {
    const detail = ticketDetail();
    const onCreated = jest.fn();
    const port = ticketPort();
    port.createTicket.mockResolvedValue({ status: 'success', value: detail });
    const root = document.createElement('div');
    const panel = createTicketEditorPanel(root, {
      onCreated,
      port,
      projectId: 'project-a',
      renderMarkdown,
    });

    await panel.open();
    const title = root.querySelector<HTMLInputElement>('[data-field="ticket-title"]')!;
    title.value = 'Fix publish retry';
    setMarkdownValue(
      root.querySelector<HTMLElement>('[data-field="ticket-body"]')!,
      'The retry should preserve the description.',
    );
    root.querySelector<HTMLFormElement>('form')?.dispatchEvent(new Event('submit', {
      bubbles: true,
      cancelable: true,
    }));
    await nextTurn();

    expect(port.createTicket).toHaveBeenCalledWith({
      body: 'The retry should preserve the description.',
      intentId: expect.any(String),
      projectId: 'project-a',
      title: 'Fix publish retry',
    });
    expect(onCreated).toHaveBeenCalledWith(detail.ticket.id);
    expect(root.closest('.claudian-collab-ticket-list')).toBeNull();
  });

  it('starts in Markdown display mode and exposes editing only to Manager or author', async () => {
    const detail = ticketDetail();
    const port = ticketPort();
    port.readTicket.mockResolvedValue(ticketRead(detail));
    port.updateTicketContent.mockResolvedValue({
      status: 'success',
      value: { ...detail.ticket, revision: 4, title: 'Updated title' },
    });
    const root = document.createElement('div');
    const panel = createTicketEditorPanel(root, {
      onCreated: jest.fn(),
      port,
      projectId: 'project-a',
      renderMarkdown,
      ticketId: detail.ticket.id,
    });

    await panel.open();
    const header = root.querySelector('.claudian-collab-ticket-detail-header')!;
    expect(header.querySelector('h2')?.textContent).toBe('Fix publish retry#17');
    expect(header.querySelector('.claudian-collab-ticket-detail-title')?.textContent)
      .toBe('Fix publish retry');
    expect(header.querySelector('.claudian-collab-ticket-detail-number')?.textContent)
      .toBe('#17');
    expect(header.querySelector('[data-action="toggle-ticket-status"]')?.textContent)
      .toBe('Open');
    expect(header.textContent).not.toContain('Assignee');
    expect(header.querySelector('[data-field="ticket-assignee"]')).toBeNull();
    expect(header.querySelector('[data-action="edit-ticket"]')).not.toBeNull();
    expect(root.querySelector('[data-field="ticket-title"]')).toBeNull();
    expect(root.querySelector('[data-field="ticket-body"]')).toBeNull();
    expect(renderMarkdown).toHaveBeenCalledWith('Ticket body', expect.any(HTMLElement));
    root.querySelector<HTMLButtonElement>('[data-action="edit-ticket"]')?.click();

    const title = root.querySelector<HTMLInputElement>('[data-field="ticket-title"]')!;
    expect(title.value).toBe(detail.ticket.title);
    const body = root.querySelector<HTMLElement>('[data-field="ticket-body"]')!;
    expect(markdownValue(body)).toBe(detail.body);
    expect(body.querySelector('textarea')).toBeNull();
    const bodyHeader = body.parentElement?.querySelector<HTMLElement>(
      ':scope > .claudian-collab-ticket-field-header',
    );
    expect(bodyHeader?.querySelector(':scope > span')?.textContent).toBe('Description');
    expect(bodyHeader?.querySelector('.claudian-collab-markdown-draft-modes'))
      .not.toBeNull();
    expect(body.querySelector(':scope > .claudian-collab-markdown-draft-modes')).toBeNull();
    title.value = 'Updated title';
    setMarkdownValue(body, 'Updated **body**');
    root.querySelector<HTMLButtonElement>('[data-action="save-ticket"]')?.click();
    await nextTurn();

    expect(port.updateTicketContent).toHaveBeenCalledWith({
      body: 'Updated **body**',
      expectedRevision: 3,
      intentId: expect.any(String),
      projectId: 'project-a',
      ticketId: 'ticket-a',
      title: 'Updated title',
    });
  });

  it('updates Open/Closed status directly from its control', async () => {
    const detail = ticketDetail();
    const port = ticketPort();
    port.readTicket.mockResolvedValue(ticketRead(detail));
    port.closeTicket.mockResolvedValue({
      status: 'success',
      value: { ...detail.ticket, revision: 4, status: 'closed' },
    });
    const root = document.createElement('div');
    const panel = createTicketEditorPanel(root, {
      onCreated: jest.fn(),
      port,
      projectId: 'project-a',
      renderMarkdown,
      ticketId: detail.ticket.id,
    });

    await panel.open();
    expect(root.querySelector('[data-field="ticket-assignee"]')).toBeNull();

    const status = root.querySelector<HTMLButtonElement>(
      '[data-action="toggle-ticket-status"]',
    )!;
    expect(status.textContent).toBe('Open');
    status.click();
    await nextTurn();
    expect(port.closeTicket).toHaveBeenCalledWith({
      expectedRevision: 3,
      intentId: expect.any(String),
      projectId: 'project-a',
      ticketId: 'ticket-a',
    });
  });

  it('reuses the create intent when retrying the same draft after a lost response', async () => {
    const detail = ticketDetail();
    const port = ticketPort();
    port.createTicket
      .mockResolvedValueOnce({
        error: new CollabError({ code: 'operation-failed' }),
        status: 'failure',
      })
      .mockResolvedValueOnce({ status: 'success', value: detail });
    const root = document.createElement('div');
    const panel = createTicketEditorPanel(root, {
      onCreated: jest.fn(),
      port,
      projectId: 'project-a',
      renderMarkdown,
    });
    await panel.open();
    root.querySelector<HTMLInputElement>('[data-field="ticket-title"]')!.value = 'Retry';
    setMarkdownValue(
      root.querySelector<HTMLElement>('[data-field="ticket-body"]')!,
      'Same draft',
    );
    const form = root.querySelector<HTMLFormElement>('form')!;

    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await nextTurn();
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await nextTurn();

    const firstIntent = port.createTicket.mock.calls[0]?.[0].intentId;
    const secondIntent = port.createTicket.mock.calls[1]?.[0].intentId;
    expect(firstIntent).toEqual(expect.any(String));
    expect(secondIntent).toBe(firstIntent);
  });

  it('reuses the comment intent when retrying the same draft after a lost response', async () => {
    const detail = ticketDetail();
    const port = ticketPort();
    port.readTicket.mockResolvedValue(ticketRead(detail));
    port.addTicketComment
      .mockResolvedValueOnce({
        error: new CollabError({ code: 'operation-failed' }),
        status: 'failure',
      })
      .mockResolvedValueOnce({
        status: 'success',
        value: {
          authorMemberId: 'member-a',
          body: 'Same comment',
          createdAt: COMMENTED_EARLY_AT,
          id: 'comment-retry',
          ticketId: detail.ticket.id,
        },
      });
    const root = document.createElement('div');
    const panel = createTicketEditorPanel(root, {
      onCreated: jest.fn(),
      port,
      projectId: 'project-a',
      renderMarkdown,
      ticketId: detail.ticket.id,
    });
    await panel.open();
    setMarkdownValue(
      root.querySelector<HTMLElement>('[data-field="ticket-comment"]')!,
      'Same comment',
    );
    const submit = root.querySelector<HTMLButtonElement>(
      '[data-action="submit-ticket-comment"]',
    )!;

    submit.click();
    await nextTurn();
    submit.click();
    await nextTurn();

    const firstIntent = port.addTicketComment.mock.calls[0]?.[0].intentId;
    const secondIntent = port.addTicketComment.mock.calls[1]?.[0].intentId;
    expect(firstIntent).toEqual(expect.any(String));
    expect(secondIntent).toBe(firstIntent);
  });

  it('rotates the comment intent after refreshed detail consumes success', async () => {
    const detail = ticketDetail();
    const port = ticketPort();
    port.readTicket.mockResolvedValue(ticketRead(detail));
    port.addTicketComment.mockResolvedValue({
      status: 'success',
      value: {
        authorMemberId: 'member-a',
        body: 'Repeated comment',
        createdAt: COMMENTED_EARLY_AT,
        id: 'comment-success',
        ticketId: detail.ticket.id,
      },
    });
    const root = document.createElement('div');
    const panel = createTicketEditorPanel(root, {
      onCreated: jest.fn(),
      port,
      projectId: 'project-a',
      renderMarkdown,
      ticketId: detail.ticket.id,
    });
    await panel.open();

    setMarkdownValue(
      root.querySelector<HTMLElement>('[data-field="ticket-comment"]')!,
      'Repeated comment',
    );
    root.querySelector<HTMLButtonElement>('[data-action="submit-ticket-comment"]')!.click();
    await nextTurn();
    setMarkdownValue(
      root.querySelector<HTMLElement>('[data-field="ticket-comment"]')!,
      'Repeated comment',
    );
    root.querySelector<HTMLButtonElement>('[data-action="submit-ticket-comment"]')!.click();
    await nextTurn();

    const firstIntent = port.addTicketComment.mock.calls[0]?.[0].intentId;
    const secondIntent = port.addTicketComment.mock.calls[1]?.[0].intentId;
    expect(secondIntent).not.toBe(firstIntent);
  });

  it('does not replace a newer view when a mutation completes after destroy', async () => {
    const detail = ticketDetail();
    const pending = deferred<Awaited<ReturnType<
      TicketEditorPanelOptions['port']['closeTicket']
    >>>();
    const port = ticketPort();
    port.readTicket.mockResolvedValue(ticketRead(detail));
    port.closeTicket.mockReturnValue(pending.promise);
    const root = document.createElement('div');
    const panel = createTicketEditorPanel(root, {
      onCreated: jest.fn(),
      port,
      projectId: 'project-a',
      renderMarkdown,
      ticketId: detail.ticket.id,
    });
    await panel.open();

    root.querySelector<HTMLButtonElement>(
      '[data-action="toggle-ticket-status"]',
    )!.click();
    panel.destroy();
    root.setText('New detail view');
    pending.resolve({
      status: 'success',
      value: { ...detail.ticket, revision: 4, status: 'closed' },
    });
    await nextTurn();

    expect(root.textContent).toBe('New detail view');
    expect(port.readSnapshot).toHaveBeenCalledTimes(1);
  });

  it('does not route a created Ticket after its panel is destroyed', async () => {
    const detail = ticketDetail();
    const pending = deferred<Awaited<ReturnType<
      TicketEditorPanelOptions['port']['createTicket']
    >>>();
    const onCreated = jest.fn();
    const port = ticketPort();
    port.createTicket.mockReturnValue(pending.promise);
    const root = document.createElement('div');
    const panel = createTicketEditorPanel(root, {
      onCreated,
      port,
      projectId: 'project-a',
      renderMarkdown,
    });
    await panel.open();
    root.querySelector<HTMLInputElement>('[data-field="ticket-title"]')!.value = 'Late';
    setMarkdownValue(
      root.querySelector<HTMLElement>('[data-field="ticket-body"]')!,
      'Late create',
    );
    root.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit', {
      bubbles: true,
      cancelable: true,
    }));

    panel.destroy();
    root.setText('New detail view');
    pending.resolve({ status: 'success', value: detail });
    await nextTurn();

    expect(onCreated).not.toHaveBeenCalled();
    expect(root.textContent).toBe('New detail view');
  });

  it('orders accepted references and comments together from oldest to newest', async () => {
    const detail: CollabTicketDetail = {
      ...ticketDetail(),
      acceptedRelations: [{
        ...ticketDetail().acceptedRelations[0]!,
        acceptedAt: ACCEPTED_AT,
      }],
      comments: [{
        authorMemberId: 'member-a',
        body: 'Late comment',
        createdAt: COMMENTED_LATE_AT,
        id: 'comment-late',
        ticketId: 'ticket-a',
      }, {
        authorMemberId: 'member-a',
        body: 'Early comment',
        createdAt: COMMENTED_EARLY_AT,
        id: 'comment-early',
        ticketId: 'ticket-a',
      }],
    };
    const port = ticketPort();
    port.readTicket.mockResolvedValue(ticketRead(detail));
    const root = document.createElement('div');
    const panel = createTicketEditorPanel(root, {
      onCreated: jest.fn(),
      port,
      projectId: 'project-a',
      renderMarkdown,
      ticketId: detail.ticket.id,
    });

    await panel.open();

    expect([...root.querySelectorAll<HTMLElement>('[data-activity-kind]')]
      .map(item => item.dataset.activityKind)).toEqual([
      'comment',
      'resolves',
      'comment',
    ]);
    expect(root.textContent).not.toContain('Accepted changes');
    expect(root.querySelector('.claudian-collab-ticket-activity > h3')?.textContent)
      .toBe('Activity (3)');
    expect(root.querySelector('.claudian-collab-ticket-activity')?.classList)
      .toContain('has-entries');
  });

  it('hides an empty Activity heading while keeping the comment composer', async () => {
    const detail: CollabTicketDetail = {
      ...ticketDetail(),
      acceptedRelations: [],
      comments: [],
    };
    const port = ticketPort();
    port.readTicket.mockResolvedValue(ticketRead(detail));
    const root = document.createElement('div');
    const panel = createTicketEditorPanel(root, {
      onCreated: jest.fn(),
      port,
      projectId: 'project-a',
      renderMarkdown,
      ticketId: detail.ticket.id,
    });

    await panel.open();

    expect(root.querySelector('.claudian-collab-ticket-activity > h3')).toBeNull();
    expect(root.querySelector('.claudian-collab-ticket-timeline')).toBeNull();
    expect(root.querySelector('.claudian-collab-ticket-activity')?.classList)
      .not.toContain('has-entries');
    expect(root.querySelector('[data-field="ticket-comment"]')).not.toBeNull();
  });

  it('previews the comment draft as Markdown without losing its editable text', async () => {
    const detail = ticketDetail();
    const port = ticketPort();
    port.readTicket.mockResolvedValue(ticketRead(detail));
    const root = document.createElement('div');
    const panel = createTicketEditorPanel(root, {
      onCreated: jest.fn(),
      port,
      projectId: 'project-a',
      renderMarkdown,
      ticketId: detail.ticket.id,
    });

    await panel.open();
    const draft = root.querySelector<HTMLElement>('[data-field="ticket-comment"]')!;
    setMarkdownValue(draft, 'Preview **this** comment');
    root.querySelector<HTMLButtonElement>('[data-action="preview-ticket-comment"]')?.click();

    const preview = draft.querySelector<HTMLElement>(
      '.claudian-collab-markdown-draft-preview',
    )!;
    expect(draft.querySelector<HTMLElement>('.claudian-collab-markdown-draft-editor')?.hidden)
      .toBe(true);
    expect(preview.hidden).toBe(false);
    expect(renderMarkdown).toHaveBeenLastCalledWith(
      'Preview **this** comment',
      preview,
    );

    root.querySelector<HTMLButtonElement>('[data-action="edit-ticket-comment"]')?.click();
    expect(draft.querySelector<HTMLElement>('.claudian-collab-markdown-draft-editor')?.hidden)
      .toBe(false);
    expect(preview.hidden).toBe(true);
    expect(markdownValue(draft)).toBe('Preview **this** comment');
    const commentButton = root.querySelector<HTMLButtonElement>(
      '[data-action="submit-ticket-comment"]',
    );
    expect(commentButton?.parentElement).toBe(root.querySelector(
      '.claudian-collab-comment-modes',
    ));
  });

  it('links Ticket references in sent descriptions, comments, and Preview', async () => {
    const detail: CollabTicketDetail = {
      ...ticketDetail(),
      body: 'Description references #17.',
      comments: [{
        authorMemberId: 'member-a',
        body: 'Comment references #17.',
        createdAt: COMMENTED_EARLY_AT,
        id: 'comment-a',
        ticketId: 'ticket-a',
      }],
    };
    const port = ticketPort();
    port.readTicket.mockResolvedValue(ticketRead(detail));
    const onOpenTicket = jest.fn();
    const root = document.createElement('div');
    const panel = createTicketEditorPanel(root, {
      onCreated: jest.fn(),
      onOpenTicket,
      port,
      projectId: 'project-a',
      renderMarkdown,
      ticketId: detail.ticket.id,
    });

    await panel.open();
    await nextTurn();
    const sentReferences = root.querySelectorAll<HTMLButtonElement>(
      '.claudian-collab-markdown-ticket-reference',
    );
    expect(sentReferences).toHaveLength(2);
    sentReferences[0]?.click();
    expect(onOpenTicket).toHaveBeenCalledWith(17);

    const draft = root.querySelector<HTMLElement>('[data-field="ticket-comment"]')!;
    setMarkdownValue(draft, 'Preview references #17.');
    root.querySelector<HTMLButtonElement>('[data-action="preview-ticket-comment"]')?.click();
    await nextTurn();
    draft.querySelector<HTMLButtonElement>(
      '.claudian-collab-markdown-ticket-reference',
    )?.click();
    expect(onOpenTicket).toHaveBeenLastCalledWith(17);
  });

  it('offers Ticket reference syntax from Ticket descriptions and comments', async () => {
    const detail = ticketDetail();
    const port = ticketPort();
    port.readTicket.mockResolvedValue(ticketRead(detail));
    const root = document.createElement('div');
    const panel = createTicketEditorPanel(root, {
      onCreated: jest.fn(),
      port,
      projectId: 'project-a',
      renderMarkdown,
      ticketId: detail.ticket.id,
    });

    await panel.open();
    const comment = root.querySelector<HTMLElement>('[data-field="ticket-comment"]')!;
    setMarkdownValue(comment, 'Related #');
    const commentView = markdownEditor(comment);
    commentView.dispatch({ selection: { anchor: commentView.state.doc.length } });
    comment.querySelector<HTMLButtonElement>(
      '.claudian-collab-markdown-suggestion',
    )?.click();

    expect(markdownValue(comment)).toBe('Related #17 ');

    root.querySelector<HTMLButtonElement>('[data-action="edit-ticket"]')?.click();
    expect(root.querySelector(
      '[data-field="ticket-body"] .claudian-collab-markdown-suggestions',
    )).not.toBeNull();
  });

  it('offers active Member completion in Ticket descriptions and comments', async () => {
    const detail = ticketDetail();
    const port = ticketPort();
    const online = coordination();
    port.readSnapshot.mockResolvedValue({
      status: 'success',
      value: {
        ...online,
        snapshot: {
          ...online.snapshot,
          members: [...online.snapshot.members, {
            activatedAt: CREATED_AT,
            createdAt: CREATED_AT,
            displayName: 'Bob Builder',
            id: 'member-bob',
            personalRef: 'refs/heads/members/member-bob',
            role: 'member',
            status: 'active',
          }],
        },
      },
    });
    port.readTicket.mockResolvedValue(ticketRead(detail));
    const root = document.createElement('div');
    const panel = createTicketEditorPanel(root, {
      onCreated: jest.fn(),
      port,
      projectId: 'project-a',
      renderMarkdown,
      ticketId: detail.ticket.id,
    });

    await panel.open();
    const comment = root.querySelector<HTMLElement>('[data-field="ticket-comment"]')!;
    setMarkdownValue(comment, 'Please ask @bo');
    const commentView = markdownEditor(comment);
    commentView.dispatch({ selection: { anchor: commentView.state.doc.length } });
    const suggestion = comment.querySelector<HTMLButtonElement>(
      '.claudian-collab-markdown-suggestion',
    );
    expect(suggestion?.textContent).toBe('Bob Builder');
    suggestion?.click();
    expect(markdownValue(comment)).toBe('Please ask @Bob Builder ');

    root.querySelector<HTMLButtonElement>('[data-action="edit-ticket"]')?.click();
    const body = root.querySelector<HTMLElement>('[data-field="ticket-body"]')!;
    setMarkdownValue(body, 'Owner @bo');
    const bodyView = markdownEditor(body);
    bodyView.dispatch({ selection: { anchor: bodyView.state.doc.length } });
    expect(body.querySelector('.claudian-collab-markdown-suggestion')?.textContent)
      .toBe('Bob Builder');
  });

  it('does not offer an ambiguous active Member display name', async () => {
    const detail = ticketDetail();
    const port = ticketPort();
    const online = coordination();
    const duplicateMembers = ['member-bob-a', 'member-bob-b'].map(id => ({
      activatedAt: CREATED_AT,
      createdAt: CREATED_AT,
      displayName: 'Bob Builder',
      id,
      personalRef: `refs/heads/members/${id}`,
      role: 'member' as const,
      status: 'active' as const,
    }));
    port.readSnapshot.mockResolvedValue({
      status: 'success',
      value: {
        ...online,
        snapshot: {
          ...online.snapshot,
          members: [...online.snapshot.members, ...duplicateMembers],
        },
      },
    });
    port.readTicket.mockResolvedValue(ticketRead(detail));
    const root = document.createElement('div');
    const panel = createTicketEditorPanel(root, {
      onCreated: jest.fn(),
      port,
      projectId: 'project-a',
      renderMarkdown,
      ticketId: detail.ticket.id,
    });

    await panel.open();
    const comment = root.querySelector<HTMLElement>('[data-field="ticket-comment"]')!;
    setMarkdownValue(comment, 'Please ask @bo');
    const view = markdownEditor(comment);
    view.dispatch({ selection: { anchor: view.state.doc.length } });

    expect(comment.querySelector('.claudian-collab-markdown-suggestion')).toBeNull();
  });

  it('renders cached Ticket detail read-only even when coordination is still online', async () => {
    const detail = ticketDetail();
    const port = ticketPort();
    port.readTicket.mockResolvedValue({
      status: 'success',
      value: { detail, source: 'cache', stale: true },
    });
    const root = document.createElement('div');
    const panel = createTicketEditorPanel(root, {
      onCreated: jest.fn(),
      port,
      projectId: 'project-a',
      renderMarkdown,
      ticketId: detail.ticket.id,
    });

    await panel.open();

    expect(root.querySelector('[data-state="ticket-offline-read-only"]')).not.toBeNull();
    expect(root.querySelector<HTMLButtonElement>('[data-action="toggle-ticket-status"]')?.disabled)
      .toBe(true);
    expect(root.querySelector('[data-action="edit-ticket"]')).toBeNull();
    expect(root.querySelector('[data-field="ticket-comment"]')).toBeNull();
    expect(renderMarkdown).toHaveBeenCalledWith(detail.body, expect.any(HTMLElement));
  });

  it('does not expose Ticket creation from a cached offline snapshot', async () => {
    const port = ticketPort();
    const cached = coordination();
    port.readSnapshot.mockResolvedValue({
      status: 'success',
      value: {
        ...cached,
        source: 'cache',
        stale: true,
        syncState: { ...cached.syncState, status: 'offline' },
      },
    });
    const root = document.createElement('div');
    const panel = createTicketEditorPanel(root, {
      onCreated: jest.fn(),
      port,
      projectId: 'project-a',
      renderMarkdown,
    });

    await panel.open();

    expect(root.querySelector('[data-state="ticket-offline-read-only"]')).not.toBeNull();
    expect(root.querySelector('form')).toBeNull();
    expect(port.createTicket).not.toHaveBeenCalled();
  });

  it('does not expose content editing to a Member who is not the author', async () => {
    const detail = ticketDetail();
    const port = ticketPort();
    port.readSnapshot.mockResolvedValue({
      status: 'success',
      value: coordination('member-other', 'member'),
    });
    port.readTicket.mockResolvedValue(ticketRead(detail));
    const root = document.createElement('div');
    const panel = createTicketEditorPanel(root, {
      onCreated: jest.fn(),
      port,
      projectId: 'project-a',
      renderMarkdown,
      ticketId: detail.ticket.id,
    });

    await panel.open();

    const header = root.querySelector('.claudian-collab-ticket-detail-header')!;
    expect(header.textContent).toContain('Open');
    expect(header.querySelector('[data-field="ticket-assignee"]')).toBeNull();
    expect(root.querySelector('[data-action="edit-ticket"]')).toBeNull();
    expect(root.querySelector('[data-field="ticket-title"]')).toBeNull();
    expect(root.querySelector('[data-field="ticket-body"]')).toBeNull();
  });
});

function ticketPort(): jest.Mocked<TicketEditorPanelOptions['port']> {
  return {
    addTicketComment: jest.fn(),
    closeTicket: jest.fn(),
    createTicket: jest.fn(),
    readSnapshot: jest.fn().mockResolvedValue({
      status: 'success',
      value: coordination(),
    }),
    readTicket: jest.fn(),
    reopenTicket: jest.fn(),
    updateTicketContent: jest.fn(),
  };
}

function ticketDetail(): CollabTicketDetail {
  return {
    acceptedRelations: [{
      acceptedAt: ACCEPTED_AT,
      acceptedMergeOid: 'b'.repeat(40),
      commitOid: 'a'.repeat(40),
      id: 'relation-a',
      kind: 'resolves',
      requestId: 'request-a',
    }],
    body: 'Ticket body',
    comments: [],
    ticket: {
      authorMemberId: 'member-a',
      commentCount: 0,
      createdAt: CREATED_AT,
      id: 'ticket-a',
      number: 17,
      revision: 3,
      status: 'open',
      title: 'Fix publish retry',
      updatedAt: CREATED_AT,
    },
  };
}

function ticketRead(detail: CollabTicketDetail) {
  return {
    status: 'success' as const,
    value: { detail, source: 'online' as const, stale: false },
  };
}

function coordination(
  currentMemberId = 'member-a',
  currentRole: 'manager' | 'member' = 'manager',
): CollabCoordinationSnapshot {
  const author = {
    activatedAt: CREATED_AT,
    createdAt: CREATED_AT,
    displayName: 'Alice',
    id: 'member-a',
    personalRef: 'refs/heads/members/member-a',
    role: 'manager' as const,
    status: 'active' as const,
  };
  const currentMember = currentMemberId === author.id
    ? { ...author, role: currentRole }
    : {
      activatedAt: CREATED_AT,
      createdAt: CREATED_AT,
      displayName: 'Other member',
      id: currentMemberId,
      personalRef: `refs/heads/members/${currentMemberId}`,
      role: currentRole,
      status: 'active' as const,
    };
  return {
    snapshot: {
      currentMember,
      eventSequence: 4,
      members: currentMember.id === author.id ? [currentMember] : [author, currentMember],
      openRequests: [],
      openTicketCount: 1,
      project: {
        authorityKind: 'lan',
        createdAt: CREATED_AT,
        hostMemberId: author.id,
        id: 'project-a',
        mainOid: 'c'.repeat(40),
        mainRef: 'refs/heads/main',
        managerSetGeneration: 0,
        name: 'Project A',
      },
      ticketHighlights: [ticketDetail().ticket],
    },
    source: 'online',
    stale: false,
    syncState: {
      eventSequence: 4,
      generation: 1,
      projectId: 'project-a',
      status: 'synchronized',
    },
  };
}

async function nextTurn(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
}

function markdownEditor(root: HTMLElement): EditorView {
  const view = EditorView.findFromDOM(root.querySelector<HTMLElement>('.cm-editor')!);
  if (!view) throw new Error('CodeMirror editor not found');
  return view;
}

function markdownValue(root: HTMLElement): string {
  return markdownEditor(root).state.doc.toString();
}

function setMarkdownValue(root: HTMLElement, value: string): void {
  const view = markdownEditor(root);
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
