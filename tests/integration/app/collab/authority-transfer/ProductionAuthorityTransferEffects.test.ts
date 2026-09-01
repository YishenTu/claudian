import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import {
  COLLAB_CLOUD_BINDING_VERSION,
  COLLAB_PROTOCOL_VERSION,
  type CollabAuthorityTransferStatus,
  type CollabCloudAuthorityTransferArtifact,
  type CollabCloudCapability,
  type CollabTransferredMembershipClaimBatch,
  decodeCollabProjectCheckpointManifest,
  encodeCollabProjectCheckpointManifestCanonicalJson,
  encodeCollabTransferredMembershipClaimBatchDigestInput,
} from '@claudian-collab/protocol';
import {
  TEST_INSTALLATION_A,
  TEST_INSTALLATION_B,
} from '@test/helpers/installations';
import initSqlJs, { type SqlJsStatic } from 'sql.js';

import {
  ClaudianCollabService,
  CollabProjectSetupService,
  createCollabFeatureSubcomposition,
} from '@/app/collab';
import { CollabProjectWorkSessionRegistry } from '@/app/collab/activity/CollabProjectWorkSession';
import { SqlJsProjectDatabase } from '@/app/collab/authority/SqlJsProjectDatabase';
import { createAuthorityTransferEntryRecord } from '@/app/collab/authority-transfer/AuthorityTransferEntryRecord';
import { AuthorityTransferLocalConvergence } from '@/app/collab/authority-transfer/AuthorityTransferLocalConvergence';
import { AuthorityTransferLocalFence } from '@/app/collab/authority-transfer/AuthorityTransferLocalFence';
import {
  authorityTransferChildIdempotencyKey,
} from '@/app/collab/authority-transfer/AuthorityTransferOperationIdentity';
import { createAuthorityTransferRecord } from '@/app/collab/authority-transfer/AuthorityTransferRecord';
import { createAuthorityTransferCheckpointManifest } from '@/app/collab/authority-transfer/checkpoint/AuthorityTransferCheckpointManifest';
import { ProductionCloudToLanTargetEffects } from '@/app/collab/authority-transfer/cloud-to-lan/ProductionCloudToLanTargetEffects';
import { ProductionLanToCloudSourceEffects } from '@/app/collab/authority-transfer/lan-to-cloud/ProductionLanToCloudSourceEffects';
import type { CollabLocalLanMembershipRecord } from '@/app/collab/CollabLocalProjectRepository';
import { rotateAuthorityTransferOrigin } from '@/app/collab/git/CollabGitOriginPolicy';
import { LanAuthorityTransferClient } from '@/app/collab/lan/authority-transfer/LanAuthorityTransferClient';
import { ProjectOperationAdmission } from '@/app/collab/ProjectOperationAdmission';
import type { CloudAuthorityConnection } from '@/app/collab/remote-authority/CloudAuthorityAdapter';
import { cloudProjectGitRemoteUrl } from '@/app/collab/remote-authority/CloudAuthorityUrls';
import type { CollabCloudProjectSnapshot } from '@/core/collab';

const PROJECT_ID = 'project-production-effects';
const MEMBER_ID = 'member-production-host';
const TRANSFER_ID = 'transfer-production-effects';
const OPERATION_ID = 'intent-production-effects';
const HOST_CREDENTIAL = Buffer.alloc(32, 7).toString('base64url');

jest.setTimeout(30_000);

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  return result.stdout.trim();
}

function status(
  direction: 'cloud-to-lan' | 'lan-to-cloud',
  phase: CollabAuthorityTransferStatus['phase'],
  targetUrl: string,
  checkpointSha256: string | null = null,
): CollabAuthorityTransferStatus {
  return {
    batchRevision: null,
    batchSha256: null,
    checkpointSha256,
    createdAt: '2026-08-28T00:00:00.000Z',
    direction,
    expiresAt: '2026-09-27T00:00:00.000Z',
    phase,
    projectId: PROJECT_ID,
    relinquishmentProof: null,
    sourceAuthority: direction === 'lan-to-cloud'
      ? { generation: 1, kind: 'lan' }
      : { generation: 2, kind: 'cloud' },
    state: 'active',
    targetAuthority: direction === 'lan-to-cloud'
      ? { generation: 2, kind: 'cloud' }
      : { generation: 3, kind: 'lan' },
    targetUrl,
    transferId: TRANSFER_ID,
    updatedAt: phase === 'collecting-readiness'
      ? '2026-08-28T00:00:00.000Z'
      : '2026-08-28T00:01:00.000Z',
  };
}

