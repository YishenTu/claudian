/** @jest-environment jsdom */

import { type CollabRequestReview, type CollabReviewFileContent } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';
import {
  type CollabDetailDiffPort,
  type CollabDetailObjectUrlPort,
  ReviewDiffSession,
  type ReviewDiffSessionPort,
} from '@/features/collab/detail/review/ReviewDiffSession';

const MAIN = '1'.repeat(40);
const TREE = '2'.repeat(40);

describe('ReviewDiffSession', () => {
  it('loads continuous files serially with the selected file first', async () => {
    const first = deferred<CollabReviewFileContent>();
    const second = deferred<CollabReviewFileContent>();
    const port = reviewPort(first.promise, second.promise);
    const primary = diffPort();
    const secondary = diffPort();
    const host = document.createElement('div');
    const review = requestReview();
    const session = new ReviewDiffSession({
      objectUrls: objectUrlPort(),
      port,
      renderer: primary,
      rendererFactory: () => secondary,
    });

    session.show(host, review, 'second.md');
    await nextTurn();

    expect(port.readReviewFile).toHaveBeenCalledTimes(1);
    expect(port.readReviewFile.mock.calls[0]?.[0].file.path).toBe('second.md');

    first.resolve(textContent(review.files[1], 'second'));
    await nextTurn();
    expect(port.readReviewFile).toHaveBeenCalledTimes(2);
    expect(port.readReviewFile.mock.calls[1]?.[0].file.path).toBe('first.md');

    second.resolve(textContent(review.files[0], 'first'));
    await nextTurn();
    expect(primary.render).toHaveBeenCalledTimes(1);
    expect(secondary.render).toHaveBeenCalledTimes(1);
  });

  it('uses one icon per option and toggles to the opposite mode', async () => {
    const port = reviewPort(
      Promise.resolve(textContent(requestReview().files[0], 'first')),
      Promise.resolve(textContent(requestReview().files[1], 'second')),
    );
    const controls = document.createElement('div');
    const host = document.createElement('div');
    const session = new ReviewDiffSession({
      objectUrls: objectUrlPort(),
      port,
      renderer: diffPort(),
      rendererFactory: diffPort,
    });

    session.createControls(controls);
    session.show(host, requestReview(), 'first.md');
    const scope = controls.querySelector<HTMLButtonElement>('[data-collab-review-scope]')!;
    const layout = controls.querySelector<HTMLButtonElement>('[data-collab-review-layout]')!;

    expect(scope.dataset.collabReviewScope).toBe('continuous');
    expect(layout.dataset.collabReviewLayout).toBe('unified');
    scope.click();
    layout.click();
    await nextTurn();

    expect(scope.dataset.collabReviewScope).toBe('file');
    expect(layout.dataset.collabReviewLayout).toBe('split');
  });

  it('aborts pending reads and releases renderers and object URLs on destroy', async () => {
    const pending = deferred<CollabReviewFileContent>();
    const port = reviewPort(pending.promise, pending.promise);
    const renderer = diffPort();
    const objectUrls = objectUrlPort();
    const session = new ReviewDiffSession({
      objectUrls,
      port,
      renderer,
      rendererFactory: diffPort,
    });

    session.show(document.createElement('div'), requestReview(), 'first.md');
    await nextTurn();
    const signal = port.readReviewFile.mock.calls[0]?.[1]?.signal;
    session.destroy();

    expect(signal?.aborted).toBe(true);
    expect(renderer.destroy).toHaveBeenCalledTimes(1);
    expect(objectUrls.revoke).not.toHaveBeenCalled();
  });

  it('retains the primary renderer while switching text files', async () => {
    const port = immediateReviewPort();
    const renderer = diffPort();
    const controls = document.createElement('div');
    const session = new ReviewDiffSession({
      objectUrls: objectUrlPort(),
      port,
      renderer,
      rendererFactory: diffPort,
    });
    session.createControls(controls);
    controls.querySelector<HTMLButtonElement>('[data-collab-review-scope]')!.click();
    session.show(document.createElement('div'), requestReview(), 'first.md');
    await nextTurn();

    session.select('second.md');
    await nextTurn();

    expect(renderer.render).toHaveBeenCalledTimes(2);
    expect(renderer.clear).not.toHaveBeenCalled();
  });

  it('retains the primary renderer across detached review identities', async () => {
    const port = immediateReviewPort();
    const renderer = diffPort();
    const controls = document.createElement('div');
    const session = new ReviewDiffSession({
      objectUrls: objectUrlPort(),
      port,
      renderer,
      rendererFactory: diffPort,
    });
    session.createControls(controls);
    controls.querySelector<HTMLButtonElement>('[data-collab-review-scope]')!.click();
    session.show(document.createElement('div'), requestReview(), 'first.md');
    await nextTurn();
    session.detach();
    const nextReview = {
      ...requestReview(),
      comparisonTargetOid: '3'.repeat(40),
    };

    session.show(document.createElement('div'), nextReview, 'first.md');
    await nextTurn();

    expect(renderer.render).toHaveBeenCalledTimes(2);
    expect(renderer.clear).not.toHaveBeenCalled();
  });

  it('clears a retained primary renderer before showing opaque content', async () => {
    const firstReview = singleFileReview();
    const nextReview = {
      ...singleFileReview(),
      comparisonTargetOid: '3'.repeat(40),
    };
    const port = immediateReviewPort();
    port.readReviewFile
      .mockResolvedValueOnce({
        status: 'success',
        value: textContent(firstReview.files[0], 'first'),
      })
      .mockResolvedValueOnce({
        status: 'success',
        value: { file: nextReview.files[0], kind: 'binary' },
      });
    const renderer = diffPort();
    const session = new ReviewDiffSession({
      objectUrls: objectUrlPort(),
      port,
      renderer,
      rendererFactory: diffPort,
    });

    session.show(document.createElement('div'), firstReview, 'first.md');
    await nextTurn();
    (renderer.clear as jest.Mock).mockClear();
    session.detach();
    session.show(document.createElement('div'), nextReview, 'first.md');
    await nextTurn();

    expect(renderer.clear).toHaveBeenCalledTimes(1);
    expect(renderer.destroy).not.toHaveBeenCalled();
  });

  it('clears a retained primary renderer when continuous content loading fails', async () => {
    const firstReview = singleFileReview();
    const nextReview = {
      ...singleFileReview(),
      comparisonTargetOid: '3'.repeat(40),
    };
    const port = immediateReviewPort();
    port.readReviewFile
      .mockResolvedValueOnce({
        status: 'success',
        value: textContent(firstReview.files[0], 'first'),
      })
      .mockResolvedValueOnce({
        error: new CollabError({ code: 'operation-failed' }),
        status: 'failure',
      });
    const renderer = diffPort();
    const session = new ReviewDiffSession({
      objectUrls: objectUrlPort(),
      port,
      renderer,
      rendererFactory: diffPort,
    });

    session.show(document.createElement('div'), firstReview, 'first.md');
    await nextTurn();
    (renderer.clear as jest.Mock).mockClear();
    session.detach();
    session.show(document.createElement('div'), nextReview, 'first.md');
    await nextTurn();

    expect(renderer.clear).toHaveBeenCalledTimes(1);
    expect(renderer.destroy).not.toHaveBeenCalled();
  });
});

