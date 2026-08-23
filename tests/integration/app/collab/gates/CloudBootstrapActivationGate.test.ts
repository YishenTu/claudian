import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type {
  DevelopmentBootstrapAttemptStatus,
  DevelopmentBootstrapManifest,
  SubmitDevelopmentBootstrapReportRequest,
} from '@claudian-collab/protocol';

import {
  CloudBootstrapCoordinator,
  type DevelopmentBootstrapCloudPort,
} from '@/app/collab/bootstrap/CloudBootstrapCoordinator';
import {
  CloudBootstrapReadinessCollector,
  type CloudBootstrapReadinessObservation,
} from '@/app/collab/bootstrap/CloudBootstrapReadiness';
import { CloudBootstrapTransitionStore } from '@/app/collab/bootstrap/CloudBootstrapTransitionStore';

import {
  ATTEMPT_ID,
  bootstrapManifest,
  finalizeActivatedBindingForTest,
  HOST_MEMBER_ID,
  HOST_OID,
  HOST_REF,
  MAIN_OID,
  MANIFEST_SHA256,
  OTHER_MEMBER_ID,
  OTHER_OID,
  OTHER_REF,
  PROJECT_ID,
} from '../../../../unit/app/collab/bootstrap/fixtures';

const ACTIVATION_RESULT = {
  activatedAt: '2026-08-21T00:00:08.000Z',
  activationOperationId: 'activation-gate',
  placementGeneration: 1,
  projectId: PROJECT_ID,
} as const;

function readiness(memberId: string): CloudBootstrapReadinessObservation {
  const formerHost = memberId === HOST_MEMBER_ID;
  return {
    collabGitChildCount: 0,
    operations: {
      cleanup: 'settled',
      conflictRecovery: 'settled',
      hostTransfer: 'settled',
      join: 'settled',
      leave: 'settled',
      managerResponsibility: 'settled',
      projectSetup: 'settled',
      publish: 'settled',
      reconciliation: 'settled',
      reconnect: 'settled',
      retirement: 'settled',
    },
    preservedWork: {
      hasLocalOnlyCommits: true,
      hasPrivateDraft: true,
      hasUnpublishedFiles: true,
    },
    projectOperationQueue: { activeCount: 0, queuedCount: 0 },
    projectWorkSession: 'closed',
    repository: {
      mainOid: MAIN_OID,
      memberId,
      objectFormat: 'sha1',
      personalRef: formerHost ? HOST_REF : OTHER_REF,
      personalRefOid: formerHost ? HOST_OID : OTHER_OID,
      projectId: PROJECT_ID,
    },
  };
}

function localIdentity(memberId: string) {
  return {
    load: async () => ({
      authorityKind: 'lan' as const,
      caFingerprint: 'b'.repeat(64),
      endpoint: 'https://192.168.1.20:54545',
      gitRemoteUrl: `https://192.168.1.20:54545/v1/git/${PROJECT_ID}/repository.git`,
      memberId,
      ownsAuthority: memberId === HOST_MEMBER_ID,
      projectId: PROJECT_ID,
    }),
  };
}

function status(
  state: DevelopmentBootstrapAttemptStatus['state'],
  reporters: readonly string[],
  bundleState: DevelopmentBootstrapAttemptStatus['bundleState'],
): DevelopmentBootstrapAttemptStatus {
  return {
    ...(state === 'activated' ? {
      activationPhase: 'completed' as const,
      activationResult: ACTIVATION_RESULT,
    } : {}),
    attemptId: ATTEMPT_ID,
    bundleState,
    createdAt: '2026-08-21T00:00:00.000Z',
    expiresAt: '2026-08-22T00:00:00.000Z',
    manifestSha256: MANIFEST_SHA256,
    projectId: PROJECT_ID,
    reporterMemberIds: reporters,
    state,
  };
}

class SharedBootstrapCloud implements DevelopmentBootstrapCloudPort {
  readonly calls: string[] = [];
  private activated = false;
  private bundleValidated = false;
  private manifest: DevelopmentBootstrapManifest | null = null;
  private readonly reports = new Map<string, string>();
  private readonly reporters = new Set<string>();

  constructor(private readonly timeline: string[]) {}

  async activate() {
    this.record('activate');
    if (!this.bundleValidated || this.reporters.size !== 2) {
      throw new Error('cloud-bootstrap-gate-activated-before-ready');
    }
    this.activated = true;
    return this.currentStatus();
  }

