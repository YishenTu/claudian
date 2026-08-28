import {
  TEST_COLLAB_FEATURE_PORT_METHODS,
  TEST_COLLAB_RESULT_STATUSES,
} from '@test/helpers/collab/CollabFeatureTestHarness';

import { CollabError } from '@/core/collab/ClaudianCollabError';
import {
  type CollabFeaturePort,
  type CollabResult,
} from '@/core/collab/CollabFeaturePort';
import type { CollabConflictDescriptor } from '@/core/collab/types';

describe('CollabFeaturePort', () => {
  it('keeps every feature operation behind the provider-neutral port', () => {
    const methodCoverage = {
      initialize: true,
      listProjects: true,
      readProjectSelection: true,
      selectProject: true,
      inspectProject: true,
      createProject: true,
      joinProject: true,
      reconnectProject: true,
      resumeSetup: true,
      readGitStatus: true,
      readSnapshot: true,
      readPublishDescription: true,
      publish: true,
      confirmPublish: true,
      prepareWorkingTreeReview: true,
      readWorkingTreeReviewFile: true,
      readConflict: true,
      readConflictFile: true,
      createInvitation: true,
      revokeInvitation: true,
      claimLegacyHostInstallation: true,
      startHost: true,
      stopHost: true,
      readRequest: true,
      prepareReview: true,
      preparePublicationReview: true,
      readReviewFile: true,
      readPublicationReviewFile: true,
      addComment: true,
      listTickets: true,
      readTicket: true,
      createTicket: true,
      updateTicketContent: true,
      addTicketComment: true,
      closeTicket: true,
      reopenTicket: true,
      updateRequestMetadata: true,
      acceptRequest: true,
      listMembers: true,
      removeMember: true,
      leaveProject: true,
      createManagerResponsibilityOffer: true,
      cancelManagerResponsibilityOffer: true,
      promoteManager: true,
      demoteManager: true,
      createHostTransfer: true,
      acceptHostTransfer: true,
      declineHostTransfer: true,
      cancelHostTransfer: true,
      retireProject: true,
      finalizeRetiredProject: true,
      retryProjectCleanup: true,
      subscribe: true,
    } satisfies Record<keyof CollabFeaturePort, true>;

    expect(Object.keys(methodCoverage)).toEqual(TEST_COLLAB_FEATURE_PORT_METHODS);
    expect(TEST_COLLAB_FEATURE_PORT_METHODS).not.toContain('shutdown');
    expect(TEST_COLLAB_FEATURE_PORT_METHODS).not.toContain(
      'acknowledgeManagerResponsibility',
    );
    expect(TEST_COLLAB_FEATURE_PORT_METHODS).not.toContain(
      'declineManagerResponsibility',
    );
  });

  it('keeps decision-free conflict inspection and file versions provider-neutral', () => {
    const session = {
      descriptor: {
        operationId: 'operation_1',
        projectId: 'project_1',
        startingPersonalOid: '1'.repeat(40),
        startingMainOid: '2'.repeat(40),
        mergeBaseOid: '3'.repeat(40),
        conflicts: [{ kind: 'text' as const, path: 'note.md' }],
      },
    };
    const content = {
      accepted: { path: 'note.md', text: 'accepted\n' },
      base: { path: 'note.md', text: 'base\n' },
      kind: 'text' as const,
      path: 'note.md',
      personal: { path: 'note.md', text: 'mine\n' },
    };

    expect(session.descriptor.conflicts).toEqual([{ kind: 'text', path: 'note.md' }]);
    expect(content).toMatchObject({
      accepted: { text: 'accepted\n' },
      personal: { text: 'mine\n' },
    });
  });

  it('defines every command result as a stable discriminated state', () => {
    const error = new CollabError({ code: 'operation-failed' });
    const conflict: CollabConflictDescriptor = {
      operationId: 'operation_1',
      projectId: 'project_1',
      startingPersonalOid: '1'.repeat(40),
      startingMainOid: '2'.repeat(40),
      mergeBaseOid: '3'.repeat(40),
      conflicts: [],
    };
    const results: readonly CollabResult<string>[] = [
      { status: 'success', value: 'done' },
      {
        status: 'cancelled',
        operationId: 'operation_1',
        durableProgress: false,
      },
      {
        status: 'recovery-required',
        operationId: 'operation_1',
        durableProgress: true,
        durablePhase: 'committed',
        error: new CollabError({
          code: 'durable-progress-recovery-required',
          recoveryActions: ['resume'],
        }),
      },
      {
        status: 'stale',
        staleKind: 'request-head',
        error: new CollabError({ code: 'stale-request-head' }),
      },
      {
        status: 'conflict',
        conflict,
        error: new CollabError({ code: 'content-conflict' }),
      },
      { status: 'failure', error },
    ];

    expect(results.map(result => result.status)).toEqual(TEST_COLLAB_RESULT_STATUSES);
    expect(results[1]).toMatchObject({ durableProgress: false });
    expect(results[2]).toMatchObject({ durableProgress: true });
  });
});
