import type {
  CollabCloudBootstrapPort,
  CollabFeatureServiceOptions,
  CollabHostTransferPort,
  CollabJoinProjectPort,
  CollabLanHostPort,
  CollabLifecycleRecoveryPort,
  CollabLocalExitPort,
  CollabMembershipPort,
  CollabPublicationPort,
  CollabRetirementPort,
} from '@/app/collab/CollabFeatureService';
import type {
  CollabPublicationReconnectPort,
  CollabPublicationServiceOptions,
} from '@/app/collab/publish/CollabPublicationService';
import type { CollabLanProjectSnapshot } from '@/core/collab';
import { type CollabFeaturePort, type CollabResult } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const OID_A = 'a'.repeat(40);
const OID_B = 'b'.repeat(40);
const SNAPSHOT_ID = 'd'.repeat(64);
const TEST_TIMESTAMP = '2026-08-08T00:00:00.000Z';

export const TEST_COLLAB_FEATURE_PORT_METHODS = [
  'initialize',
  'listProjects',
  'readProjectSelection',
  'selectProject',
  'inspectProject',
  'createProject',
  'joinProject',
  'reconnectProject',
  'resumeSetup',
  'readGitStatus',
  'readSnapshot',
  'readPublishDescription',
  'publish',
  'confirmPublish',
  'prepareWorkingTreeReview',
  'readWorkingTreeReviewFile',
  'readConflict',
  'readConflictFile',
  'createInvitation',
  'revokeInvitation',
  'claimLegacyHostInstallation',
  'startHost',
  'stopHost',
  'readRequest',
  'prepareReview',
  'preparePublicationReview',
  'readReviewFile',
  'readPublicationReviewFile',
  'addComment',
  'listTickets',
  'readTicket',
  'createTicket',
  'updateTicketContent',
  'addTicketComment',
  'closeTicket',
  'reopenTicket',
  'updateRequestMetadata',
  'acceptRequest',
  'listMembers',
  'removeMember',
  'leaveProject',
  'createManagerResponsibilityOffer',
  'cancelManagerResponsibilityOffer',
  'promoteManager',
  'demoteManager',
  'createHostTransfer',
  'acceptHostTransfer',
  'declineHostTransfer',
  'cancelHostTransfer',
  'retireProject',
  'finalizeRetiredProject',
  'retryProjectCleanup',
  'subscribe',
] as const satisfies readonly (keyof CollabFeaturePort)[];

export const TEST_COLLAB_RESULT_STATUSES = [
  'success',
  'cancelled',
  'recovery-required',
  'stale',
  'conflict',
  'failure',
] as const satisfies readonly CollabResult<unknown>['status'][];

type FeatureOptionsOverrides = {
  readonly cloudBootstrap?: Partial<CollabCloudBootstrapPort>;
  readonly hostTransfer?: Partial<CollabHostTransferPort>;
  readonly hostInstallation?: Partial<CollabFeatureServiceOptions['hostInstallation']>;
  readonly join?: Partial<CollabJoinProjectPort>;
  readonly lanHost?: Partial<CollabLanHostPort>;
  readonly lifecycleRecovery?: Partial<CollabLifecycleRecoveryPort>;
  readonly localExit?: Partial<CollabLocalExitPort>;
  readonly membership?: Partial<CollabMembershipPort>;
  readonly publication?: Partial<CollabPublicationPort>;
  readonly retirement?: Partial<CollabRetirementPort>;
  readonly vaultRoot: string;
};

function defaultCloudBootstrap(): CollabCloudBootstrapPort {
  return {
    cancel: () => unexpected('cancelCloudBootstrap'),
    close: () => Promise.resolve(),
    prepareLocalRecovery: () => Promise.resolve(),
    recoverPending: () => Promise.resolve(),
    startFormerHost: () => unexpected('startCloudBootstrapFormerHost'),
    submitParticipant: () => unexpected('submitCloudBootstrapParticipant'),
  };
}

type PublicationOptionsOverrides = {
  readonly discovery?: Partial<CollabPublicationServiceOptions['discovery']>;
  readonly inspectHostInstallation?: CollabPublicationServiceOptions['inspectHostInstallation'];
  readonly readActiveLocalRoute?: CollabPublicationServiceOptions['readActiveLocalRoute'];
  readonly managerResponsibility?: Partial<
    CollabPublicationServiceOptions['managerResponsibility']
  >;
  readonly reconnect?: Partial<CollabPublicationServiceOptions['reconnect']>;
  readonly retirement?: Partial<CollabPublicationServiceOptions['retirement']>;
  readonly retirementAdmission?: CollabPublicationServiceOptions['retirementAdmission'];
  readonly vaultRoot: string;
};