  async begin(request: { readonly manifest: DevelopmentBootstrapManifest }) {
    this.record('begin');
    this.manifest = request.manifest;
    return this.currentStatus();
  }

  async cancel() {
    this.record('cancel');
    return status('cancelled', [...this.reporters].sort(), this.bundleState());
  }

  async get() {
    this.record('get');
    return this.manifest === null ? null : this.currentStatus();
  }

  async report(request: SubmitDevelopmentBootstrapReportRequest) {
    this.record(`report:${request.report.reporterMemberId}`);
    const encoded = JSON.stringify(request.report);
    const existing = this.reports.get(request.report.reporterMemberId);
    if (existing !== undefined && existing !== encoded) {
      throw new Error('cloud-bootstrap-report-replay-mismatch');
    }
    this.reports.set(request.report.reporterMemberId, encoded);
    this.reporters.add(request.report.reporterMemberId);
    return this.currentStatus();
  }

  async upload(
    _request: unknown,
    body: (signal: AbortSignal) => AsyncIterable<Uint8Array>,
  ) {
    this.record('upload');
    let byteCount = 0;
    for await (const chunk of body(new AbortController().signal)) {
      byteCount += chunk.byteLength;
    }
    if (byteCount !== 3) throw new Error('cloud-bootstrap-gate-bundle-mismatch');
    this.bundleValidated = true;
    return this.currentStatus();
  }

  private bundleState(): DevelopmentBootstrapAttemptStatus['bundleState'] {
    return this.bundleValidated ? 'validated' : 'missing';
  }

  private currentStatus(): DevelopmentBootstrapAttemptStatus {
    const reporters = [...this.reporters].sort();
    if (this.activated) return status('activated', reporters, 'validated');
    if (this.bundleValidated && this.reporters.size === 2) {
      return status('ready', reporters, 'validated');
    }
    return status(
      this.reporters.size === 0 ? 'collecting' : 'validating',
      reporters,
      this.bundleState(),
    );
  }

  private record(call: string): void {
    this.calls.push(call);
    this.timeline.push(`cloud.${call}`);
  }
}