describe('production authority-transfer effects', () => {
  let SQL: SqlJsStatic;
  let sourceRoot: string;
  let targetRoot: string;

  beforeAll(async () => {
    SQL = await initSqlJs();
  });

  beforeEach(async () => {
    sourceRoot = await mkdtemp(path.join(tmpdir(), 'claudian-transfer-source-'));
    targetRoot = await mkdtemp(path.join(tmpdir(), 'claudian-transfer-target-'));
  });

  afterEach(async () => {
    await Promise.all([
      rm(sourceRoot, { force: true, recursive: true }),
      rm(targetRoot, { force: true, recursive: true }),
    ]);
  });

  it('releases a source endpoint pin when pre-ownership membership loading fails', async () => {
    const endpoint = 'https://127.0.0.1:54545';
    const pinAuthorityTransferSourceEndpoint = jest.fn(async () => endpoint);
    const unpinAuthorityTransferSourceEndpoint = jest.fn(async () => undefined);
    const loadMembership = jest.fn(async () => {
      throw new Error('simulated membership read failure');
    });
    const effects = new ProductionLanToCloudSourceEffects({
      cloudSession: null,
      convergence: {} as AuthorityTransferLocalConvergence,
      foundation: {
        lanHost: {
          pinAuthorityTransferSourceEndpoint,
          unpinAuthorityTransferSourceEndpoint,
        },
        local: { projects: { loadMembership } },
      } as never,
      persistence: {} as never,
      projectId: PROJECT_ID,
    });
    const record = createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      lifecycleOwnership: 'proposal',
      localRole: 'source',
      operationIntentId: OPERATION_ID,
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: status('lan-to-cloud', 'collecting-readiness', 'https://cloud.example.test/'),
    });

    await expect(effects.sourceEndpoint(record)).rejects.toThrow(
      'simulated membership read failure',
    );

    expect(pinAuthorityTransferSourceEndpoint).toHaveBeenCalledWith(PROJECT_ID);
    expect(unpinAuthorityTransferSourceEndpoint).toHaveBeenCalledWith(PROJECT_ID, endpoint);
  });

  it('uses ordinary guarded Host start for an open-fence cancelled record', async () => {
    const startProject = jest.fn(async () => ({
      endpoint: 'https://127.0.0.1:54545',
      projectId: PROJECT_ID,
      status: 'running' as const,
    }));
    const restartProjectAfterAuthorityTransferCancellation = jest.fn();
    const effects = new ProductionLanToCloudSourceEffects({
      cloudSession: null,
      convergence: {} as AuthorityTransferLocalConvergence,
      foundation: {
        lanHost: {
          isProjectRunning: () => false,
          restartProjectAfterAuthorityTransferCancellation,
          startProject,
          unpinAuthorityTransferSourceEndpoint: jest.fn(),
        },
        local: {
          projects: {
            loadMembership: jest.fn(async () => ({
              project: { workspacePath: '/vault/Projects/Portable' },
            })),
          },
          workspace: {
            removeReservedProjectsFolderChild: jest.fn(async () => false),
          },
        },
      } as never,
      persistence: {} as never,
      projectId: PROJECT_ID,
    });
    const record = createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      lifecycleOwnership: 'owned',
      localRole: 'source',
      operationIntentId: OPERATION_ID,
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: {
        ...status('lan-to-cloud', 'cancelled', 'https://cloud.example.test/'),
        state: 'cancelled',
      },
    });

    await effects.reopenAfterCancellation(record);

    expect(startProject).toHaveBeenCalledWith(PROJECT_ID);
    expect(restartProjectAfterAuthorityTransferCancellation).not.toHaveBeenCalled();
  });

  it('converges an expired completed LAN source locally before terminal cleanup', async () => {
    const completed = status('lan-to-cloud', 'completed', 'https://cloud.example.test/');
    const completedRecord = createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      lifecycleOwnership: 'owned',
      localRole: 'source',
      operationIntentId: OPERATION_ID,
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: {
        ...completed,
        batchRevision: 1,
        batchSha256: 'b'.repeat(64),
        checkpointSha256: 'a'.repeat(64),
        expiresAt: '2026-08-29T00:00:00.000Z',
        phase: 'completed',
        relinquishmentProof: {
          batchRevision: 1,
          batchSha256: 'b'.repeat(64),
          certificate: Buffer.alloc(64, 2).toString('base64url'),
          certificateAlgorithm: 'ed25519',
          checkpointSha256: 'a'.repeat(64),
          committedAt: '2026-08-28T00:02:00.000Z',
          operationIntentId: OPERATION_ID,
          projectId: PROJECT_ID,
          sourceAuthority: { generation: 1, kind: 'lan' },
          sourceHostMemberId: MEMBER_ID,
          targetAuthority: { generation: 2, kind: 'cloud' },
          transferId: TRANSFER_ID,
        },
        state: 'completed',
        updatedAt: '2026-08-28T00:03:00.000Z',
      },
    });
    const events: string[] = [];
    const convergence = {
      lanToCloudHostOffline: jest.fn(async () => { events.push('converge'); }),
    } as unknown as AuthorityTransferLocalConvergence;
    const persistence = {
      completeTerminalCleanup: jest.fn(async () => { events.push('cleanup'); }),
      expireTerminalResponder: jest.fn(async () => { events.push('expire'); }),
      load: jest.fn(async () => completedRecord),
    };
    const effects = new ProductionLanToCloudSourceEffects({
      cloudSession: null,
      convergence,
      foundation: {
        inspectAuthority: jest.fn(async () => ({ database: {} })),
        lanHost: {
          relinquishProjectForAuthorityTransfer: jest.fn(async () => {
            events.push('relinquish');
          }),
        },
        local: {
          projects: {
            loadMembership: jest.fn(async () => ({
              project: { workspacePath: '/vault/Projects/Portable' },
            })),
          },
          workspace: {
            removeReservedProjectsFolderChild: jest.fn(async () => {
              events.push('remove-staging');
            }),
          },
        },
      } as never,
      persistence: persistence as never,
      projectId: PROJECT_ID,
    });

    await effects.restoreCompleted(completedRecord);

    expect(convergence.lanToCloudHostOffline).toHaveBeenCalledWith(completedRecord.status);
    expect(events).toEqual([
      'relinquish',
      'converge',
      'expire',
      'remove-staging',
      'cleanup',
    ]);
  });

  it('runs an ordinary LAN Member proposal and exact Host acceptance through production effects', async () => {
    const sourceFoundation = foundation(sourceRoot);
    const sourceSetup = new CollabProjectSetupService(sourceFoundation, {
      installationKey: TEST_INSTALLATION_A,
      createCredential: () => HOST_CREDENTIAL,
      createId: kind => {
        if (kind === 'member') return MEMBER_ID;
        if (kind === 'operation') return 'create-joined-production-effects';
        return PROJECT_ID;
      },
      now: () => new Date('2026-08-08T00:00:00.000Z'),
      vaultRoot: sourceRoot,
    });
    const composition = createCollabFeatureSubcomposition({
      foundation: sourceFoundation,
      projectSetup: sourceSetup,
      vaultRoot: sourceRoot,
    });
    const sourceFeature = composition.feature;
    const peerCredential = Buffer.alloc(32, 8).toString('base64url');
    const targetUrl = 'https://cloud.example.test/';
    try {
      await sourceFeature.initialize();
      await sourceFeature.createProject({ memberDisplayName: 'Alice', name: 'Portable' });
      const authority = await sourceFoundation.openAuthority(PROJECT_ID);
      await authority.database.mutate(connection => {
        connection.run(`
          INSERT INTO members (
            member_id, display_name, personal_ref, role, status, credential_hash,
            join_attempt_id, created_at, activated_at, revoked_at
          ) VALUES (
            'member-production-peer', 'Bob',
            'refs/heads/members/member-production-peer', 'member', 'active', ?,
            NULL, '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z', NULL
          )
        `, [createHash('sha256').update(peerCredential, 'utf8').digest()]);
      });
      const authorityRepository = path.join(authority.authorityDirectory, 'repository.git');
      const mainOid = git(authorityRepository, ['rev-parse', 'refs/heads/main']);
      git(authorityRepository, [
        'update-ref',
        'refs/heads/members/member-production-peer',
        mainOid,
      ]);
      const membership = await sourceFoundation.local.projects.loadMembership(PROJECT_ID);
      if (!membership || membership.authority.kind !== 'lan') {
        throw new Error('Missing source LAN membership');
      }
      const client = new LanAuthorityTransferClient({
        caCertificatePem: membership.authority.hostCaCertificatePem!,
        caFingerprint: membership.authority.hostCaFingerprint!,
        endpoint: membership.authority.endpoint!,
        projectId: PROJECT_ID,
      });
      const proposal = await client.requestWithMember('requestLanToCloudTransfer', {
        expectedAuthorityGeneration: 1,
        idempotencyKey: OPERATION_ID,
        projectId: PROJECT_ID,
        targetUrl,
      }, peerCredential);
      const acceptance = {
        expectedAuthorityGeneration: 1,
        idempotencyKey: authorityTransferChildIdempotencyKey(OPERATION_ID, 'accept'),
        projectId: PROJECT_ID,
        targetUrl,
        transferId: proposal.transferId,
      };
      await expect(client.requestWithMember('cancelProjectAuthorityTransfer', {
        expectedPhase: 'collecting-readiness',
        idempotencyKey: `${OPERATION_ID}-remote-cancel`,
        projectId: PROJECT_ID,
        transferId: proposal.transferId,
      }, HOST_CREDENTIAL)).rejects.toMatchObject({
        code: 'authorization-denied',
        safeContext: { reason: 'authority-transfer-local-host-confirmation-required' },
      });
      const foreignFoundation = foundation(sourceRoot, TEST_INSTALLATION_B);
      const foreignSetup = new CollabProjectSetupService(foreignFoundation, {
        installationKey: TEST_INSTALLATION_B,
        vaultRoot: sourceRoot,
      });
      const foreignComposition = createCollabFeatureSubcomposition({
        foundation: foreignFoundation,
        projectSetup: foreignSetup,
        vaultRoot: sourceRoot,
      });
      try {
        await expect(foreignComposition.authorityTransfer
          .acceptLanToCloudTransferTarget(acceptance)).rejects.toMatchObject({
          code: 'authorization-denied',
          safeContext: { reason: 'host-installation-owner-mismatch' },
        });
        await expect(sourceFoundation.authorityTransfers.load(PROJECT_ID)).resolves.toBeNull();
      } finally {
        await foreignFoundation.close();
      }
      const canonicalCreatedAt = new Date(
        Date.parse(proposal.createdAt) + 5 * 60_000,
      ).toISOString();
      const canonicalExpiresAt = new Date(
        Date.parse(canonicalCreatedAt) + 30 * 24 * 60 * 60_000,
      ).toISOString();
      const unsignedBatch: CollabTransferredMembershipClaimBatch = {
        batchRevision: 1,
        batchSha256: '0'.repeat(64),
        checkpointSha256: '0'.repeat(64),
        claims: [
          { claim: Buffer.alloc(32, 1).toString('base64url'), memberId: MEMBER_ID },
          {
            claim: Buffer.alloc(32, 2).toString('base64url'),
            memberId: 'member-production-peer',
          },
        ],
        expiresAt: canonicalExpiresAt,
        projectId: PROJECT_ID,
        targetAuthorityGeneration: 2,
        transferId: proposal.transferId,
      };
      let checkpointSha256 = '';
      let batch: CollabTransferredMembershipClaimBatch | null = null;
      let statusReadCount = 0;
      const transferTimestamp = (minute: number): string => new Date(
        Date.parse(canonicalCreatedAt) + minute * 60_000,
      ).toISOString();
      const withCheckpoint = (
        phase: CollabAuthorityTransferStatus['phase'],
      ): CollabAuthorityTransferStatus => {
        const validated = phase !== 'source-quiesced';
        return {
          ...proposal,
          createdAt: canonicalCreatedAt,
          expiresAt: canonicalExpiresAt,
          batchRevision: validated && batch ? 1 : null,
          batchSha256: validated ? (batch?.batchSha256 ?? null) : null,
          checkpointSha256: validated ? (checkpointSha256 || null) : null,
          phase,
          updatedAt: phase === 'source-quiesced'
            ? transferTimestamp(1)
            : phase === 'checkpoint-validated'
              ? transferTimestamp(2)
              : transferTimestamp(3),
        };
      };
      const authorityTransfer = jest.fn(async (operation: string, request: never) => {
        if (operation === 'beginLanToCloudTransfer') {
          checkpointSha256 = (request as { checkpointManifestSha256: string })
            .checkpointManifestSha256;
          const candidate = {
            ...unsignedBatch,
            checkpointSha256,
          };
          batch = {
            ...candidate,
            batchSha256: createHash('sha256')
              .update(encodeCollabTransferredMembershipClaimBatchDigestInput(candidate), 'utf8')
              .digest('hex'),
          };
          return withCheckpoint('source-quiesced');
        }
        if (operation === 'getAuthorityTransferReceiptVerifier') {
          return {
            projectId: PROJECT_ID,
            receiptKeyId: 'receipt-key-joined-production-effects',
            receiptPublicKey: Buffer.alloc(32, 4).toString('base64url'),
            receiptPublicKeyEncoding: 'base64url-raw',
            signatureAlgorithm: 'ed25519',
            transferId: proposal.transferId,
          };
        }
        if (operation === 'rotateTransferredMembershipClaims') return batch!;
        if (operation === 'acknowledgeTransferredMembershipClaimBatch') {
          return {
            batchRevision: 1,
            batchSha256: batch!.batchSha256,
            checkpointSha256,
            committedAt: transferTimestamp(2.5),
            custodyAuthority: { generation: 1, kind: 'lan' },
            operationIntentId: OPERATION_ID,
            projectId: PROJECT_ID,
            receiptId: 'receipt-joined-production-effects',
            submittedByMemberId: MEMBER_ID,
            targetAuthorityGeneration: 2,
            transferId: proposal.transferId,
          };
        }
        if (operation === 'getProjectAuthorityTransfer') {
          statusReadCount += 1;
          return statusReadCount === 1
            ? withCheckpoint('checkpoint-validated')
            : withCheckpoint('repository-published');
        }
        if (operation === 'commitLanToCloudRelinquishment') {
          const proof = (request as { proof: NonNullable<
            CollabAuthorityTransferStatus['relinquishmentProof']
          > }).proof;
          return {
            ...withCheckpoint('completed'),
            phase: 'completed',
            relinquishmentProof: proof,
            state: 'completed',
            updatedAt: transferTimestamp(4),
          };
        }
        throw new Error(`Unexpected Cloud operation ${operation}`);
      });
      const currentMember = {
        activatedAt: '2026-08-08T00:00:00.000Z',
        createdAt: '2026-08-08T00:00:00.000Z',
        displayName: 'Alice',
        id: MEMBER_ID,
        personalRef: `refs/heads/members/${MEMBER_ID}`,
        role: 'manager' as const,
        status: 'active' as const,
      };
      const cloudSession = {
        developmentActorId: MEMBER_ID,
        dispose: jest.fn(),
        lifecycle: {
          authorityTransfer,
          downloadAuthorityTransferArtifact: jest.fn(),
          retirement: jest.fn(),
          uploadAuthorityTransferArtifact: jest.fn(async input => {
            let uploadedBytes = 0;
            for await (const chunk of input.body) {
              uploadedBytes += Buffer.byteLength(chunk as Uint8Array);
            }
            expect(uploadedBytes).toBeGreaterThan(0);
          }),
        },
        projectId: PROJECT_ID,
        readSnapshot: jest.fn(async () => ({
          currentMember,
          eventSequence: 3,
          members: [currentMember],
          openRequests: [],
          openTicketCount: 0,
          project: {
            authorityGeneration: 2,
            authorityKind: 'cloud',
            createdAt: '2026-08-08T00:00:00.000Z',
            id: PROJECT_ID,
            mainOid,
            mainRef: 'refs/heads/main',
            name: 'Portable',
          },
          ticketHighlights: [],
        })),
        serverUrl: targetUrl,
        supports: (capability: CollabCloudCapability) => (
          capability === 'authority-transfer' || capability === 'project-snapshot'
        ),
      } as unknown as CloudAuthorityConnection;
      await composition.authorityTransfer.bindLanToCloudSource({
        cloudSession,
        projectId: PROJECT_ID,
      });

      await expect(client.requestWithMember(
        'acceptLanToCloudTransferTarget',
        acceptance,
        HOST_CREDENTIAL,
      )).rejects.toMatchObject({
        code: 'authorization-denied',
        safeContext: { reason: 'authority-transfer-local-host-confirmation-required' },
      });
      const completed = await composition.authorityTransfer
        .acceptLanToCloudTransferTarget(acceptance);

      expect(completed).toMatchObject({ phase: 'completed', state: 'completed' });
      expect(authorityTransfer.mock.calls.map(([operation]) => operation)).not.toEqual(
        expect.arrayContaining([
          'requestLanToCloudTransfer',
          'acceptLanToCloudTransferTarget',
        ]),
      );
      expect(authorityTransfer.mock.calls.filter(
        ([operation]) => operation === 'acknowledgeTransferredMembershipClaimBatch',
      )).toHaveLength(1);
      await expect(sourceFoundation.local.projects.loadMembership(PROJECT_ID))
        .resolves.toMatchObject({
          authority: {
            authorityGeneration: 2,
            kind: 'cloud',
            serverUrl: targetUrl,
          },
        });
    } finally {
      await sourceFeature.close();
      await sourceFoundation.close();
    }
  });

  it('restarts the exact LAN Host while recovering a locally proved cancellation', async () => {
    const initialFoundation = foundation(sourceRoot);
    const initialSetup = new CollabProjectSetupService(initialFoundation, {
      installationKey: TEST_INSTALLATION_A,
      createCredential: () => HOST_CREDENTIAL,
      createId: kind => {
        if (kind === 'member') return MEMBER_ID;
        if (kind === 'operation') return 'create-cancellation-restart';
        return PROJECT_ID;
      },
      now: () => new Date('2026-08-08T00:00:00.000Z'),
      vaultRoot: sourceRoot,
    });
    const initialComposition = createCollabFeatureSubcomposition({
      foundation: initialFoundation,
      projectSetup: initialSetup,
      vaultRoot: sourceRoot,
    });
    await initialComposition.feature.initialize();
    await initialComposition.feature.createProject({
      memberDisplayName: 'Alice',
      name: 'Portable',
    });
    const route = initialFoundation.lanHost.getActiveProjectRoute(PROJECT_ID);
    if (!route) throw new Error('Missing initial LAN Host route');
    const transferStatus = status(
      'lan-to-cloud',
      'collecting-readiness',
      'https://cloud.example.test/',
    );
    const entry = createAuthorityTransferEntryRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      proposedByMemberId: MEMBER_ID,
      request: {
        expectedAuthorityGeneration: 1,
        idempotencyKey: OPERATION_ID,
        projectId: PROJECT_ID,
        targetUrl: 'https://cloud.example.test/',
      },
      status: transferStatus,
    });
    const record = createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      lifecycleOwnership: 'owned',
      localRole: 'source',
      operationIntentId: OPERATION_ID,
      sourceLanEndpoint: route.endpoint,
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: transferStatus,
    });
    await initialFoundation.authorityTransfers.proposeEntry(entry);
    await initialFoundation.authorityTransfers.handoffEntry(entry, record);
    const cancellation = {
      expectedAuthorityGeneration: 1,
      expectedPhase: 'collecting-readiness' as const,
      idempotencyKey: 'cancel-cancellation-restart',
      projectId: PROJECT_ID,
      transferId: TRANSFER_ID,
    };
    await initialComposition.feature.close();
    await initialFoundation.close();

    const reopenedFoundation = foundation(sourceRoot);
    const reopenedComposition = createCollabFeatureSubcomposition({
      foundation: reopenedFoundation,
      projectSetup: new CollabProjectSetupService(reopenedFoundation, {
        installationKey: TEST_INSTALLATION_A,
        vaultRoot: sourceRoot,
      }),
      vaultRoot: sourceRoot,
    });
    try {
      await reopenedComposition.feature.initialize();
      await expect(reopenedComposition.authorityTransfer.cancelLanToCloudTransfer(cancellation))
        .resolves.toMatchObject({ phase: 'cancelled', state: 'cancelled' });
      expect(reopenedFoundation.lanHost.isProjectRunning(PROJECT_ID)).toBe(true);
      await expect(reopenedFoundation.authorityTransfers.load(PROJECT_ID)).resolves.toMatchObject({
        status: { phase: 'cancelled', state: 'cancelled' },
        terminalCleanupCompleted: true,
      });
    } finally {
      await reopenedComposition.feature.close();
      await reopenedFoundation.close();
    }
  });

  async function captureSource() {
    const sourceFoundation = foundation(sourceRoot);
    const sourceSetup = new CollabProjectSetupService(sourceFoundation, {
      installationKey: TEST_INSTALLATION_A,
      createCredential: () => HOST_CREDENTIAL,
      createId: kind => {
        if (kind === 'member') return MEMBER_ID;
        if (kind === 'operation') return 'create-production-effects';
        return PROJECT_ID;
      },
      now: () => new Date('2026-08-08T00:00:00.000Z'),
      vaultRoot: sourceRoot,
    });
    const sourceFeature = createCollabFeatureSubcomposition({
      foundation: sourceFoundation,
      projectSetup: sourceSetup,
      vaultRoot: sourceRoot,
    }).feature;
    await sourceFeature.initialize();
    await sourceFeature.createProject({ memberDisplayName: 'Alice', name: 'Portable' });
    const sourceAuthority = await sourceFoundation.openAuthority(PROJECT_ID);
    await sourceAuthority.database.mutate(connection => {
      connection.run(`
        INSERT INTO members (
          member_id, display_name, personal_ref, role, status, credential_hash,
          join_attempt_id, created_at, activated_at, revoked_at
        ) VALUES (
          'member-production-peer', 'Bob',
          'refs/heads/members/member-production-peer', 'member', 'active', ?,
          NULL, '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z', NULL
        )
      `, [Buffer.alloc(32, 8)]);
    });
    const sourceAuthorityRepository = path.join(sourceAuthority.authorityDirectory, 'repository.git');
    const authorityMainOid = git(sourceAuthorityRepository, ['rev-parse', 'refs/heads/main']);
    git(sourceAuthorityRepository, [
      'update-ref',
      'refs/heads/members/member-production-peer',
      authorityMainOid,
    ]);
    const sourceMembership = await sourceFoundation.local.projects.loadMembership(PROJECT_ID);
    if (!sourceMembership || sourceMembership.authority.kind !== 'lan') {
      throw new Error('Missing source LAN membership');
    }
    const sourceRecord = createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      lifecycleOwnership: 'owned',
      localRole: 'source',
      operationIntentId: OPERATION_ID,
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: status('lan-to-cloud', 'collecting-readiness', 'https://cloud.example.test/'),
    });
    const noopSession = {
      projectId: PROJECT_ID,
    } as unknown as CloudAuthorityConnection;
    const sourceEffects = new ProductionLanToCloudSourceEffects({
      cloudSession: noopSession,
      convergence: {} as AuthorityTransferLocalConvergence,
      foundation: sourceFoundation,
      persistence: sourceFoundation.authorityTransfers,
      projectId: PROJECT_ID,
    });
    const sourceStaging = await sourceFoundation.local.workspace.reserveProjectsFolderChild(
      'workspace',
      {
        childName: sourceRecord.stagingDirectoryName,
        operationId: sourceRecord.transferId,
        projectId: sourceRecord.projectId,
        purpose: 'authority-transfer-staging',
      },
    );
    const interruptedPromotions = [
      'checkpoint.json.partial',
      'source-proof-key.json.partial',
      'source-proof.json.partial',
      'relinquishment-proof.json.partial',
    ];
    await mkdir(sourceStaging.absolutePath, { mode: 0o700 });
    await Promise.all(interruptedPromotions.map(fileName => writeFile(
      path.join(sourceStaging.absolutePath, fileName),
      '{"truncated":',
      { mode: 0o600 },
    )));
    const captured = await sourceEffects.capture(sourceRecord);
    await Promise.all(interruptedPromotions.slice(0, 3).map(fileName => expect(
      access(path.join(sourceStaging.absolutePath, fileName)),
    ).rejects.toMatchObject({ code: 'ENOENT' })));
    const artifactBytes = new Map<CollabCloudAuthorityTransferArtifact, Buffer>();
    for (const artifact of captured.artifacts) {
      const chunks: Buffer[] = [];
      for await (const chunk of artifact.body) chunks.push(Buffer.from(chunk as Uint8Array));
      artifactBytes.set(artifact.artifact, Buffer.concat(chunks));
    }
    const sourceManifestBytes = artifactBytes.get('checkpoint.json');
    const sourceCoordinationBytes = artifactBytes.get('coordination.ndjson');
    const repositoryBytes = artifactBytes.get('repository.bundle');
    if (!sourceManifestBytes || !sourceCoordinationBytes || !repositoryBytes) {
      throw new Error('Incomplete source checkpoint');
    }
    await sourceFoundation.lanHost.relinquishProjectForAuthorityTransfer(PROJECT_ID);
    const recoveryRecord = createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      lifecycleOwnership: 'owned',
      localRole: 'source',
      operationIntentId: OPERATION_ID,
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: status('lan-to-cloud', 'source-quiesced', 'https://cloud.example.test/'),
    });
    return {
      artifactBytes,
      recoveryRecord,
      repositoryBytes,
      sourceCoordinationBytes,
      sourceEffects,
      sourceFeature,
      sourceFoundation,
      sourceManifestBytes,
      sourceMembership,
      sourceRecord,
      sourceStaging,
    };
  }

  it('preserves the real LAN binding and origin when the target snapshot generation mismatches its proof', async () => {
    const { sourceFeature, sourceFoundation, sourceMembership } = await captureSource();
    const sessions = new CollabProjectWorkSessionRegistry();
    const admission = new ProjectOperationAdmission();
    const fence = new AuthorityTransferLocalFence({
      admission: {
        drainAdmittedOperations: projectId => admission.drainAdmittedOperations(projectId),
        resumeProjectAdmission: token => admission.resumeProject(token),
        suspendProjectAdmission: projectId => admission.suspendProject(projectId),
      },
      workSessions: {
        resumeProject: async token => {
          if (!await sessions.resumeProject(token)) throw new Error('Session did not resume');
        },
        suspendProject: projectId => sessions.suspendProject(projectId),
      },
    });
    try {
      const repositories = (await sourceFoundation.requireGitFoundation()).repositories;
      const convergence = new AuthorityTransferLocalConvergence({
        activity: { transitionProject: (projectId, operation) => fence.run(projectId, operation) },
        authorityProjectionTransitions: {
          run: (projectId, operation) => sourceFoundation.runAuthorityProjectionTransition(
            projectId,
            operation,
          ),
        },
        git: { rotate: input => rotateAuthorityTransferOrigin(repositories, input) },
        projects: sourceFoundation.local.projects,
        workspace: sourceFoundation.local.workspace,
      });
      const repositoryPath = path.join(sourceRoot, 'workspace', 'portable');
      const oldOrigin = git(repositoryPath, ['remote', 'get-url', 'origin']);
      const target = status('lan-to-cloud', 'completed', 'https://cloud.example.test/');
      const currentMember = {
        activatedAt: sourceMembership.createdAt,
        createdAt: sourceMembership.createdAt,
        displayName: 'Alice',
        id: MEMBER_ID,
        personalRef: `refs/heads/members/${MEMBER_ID}`,
        role: 'manager' as const,
        status: 'active' as const,
      };
      await expect(convergence.lanToCloudHost({
        snapshot: {
          currentMember,
          eventSequence: 3,
          members: [currentMember],
          openRequests: [],
          openTicketCount: 0,
          project: {
            authorityGeneration: 7,
            authorityKind: 'cloud',
            createdAt: sourceMembership.createdAt,
            id: PROJECT_ID,
            mainOid: git(repositoryPath, ['rev-parse', 'HEAD']),
            mainRef: 'refs/heads/main',
            name: 'Portable',
          },
          ticketHighlights: [],
        },
        status: {
          ...target,
          relinquishmentProof: {
            batchRevision: 1,
            batchSha256: 'b'.repeat(64),
            certificate: Buffer.alloc(64, 2).toString('base64url'),
            certificateAlgorithm: 'ed25519',
            checkpointSha256: 'a'.repeat(64),
            committedAt: target.updatedAt,
            operationIntentId: OPERATION_ID,
            projectId: PROJECT_ID,
            sourceAuthority: { generation: 1, kind: 'lan' },
            sourceHostMemberId: MEMBER_ID,
            targetAuthority: { generation: 2, kind: 'cloud' },
            transferId: TRANSFER_ID,
          },
          state: 'completed',
        },
      })).rejects.toMatchObject({
        code: 'durable-progress-recovery-required',
        safeContext: { reason: 'authority-transfer-convergence-generation-mismatch' },
      });
      expect(await sourceFoundation.local.projects.loadMembership(PROJECT_ID)).toEqual(sourceMembership);
      expect(git(repositoryPath, ['remote', 'get-url', 'origin'])).toBe(oldOrigin);
    } finally {
      await sessions.close();
      await sourceFeature.close();
      await sourceFoundation.close();
    }
  });

  it('rejects previous-wire staged checkpoints without changing the manifest or restart fence', async () => {
    const {
      recoveryRecord,
      sourceEffects,
      sourceFeature,
      sourceFoundation,
      sourceManifestBytes,
      sourceRecord,
      sourceStaging,
    } = await captureSource();
    try {
      await sourceFoundation.authorityTransfers.create(sourceRecord);
      await sourceFoundation.authorityTransfers.advance(recoveryRecord, 'collecting-readiness');
      const manifestPath = path.join(sourceStaging.absolutePath, 'checkpoint.json');
      const previousBytes = Buffer.from(JSON.stringify({
        ...JSON.parse(sourceManifestBytes.toString('utf8')),
        protocolVersion: 6,
      }));
      await writeFile(manifestPath, previousBytes, { mode: 0o600 });
      await expect(sourceEffects.capture(recoveryRecord)).rejects.toMatchObject({
        code: 'authority-integrity-error',
        safeContext: { reason: 'checkpoint-manifest-invalid' },
      });
      expect(await readFile(manifestPath)).toEqual(previousBytes);
      expect(await sourceFoundation.authorityTransfers.load(PROJECT_ID)).toEqual(recoveryRecord);
      expect(sourceFoundation.lanHost.isProjectRunning(PROJECT_ID)).toBe(false);
    } finally {
      await sourceFeature.close();
      await sourceFoundation.close();
    }
  });

  it('captures LAN data, stages Cloud-to-LAN inertly, and activates exactly once', async () => {
    const {
      artifactBytes,
      recoveryRecord,
      repositoryBytes,
      sourceCoordinationBytes,
      sourceEffects,
      sourceFeature,
      sourceFoundation,
      sourceManifestBytes,
      sourceMembership,
      sourceRecord,
      sourceStaging,
    } = await captureSource();
    const recoveredCapture = await sourceEffects.capture(recoveryRecord);
    const recoveredManifestChunks: Buffer[] = [];
    for await (const chunk of recoveredCapture.artifacts[0].body) {
      recoveredManifestChunks.push(Buffer.from(chunk as Uint8Array));
    }
    recoveredCapture.artifacts.slice(1).forEach(artifact => artifact.body.destroy());
    expect(Buffer.concat(recoveredManifestChunks)).toEqual(sourceManifestBytes);
    const sourceManifest = decodeCollabProjectCheckpointManifest(
      JSON.parse(sourceManifestBytes.toString('utf8')),
    );
    const fenceStatus: CollabAuthorityTransferStatus = {
      ...status(
        'lan-to-cloud',
        'claims-retained',
        'https://cloud.example.test/',
        sourceManifest.manifestSha256,
      ),
      batchRevision: 1,
      batchSha256: 'b'.repeat(64),
    };
    await sourceEffects.commitRelinquishmentFence(createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      lifecycleOwnership: 'owned',
      localRole: 'source',
      operationIntentId: OPERATION_ID,
      stagingDirectoryName: sourceRecord.stagingDirectoryName,
      status: fenceStatus,
    }));
    await expect(access(path.join(
      sourceStaging.absolutePath,
      'relinquishment-proof.json.partial',
    ))).rejects.toMatchObject({ code: 'ENOENT' });
    const records = sourceCoordinationBytes.toString('utf8').trimEnd().split('\n')
      .map(line => JSON.parse(line) as Record<string, unknown>);
    const project = records[0] as { value: Record<string, unknown> };
    project.value.authorityGeneration = 2;
    const targetCoordinationBytes = Buffer.from(
      `${records.map(record => JSON.stringify(record)).join('\n')}\n`,
      'utf8',
    );
    const targetManifest = createAuthorityTransferCheckpointManifest({
      artifacts: [
        {
          byteCount: targetCoordinationBytes.byteLength,
          name: 'coordination.ndjson',
          sha256: createHash('sha256').update(targetCoordinationBytes).digest('hex'),
        },
        {
          byteCount: repositoryBytes.byteLength,
          name: 'repository.bundle',
          sha256: createHash('sha256').update(repositoryBytes).digest('hex'),
        },
      ],
      createdAt: sourceManifest.createdAt,
      expectedMainOid: sourceManifest.expectedMainOid,
      gitObjectFormat: sourceManifest.gitObjectFormat,
      operationId: TRANSFER_ID,
      projectId: PROJECT_ID,
      refs: sourceManifest.refs,
      sourceAuthority: { generation: 2, kind: 'cloud' },
      targetAuthority: { generation: 3, kind: 'lan' },
    });
    artifactBytes.set('coordination.ndjson', targetCoordinationBytes);
    artifactBytes.set(
      'checkpoint.json',
      Buffer.from(encodeCollabProjectCheckpointManifestCanonicalJson(targetManifest), 'utf8'),
    );

    const targetFoundation = foundation(targetRoot);
    await targetFoundation.local.workspace.claimProjectsFolder('workspace');
    const cloudServerUrl = 'https://cloud.example.test/';
    git(targetRoot, [
      'clone',
      '--quiet',
      path.join(sourceRoot, 'workspace', 'portable'),
      path.join(targetRoot, 'workspace', 'portable'),
    ]);
    git(path.join(targetRoot, 'workspace', 'portable'), [
      'remote',
      'set-url',
      'origin',
      cloudProjectGitRemoteUrl(cloudServerUrl, PROJECT_ID),
    ]);
    await targetFoundation.local.projects.saveMembership({
      authority: {
        authorityGeneration: 2,
        bindingVersion: COLLAB_CLOUD_BINDING_VERSION,
        gitRemoteUrl: cloudProjectGitRemoteUrl(cloudServerUrl, PROJECT_ID),
        kind: 'cloud',
        serverUrl: cloudServerUrl,
        wireVersion: COLLAB_PROTOCOL_VERSION,
      },
      createdAt: sourceMembership.createdAt,
      lastEventSequence: 0,
      member: {
        displayName: sourceMembership.member.displayName,
        id: MEMBER_ID,
        personalRef: sourceMembership.member.personalRef,
        role: sourceMembership.member.role,
      },
      project: sourceMembership.project,
      schemaVersion: sourceMembership.schemaVersion,
      updatedAt: sourceMembership.updatedAt,
    });
    const snapshot: CollabCloudProjectSnapshot = {
      currentMember: {
        activatedAt: '2026-08-08T00:00:00.000Z',
        createdAt: '2026-08-08T00:00:00.000Z',
        displayName: sourceMembership.member.displayName,
        id: MEMBER_ID,
        personalRef: sourceMembership.member.personalRef,
        role: sourceMembership.member.role,
        status: 'active',
      },
      eventSequence: 3,
      members: [],
      openRequests: [],
      openTicketCount: 0,
      project: {
        authorityGeneration: 2,
        authorityKind: 'cloud',
        createdAt: sourceMembership.createdAt,
        id: PROJECT_ID,
        mainOid: git(path.join(sourceRoot, 'workspace', 'portable'), ['rev-parse', 'HEAD']),
        mainRef: 'refs/heads/main',
        name: sourceMembership.project.name,
      },
      ticketHighlights: [],
    };
    const cloudSession = {
      dispose: jest.fn(),
      projectId: PROJECT_ID,
      readSnapshot: jest.fn(async () => snapshot),
      serverUrl: cloudServerUrl,
    } as unknown as CloudAuthorityConnection;
    const gitFoundation = await targetFoundation.requireGitFoundation();
    await gitFoundation.repositories.configureLocalRepository(
      path.join(targetRoot, 'workspace', 'portable'),
      {
        memberId: MEMBER_ID,
        personalRef: sourceMembership.member.personalRef,
        projectId: PROJECT_ID,
        userDisplayName: sourceMembership.member.displayName,
      },
    );
    const convergence = new AuthorityTransferLocalConvergence({
      activity: { transitionProject: (_projectId, operation) => operation() },
      authorityProjectionTransitions: {
        run: (projectId, operation) => targetFoundation.runAuthorityProjectionTransition(
          projectId,
          operation,
        ),
      },
      git: {
        rotate: input => rotateAuthorityTransferOrigin(gitFoundation.repositories, input),
      },
      projects: targetFoundation.local.projects,
      workspace: targetFoundation.local.workspace,
    });
    const targetEffects = new ProductionCloudToLanTargetEffects({
      cloudSession,
      convergence,
      foundation: targetFoundation,
      persistence: targetFoundation.authorityTransfers,
      projectId: PROJECT_ID,
    });
    const prepared = await targetEffects.prepareTarget();
    const proposed = createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      lifecycleOwnership: 'owned',
      localRole: 'target',
      operationIntentId: OPERATION_ID,
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: status('cloud-to-lan', 'collecting-readiness', prepared.targetUrl),
    });
    const targetStaging = await targetFoundation.local.workspace.reserveProjectsFolderChild(
      'workspace',
      {
        childName: proposed.stagingDirectoryName,
        operationId: proposed.transferId,
        projectId: proposed.projectId,
        purpose: 'authority-transfer-staging',
      },
    );
    const interruptedTargetState = path.join(
      targetStaging.absolutePath,
      'target-private.json.partial',
    );
    await mkdir(targetStaging.absolutePath, { mode: 0o700 });
    await writeFile(interruptedTargetState, '{"truncated":', { mode: 0o600 });
    const acceptance = await targetEffects.acceptanceRequest(proposed);
    expect(acceptance.targetHostMemberId).toBe(MEMBER_ID);
    await expect(access(interruptedTargetState)).rejects.toMatchObject({ code: 'ENOENT' });
    const stagedRecord = createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      lifecycleOwnership: 'owned',
      localRole: 'target',
      operationIntentId: OPERATION_ID,
      stagingDirectoryName: proposed.stagingDirectoryName,
      status: status(
        'cloud-to-lan',
        'checkpoint-captured',
        prepared.targetUrl,
        targetManifest.manifestSha256,
      ),
    });
    const staged = await targetEffects.stage(stagedRecord, [
      'checkpoint.json',
      'coordination.ndjson',
      'repository.bundle',
    ].map((artifact) => {
      const typed = artifact as CollabCloudAuthorityTransferArtifact;
      const bytes = artifactBytes.get(typed);
      if (!bytes) throw new Error(`Missing ${artifact}`);
      return { artifact: typed, body: Readable.from([bytes]), byteCount: bytes.byteLength };
    }));

    expect(staged.checkpointSha256).toBe(targetManifest.manifestSha256);
    expect(staged.claimBatch.claims).toEqual([
      expect.objectContaining({ memberId: 'member-production-peer' }),
    ]);
    let targetAuthority = await targetFoundation.inspectAuthority(PROJECT_ID);
    expect(targetAuthority).toBeNull();
    await expect(access(path.join(
      targetRoot,
      '.claudian',
      'collab',
      'authorities',
      PROJECT_ID,
      '.claudian-authority.json',
    ))).rejects.toMatchObject({ code: 'ENOENT' });
    const relinquishmentProof = {
      batchRevision: staged.claimBatch.batchRevision,
      batchSha256: staged.claimBatch.batchSha256,
      certificate: Buffer.alloc(64, 4).toString('base64url'),
      certificateAlgorithm: 'ed25519' as const,
      checkpointSha256: staged.checkpointSha256,
      committedAt: '2026-08-28T00:02:00.000Z',
      operationIntentId: OPERATION_ID,
      projectId: PROJECT_ID,
      sourceAuthority: { generation: 2, kind: 'cloud' as const },
      sourceHostMemberId: null,
      targetAuthority: { generation: 3, kind: 'lan' as const },
      transferId: TRANSFER_ID,
    };
    const completedStatus: CollabAuthorityTransferStatus = {
      ...status(
        'cloud-to-lan',
        'completed',
        prepared.targetUrl,
        staged.checkpointSha256,
      ),
      batchRevision: staged.claimBatch.batchRevision,
      batchSha256: staged.claimBatch.batchSha256,
      phase: 'completed',
      relinquishmentProof,
      state: 'completed',
      updatedAt: '2026-08-28T00:03:00.000Z',
    };
    const completedRecord = createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      lifecycleOwnership: 'owned',
      localRole: 'target',
      operationIntentId: OPERATION_ID,
      stagingDirectoryName: proposed.stagingDirectoryName,
      status: completedStatus,
    });
    await targetFoundation.local.projects.authorityTransferRecords.save(completedRecord);
    await targetEffects.activate(completedRecord, relinquishmentProof);
    targetAuthority = await targetFoundation.inspectAuthority(PROJECT_ID);
    expect(JSON.parse(await readFile(path.join(
      targetRoot,
      '.claudian',
      'collab',
      'authorities',
      PROJECT_ID,
      '.claudian-authority.json',
    ), 'utf8'))).toEqual({
      ownerInstallationKey: TEST_INSTALLATION_A,
      projectId: PROJECT_ID,
      schemaVersion: 2,
    });
    const recoveringEffects = () => new ProductionCloudToLanTargetEffects({
      cloudSession: null,
      convergence,
      foundation: targetFoundation,
      persistence: targetFoundation.authorityTransfers,
      projectId: PROJECT_ID,
    });
    if (!targetAuthority) throw new Error('Missing imported target authority');
    const targetStatePath = path.join(
      targetAuthority.authorityDirectory,
      'authority-transfer-target.json',
    );
    const exactTargetState = await readFile(targetStatePath, 'utf8');
    const tamperedTargetState = JSON.parse(exactTargetState) as {
      targetProof: string;
    };
    const tamperedTargetProof = JSON.parse(
      Buffer.from(tamperedTargetState.targetProof, 'base64url').toString('utf8'),
    ) as { payload: { receiptKeyId: string } };
    tamperedTargetProof.payload.receiptKeyId = 'tampered-receipt-key';
    tamperedTargetState.targetProof = Buffer.from(
      JSON.stringify(tamperedTargetProof),
      'utf8',
    ).toString('base64url');
    await writeFile(targetStatePath, `${JSON.stringify(tamperedTargetState)}\n`);
    await expect(recoveringEffects().restoreCompleted(completedRecord)).rejects.toMatchObject({
      safeContext: { reason: 'authority-transfer-target-proof-invalid' },
    });
    await expect(targetFoundation.local.projects.loadMembership(PROJECT_ID))
      .resolves.toMatchObject({ authority: { kind: 'cloud' } });
    await writeFile(targetStatePath, exactTargetState);

    const snapshotReadsBeforeRecovery = cloudSession.readSnapshot as jest.Mock;
    const snapshotReadCount = snapshotReadsBeforeRecovery.mock.calls.length;
    const repairIndex = jest.spyOn(
      targetFoundation.local.projects,
      'repairIndexFromMemberships',
    );
    repairIndex.mockRejectedValueOnce(new Error('simulated post-membership crash'));

    await expect(recoveringEffects().restoreCompleted(completedRecord))
      .rejects.toThrow('simulated post-membership crash');
    const convertedMembership = await targetFoundation.local.projects.loadMembership(PROJECT_ID);
    if (!convertedMembership || convertedMembership.authority.kind !== 'lan') {
      throw new Error('Missing converted target membership');
    }
    const exactConvertedMembership = convertedMembership as CollabLocalLanMembershipRecord;
    await targetFoundation.local.projects.saveMembership({
      ...exactConvertedMembership,
      authority: {
        ...exactConvertedMembership.authority,
        hostCaFingerprint: 'f'.repeat(64),
      },
    });
    await expect(recoveringEffects().restoreCompleted(completedRecord)).rejects.toMatchObject({
      safeContext: { reason: 'authority-transfer-lan-membership-conflict' },
    });
    expect(repairIndex).toHaveBeenCalledTimes(1);
    await targetFoundation.local.projects.saveMembership(exactConvertedMembership);
    await expect(recoveringEffects().restoreCompleted(completedRecord)).resolves.toBeUndefined();
    expect(snapshotReadsBeforeRecovery).toHaveBeenCalledTimes(snapshotReadCount);

    expect(targetFoundation.lanHost.isProjectRunning(PROJECT_ID)).toBe(true);
    await expect(targetFoundation.local.projects.loadMembership(PROJECT_ID)).resolves.toMatchObject({
      authority: { kind: 'lan' },
      hostOwnership: { autoStart: true, ownsAuthority: true },
    });
    expect(await targetAuthority?.database.read(connection => connection.get(
      'SELECT state FROM project WHERE singleton = 1',
    ))).toEqual({ state: 'active' });
    const targetMembership = await targetFoundation.local.projects.loadMembership(PROJECT_ID);
    if (!targetMembership || targetMembership.authority.kind !== 'lan') {
      throw new Error('Missing activated target membership');
    }
    const claimantCredential = Buffer.alloc(32, 9).toString('base64url');
    const claim = staged.claimBatch.claims[0];
    if (!claim) throw new Error('Missing transferred Member claim');
    const claimClient = new LanAuthorityTransferClient({
      caCertificatePem: targetMembership.authority.hostCaCertificatePem!,
      caFingerprint: targetMembership.authority.hostCaFingerprint!,
      endpoint: targetMembership.authority.endpoint!,
      projectId: PROJECT_ID,
    });
    const claimRequest = {
      claim: claim.claim,
      credentialHash: createHash('sha256')
        .update(Buffer.from(claimantCredential, 'base64url'))
        .digest('hex'),
      idempotencyKey: 'claim-production-peer',
      projectId: PROJECT_ID,
      transferId: TRANSFER_ID,
    };
    const firstReceipt = await claimClient.claimTransferredMembership(claimRequest);
    const replayedReceipt = await claimClient.claimTransferredMembership(claimRequest);
    expect(replayedReceipt).toEqual(firstReceipt);
    expect(firstReceipt.memberId).toBe('member-production-peer');
    expect(await targetAuthority?.database.read(connection => connection.get(`
      SELECT access_state, credential_hash
      FROM members
      WHERE member_id = 'member-production-peer'
    `))).toEqual({
      access_state: 'bound',
      credential_hash: createHash('sha256')
        .update(Buffer.from(claimantCredential, 'base64url'))
        .digest(),
    });
    await sourceFeature.close();
    await sourceFoundation.close();
    await targetFoundation.close();
  });

  function foundation(
    vaultRoot: string,
    installationKey: typeof TEST_INSTALLATION_A | typeof TEST_INSTALLATION_B = TEST_INSTALLATION_A,
  ): ClaudianCollabService {
    return new ClaudianCollabService({
      createAuthorityDatabase: authorityDirectory => (
        new SqlJsProjectDatabase(authorityDirectory, { loadSqlJs: async () => SQL })
      ),
      getConfiguredGitPath: () => '',
      installationKey,
      obsidianConfigDirectory: '.obsidian',
      vaultRoot,
    });
  }
});