function unexpected<T>(operation: string): Promise<T> {
  return Promise.reject(new Error(`Unexpected Collab test operation: ${operation}`));
}

function projectSnapshot(): CollabLanProjectSnapshot {
  const currentMember = {
    activatedAt: TEST_TIMESTAMP,
    createdAt: TEST_TIMESTAMP,
    displayName: 'Test Member',
    id: 'member-test',
    personalRef: 'refs/heads/members/member-test',
    role: 'manager' as const,
    status: 'active' as const,
  };
  return {
    currentMember,
    eventSequence: 1,
    members: [currentMember],
    openTicketCount: 0,
    openRequests: [],
    project: {
      authorityKind: 'lan',
      createdAt: TEST_TIMESTAMP,
      hostMemberId: currentMember.id,
      id: 'project-alpha',
      mainOid: OID_A,
      mainRef: 'refs/heads/main',
      managerSetGeneration: 0,
      name: 'Alpha',
    },
    ticketHighlights: [],
  };
}

function defaultHostTransfer(): CollabHostTransferPort {
  return {
    acceptHostTransfer: () => Promise.resolve(),
    cancelHostTransfer: () => Promise.resolve(),
    close: () => Promise.resolve(),
    createHostTransfer: () => Promise.resolve(),
    declineHostTransfer: () => Promise.resolve(),
  };
}

function defaultHostInstallation(): CollabFeatureServiceOptions['hostInstallation'] {
  return {
    claimLegacy: () => unexpected('claimLegacyHostInstallation'),
    inspect: () => Promise.resolve('hosted-here'),
  };
}

function defaultJoin(): CollabJoinProjectPort {
  return {
    joinProject: () => unexpected('joinProject'),
    resumeJoin: () => unexpected('resumeJoin'),
  };
}

function defaultLanHost(): CollabLanHostPort {
  return {
    getProjectState: projectId => ({ projectId, status: 'stopped' }),
    startProject: projectId => Promise.resolve({
      endpoint: 'https://127.0.0.1:54545',
      projectId,
      status: 'running',
    }),
    stopProject: projectId => Promise.resolve({ projectId, status: 'stopped' }),
  };
}

function defaultLifecycleRecovery(): CollabLifecycleRecoveryPort {
  return {
    close: () => Promise.resolve(),
    resume: () => Promise.resolve(),
  };
}

function defaultLocalExit(): CollabLocalExitPort {
  return { leaveProject: () => Promise.resolve() };
}

function defaultMembership(): CollabMembershipPort {
  return {
    cancelManagerResponsibilityOffer: () => unexpected('cancelManagerResponsibilityOffer'),
    createInvitation: () => unexpected('createInvitation'),
    createManagerResponsibilityOffer: () => unexpected('createManagerResponsibilityOffer'),
    listMembers: () => Promise.resolve([]),
    removeMember: () => Promise.resolve(),
    revokeInvitation: () => Promise.resolve(),
    promoteManager: () => Promise.resolve(),
    demoteManager: () => Promise.resolve(),
  };
}