describe('Cloud bootstrap activation gate', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'claudian-cloud-bootstrap-gate-'));
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it('completes both client bindings while the former Host stays durably stopped', async () => {
    const hostRoot = path.join(root, 'host');
    const participantRoot = path.join(root, 'participant');
    const membership = JSON.stringify({
      authority: 'lan',
      origin: 'https://192.168.1.20:54545',
    });
    for (const clientRoot of [hostRoot, participantRoot]) {
      await mkdir(path.join(clientRoot, '.claudian', 'collab', 'projects', PROJECT_ID), {
        recursive: true,
      });
      await mkdir(path.join(clientRoot, 'workspace', PROJECT_ID), { recursive: true });
      await writeFile(
        path.join(clientRoot, '.claudian', 'collab', 'projects', PROJECT_ID, 'membership.json'),
        membership,
      );
      await writeFile(
        path.join(clientRoot, 'workspace', PROJECT_ID, 'unpublished.md'),
        'preserved\n',
      );
    }
    const timeline: string[] = [];
    const cloud = new SharedBootstrapCloud(timeline);
    const host = new CloudBootstrapCoordinator({
      binding: { finalize: async record => finalizeActivatedBindingForTest(record) },
      cloud,
      createFenceId: () => 'bootstrap-fence-gate',
      formerHost: {
        stopAndDrain: async () => {
          timeline.push('host-stopped');
          return {
            autoStartDisabled: true as const,
            resourcesDrained: true as const,
            routeUnregistered: true as const,
            stoppedAt: '2026-08-21T00:00:02.000Z',
          };
        },
      },
      localIdentity: localIdentity(HOST_MEMBER_ID),
      now: (() => {
        let second = 3;
        return () => new Date(Date.parse('2026-08-21T00:00:00.000Z') + second++ * 1_000);
      })(),
      readiness: new CloudBootstrapReadinessCollector({
        inspect: async () => readiness(HOST_MEMBER_ID),
      }),
      source: {
        assertManifestCurrent: async () => undefined,
        captureManifest: async () => bootstrapManifest(),
        discardBundle: async () => undefined,
        openBundle: async function* () { yield new Uint8Array([1, 2, 3]); },
      },
      transitions: new CloudBootstrapTransitionStore(hostRoot),
      workSessions: {
        closeAndDrain: async () => {
          timeline.push('session-closed');
        },
        completeAfterActivation: async () => undefined,
        resumeAfterCancellation: async () => undefined,
      },
    });
    const participant = new CloudBootstrapCoordinator({
      binding: { finalize: async record => finalizeActivatedBindingForTest(record) },
      cloud,
      createFenceId: () => 'unused',
      formerHost: { stopAndDrain: async () => { throw new Error('not-former-host'); } },
      localIdentity: localIdentity(OTHER_MEMBER_ID),
      now: () => new Date('2026-08-21T00:00:04.000Z'),
      readiness: new CloudBootstrapReadinessCollector({
        inspect: async () => readiness(OTHER_MEMBER_ID),
      }),
      source: {
        assertManifestCurrent: async () => undefined,
        captureManifest: async () => { throw new Error('not-former-host'); },
        discardBundle: async () => undefined,
        openBundle: async function* () {
          yield new Uint8Array();
          throw new Error('not-former-host');
        },
      },
      transitions: new CloudBootstrapTransitionStore(participantRoot),
      workSessions: {
        closeAndDrain: async () => undefined,
        completeAfterActivation: async () => undefined,
        resumeAfterCancellation: async () => undefined,
      },
    });

    const hostPending = await host.startFormerHost({
      developmentActorId: HOST_MEMBER_ID,
      memberId: HOST_MEMBER_ID,
      projectId: PROJECT_ID,
      serverUrl: 'https://cloud.example.test',
    });
    expect(hostPending.attemptState).toBe('pending');
    expect(timeline).toEqual([
      'session-closed',
      'host-stopped',
      'cloud.begin',
      `cloud.report:${HOST_MEMBER_ID}`,
      'cloud.upload',
    ]);

    const participantPending = await participant.submitParticipant({
      developmentActorId: OTHER_MEMBER_ID,
      manifest: bootstrapManifest(),
      memberId: OTHER_MEMBER_ID,
      projectId: PROJECT_ID,
      serverUrl: 'https://cloud.example.test',
    });
    expect(participantPending.attemptState).toBe('pending');

    const hostActivated = await host.recoverProject(PROJECT_ID);
    expect(hostActivated).toMatchObject({
      activationResult: ACTIVATION_RESULT,
      attemptState: 'activated',
      fence: { state: 'terminal' },
      phase: 'fence-terminal',
    });
    expect(cloud.calls).toEqual([
      'begin',
      `report:${HOST_MEMBER_ID}`,
      'upload',
      `report:${OTHER_MEMBER_ID}`,
      'get',
      'activate',
    ]);

    const restarted = new CloudBootstrapCoordinator({
      binding: { finalize: async record => finalizeActivatedBindingForTest(record) },
      cloud,
      createFenceId: () => 'unused',
      formerHost: { stopAndDrain: async () => { throw new Error('host-restarted'); } },
      localIdentity: localIdentity(HOST_MEMBER_ID),
      readiness: new CloudBootstrapReadinessCollector({
        inspect: async () => readiness(HOST_MEMBER_ID),
      }),
      source: {
        assertManifestCurrent: async () => undefined,
        captureManifest: async () => { throw new Error('bootstrap-restarted'); },
        discardBundle: async () => undefined,
        openBundle: async function* () {
          yield new Uint8Array();
          throw new Error('bootstrap-restarted');
        },
      },
      transitions: new CloudBootstrapTransitionStore(hostRoot),
      workSessions: {
        closeAndDrain: async () => { throw new Error('session-restarted'); },
        completeAfterActivation: async () => undefined,
        resumeAfterCancellation: async () => undefined,
      },
    });
    await expect(restarted.recoverProject(PROJECT_ID)).resolves.toMatchObject({
      attemptState: 'activated',
      fence: { state: 'terminal' },
      phase: 'fence-terminal',
    });

    for (const clientRoot of [hostRoot, participantRoot]) {
      expect(await readFile(
        path.join(clientRoot, '.claudian', 'collab', 'projects', PROJECT_ID, 'membership.json'),
        'utf8',
      )).toBe(membership);
      expect(await readFile(
        path.join(clientRoot, 'workspace', PROJECT_ID, 'unpublished.md'),
        'utf8',
      )).toBe('preserved\n');
    }
  });
});
