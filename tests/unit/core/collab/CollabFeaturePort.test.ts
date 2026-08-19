import {
  TEST_COLLAB_FEATURE_PORT_METHODS,
  TEST_COLLAB_RESULT_STATUSES,
} from '@test/helpers/collab/CollabFeatureTestHarness';

import { CollabError } from '@/core/collab/ClaudianCollabError';
import {
  type CollabConflictDecision,
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
      acknowledgeManagerResponsibility: true,
      declineManagerResponsibility: true,
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
  });

  it('keeps legacy agent decisions decodable for durable conflict replay', () => {
    const decisions: readonly CollabConflictDecision[] = [
      { path: 'mine.md', choice: 'keep-personal' },
      { path: 'accepted.md', choice: 'use-accepted' },
      {
        path: 'manual.md',
        choice: 'use-manual-draft',
        draft: 'reviewed manual result',
      },
      {
        path: 'agent.md',
        choice: 'use-agent-proposal',
        proposal: 'reviewed agent result',
      },
    ];

    expect(decisions).toEqual([
      { path: 'mine.md', choice: 'keep-personal' },
      { path: 'accepted.md', choice: 'use-accepted' },
      {
        path: 'manual.md',
        choice: 'use-manual-draft',
        draft: 'reviewed manual result',
      },
      {
        path: 'agent.md',
        choice: 'use-agent-proposal',
        proposal: 'reviewed agent result',
      },
    ]);
  });

  it('keeps resumable conflict decisions and file versions provider-neutral', () => {
    const session = {
      decisions: [{ path: 'note.md', choice: 'keep-personal' as const }],
      descriptor: {
        operationId: 'operation_1',
        projectId: 'project_1',
        startingPersonalOid: '1'.repeat(40),
        startingMainOid: '2'.repeat(40),
        mergeBaseOid: '3'.repeat(40),
        conflicts: [{ kind: 'text' as const, path: 'note.md' }],
      },
      pending: [],
      resolvedPaths: ['note.md'],
    };
    const content = {
      accepted: { path: 'note.md', text: 'accepted\n' },
      base: { path: 'note.md', text: 'base\n' },
      kind: 'text' as const,
      path: 'note.md',
      personal: { path: 'note.md', text: 'mine\n' },
    };

    expect(session.decisions[0]).toMatchObject({ choice: 'keep-personal' });
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