function defaultPublication(): CollabPublicationPort {
  return {
    abortProjectBackgroundWork: () => undefined,
    acceptRequest: () => unexpected('acceptRequest'),
    addComment: () => unexpected('addComment'),
    addTicketComment: () => unexpected('addTicketComment'),
    beginProjectInspection: () => ({
      precedingSynchronization: null,
      release: () => undefined,
    }),
    close: () => Promise.resolve(),
    closeTicket: () => unexpected('closeTicket'),
    confirmPublish: () => unexpected('confirmPublish'),
    createTicket: () => unexpected('createTicket'),
    findConflict: () => Promise.resolve({ status: 'success', value: null }),
    inspectPersonalChanges: projectId => Promise.resolve({
      action: 'publish',
      hasContribution: false,
      unpublishedReview: {
        baseOid: OID_A,
        files: [],
        headOid: OID_B,
        kind: 'working-tree',
        projectId,
        snapshotId: SNAPSHOT_ID,
      },
      updateAvailable: false,
    }),
    listRequestComments: () => unexpected('listRequestComments'),
    listTicketAcceptedRelations: () => unexpected('listTicketAcceptedRelations'),
    listTicketComments: () => unexpected('listTicketComments'),
    listTickets: () => unexpected('listTickets'),
    preparePublicationReview: () => unexpected('preparePublicationReview'),
    prepareReview: () => unexpected('prepareReview'),
    prepareReviewPage: () => unexpected('prepareReviewPage'),
    prepareWorkingTreeReview: () => unexpected('prepareWorkingTreeReview'),
    publish: () => unexpected('publish'),
    readConflict: () => unexpected('readConflict'),
    readConflictFile: () => unexpected('readConflictFile'),
    readCoordinationSnapshot: projectId => Promise.resolve({
      snapshot: { ...projectSnapshot(), project: { ...projectSnapshot().project, id: projectId } },
      source: 'online',
      stale: false,
      syncState: {
        eventSequence: 1,
        generation: 1,
        projectId,
        status: 'synchronized',
      },
    }),
    readGitStatus: () => Promise.resolve({
      acceptedMainOid: OID_A,
      aheadBy: 0,
      behindBy: 0,
      changedFiles: [],
      headOid: OID_B,
      includesAcceptedMain: true,
      personalRemoteOid: OID_B,
      workingTreeClean: true,
    }),
    readPublicationReviewFile: () => unexpected('readPublicationReviewFile'),
    readPublishDescription: () => Promise.resolve(null),
    readRequest: () => unexpected('readRequest'),
    readReviewFile: () => unexpected('readReviewFile'),
    readTicket: () => unexpected('readTicket'),
    readTicketPage: () => unexpected('readTicketPage'),
    readWorkingTreeReviewFile: () => unexpected('readWorkingTreeReviewFile'),
    reconnectProject: () => unexpected('reconnectProject'),
    reopenTicket: () => unexpected('reopenTicket'),
    scheduleAcceptedMainSynchronization: () => undefined,
    subscribeCoordination: () => ({ dispose: () => undefined }),
    synchronizeAcceptedMain: projectId => Promise.resolve({
      status: 'success',
      value: { headOid: OID_A, projectId, state: 'already-current' },
    }),
    tryAutoReconnect: () => Promise.resolve(false),
    updateRequestMetadata: () => unexpected('updateRequestMetadata'),
    updateTicketContent: () => unexpected('updateTicketContent'),
  };
}

function defaultRetirement(): CollabRetirementPort {
  return {
    close: () => Promise.resolve(),
    finalizeRetiredProject: () => Promise.resolve(),
    retireProject: () => Promise.resolve(),
    retryProjectCleanup: () => Promise.resolve(),
  };
}

export function completeCollabFeatureOptions(
  overrides: FeatureOptionsOverrides,
): CollabFeatureServiceOptions {
  return {
    cloudBootstrap: { ...defaultCloudBootstrap(), ...overrides.cloudBootstrap },
    hostTransfer: { ...defaultHostTransfer(), ...overrides.hostTransfer },
    hostInstallation: {
      ...defaultHostInstallation(),
      ...overrides.hostInstallation,
    },
    join: { ...defaultJoin(), ...overrides.join },
    lanHost: { ...defaultLanHost(), ...overrides.lanHost },
    lifecycleRecovery: { ...defaultLifecycleRecovery(), ...overrides.lifecycleRecovery },
    localExit: { ...defaultLocalExit(), ...overrides.localExit },
    membership: { ...defaultMembership(), ...overrides.membership },
    publication: { ...defaultPublication(), ...overrides.publication },
    retirement: { ...defaultRetirement(), ...overrides.retirement },
    vaultRoot: overrides.vaultRoot,
  };
}

const defaultPublicationReconnect: CollabPublicationReconnectPort = {
  reconnectDiscoveredProject: () => Promise.resolve({
    error: new CollabError({ code: 'host-stopped' }),
    status: 'failure',
  }),
  reconnectProject: () => Promise.resolve({
    error: new CollabError({ code: 'host-stopped' }),
    status: 'failure',
  }),
};

export function completeCollabPublicationOptions(
  overrides: PublicationOptionsOverrides,
): CollabPublicationServiceOptions {
  return {
    discovery: {
      discoverProjectCandidates: () => Promise.resolve([]),
      ...overrides.discovery,
    },
    inspectHostInstallation: overrides.inspectHostInstallation
      ?? (() => Promise.resolve('absent')),
    readActiveLocalRoute: overrides.readActiveLocalRoute ?? (() => null),
    managerResponsibility: {
      reconcileSnapshot: () => Promise.resolve(null),
      ...overrides.managerResponsibility,
    },
    reconnect: { ...defaultPublicationReconnect, ...overrides.reconnect },
    retirement: {
      handle: () => Promise.resolve(),
      ...overrides.retirement,
    },
    retirementAdmission: overrides.retirementAdmission
      ?? ((_projectId, operation) => operation()),
    vaultRoot: overrides.vaultRoot,
  };
}
