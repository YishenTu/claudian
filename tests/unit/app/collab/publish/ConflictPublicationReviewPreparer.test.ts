import {
  COLLAB_PUBLICATION_STATE_SCHEMA_VERSION,
  type CollabPublicationStateRecord,
} from '@/app/collab/publish/CollabPublicationStateRecord';
import { ConflictPublicationReviewPreparer } from '@/app/collab/publish/ConflictPublicationReviewPreparer';
import type {
  PublishCandidatePort,
  PublishCoordinator,
  PublishProjectContext,
} from '@/app/collab/publish/PublishCoordinator';

const CONTRIBUTION = '1'.repeat(40);
const MAIN = '2'.repeat(40);
const CANDIDATE = '3'.repeat(40);
const CREATED_AT = '2026-08-08T00:00:00.000Z';
const UPDATED_AT = '2026-08-08T00:01:00.000Z';
const CONTEXT: PublishProjectContext = {
  memberId: 'member-a',
  personalRef: 'refs/heads/members/member-a',
  projectId: 'project-a',
  remoteUrl: 'https://127.0.0.1/repository.git',
  repositoryPath: '/vault/project-a',
};

describe('ConflictPublicationReviewPreparer', () => {
  it('durably transitions the captured conflict result into exact review state', async () => {
    const fixture = createFixture(capturedState());

    await expect(fixture.subject.prepareResolvedReview(CONTEXT, input())).resolves
      .toMatchObject({ candidateOid: CANDIDATE, kind: 'publication' });

    expect(fixture.candidates.assertRetained).toHaveBeenCalledWith(
      CONTEXT,
      input(),
      undefined,
    );
    expect(fixture.state.value.operation).toMatchObject({
      candidateOid: CANDIDATE,
      currentMainOid: MAIN,
      phase: 'review-ready',
      updatedAt: UPDATED_AT,
    });
    expect(fixture.publications.prepareReview).toHaveBeenCalledWith(
      'project-a',
      'operation-a',
      { signal: undefined },
    );
  });

  it('resumes the same exact retained review without rewriting durable state', async () => {
    const fixture = createFixture(reviewReadyState());

    await fixture.subject.prepareResolvedReview(CONTEXT, input());

    expect(fixture.state.save).not.toHaveBeenCalled();
    expect(fixture.candidates.assertRetained).toHaveBeenCalledTimes(1);
  });

  it('rejects a result that does not match the captured publication operation', async () => {
    const fixture = createFixture(capturedState());

    await expect(fixture.subject.prepareResolvedReview(CONTEXT, {
      ...input(),
      contributionHeadOid: '4'.repeat(40),
    })).rejects.toMatchObject({
      code: 'repository-invalid',
      safeContext: { reason: 'conflict-publication-state-mismatch' },
    });
    expect(fixture.candidates.assertRetained).not.toHaveBeenCalled();
    expect(fixture.state.save).not.toHaveBeenCalled();
  });
});

function input() {
  return {
    candidateOid: CANDIDATE,
    contributionHeadOid: CONTRIBUTION,
    currentMainOid: MAIN,
    operationId: 'operation-a',
  } as const;
}

function capturedState(): CollabPublicationStateRecord {
  return {
    baseMainOid: '0'.repeat(40),
    operation: {
      candidateOid: null,
      contributionHeadOid: CONTRIBUTION,
      createdAt: CREATED_AT,
      currentMainOid: null,
      operationId: 'operation-a',
      phase: 'captured',
      updatedAt: CREATED_AT,
    },
    projectId: 'project-a',
    schemaVersion: COLLAB_PUBLICATION_STATE_SCHEMA_VERSION,
    updatedAt: CREATED_AT,
  };
}

function reviewReadyState(): CollabPublicationStateRecord {
  const state = capturedState();
  return {
    ...state,
    operation: {
      ...state.operation!,
      candidateOid: CANDIDATE,
      currentMainOid: MAIN,
      phase: 'review-ready',
    },
  };
}

function createFixture(initial: CollabPublicationStateRecord) {
  const stateValue = { value: initial };
  const state = {
    get value() { return stateValue.value; },
    load: jest.fn(async () => stateValue.value),
    save: jest.fn(async (record: CollabPublicationStateRecord) => {
      stateValue.value = record;
    }),
  };
  const candidates = {
    assertRetained: jest.fn(async () => undefined),
  } as unknown as jest.Mocked<PublishCandidatePort>;
  const review = {
    baseMainOid: initial.baseMainOid,
    candidateOid: CANDIDATE,
    canConfirm: true,
    comparisonBaseOid: MAIN,
    comparisonTargetOid: CANDIDATE,
    contributionHeadOid: CONTRIBUTION,
    currentMainOid: MAIN,
    files: [],
    kind: 'publication' as const,
    operationId: 'operation-a',
    projectId: 'project-a',
  };
  const publications = {
    prepareReview: jest.fn(async () => review),
  } satisfies Pick<PublishCoordinator, 'prepareReview'>;
  const subject = new ConflictPublicationReviewPreparer(
    state,
    candidates,
    publications,
    () => new Date(UPDATED_AT),
  );
  return { candidates, publications, state, subject };
}