function singleFileReview(): CollabRequestReview {
  return { ...requestReview(), files: requestReview().files.slice(0, 1) };
}

function requestReview(): CollabRequestReview {
  return {
    canAccept: false,
    comparisonBaseOid: MAIN,
    comparisonKind: 'candidate',
    comparisonTargetOid: TREE,
    detail: {
      comments: { comments: [] },
      currentMainOid: MAIN,
      request: {
        commentCount: 0,
        createdAt: '2026-08-08T00:00:00.000Z',
        description: '',
        firstBaseOid: MAIN,
        id: 'request-a',
        latestHeadOid: TREE,
        memberId: 'member-a',
        revision: 1,
        status: 'open',
        ticketRelations: [],
        updatedAt: '2026-08-08T00:00:00.000Z',
      },
      reviewCondition: 'clean',
      reviewedHeadOid: TREE,
    },
    files: ['first.md', 'second.md'].map(path => ({
      binary: false,
      kind: 'modified' as const,
      largeForReview: false,
      newBytes: 4,
      oldBytes: 4,
      path,
    })),
    projectId: 'project-a',
  };
}

function textContent(
  file: CollabRequestReview['files'][number],
  text: string,
): CollabReviewFileContent {
  return { file, kind: 'text', newText: `${text}\n`, oldText: 'old\n' };
}

function reviewPort(
  first: Promise<CollabReviewFileContent>,
  second: Promise<CollabReviewFileContent>,
): jest.Mocked<ReviewDiffSessionPort> {
  let call = 0;
  return {
    readPublicationReviewFile: jest.fn<
      ReturnType<ReviewDiffSessionPort['readPublicationReviewFile']>,
      Parameters<ReviewDiffSessionPort['readPublicationReviewFile']>
    >(),
    readReviewFile: jest.fn<
      ReturnType<ReviewDiffSessionPort['readReviewFile']>,
      Parameters<ReviewDiffSessionPort['readReviewFile']>
    >(() => (
      (++call === 1 ? first : second).then(value => ({ status: 'success' as const, value }))
    )),
    readWorkingTreeReviewFile: jest.fn<
      ReturnType<ReviewDiffSessionPort['readWorkingTreeReviewFile']>,
      Parameters<ReviewDiffSessionPort['readWorkingTreeReviewFile']>
    >(),
  };
}

function immediateReviewPort(): jest.Mocked<ReviewDiffSessionPort> {
  return {
    readPublicationReviewFile: jest.fn(),
    readReviewFile: jest.fn(async request => ({
      status: 'success' as const,
      value: textContent(request.file, request.file.path),
    })),
    readWorkingTreeReviewFile: jest.fn(),
  };
}

function diffPort(): CollabDetailDiffPort {
  return {
    clear: jest.fn(),
    destroy: jest.fn(),
    render: jest.fn().mockResolvedValue(undefined),
    setLayout: jest.fn(),
  };
}

function objectUrlPort(): CollabDetailObjectUrlPort {
  return {
    create: jest.fn().mockReturnValue('blob:review'),
    revoke: jest.fn(),
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(settle => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function nextTurn(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
}
