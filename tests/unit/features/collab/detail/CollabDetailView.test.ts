/** @jest-environment jsdom */

import { type CollabTicketDetail } from '@claudian/collab-protocol';
import { EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { MarkdownRenderer, setIcon, type WorkspaceLeaf } from 'obsidian';

import { type CollabAcceptOutcome, type CollabConflictDescriptor, type CollabCoordinationSnapshot, type CollabPublicationReview, type CollabRequestReview, type CollabReviewFileContent, type CollabWorkingTreeReview } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';
import type {
  CollabDetailViewPort,
  CollabPublicationDetailViewState,
  CollabRequestDetailViewState,
  CollabTicketDetailViewState,
  CollabWorkingTreeDetailViewState,
} from '@/features/collab/detail/CollabDetailContracts';
import {
  COLLAB_DETAIL_VIEW_TYPE,
  type CollabDetailDiffPort,
  type CollabDetailObjectUrlPort,
  CollabDetailView,
  CollabDetailViewCoordinator,
} from '@/features/collab/detail/CollabDetailView';
import { CollabPreparedReviewCache } from '@/features/collab/handoff/CollabPreparedReviewCache';

const MAIN = '1'.repeat(40);
const HEAD = '2'.repeat(40);
const TREE = '3'.repeat(40);

describe('CollabDetailView', () => {
  it('retains restored state without subscribing or loading while admission is closed', async () => {
    const port = detailPort(requestReview());
    port.isDetailAdmissionOpen.mockReturnValue(false);
    const view = createView(port, diffPort(), objectUrlPort());

    await view.setState(viewState(), { history: false });
    await view.onOpen();
    await nextTurn();

    expect(view.getState()).toEqual(viewState());
    expect(port.subscribe).not.toHaveBeenCalled();
    expect(port.prepareReview).not.toHaveBeenCalled();
    expect(port.readSnapshot).not.toHaveBeenCalled();
  });

  it('retains restored Ticket state without subscribing or loading while admission is closed', async () => {
    const port = detailPort(requestReview());
    port.isDetailAdmissionOpen.mockReturnValue(false);
    const view = createView(port, diffPort(), objectUrlPort());
    const state: CollabTicketDetailViewState = {
      kind: 'ticket',
      projectId: 'project-a',
      ticketId: 'ticket-a',
    };

    await view.setState(state, { history: false });
    await view.onOpen();
    await nextTurn();

    expect(view.getState()).toEqual(state);
    expect(port.subscribe).not.toHaveBeenCalled();
    expect(port.readTicket).not.toHaveBeenCalled();
  });

  it('validates restored detail identifiers by their semantic contracts', async () => {
    const port = detailPort(requestReview());
    port.isDetailAdmissionOpen.mockReturnValue(false);
    const view = createView(port, diffPort(), objectUrlPort());
    const projectId = `p${'a'.repeat(63)}`;
    const ticketId = `t${'b'.repeat(127)}`;

    await expect(view.setState({
      kind: 'ticket',
      projectId,
      ticketId,
    }, { history: false })).resolves.toBeUndefined();
    await expect(view.setState({
      kind: 'ticket',
      projectId: `p${'a'.repeat(64)}`,
    }, { history: false })).rejects.toBeInstanceOf(CollabError);
    await expect(view.setState({
      kind: 'ticket',
      projectId,
      ticketId: `t${'b'.repeat(128)}`,
    }, { history: false })).rejects.toBeInstanceOf(CollabError);
  });

  it('distinguishes Git OIDs from the working-tree snapshot digest', async () => {
    const port = detailPort(requestReview());
    port.isDetailAdmissionOpen.mockReturnValue(false);
    const view = createView(port, diffPort(), objectUrlPort());
    const state = {
      baseOid: 'a'.repeat(40),
      headOid: 'b'.repeat(64),
      kind: 'working-tree' as const,
      projectId: 'project-a',
      snapshotId: 'c'.repeat(64),
    };

    await expect(view.setState(state, { history: false })).resolves.toBeUndefined();
    await expect(view.setState({
      ...state,
      snapshotId: 'c'.repeat(40),
    }, { history: false })).rejects.toBeInstanceOf(CollabError);
  });

  it('loads normally once admission is open', async () => {
    const review = requestReview();
    const port = detailPort(review);
    const view = createView(port, diffPort(), objectUrlPort());

    await view.onOpen();
    await view.setState(viewState(), { history: false });
    await nextTurn();

    expect(port.subscribe).toHaveBeenCalled();
    expect(port.prepareReview).toHaveBeenCalledWith(
      'project-a',
      'request-a',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
  it('previews the working tree locally and publishes only from the review header', async () => {
    const review = workingTreeReview();
    const port = detailPort(requestReview());
    const renderer = diffPort();
    const leaf = {
      detach: jest.fn(),
      setViewState: jest.fn().mockResolvedValue(undefined),
    } as unknown as WorkspaceLeaf;
    port.prepareWorkingTreeReview.mockResolvedValue({ status: 'success', value: review });
    port.readWorkingTreeReviewFile.mockResolvedValue({
      status: 'success',
      value: {
        file: review.files[0],
        kind: 'text',
        newText: 'working\n',
        oldText: 'head\n',
      },
    });
    port.publish.mockResolvedValue({
      status: 'success',
      value: {
        localHeadOid: HEAD,
        projectId: 'project-a',
        state: 'pushed',
      },
    });
    const view = createView(port, renderer, objectUrlPort(), undefined, leaf);

    await view.setState(workingTreeViewState(), { history: false });
    await nextTurn();

    expect(port.prepareWorkingTreeReview).toHaveBeenCalledWith(
      'project-a',
      MAIN,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(port.publish).not.toHaveBeenCalled();
    expect(view.contentEl.textContent).not.toContain('Ready to publish');
    expect(view.contentEl.querySelector<HTMLButtonElement>(
      '[data-collab-action="publish-working-tree"]',
    )?.textContent).toBe('Publish');
    expect(view.contentEl.querySelector<HTMLButtonElement>(
      '[data-collab-action="publish-working-tree"]',
    )?.disabled).toBe(true);

    const publish = view.contentEl.querySelector<HTMLButtonElement>(
      '[data-collab-action="publish-working-tree"]',
    )!;
    expect(publish.title).toBe('Add a description before publishing.');
    const reviewHeader = publish.parentElement!;
    const description = view.contentEl.querySelector<HTMLElement>(
      '[data-collab-description="true"]',
    )!;
    expect(description.querySelector('.cm-placeholder')).toBeNull();
    const descriptionHeader = view.contentEl.querySelector<HTMLElement>(
      '.claudian-collab-request-description-header',
    )!;
    expect(descriptionHeader.querySelector(
      '.claudian-collab-request-description-header > span',
    )?.textContent).toBe('Description');
    expect(reviewHeader.classList.contains('has-primary-action')).toBe(true);
    expect(descriptionHeader.querySelector('.claudian-collab-review-summary')?.textContent)
      .toBe('1 changed files');
    expect(descriptionHeader.querySelector('.claudian-collab-review-metadata-line')?.parentElement)
      .toBe(descriptionHeader);
    const editDescription = view.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="edit-publish-description"]',
    );
    const previewDescription = view.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="preview-publish-description"]',
    );
    expect(editDescription?.parentElement).toBe(previewDescription?.parentElement);
    expect(editDescription?.parentElement?.classList)
      .toContain('claudian-collab-request-description-modes');
    setMarkdownValue(description, 'Published change');
    expect(description.querySelector('textarea')).toBeNull();
    expect(publish.disabled).toBe(false);
    expect(publish.hasAttribute('title')).toBe(false);

    publish.click();
    await nextTurn();

    expect(port.publish).toHaveBeenCalledWith(
      { description: 'Published change', projectId: 'project-a' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(leaf.detach).toHaveBeenCalledTimes(1);
  });

  it('restores a local description draft and inserts canonical Ticket syntax', async () => {
    const review = workingTreeReview();
    const port = detailPort(requestReview());
    port.prepareWorkingTreeReview.mockResolvedValue({ status: 'success', value: review });
    port.readPublishDescription.mockResolvedValue({
      status: 'success',
      value: 'Investigate Resolves #',
    });
    const value = coordination(requestReview());
    port.readSnapshot.mockResolvedValue({
      status: 'success',
      value: {
        ...value,
        snapshot: {
          ...value.snapshot,
          openTicketCount: 1,
          ticketHighlights: [{
            authorMemberId: 'member-a',
            commentCount: 0,
            createdAt: '2026-08-08T00:00:00.000Z',
            id: 'ticket-a',
            number: 17,
            revision: 1,
            status: 'open',
            title: 'Preserve publish description',
            updatedAt: '2026-08-08T00:00:00.000Z',
          }],
        },
      },
    });
    const view = createView(port, diffPort(), objectUrlPort());

    await view.setState(workingTreeViewState(), { history: false });
    const description = view.contentEl.querySelector<HTMLElement>(
      '[data-collab-description="true"]',
    )!;
    const descriptionView = markdownEditor(description);
    descriptionView.dispatch({
      selection: EditorSelection.cursor(descriptionView.state.doc.length),
    });
    view.contentEl.querySelector<HTMLButtonElement>(
      '.claudian-collab-markdown-suggestion',
    )?.click();

    expect(markdownValue(description)).toBe('Investigate Resolves #17 ');
    expect(view.contentEl.querySelector('.claudian-collab-description-relations')).toBeNull();
  });

  it('prefers the owning member local draft over stale authority metadata', async () => {
    const request = requestReview();
    const review = workingTreeReview();
    const port = detailPort(request);
    const snapshot = coordination(request);
    port.prepareWorkingTreeReview.mockResolvedValue({ status: 'success', value: review });
    port.readPublishDescription.mockResolvedValue({
      status: 'success',
      value: 'Local unsynchronized description',
    });
    port.readSnapshot.mockResolvedValue({
      status: 'success',
      value: {
        ...snapshot,
        snapshot: {
          ...snapshot.snapshot,
          currentMember: member('member-a', 'Member A'),
        },
      },
    });
    const view = createView(port, diffPort(), objectUrlPort());

    await view.setState(workingTreeViewState(), { history: false });

    const description = view.contentEl.querySelector<HTMLElement>(
      '[data-collab-description="true"]',
    )!;
    expect(markdownValue(description)).toBe('Local unsynchronized description');
    expect(view.contentEl.textContent).toContain('Local draft — not synced.');
  });

  it('saves a new description on an existing empty request and advances its revision', async () => {
    const base = requestReview();
    const review: CollabRequestReview = {
      ...base,
      detail: {
        ...base.detail,
        request: { ...base.detail.request, description: '' },
      },
    };
    const port = detailPort(review);
    const ownerSnapshot = coordination(review);
    port.readSnapshot.mockResolvedValue({
      status: 'success',
      value: {
        ...ownerSnapshot,
        snapshot: {
          ...ownerSnapshot.snapshot,
          currentMember: member('member-a', 'Member A'),
        },
      },
    });
    port.updateRequestMetadata
      .mockResolvedValueOnce({
        status: 'success',
        value: { ...review.detail.request, description: 'First description', revision: 2 },
      })
      .mockResolvedValueOnce({
        status: 'success',
        value: { ...review.detail.request, description: 'Second description', revision: 3 },
      });
    const view = createView(port, diffPort(), objectUrlPort());

    await view.setState(viewState(), { history: false });
    await nextTurn();
    const description = view.contentEl.querySelector<HTMLElement>(
      '[data-collab-description="true"]',
    )!;
    const descriptionHeader = view.contentEl.querySelector<HTMLElement>(
      '.claudian-collab-request-description-header',
    )!;
    const overviewControls = view.contentEl.querySelector<HTMLElement>(
      '.claudian-collab-review-overview-controls',
    )!;
    const openEditor = overviewControls.querySelector<HTMLButtonElement>(
      '[data-action="open-request-description-editor"]',
    )!;
    expect(descriptionHeader.querySelector(':scope > span')).toBeNull();
    expect(descriptionHeader.contains(openEditor)).toBe(false);
    expect(openEditor.parentElement).toBe(overviewControls);
    const descriptionModes = view.contentEl.querySelector<HTMLElement>(
      '.claudian-collab-request-description-modes',
    )!;
    const edit = descriptionModes.querySelector<HTMLButtonElement>(
      '[data-action="edit-publish-description"]',
    )!;
    const preview = descriptionModes.querySelector<HTMLButtonElement>(
      '[data-action="preview-publish-description"]',
    )!;
    const save = descriptionModes.querySelector<HTMLButtonElement>(
      '[data-action="submit-request-description"]',
    )!;

    expect(setIcon).toHaveBeenCalledWith(openEditor, 'pencil');
    expect(edit.parentElement).toBe(preview.parentElement);
    expect(edit.parentElement).toBe(save.parentElement);
    expect(descriptionModes.hidden).toBe(true);
    expect(description.dataset.markdownMode).toBe('preview');
    expect(description.querySelector<HTMLElement>(
      '.claudian-collab-markdown-draft-editor',
    )?.hidden).toBe(true);

    openEditor.click();
    expect(openEditor.hidden).toBe(true);
    expect(descriptionModes.hidden).toBe(false);
    expect(description.dataset.markdownMode).toBe('edit');
    setMarkdownValue(description, 'First description');
    save.click();
    await nextTurn();
    expect(port.updateRequestMetadata).toHaveBeenLastCalledWith(expect.objectContaining({
      description: 'First description',
      expectedRequestRevision: 1,
    }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(description.dataset.markdownMode).toBe('preview');
    expect(descriptionModes.hidden).toBe(true);
    expect(openEditor.hidden).toBe(false);
    expect(view.contentEl.textContent).not.toContain('Description saved.');

    openEditor.click();
    setMarkdownValue(description, 'Second description');
    save.click();
    await nextTurn();
    expect(port.updateRequestMetadata).toHaveBeenLastCalledWith(expect.objectContaining({
      description: 'Second description',
      expectedRequestRevision: 2,
    }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('reuses one request-description intent when retrying the same draft', async () => {
    const review = requestReview();
    const port = detailPort(review);
    const ownerSnapshot = coordination(review);
    port.readSnapshot.mockResolvedValue({
      status: 'success',
      value: {
        ...ownerSnapshot,
        snapshot: {
          ...ownerSnapshot.snapshot,
          currentMember: member('member-a', 'Member A'),
        },
      },
    });
    port.updateRequestMetadata
      .mockResolvedValueOnce({
        error: new CollabError({ code: 'operation-failed' }),
        status: 'failure',
      })
      .mockResolvedValueOnce({
        status: 'success',
        value: { ...review.detail.request, description: 'Retried draft', revision: 2 },
      });
    const view = createView(port, diffPort(), objectUrlPort());
    await view.setState(viewState(), { history: false });
    const description = view.contentEl.querySelector<HTMLElement>(
      '[data-collab-description="true"]',
    )!;
    view.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="open-request-description-editor"]',
    )!.click();
    setMarkdownValue(description, 'Retried draft');
    const save = view.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="submit-request-description"]',
    )!;

    save.click();
    await nextTurn();
    save.click();
    await nextTurn();

    const firstRequest = port.updateRequestMetadata.mock.calls[0]?.[0];
    const secondRequest = port.updateRequestMetadata.mock.calls[1]?.[0];
    expect(firstRequest?.intentId).toEqual(expect.any(String));
    expect(secondRequest?.intentId).toBe(firstRequest?.intentId);
    expect(port.updateRequestMetadata).toHaveBeenLastCalledWith(
      expect.objectContaining({ description: 'Retried draft' }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('ignores a request-description acknowledgement after navigating to another review', async () => {
    const request = requestReview();
    const pending = deferred<ReturnType<typeof successfulMetadataUpdate>>();
    const port = detailPort(request);
    const ownerSnapshot = coordination(request);
    port.readSnapshot.mockResolvedValue({
      status: 'success',
      value: {
        ...ownerSnapshot,
        snapshot: {
          ...ownerSnapshot.snapshot,
          currentMember: member('member-a', 'Member A'),
        },
      },
    });
    port.updateRequestMetadata.mockReturnValue(pending.promise);
    const working = workingTreeReview();
    port.prepareWorkingTreeReview.mockResolvedValue({ status: 'success', value: working });
    const view = createView(port, diffPort(), objectUrlPort());
    await view.setState(viewState(), { history: false });
    const description = view.contentEl.querySelector<HTMLElement>(
      '[data-collab-description="true"]',
    )!;
    view.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="open-request-description-editor"]',
    )!.click();
    setMarkdownValue(description, 'Late description');
    view.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="submit-request-description"]',
    )!.click();
    await nextTurn();
    const signal = port.updateRequestMetadata.mock.calls[0]?.[1]?.signal;

    await view.setState(workingTreeViewState(), { history: false });
    pending.resolve(successfulMetadataUpdate(request, 'Late description'));
    await nextTurn();

    expect(signal?.aborted).toBe(true);
    expect(view.getState()).toMatchObject({ kind: 'working-tree' });
    expect(view.contentEl.textContent).toContain('Review before publishing');
  });

  it('preserves newer same-revision review state after saving a description', async () => {
    const request = requestReview();
    const pending = deferred<ReturnType<typeof successfulMetadataUpdate>>();
    const port = detailPort(request);
    const ownerSnapshot = coordination(request);
    port.readSnapshot.mockResolvedValue({
      status: 'success',
      value: {
        ...ownerSnapshot,
        snapshot: {
          ...ownerSnapshot.snapshot,
          currentMember: member('member-a', 'Member A'),
        },
      },
    });
    port.updateRequestMetadata.mockReturnValue(pending.promise);
    let invalidate: (() => void) | undefined;
    port.subscribe.mockImplementation(listener => {
      invalidate = listener;
      return { dispose: jest.fn() };
    });
    const view = createView(port, diffPort(), objectUrlPort());
    await view.onOpen();
    await view.setState(viewState(), { history: false });
    const description = view.contentEl.querySelector<HTMLElement>(
      '[data-collab-description="true"]',
    )!;
    view.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="open-request-description-editor"]',
    )!.click();
    setMarkdownValue(description, 'Updated description');
    view.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="submit-request-description"]',
    )!.click();

    const concurrentComment = {
      authorMemberId: 'member-b',
      body: 'Concurrent feedback',
      createdAt: '2026-08-08T00:01:00.000Z',
      id: 'comment-concurrent',
      requestId: request.detail.request.id,
    };
    const concurrentReview: CollabRequestReview = {
      ...request,
      canAccept: false,
      detail: {
        ...request.detail,
        comments: { comments: [concurrentComment] },
        request: { ...request.detail.request, commentCount: 1 },
      },
    };
    port.readSnapshot.mockResolvedValue({
      status: 'success',
      value: coordination(concurrentReview),
    });
    port.prepareReview.mockResolvedValue({ status: 'success', value: concurrentReview });
    invalidate?.();
    await nextTurn();
    pending.resolve(successfulMetadataUpdate(request, 'Updated description'));
    await nextTurn();

    expect(view.contentEl.textContent).toContain('Comments (1)');
    expect(view.contentEl.textContent).toContain('Updated description');
  });

  it('opens a request on Overview and loads the diff only after selecting Changes', async () => {
    const base = requestReview();
    const review: CollabRequestReview = {
      ...base,
      detail: {
        ...base.detail,
        comments: {
          comments: [{
          authorMemberId: 'member-reviewer',
          body: 'Overview feedback',
          createdAt: '2026-08-08T00:01:00.000Z',
          id: 'comment-a',
          requestId: 'request-a',
        }],
        },
      },
    };
    const port = detailPort(review);
    const renderer = diffPort();
    const view = createView(port, renderer, objectUrlPort());

    await view.setState(viewState(), { history: false });
    await nextTurn();

    const overview = view.contentEl.querySelector<HTMLButtonElement>(
      '[role="tab"][aria-selected="true"]',
    );
    const overviewControls = view.contentEl.querySelector<HTMLElement>(
      '.claudian-collab-review-overview-controls',
    )!;
    const changesControls = view.contentEl.querySelector<HTMLElement>(
      '.claudian-collab-review-changes-controls',
    )!;
    expect(overview?.textContent).toBe('Overview');
    expect(overviewControls.hidden).toBe(false);
    expect(changesControls.hidden).toBe(true);
    expect((MarkdownRenderer.render as jest.Mock).mock.calls.map(call => call[1]))
      .toEqual(expect.arrayContaining(['Published change', 'Overview feedback']));
    expect(port.readReviewFile).not.toHaveBeenCalled();
    expect(renderer.render).not.toHaveBeenCalled();

    [...view.contentEl.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
      .find(button => button.textContent === 'Changes (2)')?.click();
    await nextTurn();

    expect(overviewControls.hidden).toBe(true);
    expect(changesControls.hidden).toBe(false);
    expect(port.readReviewFile).toHaveBeenCalled();
    expect(renderer.render).toHaveBeenCalled();
  });

  it('shows immutable Request comments in Overview', async () => {
    const base = requestReview();
    const review: CollabRequestReview = {
      ...base,
      detail: {
        ...base.detail,
        comments: {
          comments: [{
          authorMemberId: 'member-reviewer',
          body: 'Overview feedback',
          createdAt: '2026-08-08T00:01:00.000Z',
          id: 'comment-stale',
          requestId: 'request-a',
        }],
        },
      },
    };
    const view = createView(detailPort(review), diffPort(), objectUrlPort());

    await view.setState(viewState(), { history: false });

    expect(view.contentEl.querySelector('[data-request-comment-id="comment-stale"]'))
      .not.toBeNull();
    expect((MarkdownRenderer.render as jest.Mock).mock.calls.map(call => call[1]))
      .toContain('Overview feedback');
  });

  it('submits a Request-level comment from the shared Markdown composer', async () => {
    const review = requestReview();
    const port = detailPort(review);
    port.addComment.mockResolvedValue({
      status: 'success',
      value: {
        authorMemberId: 'member-reviewer',
        body: 'General feedback',
        createdAt: '2026-08-08T00:01:00.000Z',
        id: 'comment-general',
        requestId: 'request-a',
      },
    });
    const view = createView(port, diffPort(), objectUrlPort());

    await view.setState(viewState(), { history: false });
    const commentsTitle = view.contentEl.querySelector<HTMLElement>(
      '.claudian-collab-request-comments > h3',
    )!;
    const commentsList = view.contentEl.querySelector<HTMLElement>(
      '.claudian-collab-request-comment-list',
    )!;
    const commentsSection = commentsTitle.parentElement!;
    expect(commentsSection.classList.contains('has-entries')).toBe(false);
    expect(commentsTitle.hidden).toBe(true);
    expect(commentsList.hidden).toBe(true);
    expect(view.contentEl.querySelector('.claudian-collab-request-comments-empty'))
      .toBeNull();
    const composer = view.contentEl.querySelector<HTMLElement>(
      '[data-field="request-comment"]',
    )!;
    setMarkdownValue(composer, 'General feedback');
    view.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="submit-request-comment"]',
    )?.click();
    await nextTurn();
    await nextTurn();

    expect(port.addComment).toHaveBeenCalledWith({
      body: 'General feedback',
      intentId: expect.stringMatching(/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/),
      projectId: 'project-a',
      requestId: 'request-a',
    });
    expect(view.contentEl.querySelector(
      '[data-request-comment-id="comment-general"]',
    )).not.toBeNull();
    expect(commentsTitle.hidden).toBe(false);
    expect(commentsTitle.textContent).toBe('Comments (1)');
    expect(commentsList.hidden).toBe(false);
    expect(commentsSection.classList.contains('has-entries')).toBe(true);
    expect((MarkdownRenderer.render as jest.Mock).mock.calls.map(call => call[1]))
      .toContain('General feedback');
    expect(markdownValue(composer)).toBe('');
  });

  it('retains a request-comment intent only while retrying the exact body', async () => {
    const review = requestReview();
    const port = detailPort(review);
    port.addComment
      .mockResolvedValueOnce({
        error: new CollabError({ code: 'operation-failed' }),
        status: 'failure',
      })
      .mockResolvedValueOnce({
        error: new CollabError({ code: 'operation-failed' }),
        status: 'failure',
      })
      .mockResolvedValueOnce({
        status: 'success',
        value: {
          authorMemberId: 'member-reviewer',
          body: 'Edited feedback',
          createdAt: '2026-08-08T00:01:00.000Z',
          id: 'comment-edited',
          requestId: 'request-a',
        },
      });
    const view = createView(port, diffPort(), objectUrlPort());
    await view.setState(viewState(), { history: false });
    const composer = view.contentEl.querySelector<HTMLElement>(
      '[data-field="request-comment"]',
    )!;
    const submit = view.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="submit-request-comment"]',
    )!;
    setMarkdownValue(composer, 'Original feedback');

    submit.click();
    await nextTurn();
    submit.click();
    await nextTurn();
    setMarkdownValue(composer, 'Edited feedback');
    submit.click();
    await nextTurn();

    const firstIntent = port.addComment.mock.calls[0]?.[0].intentId;
    const unchangedRetryIntent = port.addComment.mock.calls[1]?.[0].intentId;
    const editedRetryIntent = port.addComment.mock.calls[2]?.[0].intentId;
    expect(firstIntent).toEqual(expect.any(String));
    expect(unchangedRetryIntent).toBe(firstIntent);
    expect(editedRetryIntent).not.toBe(firstIntent);
  });

  it('rotates a request-comment intent after the current UI consumes success', async () => {
    const review = requestReview();
    const port = detailPort(review);
    port.addComment
      .mockResolvedValueOnce({
        status: 'success',
        value: {
          authorMemberId: 'member-reviewer',
          body: 'Repeated feedback',
          createdAt: '2026-08-08T00:01:00.000Z',
          id: 'comment-first',
          requestId: 'request-a',
        },
      })
      .mockResolvedValueOnce({
        status: 'success',
        value: {
          authorMemberId: 'member-reviewer',
          body: 'Repeated feedback',
          createdAt: '2026-08-08T00:02:00.000Z',
          id: 'comment-second',
          requestId: 'request-a',
        },
      });
    const view = createView(port, diffPort(), objectUrlPort());
    await view.setState(viewState(), { history: false });
    const composer = view.contentEl.querySelector<HTMLElement>(
      '[data-field="request-comment"]',
    )!;
    const submit = view.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="submit-request-comment"]',
    )!;

    setMarkdownValue(composer, 'Repeated feedback');
    submit.click();
    await nextTurn();
    setMarkdownValue(composer, 'Repeated feedback');
    submit.click();
    await nextTurn();

    const firstIntent = port.addComment.mock.calls[0]?.[0].intentId;
    const secondIntent = port.addComment.mock.calls[1]?.[0].intentId;
    expect(secondIntent).not.toBe(firstIntent);
  });

  it('opens a Preview Ticket reference in a new detail tab', async () => {
    const review = workingTreeReview();
    const port = detailPort(requestReview());
    port.prepareWorkingTreeReview.mockResolvedValue({ status: 'success', value: review });
    port.listTickets.mockResolvedValue({
      status: 'success',
      value: {
        page: {
          tickets: [{
            authorMemberId: 'member-a',
            commentCount: 0,
            createdAt: '2026-08-08T00:00:00.000Z',
            id: 'ticket-a',
            number: 17,
            revision: 1,
            status: 'open',
            title: 'Preview reference',
            updatedAt: '2026-08-08T00:00:00.000Z',
          }],
        },
        source: 'online',
        stale: false,
      },
    });
    const openTicketInNewTab = jest.fn().mockResolvedValue(undefined);
    const render = MarkdownRenderer.render as jest.Mock;
    const previousRender = render.getMockImplementation();
    render.mockImplementation(async (
      _app: unknown,
      markdown: string,
      host: HTMLElement,
    ) => host.setText(markdown));
    const view = createView(
      port,
      diffPort(),
      objectUrlPort(),
      undefined,
      {} as WorkspaceLeaf,
      undefined,
      undefined,
      openTicketInNewTab,
    );

    await view.setState(workingTreeViewState(), { history: false });
    const description = view.contentEl.querySelector<HTMLElement>(
      '[data-collab-description="true"]',
    )!;
    setMarkdownValue(description, 'See #17.');
    view.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="preview-publish-description"]',
    )?.click();
    await nextTurn();
    const reference = description.querySelector<HTMLButtonElement>(
      '.claudian-collab-markdown-ticket-reference',
    );
    expect(reference).not.toBeNull();
    reference?.click();
    await nextTurn();
    if (previousRender) render.mockImplementation(previousRender);

    expect(port.listTickets).toHaveBeenCalledWith({
      limit: 100,
      projectId: 'project-a',
      status: 'open',
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(openTicketInNewTab).toHaveBeenCalledWith('project-a', 'ticket-a');
  });

  it('closes the working-tree review when Publish prepares a final review', async () => {
    const review = workingTreeReview();
    const finalReview = publicationReview();
    const port = detailPort(requestReview());
    const leaf = {
      detach: jest.fn(),
      setViewState: jest.fn().mockResolvedValue(undefined),
    } as unknown as WorkspaceLeaf;
    const preparedReviews = new CollabPreparedReviewCache();
    port.prepareWorkingTreeReview.mockResolvedValue({ status: 'success', value: review });
    port.readWorkingTreeReviewFile.mockResolvedValue({
      status: 'success',
      value: {
        file: review.files[0],
        kind: 'text',
        newText: 'working\n',
        oldText: 'head\n',
      },
    });
    port.publish.mockResolvedValue({
      status: 'success',
      value: {
        localHeadOid: HEAD,
        projectId: 'project-a',
        review: finalReview,
        state: 'review-required',
      },
    });
    const view = createView(
      port,
      diffPort(),
      objectUrlPort(),
      preparedReviews,
      leaf,
    );

    await view.setState(workingTreeViewState(), { history: false });
    await nextTurn();
    const description = view.contentEl.querySelector<HTMLElement>(
      '[data-collab-description="true"]',
    )!;
    setMarkdownValue(description, 'Published change');
    view.contentEl.querySelector<HTMLButtonElement>(
      '[data-collab-action="publish-working-tree"]',
    )?.click();
    await nextTurn();

    expect(preparedReviews.readPublication(publicationViewState(finalReview))).toBe(finalReview);
    expect(leaf.setViewState).not.toHaveBeenCalled();
    expect(leaf.detach).toHaveBeenCalledTimes(1);
  });

  it('opens an unpublished conflict under My changes', async () => {
    const review = workingTreeReview();
    const port = detailPort(requestReview());
    const leaf = {
      detach: jest.fn(),
      setViewState: jest.fn().mockResolvedValue(undefined),
    } as unknown as WorkspaceLeaf;
    port.prepareWorkingTreeReview.mockResolvedValue({ status: 'success', value: review });
    port.readWorkingTreeReviewFile.mockResolvedValue({
      status: 'success',
      value: {
        file: review.files[0],
        kind: 'text',
        newText: 'working\n',
        oldText: 'head\n',
      },
    });
    port.publish.mockResolvedValue({ conflict: conflictDescriptor(), status: 'conflict' });
    const view = createView(port, diffPort(), objectUrlPort(), undefined, leaf);

    await view.setState(workingTreeViewState(), { history: false });
    await nextTurn();
    setMarkdownValue(
      view.contentEl.querySelector<HTMLElement>('[data-collab-description="true"]')!,
      'Resolve locally',
    );
    view.contentEl.querySelector<HTMLButtonElement>(
      '[data-collab-action="publish-working-tree"]',
    )?.click();
    await nextTurn();
    await nextTurn();

    expect(leaf.setViewState).toHaveBeenCalledWith({
      active: true,
      state: {
        kind: 'conflict',
        location: 'my-changes',
        operationId: 'conflict-a',
        projectId: 'project-a',
      },
      type: COLLAB_DETAIL_VIEW_TYPE,
    });
  });

  it('renders publication review without comments and confirms the exact candidate', async () => {
    const review = publicationReview();
    const port = detailPort(requestReview());
    const renderer = diffPort();
    const leaf = {
      detach: jest.fn(),
      setViewState: jest.fn().mockResolvedValue(undefined),
    } as unknown as WorkspaceLeaf;
    port.preparePublicationReview.mockResolvedValue({ status: 'success', value: review });
    port.readPublicationReviewFile.mockResolvedValue({
      status: 'success',
      value: {
        file: review.files[0],
        kind: 'text',
        newText: 'new\n',
        oldText: 'accepted\n',
      },
    });
    port.confirmPublish.mockResolvedValue({
      status: 'success',
      value: {
        localHeadOid: review.candidateOid,
        projectId: review.projectId,
        remoteHeadOid: review.candidateOid,
        state: 'request-synchronized',
      },
    });
    const view = createView(port, renderer, objectUrlPort(), undefined, leaf);

    await view.setState(publicationViewState(), { history: false });
    await nextTurn();
    view.contentEl.querySelector<HTMLButtonElement>('[data-collab-review-scope]')?.click();
    await nextTurn();

    expect(view.contentEl.querySelector('h2')?.textContent).toBe('Review before publishing');
    expect(view.getDisplayText()).toBe('Review before publishing');
    expect(view.contentEl.querySelector('[data-collab-action="accept"]')).toBeNull();
    expect(view.contentEl.querySelector<HTMLButtonElement>(
      '[data-collab-action="confirm-publish"]',
    )?.textContent).toBe('Publish');
    expect(renderer.render).toHaveBeenCalledWith(expect.objectContaining({
      newText: 'new\n',
      oldText: 'accepted\n',
    }));
    expect(port.readPublicationReviewFile).toHaveBeenCalledWith({
      comparisonBaseOid: review.comparisonBaseOid,
      comparisonTargetOid: review.comparisonTargetOid,
      expectedCandidateOid: review.candidateOid,
      expectedMainOid: review.currentMainOid,
      file: review.files[0],
      operationId: review.operationId,
      projectId: review.projectId,
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }));

    const description = view.contentEl.querySelector<HTMLElement>(
      '[data-collab-description="true"]',
    )!;
    setMarkdownValue(description, 'Published change');

    view.contentEl.querySelector<HTMLButtonElement>(
      '[data-collab-action="confirm-publish"]',
    )?.click();
    await nextTurn();

    expect(port.confirmPublish).toHaveBeenCalledWith({
      description: 'Published change',
      expectedCandidateOid: review.candidateOid,
      expectedMainOid: review.currentMainOid,
      operationId: review.operationId,
      projectId: review.projectId,
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(leaf.detach).toHaveBeenCalledTimes(1);
  });

  it('opens a conflict on the current Member existing Request', async () => {
    const request = requestReview();
    const review = publicationReview();
    const port = detailPort(request);
    const leaf = {
      detach: jest.fn(),
      setViewState: jest.fn().mockResolvedValue(undefined),
    } as unknown as WorkspaceLeaf;
    port.preparePublicationReview.mockResolvedValue({ status: 'success', value: review });
    port.readPublicationReviewFile.mockResolvedValue({
      status: 'success',
      value: {
        file: review.files[0],
        kind: 'text',
        newText: 'new\n',
        oldText: 'accepted\n',
      },
    });
    const value = coordination(request);
    port.readSnapshot.mockResolvedValue({
      status: 'success',
      value: {
        ...value,
        snapshot: {
          ...value.snapshot,
          currentMember: value.snapshot.members.find(member => member.id === 'member-a')!,
        },
      },
    });
    port.confirmPublish.mockResolvedValue({
      conflict: conflictDescriptor(),
      status: 'conflict',
    });
    const view = createView(port, diffPort(), objectUrlPort(), undefined, leaf);

    await view.setState(publicationViewState(), { history: false });
    await nextTurn();
    setMarkdownValue(
      view.contentEl.querySelector<HTMLElement>('[data-collab-description="true"]')!,
      'Resolve locally',
    );
    view.contentEl.querySelector<HTMLButtonElement>(
      '[data-collab-action="confirm-publish"]',
    )?.click();
    await nextTurn();
    await nextTurn();

    expect(leaf.setViewState).toHaveBeenCalledWith({
      active: true,
      state: {
        kind: 'conflict',
        location: 'request',
        operationId: 'conflict-a',
        projectId: 'project-a',
        requestId: 'request-a',
      },
      type: COLLAB_DETAIL_VIEW_TYPE,
    });
  });

  it('loads the selected file into a full-width review and revokes binary preview URLs', async () => {
    const review = requestReview();
    const port = detailPort(review);
    const renderer = diffPort();
    const objectUrls = objectUrlPort();
    const view = createView(port, renderer, objectUrls);
    await view.onOpen();

    await view.setState(viewState(), { history: false });
    await openChanges(view);
    expect(port.prepareReview).toHaveBeenCalledWith(
      'project-a',
      'request-a',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(renderer.render).toHaveBeenCalledWith(expect.objectContaining({
      newText: 'new\n',
      oldText: 'old\n',
      path: 'note.md',
    }));
    expect(view.contentEl.querySelector('h2')?.textContent)
      .toBe('Review changes @Member A');
    const accept = view.contentEl.querySelector<HTMLButtonElement>(
      '[data-collab-action="accept"]',
    );
    expect(accept?.parentElement?.classList.contains('claudian-collab-review-header'))
      .toBe(true);
    expect(accept?.parentElement?.classList.contains('is-request')).toBe(true);
    const metadata = accept?.parentElement?.querySelector(
      '.claudian-collab-review-metadata-line',
    );
    const tabs = accept?.parentElement?.querySelector('.claudian-collab-review-tabs');
    expect(metadata).toBeNull();
    expect(accept?.parentElement?.querySelector('.claudian-collab-review-summary')).toBeNull();
    expect(tabs?.querySelector('.claudian-collab-review-condition')?.textContent)
      .toBe('Ready to accept');
    expect(accept?.classList.contains('claudian-collab-review-accept')).toBe(true);
    expect(accept?.classList.contains('mod-cta')).toBe(false);
    expect(view.contentEl.querySelector('.claudian-collab-review-footer')).toBeNull();
    expect(view.contentEl.querySelector('.claudian-collab-comments')).toBeNull();
    expect(view.contentEl.querySelector('[data-collab-file]')).toBeNull();
    expect(view.contentEl.querySelector('.claudian-collab-review-layout')).toBeNull();

    await nextTurn();
    view.contentEl.querySelector<HTMLButtonElement>('[data-collab-review-scope]')?.click();
    await nextTurn();
    objectUrls.create.mockClear();
    objectUrls.revoke.mockClear();
    renderer.clear.mockClear();

    await view.setState({ ...viewState(), selectedPath: 'image.png' }, { history: false });
    expect(renderer.clear).toHaveBeenCalled();
    expect(objectUrls.create).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      'image/png',
    );
    expect(view.contentEl.querySelector('img')?.getAttribute('src')).toBe('blob:preview-1');

    await view.setState(viewState(), { history: false });
    expect(objectUrls.revoke).toHaveBeenCalledWith('blob:preview-1');
    expect(port.prepareReview).toHaveBeenCalledTimes(1);
    expect(port.readSnapshot).toHaveBeenCalledTimes(1);

    await view.onClose();
    expect(renderer.destroy).toHaveBeenCalledTimes(1);
  });

  it('binds each rendered file header to that Project file instead of global metadata', async () => {
    const request = requestReview();
    const review = {
      ...workingTreeReview(),
      files: [
        workingTreeReview().files[0],
        {
          binary: false,
          kind: 'modified' as const,
          largeForReview: false,
          newBytes: 8,
          oldBytes: 5,
          path: 'second.md',
        },
      ],
    };
    const port = detailPort(request);
    port.prepareWorkingTreeReview.mockResolvedValue({ status: 'success', value: review });
    port.readWorkingTreeReviewFile.mockImplementation(async request => ({
      status: 'success',
      value: {
        file: request.file,
        kind: 'text',
        newText: 'working\n',
        oldText: 'head\n',
      },
    }));
    const renderer = diffPort();
    const openProjectFile = jest.fn().mockResolvedValue(undefined);
    const view = createView(
      port,
      renderer,
      objectUrlPort(),
      undefined,
      {} as WorkspaceLeaf,
      undefined,
      openProjectFile,
    );

    await view.setState(workingTreeViewState(), { history: false });
    await nextTurn();

    expect(view.contentEl.querySelector(
      '.claudian-collab-review-metadata-line [data-collab-review-open-file]',
    )).toBeNull();
    const noteInput = renderer.render.mock.calls.find(
      ([input]) => input.path === 'note.md',
    )?.[0];
    noteInput?.onOpenFile?.();
    await nextTurn();

    expect(openProjectFile).toHaveBeenCalledWith('project-a', 'note.md');

    view.contentEl.querySelector<HTMLButtonElement>('[data-collab-review-scope]')?.click();
    await nextTurn();
    await view.setState({ ...workingTreeViewState(), selectedPath: 'second.md' }, {
      history: false,
    });
    await nextTurn();

    const secondInput = [...renderer.render.mock.calls].reverse().find(
      ([input]) => input.path === 'second.md',
    )?.[0];
    secondInput?.onOpenFile?.();
    await nextTurn();

    expect(openProjectFile).toHaveBeenLastCalledWith('project-a', 'second.md');

    await view.setState(viewState(), { history: false });
    await openChanges(view);
    await nextTurn();
    const requestInput = [...renderer.render.mock.calls].reverse().find(
      ([input]) => input.path === 'note.md',
    )?.[0];
    expect(requestInput?.onOpenFile).toBeUndefined();
  });

  it('retains the primary diff renderer across text review kinds', async () => {
    const request = requestReview();
    const working = workingTreeReview();
    const port = detailPort(request);
    port.prepareWorkingTreeReview.mockResolvedValue({ status: 'success', value: working });
    port.readWorkingTreeReviewFile.mockResolvedValue({
      status: 'success',
      value: {
        file: working.files[0],
        kind: 'text',
        newText: 'working\n',
        oldText: 'head\n',
      },
    });
    const renderer = diffPort();
    const view = createView(port, renderer, objectUrlPort());

    await view.setState(viewState(), { history: false });
    await openChanges(view);
    await nextTurn();
    renderer.clear.mockClear();
    renderer.destroy.mockClear();

    await view.setState(workingTreeViewState(), { history: false });
    await nextTurn();

    expect(renderer.clear).not.toHaveBeenCalled();
    expect(renderer.destroy).not.toHaveBeenCalled();
    expect(renderer.render).toHaveBeenLastCalledWith(expect.objectContaining({
      newText: 'working\n',
      oldText: 'head\n',
      path: 'note.md',
    }));
  });

  it('defaults to continuous review and shows the opposite scope and layout actions', async () => {
    const review = requestReview();
    const port = detailPort(review);
    const renderer = diffPort();
    const rendererFactory = jest.fn(() => diffPort());
    const view = createView(
      port,
      renderer,
      objectUrlPort(),
      undefined,
      {} as WorkspaceLeaf,
      rendererFactory,
    );

    await view.setState(viewState(), { history: false });
    await openChanges(view);
    const tabs = view.contentEl.querySelector('.claudian-collab-review-tabs');
    const scope = tabs?.querySelector<HTMLButtonElement>('[data-collab-review-scope]');
    const layout = tabs?.querySelector<HTMLButtonElement>('[data-collab-review-layout]');

    expect(tabs?.querySelectorAll('[data-collab-review-scope]')).toHaveLength(1);
    expect(tabs?.querySelectorAll('[data-collab-review-layout]')).toHaveLength(1);
    expect(scope?.dataset.collabReviewScope).toBe('continuous');
    expect(layout?.dataset.collabReviewLayout).toBe('unified');
    expect(scope?.getAttribute('aria-label')).toBe('Current file');
    expect(layout?.getAttribute('aria-label')).toBe('Side by side');
    expect(scope?.getAttribute('title')).toBeNull();
    expect(layout?.getAttribute('title')).toBeNull();
    expect(setIcon).toHaveBeenCalledWith(scope, 'file');
    expect(setIcon).toHaveBeenCalledWith(layout, 'columns-2');

    layout?.click();
    expect(renderer.setLayout).toHaveBeenLastCalledWith('split');
    expect(layout?.dataset.collabReviewLayout).toBe('split');
    expect(layout?.getAttribute('aria-label')).toBe('Unified');
    expect(setIcon).toHaveBeenLastCalledWith(layout, 'rows-2');

    scope?.click();
    await nextTurn();

    expect(scope?.dataset.collabReviewScope).toBe('file');
    expect(scope?.getAttribute('aria-label')).toBe('All files');
    expect(setIcon).toHaveBeenCalledWith(scope, 'files');
    expect(renderer.clear).toHaveBeenCalled();
    expect(rendererFactory).not.toHaveBeenCalled();
    expect(renderer.render).toHaveBeenLastCalledWith(expect.objectContaining({
      layout: 'split',
      path: 'note.md',
    }));
  });

  it('loads continuous files near the viewport and opens a sidebar-selected file immediately', async () => {
    const previousObserver = globalThis.IntersectionObserver;
    const observe = jest.fn();
    const unobserve = jest.fn();
    class TestIntersectionObserver {
      readonly root = null;
      readonly rootMargin = '600px 0px';
      readonly thresholds = [0];
      readonly disconnect = jest.fn();
      readonly observe = observe;
      readonly takeRecords = jest.fn(() => []);
      readonly unobserve = unobserve;
    }
    Object.defineProperty(globalThis, 'IntersectionObserver', {
      configurable: true,
      value: TestIntersectionObserver,
    });
    try {
      const review = requestReview();
      const port = detailPort(review);
      const view = createView(
        port,
        diffPort(),
        objectUrlPort(),
        undefined,
        {} as WorkspaceLeaf,
        () => diffPort(),
      );
      await view.setState(viewState(), { history: false });
      await openChanges(view);

      expect(observe.mock.calls
        .map(([element]) => (element as HTMLElement).dataset.collabReviewFile)
        .filter(Boolean)).toEqual(['note.md', 'image.png']);
      expect(port.readReviewFile.mock.calls.map(call => call[0].file.path))
        .toEqual(['note.md']);

      await view.setState({
        ...viewState(),
        selectedPath: 'image.png',
      }, { history: false });
      await nextTurn();

      expect(unobserve).toHaveBeenCalledWith(expect.objectContaining({
        dataset: expect.objectContaining({ collabReviewFile: 'image.png' }),
      }));
      expect(port.readReviewFile.mock.calls.map(call => call[0].file.path))
        .toEqual(['note.md', 'image.png']);
    } finally {
      if (previousObserver) {
        Object.defineProperty(globalThis, 'IntersectionObserver', {
          configurable: true,
          value: previousObserver,
        });
      } else {
        Reflect.deleteProperty(globalThis, 'IntersectionObserver');
      }
    }
  });

  it('scrolls within an exact working-tree review when another file is selected', async () => {
    const base = workingTreeReview();
    const secondFile = {
      ...base.files[0],
      path: 'second.md',
    };
    const review: CollabWorkingTreeReview = {
      ...base,
      files: [...base.files, secondFile],
    };
    const port = detailPort(requestReview());
    port.prepareWorkingTreeReview.mockResolvedValue({ status: 'success', value: review });
    port.readWorkingTreeReviewFile.mockImplementation(async request => ({
      status: 'success',
      value: {
        file: request.file,
        kind: 'text',
        newText: 'working\n',
        oldText: 'head\n',
      },
    }));
    const view = createView(port, diffPort(), objectUrlPort());
    const exactState = {
      ...workingTreeViewState(),
      headOid: review.headOid,
      snapshotId: review.snapshotId,
    } as unknown as CollabWorkingTreeDetailViewState;

    await view.setState(exactState, { history: false });
    await nextTurn();
    const header = view.contentEl.querySelector('.claudian-collab-review-header');
    const secondSection = view.contentEl.querySelector<HTMLElement>(
      '[data-collab-review-file="second.md"]',
    )!;
    const scrollIntoView = jest.fn();
    secondSection.scrollIntoView = scrollIntoView;
    port.prepareWorkingTreeReview.mockClear();

    await view.setState({ ...exactState, selectedPath: 'second.md' }, { history: false });
    await nextTurn();

    expect(port.prepareWorkingTreeReview).not.toHaveBeenCalled();
    expect(view.contentEl.querySelector('.claudian-collab-review-header')).toBe(header);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start' });
  });

  it('loads the selected file before serial background files and reuses completed content', async () => {
    const previousObserver = globalThis.IntersectionObserver;
    Reflect.deleteProperty(globalThis, 'IntersectionObserver');
    try {
      const review = requestReview();
      const port = detailPort(review);
      const first = deferred<{
        status: 'success';
        value: Extract<CollabReviewFileContent, { kind: 'binary' | 'text' }>;
      }>();
      port.readReviewFile
        .mockReturnValueOnce(first.promise)
        .mockImplementation(async request => {
          const file = review.files.find(candidate => candidate.path === request.file.path)!;
          return {
            status: 'success',
            value: file.binary
              ? { file, kind: 'binary' }
              : {
                file,
                kind: 'text',
                newText: 'new\n',
                oldText: 'old\n',
              },
          };
        });
      const view = createView(port, diffPort(), objectUrlPort());

      await view.setState(viewState(), { history: false });
      await openChanges(view);

      expect(port.readReviewFile.mock.calls.map(call => call[0].file.path))
        .toEqual(['note.md']);
      first.resolve({
        status: 'success',
        value: {
          file: review.files[0],
          kind: 'text',
          newText: 'new\n',
          oldText: 'old\n',
        },
      });
      await nextTurn();
      await nextTurn();
      expect(port.readReviewFile.mock.calls.map(call => call[0].file.path))
        .toEqual(['note.md', 'image.png']);

      view.contentEl.querySelector<HTMLButtonElement>('[data-collab-review-scope]')?.click();
      await nextTurn();
      expect(port.readReviewFile).toHaveBeenCalledTimes(2);
    } finally {
      if (previousObserver) {
        Object.defineProperty(globalThis, 'IntersectionObserver', {
          configurable: true,
          value: previousObserver,
        });
      }
    }
  });

  it('rebuilds review chrome when a prepared handoff targets another request', async () => {
    const review = requestReview();
    const port = detailPort(review);
    const cache = new CollabPreparedReviewCache();
    cache.store({ coordination: coordination(review), review });
    const view = createView(port, diffPort(), objectUrlPort(), cache);
    await view.setState(viewState(), { history: false });
    const otherHead = '4'.repeat(40);
    const otherTree = '5'.repeat(40);
    const otherReview: CollabRequestReview = {
      ...review,
      comparisonTargetOid: otherTree,
      detail: {
        ...review.detail,
        request: {
          ...review.detail.request,
          id: 'request-b',
          latestHeadOid: otherHead,
          memberId: 'member-b',
        },
        reviewedHeadOid: otherHead,
      },
      files: [{
        binary: false,
        kind: 'added',
        largeForReview: false,
        newBytes: 6,
        path: 'note.md',
      }],
    };
    const otherState: CollabRequestDetailViewState = {
      ...viewState(),
      comparisonTargetOid: otherTree,
      requestId: 'request-b',
      reviewedHeadOid: otherHead,
      selectedPath: 'note.md',
    };
    cache.store({ coordination: coordination(otherReview), review: otherReview });
    port.readSnapshot.mockResolvedValueOnce({
      status: 'success',
      value: coordination(otherReview),
    });

    await view.setState(otherState, { history: false });

    expect(view.contentEl.querySelector('h2')?.textContent)
      .toBe('Review changes @Member B');
  });

  it('sends Accept with the exact reviewed pair and replaces the ready state after merge', async () => {
    const port = detailPort(requestReview());
    const renderer = diffPort();
    const detach = jest.fn();
    const view = createView(
      port,
      renderer,
      objectUrlPort(),
      undefined,
      { detach } as unknown as WorkspaceLeaf,
    );
    await view.onOpen();
    await view.setState(viewState(), { history: false });

    view.contentEl.querySelector<HTMLButtonElement>('[data-collab-action="accept"]')?.click();
    await nextTurn();

    expect(port.acceptRequest).toHaveBeenCalledWith({
      expectedHeadOid: HEAD,
      expectedMainOid: MAIN,
      expectedRequestRevision: 1,
      expectedResolvingTickets: [],
      intentId: expect.any(String),
      projectId: 'project-a',
      requestId: 'request-a',
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(view.contentEl.querySelector('.claudian-collab-review-condition')?.textContent)
      .toBe('Changes accepted');
    expect(view.contentEl.querySelector('.claudian-collab-review-condition')
      ?.classList.contains('is-merged')).toBe(true);
    expect(view.contentEl.querySelector('[data-collab-action="accept"]')).toBeNull();
    expect(detach).toHaveBeenCalledTimes(1);
  });

  it('exposes Accept for any fresh synchronized current Manager', async () => {
    const review = requestReview();
    const port = detailPort(review);
    const projected = coordination(review);
    port.readSnapshot.mockResolvedValue({
      status: 'success',
      value: {
        ...projected,
        snapshot: {
          ...projected.snapshot,
          currentMember: member('member-b', 'Member B', 'manager'),
          members: projected.snapshot.members.map(candidate => (
            candidate.id === 'member-b'
              ? member('member-b', 'Member B', 'manager')
              : candidate
          )),
        },
      },
    });
    const view = createView(port, diffPort(), objectUrlPort());

    await view.setState(viewState(), { history: false });

    expect(view.contentEl.querySelector('[data-collab-action="accept"]')).not.toBeNull();
  });

  it('does not expose Accept when fresh coordination demotes the current Manager', async () => {
    const review = requestReview();
    const port = detailPort(review);
    const demoted = coordination(review);
    port.readSnapshot.mockResolvedValue({
      status: 'success',
      value: {
        ...demoted,
        snapshot: {
          ...demoted.snapshot,
          currentMember: member('member-a', 'Member A'),
        },
      },
    });
    const view = createView(port, diffPort(), objectUrlPort());

    await view.setState(viewState(), { history: false });

    expect(view.contentEl.querySelector('[data-collab-action="accept"]')).toBeNull();
  });

  it('removes Accept when a coordination invalidation demotes the current Manager', async () => {
    const review = requestReview();
    const port = detailPort(review);
    let invalidate = () => undefined;
    port.subscribe.mockImplementation(listener => {
      invalidate = listener;
      return { dispose: jest.fn() };
    });
    const view = createView(port, diffPort(), objectUrlPort());
    await view.onOpen();
    await view.setState(viewState(), { history: false });
    expect(view.contentEl.querySelector('[data-collab-action="accept"]')).not.toBeNull();

    const demoted = coordination(review);
    port.readSnapshot.mockResolvedValueOnce({
      status: 'success',
      value: {
        ...demoted,
        snapshot: {
          ...demoted.snapshot,
          currentMember: member('member-reviewer', 'Reviewer', 'member'),
        },
      },
    });
    invalidate();
    await nextTurn();

    expect(view.contentEl.querySelector('[data-collab-action="accept"]')).toBeNull();
  });

  it('refreshes request metadata and comments after an invalidation', async () => {
    const review = requestReview();
    const port = detailPort(review);
    let invalidate = () => undefined;
    port.subscribe.mockImplementation(listener => {
      invalidate = listener;
      return { dispose: jest.fn() };
    });
    const view = createView(port, diffPort(), objectUrlPort());
    await view.onOpen();
    await view.setState(viewState(), { history: false });

    const comment = {
      authorMemberId: 'member-b',
      body: 'Remote review comment',
      createdAt: '2026-08-08T00:01:00.000Z',
      id: 'comment-remote',
      requestId: review.detail.request.id,
    };
    const refreshed: CollabRequestReview = {
      ...review,
      detail: {
        ...review.detail,
        comments: { comments: [comment] },
        request: {
          ...review.detail.request,
          commentCount: 1,
          description: 'Remote description',
          revision: 2,
          updatedAt: '2026-08-08T00:01:00.000Z',
        },
      },
    };
    const refreshedCoordination = coordination(refreshed);
    port.readSnapshot.mockResolvedValueOnce({
      status: 'success',
      value: refreshedCoordination,
    });
    port.prepareReview.mockResolvedValueOnce({ status: 'success', value: refreshed });

    invalidate();
    await nextTurn();
    await nextTurn();

    expect(port.prepareReview).toHaveBeenLastCalledWith(
      'project-a',
      'request-a',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect((MarkdownRenderer.render as jest.Mock).mock.calls.map(call => call[1]))
      .toEqual(expect.arrayContaining(['Remote description', 'Remote review comment']));
  });

  it('refreshes a newer description revision with the same timestamp', async () => {
    const review = requestReview();
    const port = detailPort(review);
    let invalidate = () => undefined;
    port.subscribe.mockImplementation(listener => {
      invalidate = listener;
      return { dispose: jest.fn() };
    });
    const view = createView(port, diffPort(), objectUrlPort());
    await view.onOpen();
    await view.setState(viewState(), { history: false });
    const refreshed: CollabRequestReview = {
      ...review,
      detail: {
        ...review.detail,
        request: {
          ...review.detail.request,
          description: 'Same timestamp description',
          revision: 2,
        },
      },
    };
    port.readSnapshot.mockResolvedValueOnce({
      status: 'success',
      value: coordination(refreshed),
    });
    port.prepareReview.mockResolvedValueOnce({ status: 'success', value: refreshed });

    invalidate();
    await nextTurn();
    await nextTurn();

    expect((MarkdownRenderer.render as jest.Mock).mock.calls.map(call => call[1]))
      .toContain('Same timestamp description');
  });

  it('adopts a new exact request review after the published head advances', async () => {
    const review = requestReview();
    const port = detailPort(review);
    let invalidate = () => undefined;
    port.subscribe.mockImplementation(listener => {
      invalidate = listener;
      return { dispose: jest.fn() };
    });
    const view = createView(port, diffPort(), objectUrlPort());
    await view.onOpen();
    await view.setState(viewState(), { history: false });

    const nextHead = '6'.repeat(40);
    const nextTree = '7'.repeat(40);
    const refreshed: CollabRequestReview = {
      ...review,
      comparisonTargetOid: nextTree,
      detail: {
        ...review.detail,
        request: {
          ...review.detail.request,
          latestHeadOid: nextHead,
          revision: 2,
          updatedAt: '2026-08-08T00:01:00.000Z',
        },
        reviewedHeadOid: nextHead,
      },
    };
    port.readSnapshot.mockResolvedValueOnce({
      status: 'success',
      value: coordination(refreshed),
    });
    port.prepareReview.mockResolvedValueOnce({ status: 'success', value: refreshed });

    invalidate();
    await nextTurn();
    await nextTurn();

    expect(view.getState()).toMatchObject({
      comparisonTargetOid: nextTree,
      reviewedHeadOid: nextHead,
    });
    await openChanges(view);
    await nextTurn();
    expect(port.readReviewFile).toHaveBeenLastCalledWith(
      expect.objectContaining({
        comparisonTargetOid: nextTree,
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('re-prepares an unchanged request when accepted main advances', async () => {
    const base = requestReview();
    const review: CollabRequestReview = {
      ...base,
      detail: {
        ...base.detail,
        comments: {
          comments: [{
          authorMemberId: 'member-reviewer',
          body: 'Current feedback',
          createdAt: '2026-08-08T00:01:00.000Z',
          id: 'comment-current',
          requestId: base.detail.request.id,
        }],
        },
      },
    };
    const port = detailPort(review);
    let invalidate = () => undefined;
    port.subscribe.mockImplementation(listener => {
      invalidate = listener;
      return { dispose: jest.fn() };
    });
    const view = createView(port, diffPort(), objectUrlPort());
    await view.onOpen();
    await view.setState(viewState(), { history: false });
    const prepareCallsBeforeInvalidation = port.prepareReview.mock.calls.length;
    expect(view.contentEl.querySelector('[data-request-comment-id="comment-current"]'))
      .not.toBeNull();

    const nextMain = '6'.repeat(40);
    const nextTree = '7'.repeat(40);
    const refreshed: CollabRequestReview = {
      ...review,
      comparisonBaseOid: nextMain,
      comparisonTargetOid: nextTree,
      detail: {
        ...review.detail,
        currentMainOid: nextMain,
      },
    };
    const nextCoordination = coordination(review);
    port.readSnapshot.mockResolvedValueOnce({
      status: 'success',
      value: {
        ...nextCoordination,
        snapshot: {
          ...nextCoordination.snapshot,
          project: { ...nextCoordination.snapshot.project, mainOid: nextMain },
        },
      },
    });
    port.prepareReview.mockResolvedValueOnce({ status: 'success', value: refreshed });

    invalidate();
    await nextTurn();
    await nextTurn();

    expect(port.prepareReview).toHaveBeenLastCalledWith(
      'project-a',
      'request-a',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(port.prepareReview).toHaveBeenCalledTimes(prepareCallsBeforeInvalidation + 1);
    expect(view.getState()).toMatchObject({
      comparisonBaseOid: nextMain,
      comparisonTargetOid: nextTree,
    });
    expect(view.contentEl.querySelector('[data-request-comment-id="comment-current"]'))
      .not.toBeNull();
  });

  it('refreshes same-review comments without clearing the active diff', async () => {
    const review = requestReview();
    const port = detailPort(review);
    const renderer = diffPort();
    let invalidate = () => undefined;
    port.subscribe.mockImplementation(listener => {
      invalidate = listener;
      return { dispose: jest.fn() };
    });
    const view = createView(port, renderer, objectUrlPort());
    await view.onOpen();
    await view.setState(viewState(), { history: false });
    await openChanges(view);
    await nextTurn();
    const clearsBeforeRefresh = renderer.clear.mock.calls.length;

    const comment = {
      authorMemberId: 'member-b',
      body: 'Remote review context',
      createdAt: '2026-08-08T00:01:00.000Z',
      id: 'comment-remote',
      requestId: review.detail.request.id,
    };
    const refreshed: CollabRequestReview = {
      ...review,
      detail: {
        ...review.detail,
        comments: { comments: [comment] },
        request: {
          ...review.detail.request,
          commentCount: 1,
          updatedAt: comment.createdAt,
        },
      },
    };
    port.readSnapshot.mockResolvedValueOnce({
      status: 'success',
      value: coordination(refreshed),
    });
    port.prepareReview.mockResolvedValueOnce({ status: 'success', value: refreshed });

    invalidate();
    await nextTurn();
    await nextTurn();

    expect(renderer.clear).toHaveBeenCalledTimes(clearsBeforeRefresh);
    expect(view.contentEl.querySelector('[data-request-comment-id="comment-remote"]'))
      .not.toBeNull();
  });

  it('consumes a description acknowledgement after its invalidation refresh wins the race', async () => {
    const review = requestReview();
    const pending = deferred<ReturnType<typeof successfulMetadataUpdate>>();
    const port = detailPort(review);
    let invalidate = () => undefined;
    port.subscribe.mockImplementation(listener => {
      invalidate = listener;
      return { dispose: jest.fn() };
    });
    const ownerCoordination = coordination(review);
    port.readSnapshot.mockResolvedValue({
      status: 'success',
      value: {
        ...ownerCoordination,
        snapshot: {
          ...ownerCoordination.snapshot,
          currentMember: member('member-a', 'Member A'),
        },
      },
    });
    port.updateRequestMetadata.mockReturnValue(pending.promise);
    const view = createView(port, diffPort(), objectUrlPort());
    await view.onOpen();
    await view.setState(viewState(), { history: false });
    const description = view.contentEl.querySelector<HTMLElement>(
      '[data-collab-description="true"]',
    )!;
    view.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="open-request-description-editor"]',
    )!.click();
    setMarkdownValue(description, 'Acknowledged description');
    const save = view.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="submit-request-description"]',
    )!;
    save.click();
    await nextTurn();

    const refreshed: CollabRequestReview = {
      ...review,
      detail: {
        ...review.detail,
        request: {
          ...review.detail.request,
          description: 'Acknowledged description',
          revision: 2,
          updatedAt: '2026-08-08T00:01:00.000Z',
        },
      },
    };
    const refreshedOwnerCoordination = coordination(refreshed);
    port.readSnapshot.mockResolvedValueOnce({
      status: 'success',
      value: {
        ...refreshedOwnerCoordination,
        snapshot: {
          ...refreshedOwnerCoordination.snapshot,
          currentMember: member('member-a', 'Member A'),
        },
      },
    });
    port.prepareReview.mockResolvedValueOnce({ status: 'success', value: refreshed });
    invalidate();
    await nextTurn();
    await nextTurn();
    pending.resolve(successfulMetadataUpdate(review, 'Acknowledged description'));
    await nextTurn();

    expect(save.disabled).toBe(false);
    expect(view.contentEl.querySelector<HTMLElement>(
      '.claudian-collab-request-description',
    )?.classList.contains('is-editing')).toBe(false);
    expect(view.contentEl.querySelector<HTMLElement>(
      '.claudian-collab-request-description-status',
    )?.textContent).toBe('');
  });

  it('coalesces an invalidation received while Accept is in flight', async () => {
    const review = requestReview();
    const pending = deferred<{
      readonly error: CollabError;
      readonly status: 'failure';
    }>();
    const port = detailPort(review);
    let invalidate = () => undefined;
    port.subscribe.mockImplementation(listener => {
      invalidate = listener;
      return { dispose: jest.fn() };
    });
    port.acceptRequest.mockReturnValue(pending.promise);
    const view = createView(port, diffPort(), objectUrlPort());
    await view.onOpen();
    await view.setState(viewState(), { history: false });
    view.contentEl.querySelector<HTMLButtonElement>(
      '[data-collab-action="accept"]',
    )!.click();

    const demoted = coordination(review);
    port.readSnapshot.mockResolvedValueOnce({
      status: 'success',
      value: {
        ...demoted,
        snapshot: {
          ...demoted.snapshot,
          currentMember: member('member-reviewer', 'Reviewer', 'member'),
        },
      },
    });
    invalidate();
    pending.resolve({
      error: new CollabError({ code: 'stale-request-metadata' }),
      status: 'failure',
    });
    await nextTurn();
    await nextTurn();

    expect(view.contentEl.querySelector('[data-collab-action="accept"]')).toBeNull();
  });

  it('refreshes coordination before deriving uncached review eligibility', async () => {
    const review = requestReview();
    const port = detailPort(review);
    const order: string[] = [];
    port.readSnapshot.mockImplementation(async () => {
      order.push('coordination');
      return { status: 'success', value: coordination(review) };
    });
    port.prepareReview.mockImplementation(async () => {
      order.push('review');
      return { status: 'success', value: review };
    });
    const view = createView(port, diffPort(), objectUrlPort());

    await view.setState(viewState(), { history: false });

    expect(order).toEqual(['coordination', 'review']);
  });

  it('preserves a Ticket create draft and intent across invalidation refresh', async () => {
    const port = detailPort(requestReview());
    port.createTicket.mockResolvedValue({
      error: new CollabError({ code: 'operation-failed' }),
      status: 'failure',
    });
    let invalidate: () => void = () => undefined;
    port.subscribe.mockImplementation((listener: (state: never) => void) => {
      invalidate = () => listener(undefined as never);
      return { dispose: jest.fn() };
    });
    const view = createView(port, diffPort(), objectUrlPort());
    await view.onOpen();
    await view.setState({ kind: 'ticket', projectId: 'project-a' }, { history: false });

    view.contentEl.querySelector<HTMLInputElement>(
      '[data-field="ticket-title"]',
    )!.value = 'Retry after invalidation';
    setMarkdownValue(
      view.contentEl.querySelector<HTMLElement>('[data-field="ticket-body"]')!,
      'Same Ticket body',
    );
    view.contentEl.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event(
      'submit',
      { bubbles: true, cancelable: true },
    ));
    await nextTurn();
    invalidate();
    await nextTurn();

    expect(view.contentEl.querySelector<HTMLInputElement>(
      '[data-field="ticket-title"]',
    )?.value).toBe('Retry after invalidation');
    expect(markdownValue(
      view.contentEl.querySelector<HTMLElement>('[data-field="ticket-body"]')!,
    )).toBe('Same Ticket body');

    view.contentEl.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event(
      'submit',
      { bubbles: true, cancelable: true },
    ));
    await nextTurn();

    expect(port.createTicket).toHaveBeenCalledTimes(2);
    expect(port.createTicket.mock.calls[1]?.[0].intentId)
      .toBe(port.createTicket.mock.calls[0]?.[0].intentId);
  });

  it('includes the loaded Ticket number in the tab title', async () => {
    const port = detailPort(requestReview());
    port.readTicket.mockResolvedValue({
      status: 'success',
      value: { detail: ticketDetail(), source: 'online', stale: false },
    });
    const view = createView(port, diffPort(), objectUrlPort());

    await view.setState({
      kind: 'ticket',
      projectId: 'project-a',
      ticketId: 'ticket-a',
    }, { history: false });

    expect(view.getDisplayText()).toBe('Ticket title #17');
  });

  it('aborts a Ticket-reference lookup when the Ticket state is replaced', async () => {
    const port = detailPort(requestReview());
    const first = { ...ticketDetail(), body: 'See #99.' };
    const second = {
      ...ticketDetail(),
      ticket: {
        ...ticketDetail().ticket,
        id: 'ticket-b',
        number: 18,
        title: 'Replacement Ticket',
      },
    };
    port.readTicket.mockImplementation(async (_projectId, ticketId) => ({
      status: 'success',
      value: {
        detail: ticketId === 'ticket-a' ? first : second,
        source: 'online',
        stale: false,
      },
    }));
    let lookupSignal: AbortSignal | undefined;
    let releaseLookup!: () => void;
    port.listTickets.mockImplementation((_request, options) => {
      lookupSignal = options?.signal;
      return new Promise(resolve => {
        releaseLookup = () => resolve({
          status: 'success',
          value: { page: { tickets: [] }, source: 'online', stale: false },
        });
      });
    });
    const openTicketInNewTab = jest.fn().mockResolvedValue(undefined);
    const render = MarkdownRenderer.render as jest.Mock;
    const previousRender = render.getMockImplementation();
    render.mockImplementation(async (
      _app: unknown,
      markdown: string,
      host: HTMLElement,
    ) => host.setText(markdown));
    const view = createView(
      port,
      diffPort(),
      objectUrlPort(),
      undefined,
      {} as WorkspaceLeaf,
      undefined,
      undefined,
      openTicketInNewTab,
    );

    await view.setState({
      kind: 'ticket',
      projectId: 'project-a',
      ticketId: 'ticket-a',
    }, { history: false });
    view.contentEl.querySelector<HTMLButtonElement>(
      '.claudian-collab-markdown-ticket-reference',
    )?.click();
    await nextTurn();
    expect(lookupSignal?.aborted).toBe(false);

    await view.setState({
      kind: 'ticket',
      projectId: 'project-a',
      ticketId: 'ticket-b',
    }, { history: false });
    expect(lookupSignal?.aborted).toBe(true);
    releaseLookup();
    await nextTurn();
    if (previousRender) render.mockImplementation(previousRender);

    expect(openTicketInNewTab).not.toHaveBeenCalled();
  });

  it('aborts a Ticket-reference lookup when closed admission replaces the state', async () => {
    const port = detailPort(requestReview());
    port.readTicket.mockResolvedValue({
      status: 'success',
      value: {
        detail: { ...ticketDetail(), body: 'See #99.' },
        source: 'online',
        stale: false,
      },
    });
    let lookupSignal: AbortSignal | undefined;
    let releaseLookup!: () => void;
    port.listTickets.mockImplementation((_request, options) => {
      lookupSignal = options?.signal;
      return new Promise(resolve => {
        releaseLookup = () => resolve({
          status: 'success',
          value: {
            page: { tickets: [{ ...ticketDetail().ticket, number: 99 }] },
            source: 'online',
            stale: false,
          },
        });
      });
    });
    const openTicketInNewTab = jest.fn().mockResolvedValue(undefined);
    const render = MarkdownRenderer.render as jest.Mock;
    const previousRender = render.getMockImplementation();
    render.mockImplementation(async (
      _app: unknown,
      markdown: string,
      host: HTMLElement,
    ) => host.setText(markdown));
    const view = createView(
      port,
      diffPort(),
      objectUrlPort(),
      undefined,
      {} as WorkspaceLeaf,
      undefined,
      undefined,
      openTicketInNewTab,
    );

    try {
      await view.setState({
        kind: 'ticket',
        projectId: 'project-a',
        ticketId: 'ticket-a',
      }, { history: false });
      view.contentEl.querySelector<HTMLButtonElement>(
        '.claudian-collab-markdown-ticket-reference',
      )?.click();
      await nextTurn();
      expect(lookupSignal?.aborted).toBe(false);

      port.isDetailAdmissionOpen.mockReturnValue(false);
      await view.setState({
        kind: 'ticket',
        projectId: 'project-a',
        ticketId: 'ticket-b',
      }, { history: false });
      expect(lookupSignal?.aborted).toBe(true);
      releaseLookup();
      await nextTurn();

      expect(openTicketInNewTab).not.toHaveBeenCalled();
    } finally {
      if (previousRender) render.mockImplementation(previousRender);
    }
  });

  it('reuses the Accept intent when retrying after a lost response', async () => {
    const port = detailPort(requestReview());
    port.acceptRequest
      .mockRejectedValueOnce(new Error('lost response'))
      .mockResolvedValueOnce({
        status: 'success',
        value: {
          mainOid: '4'.repeat(40),
          mergeCommitOid: '4'.repeat(40),
          request: { ...requestReview().detail.request, status: 'merged' },
        },
      });
    const view = createView(port, diffPort(), objectUrlPort());
    await view.setState(viewState(), { history: false });

    const accept = view.contentEl.querySelector<HTMLButtonElement>(
      '[data-collab-action="accept"]',
    )!;
    accept.click();
    await nextTurn();
    accept.click();
    await nextTurn();

    expect(port.acceptRequest).toHaveBeenCalledTimes(2);
    const firstIntent = port.acceptRequest.mock.calls[0]?.[0].intentId;
    const secondIntent = port.acceptRequest.mock.calls[1]?.[0].intentId;
    expect(firstIntent).toEqual(expect.any(String));
    expect(secondIntent).toBe(firstIntent);
  });

  it('does not carry an Accept retry intent into a replacement detail session', async () => {
    const review = requestReview();
    const port = detailPort(review);
    port.acceptRequest.mockRejectedValue(new Error('lost response'));
    port.prepareWorkingTreeReview.mockResolvedValue({
      status: 'success',
      value: workingTreeReview(),
    });
    const view = createView(port, diffPort(), objectUrlPort());
    await view.setState(viewState(), { history: false });
    view.contentEl.querySelector<HTMLButtonElement>(
      '[data-collab-action="accept"]',
    )!.click();
    await nextTurn();

    await view.setState(workingTreeViewState(), { history: false });
    await view.setState(viewState(), { history: false });
    view.contentEl.querySelector<HTMLButtonElement>(
      '[data-collab-action="accept"]',
    )!.click();
    await nextTurn();

    const firstIntent = port.acceptRequest.mock.calls[0]?.[0].intentId;
    const secondIntent = port.acceptRequest.mock.calls[1]?.[0].intentId;
    expect(secondIntent).not.toBe(firstIntent);
  });

  it('uses one canonical resolving-Ticket payload and intent across relation ordering', async () => {
    const original = requestReview();
    const relationA = {
      commitOid: HEAD,
      id: 'relation-a',
      kind: 'resolves' as const,
      state: 'pending' as const,
      ticketId: 'ticket-a',
      ticketNumber: 1,
      ticketRevision: 3,
      ticketTitle: 'First Ticket',
    };
    const relationB = {
      commitOid: HEAD,
      id: 'relation-b',
      kind: 'resolves' as const,
      state: 'pending' as const,
      ticketId: 'ticket-b',
      ticketNumber: 2,
      ticketRevision: 5,
      ticketTitle: 'Second Ticket',
    };
    const withRelations: CollabRequestReview = {
      ...original,
      detail: {
        ...original.detail,
        request: {
          ...original.detail.request,
          ticketRelations: [relationB, relationA],
        },
      },
    };
    const reordered: CollabRequestReview = {
      ...withRelations,
      detail: {
        ...withRelations.detail,
        request: {
          ...withRelations.detail.request,
          ticketRelations: [relationA, relationB],
        },
      },
    };
    const cache = new CollabPreparedReviewCache();
    const port = detailPort(withRelations);
    port.acceptRequest.mockRejectedValue(new Error('lost response'));
    const view = createView(port, diffPort(), objectUrlPort(), cache);
    await view.setState(viewState(), { history: false });

    view.contentEl.querySelector<HTMLButtonElement>(
      '[data-collab-action="accept"]',
    )!.click();
    await nextTurn();
    cache.store({ coordination: coordination(reordered), review: reordered });
    await view.setState(viewState(), { history: false });
    view.contentEl.querySelector<HTMLButtonElement>(
      '[data-collab-action="accept"]',
    )!.click();
    await nextTurn();

    const first = port.acceptRequest.mock.calls[0]?.[0];
    const second = port.acceptRequest.mock.calls[1]?.[0];
    const expectedResolvingTickets = [
      { revision: 3, ticketId: 'ticket-a' },
      { revision: 5, ticketId: 'ticket-b' },
    ];
    expect(first?.expectedResolvingTickets).toEqual(expectedResolvingTickets);
    expect(second?.expectedResolvingTickets).toEqual(expectedResolvingTickets);
    expect(second?.intentId).toBe(first?.intentId);
  });

  it('replaces the Accept intent when request metadata changes on the same Git review', async () => {
    const original = requestReview();
    const refreshed: CollabRequestReview = {
      ...original,
      detail: {
        ...original.detail,
        request: {
          ...original.detail.request,
          description: 'Updated metadata',
          revision: 2,
          updatedAt: '2026-08-08T00:02:00.000Z',
        },
      },
    };
    const cache = new CollabPreparedReviewCache();
    const port = detailPort(original);
    port.acceptRequest.mockResolvedValue({
      error: new CollabError({ code: 'stale-request-metadata' }),
      status: 'failure',
    });
    const view = createView(port, diffPort(), objectUrlPort(), cache);
    await view.setState(viewState(), { history: false });
    view.contentEl.querySelector<HTMLButtonElement>(
      '[data-collab-action="accept"]',
    )!.click();
    await nextTurn();
    cache.store({ coordination: coordination(refreshed), review: refreshed });

    await view.setState(viewState(), { history: false });
    view.contentEl.querySelector<HTMLButtonElement>(
      '[data-collab-action="accept"]',
    )!.click();
    await nextTurn();

    const first = port.acceptRequest.mock.calls[0]?.[0];
    const second = port.acceptRequest.mock.calls[1]?.[0];
    expect(first?.expectedRequestRevision).toBe(1);
    expect(second?.expectedRequestRevision).toBe(2);
    expect(second?.intentId).not.toBe(first?.intentId);
  });

  it('renders a terminal prepared request as accepted even when its review condition is clean', async () => {
    const open = requestReview();
    const merged: CollabRequestReview = {
      ...open,
      canAccept: false,
      detail: {
        ...open.detail,
        request: { ...open.detail.request, status: 'merged' },
      },
    };
    const view = createView(detailPort(merged), diffPort(), objectUrlPort());

    await view.setState(viewState(), { history: false });

    expect(view.contentEl.querySelector('.claudian-collab-review-condition')?.textContent)
      .toBe('Changes accepted');
    expect(view.contentEl.querySelector('[data-collab-action="accept"]')).toBeNull();
  });

  it('keeps accepted state when Accept wins a pending file read', async () => {
    const review = requestReview();
    const port = detailPort(review);
    const renderer = diffPort();
    const fileResult = {
      status: 'success' as const,
      value: {
        file: review.files[0],
        kind: 'text' as const,
        newText: 'new\n',
        oldText: 'old\n',
      },
    };
    const pendingFile = deferred<typeof fileResult>();
    port.readReviewFile.mockReturnValueOnce(pendingFile.promise);
    const view = createView(port, renderer, objectUrlPort());

    const opening = view.setState(viewState(), { history: false });
    await nextTurn();
    await openChanges(view);
    view.contentEl.querySelector<HTMLButtonElement>('[data-collab-action="accept"]')?.click();
    await nextTurn();
    pendingFile.resolve(fileResult);
    await opening;
    await nextTurn();

    expect(renderer.render).toHaveBeenCalledWith(expect.objectContaining({
      newText: 'new\n',
      oldText: 'old\n',
    }));
  });

  it('uses an exact prepared-review handoff while refreshing coordination', async () => {
    const review = requestReview();
    const port = detailPort(review);
    const cache = new CollabPreparedReviewCache();
    cache.store({ coordination: coordination(review), review });
    const view = createView(port, diffPort(), objectUrlPort(), cache);

    await view.setState(viewState(), { history: false });
    await openChanges(view);
    await nextTurn();
    await nextTurn();

    expect(port.prepareReview).not.toHaveBeenCalled();
    expect(port.readSnapshot).toHaveBeenCalledTimes(1);
    expect(port.readReviewFile).toHaveBeenCalledTimes(2);
  });

  it('does not reload a selected path in a 100-file continuous review', async () => {
    const restoreObserver = installPassiveIntersectionObserver();
    const review = markdownReview(100);
    const port = detailPort(review);
    const renderer = diffPort();
    const objectUrls = objectUrlPort();
    const view = createView(port, renderer, objectUrls);
    await view.onOpen();
    try {
      for (let index = 0; index < 5; index += 1) {
        await view.setState({
          ...viewState(),
          selectedPath: 'notes/note-0.md',
        }, { history: false });
      }
      await openChanges(view);
      await nextTurn();

      expect(port.prepareReview).toHaveBeenCalledTimes(1);
      expect(port.readSnapshot).toHaveBeenCalledTimes(1);
      expect(port.readReviewFile).toHaveBeenCalledTimes(1);
      expect(renderer.render).toHaveBeenCalledTimes(1);
      expect(objectUrls.create).not.toHaveBeenCalled();
      expect(objectUrls.revoke).not.toHaveBeenCalled();

      await view.onClose();

      expect(renderer.destroy).toHaveBeenCalledTimes(1);
      expect(view.contentEl.childElementCount).toBe(0);
    } finally {
      restoreObserver();
    }
  });

  it('rejects malformed persisted state before querying review data', async () => {
    const port = detailPort(requestReview());
    const view = createView(port, diffPort(), objectUrlPort());
    await view.onOpen();

    await expect(view.setState({
      ...viewState(),
      reviewedHeadOid: 'not-an-oid',
    }, { history: false })).rejects.toMatchObject({ code: 'operation-failed' });
    expect(port.prepareReview).not.toHaveBeenCalled();
  });

  it('keeps conflict detail read-only and preserves its owner location', async () => {
    const port = detailPort(requestReview());
    const panel = { destroy: jest.fn(), open: jest.fn().mockResolvedValue(undefined) };
    let location: 'my-changes' | 'request' | undefined;
    const leaf = { setViewState: jest.fn().mockResolvedValue(undefined) };
    const view = new CollabDetailView(leaf as unknown as WorkspaceLeaf, port, {
      conflictPanelFactory: (_root, _conflictPort, options) => {
        location = options.location;
        return panel;
      },
      objectUrls: objectUrlPort(),
      renderer: diffPort(),
    });
    Object.defineProperty(view, 'contentEl', {
      configurable: true,
      value: document.createElement('div'),
    });
    await view.setState({
      kind: 'conflict',
      location: 'request',
      operationId: 'conflict-a',
      projectId: 'project-a',
      requestId: 'request-a',
    }, { history: false });

    expect(panel.open).toHaveBeenCalledWith('conflict-a');
    expect(location).toBe('request');
    expect(leaf.setViewState).not.toHaveBeenCalled();

    await view.setState(viewState(), { history: false });
    expect(panel.destroy).toHaveBeenCalledTimes(1);
  });
});

describe('CollabDetailViewCoordinator', () => {
  it('closes the active detail leaf after a completed external action', async () => {
    const leaf = { detach: jest.fn() };
    const workspace = {
      getLeaf: jest.fn(),
      getLeavesOfType: jest.fn().mockReturnValue([leaf]),
      revealLeaf: jest.fn().mockResolvedValue(undefined),
    };

    await new CollabDetailViewCoordinator(workspace).close();

    expect(leaf.detach).toHaveBeenCalledTimes(1);
  });

  it('reuses the existing detail leaf and persists identifiers without credentials', async () => {
    const leaf = { setViewState: jest.fn().mockResolvedValue(undefined) };
    const workspace = {
      getLeaf: jest.fn(),
      getLeavesOfType: jest.fn().mockReturnValue([leaf]),
      revealLeaf: jest.fn().mockResolvedValue(undefined),
    };

    await new CollabDetailViewCoordinator(workspace).open(viewState());

    expect(workspace.getLeaf).not.toHaveBeenCalled();
    expect(leaf.setViewState).toHaveBeenCalledWith({
      active: true,
      state: viewState(),
      type: COLLAB_DETAIL_VIEW_TYPE,
    });
    expect(JSON.stringify(leaf.setViewState.mock.calls)).not.toContain('credential');
    expect(workspace.revealLeaf).toHaveBeenCalledWith(leaf);
  });

  it('opens Ticket references in a fresh tab even when a detail leaf exists', async () => {
    const existing = { setViewState: jest.fn() };
    const fresh = { setViewState: jest.fn().mockResolvedValue(undefined) };
    const workspace = {
      getLeaf: jest.fn().mockReturnValue(fresh),
      getLeavesOfType: jest.fn().mockReturnValue([existing]),
      revealLeaf: jest.fn().mockResolvedValue(undefined),
    };
    const state: CollabTicketDetailViewState = {
      kind: 'ticket',
      projectId: 'project-a',
      ticketId: 'ticket-a',
    };

    await new CollabDetailViewCoordinator(workspace).openInNewTab(state);

    expect(workspace.getLeaf).toHaveBeenCalledWith('tab');
    expect(existing.setViewState).not.toHaveBeenCalled();
    expect(fresh.setViewState).toHaveBeenCalledWith({
      active: true,
      state,
      type: COLLAB_DETAIL_VIEW_TYPE,
    });
    expect(workspace.revealLeaf).toHaveBeenCalledWith(fresh);
  });

  it('stores prepared metadata outside persisted view state for an exact handoff', async () => {
    const leaf = { setViewState: jest.fn().mockResolvedValue(undefined) };
    const workspace = {
      getLeaf: jest.fn(),
      getLeavesOfType: jest.fn().mockReturnValue([leaf]),
      revealLeaf: jest.fn().mockResolvedValue(undefined),
    };
    const review = requestReview();
    const prepared = { coordination: coordination(review), review };
    const cache = new CollabPreparedReviewCache();

    await new CollabDetailViewCoordinator(workspace, cache).open(viewState(), prepared);

    expect(cache.read(viewState())).toEqual(prepared);
    expect(JSON.stringify(leaf.setViewState.mock.calls)).not.toContain('changedFiles');
  });

  it('serializes leaf transitions and skips superseded pending request intents', async () => {
    const firstTransition = deferred<void>();
    let activeTransitions = 0;
    let maxActiveTransitions = 0;
    const setViewState = jest.fn(async (
      _state: { readonly state: { readonly requestId?: string } },
    ) => {
      activeTransitions += 1;
      maxActiveTransitions = Math.max(maxActiveTransitions, activeTransitions);
      try {
        if (setViewState.mock.calls.length === 1) await firstTransition.promise;
      } finally {
        activeTransitions -= 1;
      }
    });
    const leaf = { setViewState };
    const workspace = {
      getLeaf: jest.fn(),
      getLeavesOfType: jest.fn().mockReturnValue([leaf]),
      revealLeaf: jest.fn().mockResolvedValue(undefined),
    };
    const coordinator = new CollabDetailViewCoordinator(workspace);
    const firstA = coordinator.open(viewState());
    await nextTurn();
    const pendingB = coordinator.open({ ...viewState(), requestId: 'request-b' });
    const finalA = coordinator.open(viewState());

    expect(setViewState).toHaveBeenCalledTimes(1);
    firstTransition.resolve();
    await Promise.all([firstA, pendingB, finalA]);

    expect(setViewState.mock.calls.map(call => call[0].state.requestId))
      .toEqual(['request-a', 'request-a']);
    expect(maxActiveTransitions).toBe(1);
    expect(workspace.revealLeaf).toHaveBeenCalledTimes(1);
    expect(workspace.revealLeaf).toHaveBeenCalledWith(leaf);
  });
});

function createView(
  port: CollabDetailViewPort,
  renderer: CollabDetailDiffPort,
  objectUrls: CollabDetailObjectUrlPort,
  preparedReviews?: CollabPreparedReviewCache,
  leaf: WorkspaceLeaf = {} as WorkspaceLeaf,
  rendererFactory?: () => CollabDetailDiffPort,
  openProjectFile?: (projectId: string, path: string) => Promise<void>,
  openTicketInNewTab?: (projectId: string, ticketId: string) => Promise<void>,
): CollabDetailView {
  const view = new CollabDetailView(leaf, port, {
    objectUrls,
    ...(preparedReviews ? { preparedReviews } : {}),
    renderer,
    ...(rendererFactory ? { rendererFactory } : {}),
    ...(openProjectFile ? { openProjectFile } : {}),
    ...(openTicketInNewTab ? { openTicketInNewTab } : {}),
  });
  Object.defineProperty(view, 'contentEl', {
    configurable: true,
    value: document.createElement('div'),
  });
  return view;
}

function viewState(): CollabRequestDetailViewState {
  return {
    comparisonBaseOid: MAIN,
    comparisonTargetOid: TREE,
    kind: 'request',
    projectId: 'project-a',
    requestId: 'request-a',
    reviewedHeadOid: HEAD,
    reviewedMainOid: MAIN,
    selectedPath: 'note.md',
  };
}

function publicationViewState(
  review: CollabPublicationReview = publicationReview(),
): CollabPublicationDetailViewState {
  return {
    candidateOid: review.candidateOid,
    comparisonBaseOid: review.comparisonBaseOid,
    comparisonTargetOid: review.comparisonTargetOid,
    currentMainOid: review.currentMainOid,
    kind: 'publication',
    operationId: review.operationId,
    projectId: review.projectId,
    selectedPath: review.files[0]?.path,
  };
}

function publicationReview(): CollabPublicationReview {
  return {
    baseMainOid: HEAD,
    candidateOid: TREE,
    canConfirm: true,
    comparisonBaseOid: MAIN,
    comparisonTargetOid: TREE,
    contributionHeadOid: HEAD,
    currentMainOid: MAIN,
    files: [requestReview().files[0]],
    kind: 'publication',
    operationId: 'publication-a',
    projectId: 'project-a',
  };
}

function conflictDescriptor(): CollabConflictDescriptor {
  return {
    conflicts: [{ kind: 'text', path: 'note.md' }],
    mergeBaseOid: MAIN,
    operationId: 'conflict-a',
    projectId: 'project-a',
    startingMainOid: MAIN,
    startingPersonalOid: HEAD,
  };
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

async function openChanges(view: CollabDetailView): Promise<void> {
  [...view.contentEl.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    .find(button => button.textContent?.startsWith('Changes'))?.click();
  await nextTurn();
}

function requestReview(): CollabRequestReview {
  return {
    canAccept: true,
    comparisonBaseOid: MAIN,
    comparisonKind: 'candidate',
    comparisonTargetOid: TREE,
    detail: {
      comments: { comments: [] },
      currentMainOid: MAIN,
      request: {
        commentCount: 0,
        createdAt: '2026-08-08T00:00:00.000Z',
        description: 'Published change',
        firstBaseOid: MAIN,
        id: 'request-a',
        latestHeadOid: HEAD,
        memberId: 'member-a',
        revision: 1,
        status: 'open',
        ticketRelations: [],
        updatedAt: '2026-08-08T00:00:00.000Z',
      },
      reviewCondition: 'clean',
      reviewedHeadOid: HEAD,
    },
    files: [
      {
        binary: false,
        kind: 'modified',
        largeForReview: false,
        newBytes: 4,
        oldBytes: 4,
        path: 'note.md',
      },
      {
        binary: true,
        kind: 'added',
        largeForReview: false,
        newBytes: 4,
        path: 'image.png',
      },
    ],
    projectId: 'project-a',
  };
}

function ticketDetail(): CollabTicketDetail {
  return {
    acceptedRelations: { acceptedRelations: [] },
    body: 'Ticket body',
    comments: { comments: [] },
    ticket: {
      acceptedRelationCount: 0,
      authorMemberId: 'member-a',
      commentCount: 0,
      createdAt: '2026-08-08T00:00:00.000Z',
      id: 'ticket-a',
      number: 17,
      revision: 1,
      status: 'open',
      title: 'Ticket title',
      updatedAt: '2026-08-08T00:00:00.000Z',
    },
  };
}

function markdownReview(fileCount: number): CollabRequestReview {
  const review = requestReview();
  return {
    ...review,
    files: Array.from({ length: fileCount }, (_, index) => ({
      binary: false,
      kind: 'modified' as const,
      largeForReview: false,
      newBytes: 4,
      oldBytes: 4,
      path: `notes/note-${index}.md`,
    })),
  };
}

function detailPort(review: CollabRequestReview) {
  const text: CollabReviewFileContent = {
    file: review.files[0],
    kind: 'text',
    newText: 'new\n',
    oldText: 'old\n',
  };
  const image: CollabReviewFileContent = {
    file: review.files[1],
    kind: 'binary',
    preview: {
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      mimeType: 'image/png',
    },
  };
  const accepted: CollabAcceptOutcome = {
    mainOid: '4'.repeat(40),
    mergeCommitOid: '4'.repeat(40),
    request: { ...review.detail.request, status: 'merged' },
  };
  return {
    acceptRequest: jest.fn().mockResolvedValue({ status: 'success', value: accepted }),
    addComment: jest.fn(),
    addTicketComment: jest.fn(),
    closeTicket: jest.fn(),
    confirmPublish: jest.fn(),
    createTicket: jest.fn(),
    listTickets: jest.fn(),
    prepareWorkingTreeReview: jest.fn(),
    preparePublicationReview: jest.fn(),
    prepareReview: jest.fn().mockResolvedValue({ status: 'success', value: review }),
    readConflict: jest.fn(),
    readConflictFile: jest.fn(),
    readPublicationReviewFile: jest.fn(),
    readWorkingTreeReviewFile: jest.fn(),
    readSnapshot: jest.fn().mockResolvedValue({
      status: 'success',
      value: coordination(review),
    }),
    readPublishDescription: jest.fn().mockResolvedValue({
      status: 'success',
      value: null,
    }),
    readTicket: jest.fn(),
    readReviewFile: jest.fn(async (request: { file: { path: string } }) => (
      { status: 'success' as const, value: request.file.path === 'image.png' ? image : text }
    )),
    isDetailAdmissionOpen: jest.fn().mockReturnValue(true),
    publish: jest.fn(),
    reopenTicket: jest.fn(),
    subscribe: jest.fn().mockReturnValue({ dispose: jest.fn() }),
    updateRequestMetadata: jest.fn(),
    updateTicketContent: jest.fn(),
  } satisfies CollabDetailViewPort;
}

function workingTreeReview(): CollabWorkingTreeReview {
  return {
    baseOid: MAIN,
    files: [{
      binary: false,
      kind: 'modified',
      largeForReview: false,
      newBytes: 8,
      oldBytes: 5,
      path: 'note.md',
    }],
    headOid: HEAD,
    kind: 'working-tree',
    projectId: 'project-a',
    snapshotId: '4'.repeat(64),
  };
}

function workingTreeViewState(): CollabWorkingTreeDetailViewState {
  return {
    baseOid: MAIN,
    headOid: HEAD,
    kind: 'working-tree',
    projectId: 'project-a',
    selectedPath: 'note.md',
    snapshotId: '4'.repeat(64),
  };
}

function successfulMetadataUpdate(
  review: CollabRequestReview,
  description: string,
) {
  return {
    status: 'success' as const,
    value: {
      ...review.detail.request,
      description,
      revision: review.detail.request.revision + 1,
    },
  };
}

function coordination(review: CollabRequestReview): CollabCoordinationSnapshot {
  return {
    snapshot: {
      currentMember: member('member-reviewer', 'Reviewer'),
      eventSequence: 1,
      members: [
        member('member-reviewer', 'Reviewer'),
        member('member-a', 'Member A'),
        member('member-b', 'Member B'),
      ],
      openTicketCount: 0,
      openRequests: review.detail.request.status === 'open' ? [review.detail.request] : [],
      project: {
        authorityKind: 'lan',
        createdAt: '2026-08-08T00:00:00.000Z',
        hostMemberId: 'member-reviewer',
        id: 'project-a',
        mainOid: MAIN,
        mainRef: 'refs/heads/main',
        managerSetGeneration: 0,
        name: 'Project A',
      },
      ticketHighlights: [],
    },
    source: 'online',
    stale: false,
    syncState: {
      eventSequence: 1,
      generation: 1,
      projectId: 'project-a',
      status: 'synchronized',
    },
  };
}

function member(
  id: string,
  displayName: string,
  role: 'manager' | 'member' = id === 'member-reviewer' ? 'manager' : 'member',
) {
  return {
    activatedAt: '2026-08-08T00:00:00.000Z',
    createdAt: '2026-08-08T00:00:00.000Z',
    displayName,
    id,
    personalRef: `refs/heads/members/${id}`,
    role,
    status: 'active' as const,
  };
}

function diffPort() {
  return {
    clear: jest.fn(),
    destroy: jest.fn(),
    render: jest.fn().mockResolvedValue(undefined),
    setLayout: jest.fn(),
  } satisfies CollabDetailDiffPort;
}

function objectUrlPort() {
  return {
    create: jest.fn().mockReturnValue('blob:preview-1'),
    revoke: jest.fn(),
  } satisfies CollabDetailObjectUrlPort;
}

function installPassiveIntersectionObserver(): () => void {
  const previous = globalThis.IntersectionObserver;
  class PassiveIntersectionObserver {
    readonly root = null;
    readonly rootMargin = '600px 0px';
    readonly thresholds = [0];
    disconnect(): void {}
    observe(): void {}
    takeRecords(): IntersectionObserverEntry[] { return []; }
    unobserve(): void {}
  }
  Object.defineProperty(globalThis, 'IntersectionObserver', {
    configurable: true,
    value: PassiveIntersectionObserver,
  });
  return () => {
    if (previous) {
      Object.defineProperty(globalThis, 'IntersectionObserver', {
        configurable: true,
        value: previous,
      });
    } else {
      Reflect.deleteProperty(globalThis, 'IntersectionObserver');
    }
  };
}

function nextTurn(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(next => {
    resolve = next;
  });
  return { promise, resolve };
}
