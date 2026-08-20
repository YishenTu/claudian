import type { CollabRequestDetail } from '@claudian/collab-protocol';

import type { CollabReviewControlPort } from '@/app/collab/review/CollabReviewService';
import {
  type CollabReviewProjectPort,
  type CollabReviewRepositoryPort,
  CollabReviewService,
} from '@/app/collab/review/CollabReviewService';
import type { CollabRequestReview } from '@/core/collab';

const MAIN = '1'.repeat(40);
const HEAD = '2'.repeat(40);
const TREE = '3'.repeat(40);

describe('CollabReviewService', () => {
  it('binds authority detail to one local Project context and delegates exact review', async () => {
    const detail = requestDetail();
    const review = requestReview(detail);
    const control: CollabReviewControlPort = {
      readRequest: jest.fn().mockResolvedValue(detail),
      readRequestPage: jest.fn().mockResolvedValue(detail),
    };
    const projects: CollabReviewProjectPort = {
      load: jest.fn().mockResolvedValue(projectContext()),
      revalidate: jest.fn().mockResolvedValue(undefined),
    };
    const repository: CollabReviewRepositoryPort = {
      prepare: jest.fn().mockResolvedValue(review),
      readFile: jest.fn(),
    };
    const service = new CollabReviewService(control, projects, repository);

    await expect(service.prepare('project-a', 'request-a')).resolves.toEqual(review);
    expect(control.readRequest).toHaveBeenCalledWith('project-a', 'request-a', {});
    expect(repository.prepare).toHaveBeenCalledWith(projectContext(), detail, undefined);
    expect(projects.revalidate).toHaveBeenCalledWith(projectContext());

    await expect(service.preparePage('project-a', 'request-a')).resolves.toEqual(review);
    expect(control.readRequestPage).toHaveBeenCalledWith('project-a', 'request-a', {});
  });

  it('revalidates the Project before reading one exact selected file', async () => {
    const content = {
      file: file(),
      kind: 'text' as const,
      newText: 'new\n',
      oldText: 'old\n',
    };
    const projects: CollabReviewProjectPort = {
      load: jest.fn().mockResolvedValue(projectContext()),
      revalidate: jest.fn().mockResolvedValue(undefined),
    };
    const repository: CollabReviewRepositoryPort = {
      prepare: jest.fn(),
      readFile: jest.fn().mockResolvedValue(content),
    };
    const service = new CollabReviewService({
      readRequest: jest.fn(),
      readRequestPage: jest.fn(),
    }, projects, repository);
    const request = {
      comparisonBaseOid: MAIN,
      comparisonTargetOid: TREE,
      file: file(),
      projectId: 'project-a',
      requestId: 'request-a',
    };

    await expect(service.readFile(request)).resolves.toBe(content);
    expect(projects.revalidate).toHaveBeenCalledWith(projectContext());
    expect(repository.readFile).toHaveBeenCalledWith(projectContext(), request, undefined);
  });

  it('keeps Accept eligibility false for a non-Manager review context', async () => {
    const detail = requestDetail();
    const context = { ...projectContext(), role: 'member' as const };
    const projects: CollabReviewProjectPort = {
      load: jest.fn().mockResolvedValue(context),
      revalidate: jest.fn().mockResolvedValue(undefined),
    };
    const repository: CollabReviewRepositoryPort = {
      prepare: jest.fn().mockResolvedValue({
        ...requestReview(detail),
        canAccept: undefined,
      }),
      readFile: jest.fn(),
    };
    const service = new CollabReviewService({
      readRequest: jest.fn().mockResolvedValue(detail),
      readRequestPage: jest.fn().mockResolvedValue(detail),
    }, projects, repository);

    await expect(service.prepare('project-a', 'request-a')).resolves.toMatchObject({
      canAccept: false,
    });
  });
});

function projectContext() {
  return {
    allowHostRemoteRepair: false,
    memberId: 'member-reviewer',
    personalRef: 'refs/heads/members/member-reviewer',
    projectId: 'project-a',
    remoteUrl: 'https://192.168.1.20/repository.git',
    repositoryPath: '/vault/workspace/project-a',
    role: 'manager' as const,
  };
}

function file() {
  return {
    binary: false,
    kind: 'modified' as const,
    largeForReview: false,
    newBytes: 4,
    oldBytes: 4,
    path: 'note.md',
  };
}

function requestDetail(): CollabRequestDetail {
  return {
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
  };
}

function requestReview(detail: CollabRequestDetail): CollabRequestReview {
  return {
    canAccept: true,
    comparisonBaseOid: MAIN,
    comparisonKind: 'candidate',
    comparisonTargetOid: TREE,
    detail,
    files: [file()],
    projectId: 'project-a',
  };
}
