import { createHash } from 'node:crypto';

import {
  COLLAB_MAIN_REF,
  COLLAB_PROTOCOL_VERSION,
  type DevelopmentBootstrapManifest,
  encodeDevelopmentBootstrapManifestCanonicalJson,
} from '@claudian/collab-protocol';

import {
  advanceCloudBootstrapTransitionPhase,
  CLOUD_BOOTSTRAP_TRANSITION_PHASES,
  type CloudBootstrapTransitionRecord,
} from '@/app/collab/bootstrap/CloudBootstrapTransitionRecord';

export const PROJECT_ID = 'project-alpha';
export const ATTEMPT_ID = 'bootstrap-attempt-one';
export const HOST_MEMBER_ID = 'member-alice';
export const OTHER_MEMBER_ID = 'member-bob';
export const HOST_REF = 'refs/heads/members/member-alice';
export const OTHER_REF = 'refs/heads/members/member-bob';
export const MAIN_OID = '1'.repeat(40);
export const HOST_OID = '2'.repeat(40);
export const OTHER_OID = '3'.repeat(40);

export function bootstrapManifest(): DevelopmentBootstrapManifest {
  return {
    attemptId: ATTEMPT_ID,
    comparison: {
      mainOid: MAIN_OID,
      mainRef: COLLAB_MAIN_REF,
      managerSetGeneration: 4,
      members: [{
        activatedAt: '2026-08-20T00:00:00.000Z',
        createdAt: '2026-08-19T00:00:00.000Z',
        displayName: 'Alice',
        memberId: HOST_MEMBER_ID,
        personalRef: HOST_REF,
        role: 'manager',
        status: 'active',
      }, {
        activatedAt: '2026-08-20T00:01:00.000Z',
        createdAt: '2026-08-19T00:01:00.000Z',
        displayName: 'Bob',
        memberId: OTHER_MEMBER_ID,
        personalRef: OTHER_REF,
        role: 'member',
        status: 'active',
      }],
      projectCreatedAt: '2026-08-19T00:00:00.000Z',
      projectId: PROJECT_ID,
      projectName: 'Project Alpha',
      sourceCaFingerprint: 'b'.repeat(64),
      sourceEventSequence: 12,
      sourceHostMemberId: HOST_MEMBER_ID,
    },
    createdAt: '2026-08-21T00:00:00.000Z',
    git: {
      bundle: {
        byteCount: 128,
        sha256: 'c'.repeat(64),
      },
      objectFormat: 'sha1',
      refs: [
        { name: COLLAB_MAIN_REF, oid: MAIN_OID },
        { name: HOST_REF, oid: HOST_OID },
        { name: OTHER_REF, oid: OTHER_OID },
      ],
    },
    manifestSchemaVersion: 1,
    protocolVersion: COLLAB_PROTOCOL_VERSION,
    sourceEligibility: {
      liveInvitations: 0,
      nonActiveMemberships: 0,
      nonterminalAcceptOperations: 0,
      nonterminalHostTransfers: 0,
      nonterminalManagerOffers: 0,
      requestComments: 0,
      requests: 0,
      terminalProjectTransitions: 0,
      ticketComments: 0,
      ticketMentions: 0,
      ticketRelations: 0,
      tickets: 0,
    },
  };
}

export const MANIFEST_SHA256 = createHash('sha256')
  .update(encodeDevelopmentBootstrapManifestCanonicalJson(bootstrapManifest()))
  .digest('hex');

export function finalizeActivatedBindingForTest(
  record: CloudBootstrapTransitionRecord,
): CloudBootstrapTransitionRecord {
  let current = record;
  const currentIndex = CLOUD_BOOTSTRAP_TRANSITION_PHASES.indexOf(current.phase);
  for (const phase of CLOUD_BOOTSTRAP_TRANSITION_PHASES.slice(currentIndex + 1)) {
    current = advanceCloudBootstrapTransitionPhase(current, phase, current.updatedAt);
  }
  return current;
}
