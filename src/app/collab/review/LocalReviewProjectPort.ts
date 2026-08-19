import type { CollabLocalProjectRepository } from '@/app/collab/CollabLocalProjectRepository';
import type { LocalPublishProjectPort } from '@/app/collab/publish/LocalPublishProjectPort';
import type {
  CollabReviewProjectContext,
  CollabReviewProjectPort,
} from '@/app/collab/review/CollabReviewService';
import { CollabError } from '@/core/collab/ClaudianCollabError';

function projectError(reason: string): CollabError {
  return new CollabError({
    code: 'stale-project-selection',
    recoveryActions: ['retry'],
    safeContext: { reason },
  });
}

export class LocalReviewProjectPort implements CollabReviewProjectPort {
  constructor(
    private readonly publishProjects: LocalPublishProjectPort,
    private readonly localProjects: CollabLocalProjectRepository,
  ) {}

  async load(projectId: string): Promise<CollabReviewProjectContext> {
    const context = await this.publishProjects.load(projectId);
    const membership = await this.localProjects.loadMembership(projectId);
    if (
      !membership
      || membership.project.id !== context.projectId
      || membership.member.id !== context.memberId
      || membership.member.personalRef !== context.personalRef
    ) {
      throw projectError('review-membership-changed');
    }
    return { ...context, role: membership.member.role };
  }

  async revalidate(context: CollabReviewProjectContext): Promise<void> {
    await this.publishProjects.revalidate(context);
    const membership = await this.localProjects.loadMembership(context.projectId);
    if (
      !membership
      || membership.member.id !== context.memberId
      || membership.member.role !== context.role
      || membership.member.personalRef !== context.personalRef
    ) {
      throw projectError('review-membership-changed');
    }
  }
}
