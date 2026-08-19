export type AcceptedMainRelationship =
  | 'current'
  | 'personal-behind'
  | 'personal-ahead'
  | 'diverged'
  | 'unknown';

export interface LocalContributionClassificationInput {
  readonly acceptedRelation: AcceptedMainRelationship;
  readonly coordinationAuthoritative: boolean;
  readonly hasConflictRecovery: boolean;
  readonly hasOpenRequest: boolean;
  readonly hasPublicationRecovery: boolean;
  readonly personalAheadBy: number;
  readonly personalBehindBy: number;
  readonly workingTreeClean: boolean;
}

export type LocalContributionClassification =
  | {
    readonly kind: 'contribution';
    readonly reason:
      | 'conflict-recovery'
      | 'dirty-working-tree'
      | 'local-commits'
      | 'open-request'
      | 'personal-ahead'
      | 'publication-recovery';
  }
  | { readonly kind: 'none'; readonly updateAvailable: boolean }
  | {
    readonly kind: 'unsafe';
    readonly reason:
      | 'coordination-unavailable'
      | 'history-diverged'
      | 'history-unknown'
      | 'personal-remote-diverged';
  };

export interface UnpublishedPersonalStateInput {
  readonly headOid: string | null;
  readonly openRequestHeadOid?: string;
  readonly personalRemoteOid: string | null;
  readonly workingTreeClean: boolean;
}

export interface PersonalChangesReviewBaseInput {
  readonly coordinationAuthoritative: boolean;
  readonly headOid: string | null;
  readonly openRequestHeadOid?: string;
  readonly personalRemoteOid: string | null;
}

export function personalChangesReviewBaseOid(
  input: PersonalChangesReviewBaseInput,
): string | null {
  return (input.coordinationAuthoritative ? input.openRequestHeadOid : undefined)
    ?? input.personalRemoteOid
    ?? input.headOid;
}

export function hasUnpublishedPersonalState(
  input: UnpublishedPersonalStateInput,
): boolean {
  return !input.workingTreeClean
    || input.personalRemoteOid !== input.headOid
    || (
      input.openRequestHeadOid !== undefined
      && input.openRequestHeadOid !== input.headOid
    );
}

export function classifyLocalContribution(
  input: LocalContributionClassificationInput,
): LocalContributionClassification {
  if (!input.coordinationAuthoritative) {
    return { kind: 'unsafe', reason: 'coordination-unavailable' };
  }
  if (input.personalBehindBy > 0) {
    return { kind: 'unsafe', reason: 'personal-remote-diverged' };
  }
  if (!input.workingTreeClean) {
    return { kind: 'contribution', reason: 'dirty-working-tree' };
  }
  if (input.hasPublicationRecovery) {
    return { kind: 'contribution', reason: 'publication-recovery' };
  }
  if (input.hasConflictRecovery) {
    return { kind: 'contribution', reason: 'conflict-recovery' };
  }
  if (input.hasOpenRequest) {
    return { kind: 'contribution', reason: 'open-request' };
  }
  if (input.personalAheadBy > 0 && input.acceptedRelation !== 'current') {
    return { kind: 'contribution', reason: 'local-commits' };
  }
  if (input.acceptedRelation === 'personal-ahead') {
    return { kind: 'contribution', reason: 'personal-ahead' };
  }
  if (input.acceptedRelation === 'diverged') {
    return { kind: 'unsafe', reason: 'history-diverged' };
  }
  if (input.acceptedRelation === 'unknown') {
    return { kind: 'unsafe', reason: 'history-unknown' };
  }
  return {
    kind: 'none',
    updateAvailable: input.acceptedRelation === 'personal-behind',
  };
}
