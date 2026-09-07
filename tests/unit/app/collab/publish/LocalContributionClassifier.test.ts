import {
  classifyLocalContribution,
  hasUnpublishedPersonalState,
  type LocalContributionClassificationInput,
  personalChangesReviewBaseOid,
} from '@/app/collab/publish/LocalContributionClassifier';

function input(
  overrides: Partial<LocalContributionClassificationInput> = {},
): LocalContributionClassificationInput {
  return {
    acceptedRelation: 'current',
    coordinationAuthoritative: true,
    hasConflictRecovery: false,
    hasOpenRequest: false,
    hasPublicationRecovery: false,
    personalAheadBy: 0,
    personalBehindBy: 0,
    workingTreeClean: true,
    ...overrides,
  };
}

describe('LocalContributionClassifier', () => {
  it('uses the authoritative request head as the virtual-squash review base', () => {
    expect(personalChangesReviewBaseOid({
      coordinationAuthoritative: true,
      headOid: '3'.repeat(40),
      openRequestHeadOid: '1'.repeat(40),
      personalRemoteOid: '2'.repeat(40),
    })).toBe('1'.repeat(40));
  });

  it('falls back from stale coordination to the personal remote and then HEAD', () => {
    expect(personalChangesReviewBaseOid({
      coordinationAuthoritative: false,
      headOid: '3'.repeat(40),
      openRequestHeadOid: '1'.repeat(40),
      personalRemoteOid: '2'.repeat(40),
    })).toBe('2'.repeat(40));
    expect(personalChangesReviewBaseOid({
      coordinationAuthoritative: false,
      headOid: '3'.repeat(40),
      personalRemoteOid: null,
    })).toBe('3'.repeat(40));
  });

  it.each([
    ['dirty worktree', { workingTreeClean: false }],
    ['unpushed head', { personalRemoteOid: '2'.repeat(40) }],
    ['request at another head', { openRequestHeadOid: '3'.repeat(40) }],
  ])('detects %s as unpublished personal state', (_label, overrides) => {
    expect(hasUnpublishedPersonalState({
      headOid: '1'.repeat(40),
      openRequestHeadOid: '1'.repeat(40),
      personalRemoteOid: '1'.repeat(40),
      workingTreeClean: true,
      ...overrides,
    })).toBe(true);
  });

  it('treats a clean pushed head represented by the open request as published', () => {
    expect(hasUnpublishedPersonalState({
      headOid: '1'.repeat(40),
      openRequestHeadOid: '1'.repeat(40),
      personalRemoteOid: '1'.repeat(40),
      workingTreeClean: true,
    })).toBe(false);
  });

  it.each([
    ['dirty worktree', { workingTreeClean: false }],
    ['local commits', { acceptedRelation: 'personal-ahead' as const, personalAheadBy: 1 }],
    ['open request', { hasOpenRequest: true }],
    ['publication recovery', { hasPublicationRecovery: true }],
    ['conflict recovery', { hasConflictRecovery: true }],
    ['pushed unrequested head', { acceptedRelation: 'personal-ahead' as const }],
  ])('classifies %s as a contribution', (_label, overrides) => {
    expect(classifyLocalContribution(input(overrides))).toMatchObject({
      kind: 'contribution',
    });
  });

  it('allows only a current or behind contribution-free personal state', () => {
    expect(classifyLocalContribution(input())).toEqual({
      kind: 'none',
      updateAvailable: false,
    });
    expect(classifyLocalContribution(input({
      acceptedRelation: 'personal-behind',
    }))).toEqual({
      kind: 'none',
      updateAvailable: true,
    });
    expect(classifyLocalContribution(input({ personalAheadBy: 1 }))).toEqual({
      kind: 'none',
      updateAvailable: false,
    });
  });

  it.each([
    ['offline uncertainty', { coordinationAuthoritative: false }],
    ['remote personal divergence', { personalBehindBy: 1 }],
    ['diverged main history', { acceptedRelation: 'diverged' as const }],
    ['unknown relationship', { acceptedRelation: 'unknown' as const }],
  ])('fails closed for %s', (_label, overrides) => {
    expect(classifyLocalContribution(input(overrides))).toMatchObject({
      kind: 'unsafe',
    });
  });
});
