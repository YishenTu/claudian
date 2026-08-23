import type { CollabRequestDetail, CollabRole } from '@claudian-collab/protocol';

import type { CollabOperationOptions, CollabRequestReview, CollabReviewFileContent, CollabReviewFileRequest } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export interface CollabReviewProjectContext {
  readonly allowHostRemoteRepair: boolean;
  readonly memberId: string;
  readonly personalRef: string;
  readonly projectId: string;
  readonly remoteUrl: string;
  readonly repositoryPath: string;
  readonly role: CollabRole;
}

export interface CollabReviewControlPort {
  readRequest(
    projectId: string,
    requestId: string,
    options?: CollabOperationOptions,
  ): Promise<CollabRequestDetail>;
  readRequestPage(
    projectId: string,
    requestId: string,
    options?: CollabOperationOptions,
  ): Promise<CollabRequestDetail>;
}

export interface CollabReviewProjectPort {
  load(projectId: string): Promise<CollabReviewProjectContext>;
  revalidate(context: CollabReviewProjectContext): Promise<void>;
}

export interface CollabReviewRepositoryPort {
  prepare(
    context: CollabReviewProjectContext,
    detail: CollabRequestDetail,
    signal?: AbortSignal,
  ): Promise<Omit<CollabRequestReview, 'canAccept'>>;
  readFile(
    context: CollabReviewProjectContext,
    request: CollabReviewFileRequest,
    signal?: AbortSignal,
  ): Promise<CollabReviewFileContent>;
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new CollabError({ code: 'cancelled' });
  }
}

export class CollabReviewService {
  constructor(
    private readonly control: CollabReviewControlPort,
    private readonly projects: CollabReviewProjectPort,
    private readonly repository: CollabReviewRepositoryPort,
  ) {}

  async prepare(
    projectId: string,
    requestId: string,
    options: CollabOperationOptions = {},
  ): Promise<CollabRequestReview> {
    return this.prepareWith(
      projectId,
      requestId,
      options,
      () => this.control.readRequest(projectId, requestId, options),
    );
  }

  async preparePage(
    projectId: string,
    requestId: string,
    options: CollabOperationOptions = {},
  ): Promise<CollabRequestReview> {
    return this.prepareWith(
      projectId,
      requestId,
      options,
      () => this.control.readRequestPage(projectId, requestId, options),
    );
  }

  private async prepareWith(
    projectId: string,
    requestId: string,
    options: CollabOperationOptions,
    readDetail: () => Promise<CollabRequestDetail>,
  ): Promise<CollabRequestReview> {
    throwIfCancelled(options.signal);
    const [context, detail] = await Promise.all([
      this.projects.load(projectId),
      readDetail(),
    ]);
    const review = await this.repository.prepare(context, detail, options.signal);
    await this.projects.revalidate(context);
    throwIfCancelled(options.signal);
    return {
      ...review,
      canAccept: context.role === 'manager'
        && detail.request.status === 'open'
        && detail.reviewCondition === 'clean',
    };
  }

  async readFile(
    request: CollabReviewFileRequest,
    options: CollabOperationOptions = {},
  ): Promise<CollabReviewFileContent> {
    throwIfCancelled(options.signal);
    const context = await this.projects.load(request.projectId);
    await this.projects.revalidate(context);
    const content = await this.repository.readFile(context, request, options.signal);
    throwIfCancelled(options.signal);
    return content;
  }
}
