import { spawnSync } from 'node:child_process';
import {
  constants,
  createHash,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from 'node:crypto';
import fsPromises from 'node:fs/promises';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import {
  COLLAB_CLOUD_BINDING_VERSION,
  COLLAB_PROTOCOL_VERSION,
  type CollabAuthorityRelinquishmentProof,
  type CollabAuthorityRelinquishmentProofSigningPayload,
  type CollabAuthorityTransferStatus,
  type CollabCloudAuthorityTransferArtifact,
  type CollabCloudCapability,
  type CollabTransferredMembershipClaimBatch,
  decodeCollabProjectCheckpointManifest,
  encodeCollabAuthorityRelinquishmentProofSigningInput,
  encodeCollabCloudToLanTargetCleanupProofSigningInput,
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
  createCollabFeatureSubcomposition as createProductionFeatureSubcomposition,
} from '@/app/collab';
import { CollabProjectWorkSessionRegistry } from '@/app/collab/activity/CollabProjectWorkSession';
import { AuthorityMetadataRepository } from '@/app/collab/authority/AuthorityMetadataRepository';
import { SqlJsProjectDatabase } from '@/app/collab/authority/SqlJsProjectDatabase';
import { createAuthorityTransferEntryRecord } from '@/app/collab/authority-transfer/AuthorityTransferEntryRecord';
import { AuthorityTransferLocalConvergence } from '@/app/collab/authority-transfer/AuthorityTransferLocalConvergence';
import { AuthorityTransferLocalFence } from '@/app/collab/authority-transfer/AuthorityTransferLocalFence';
import {
  authorityTransferChildIdempotencyKey,
} from '@/app/collab/authority-transfer/AuthorityTransferOperationIdentity';
import {
  createAuthorityTransferRecord,
  expireAuthorityTransferTerminalResponder,
} from '@/app/collab/authority-transfer/AuthorityTransferRecord';
import { createAuthorityTransferCheckpointManifest } from '@/app/collab/authority-transfer/checkpoint/AuthorityTransferCheckpointManifest';
import {
  cloudToLanTransferHandle,
  createCloudToLanManagerEntry,
  createCloudToLanTargetEntry,
  handoffCloudToLanTargetEntry,
  markCloudToLanManagerBeginPossiblySent,
  publishCloudToLanTargetEntry,
  recordCloudToLanManagerStatus,
} from '@/app/collab/authority-transfer/cloud-to-lan/CloudToLanTransferEntryRecord';
import { ProductionCloudToLanTargetEffects } from '@/app/collab/authority-transfer/cloud-to-lan/ProductionCloudToLanTargetEffects';
import { LanToCloudSourceCoordinator } from '@/app/collab/authority-transfer/lan-to-cloud/LanToCloudSourceCoordinator';
import { ProductionLanToCloudSourceEffects } from '@/app/collab/authority-transfer/lan-to-cloud/ProductionLanToCloudSourceEffects';
import { AuthorityTransferPersistence } from '@/app/collab/authority-transfer/persistence/AuthorityTransferPersistence';
import {
  type CollabLocalLanMembershipRecord,
  type CollabLocalMembershipRecord,
  isCollabLocalCloudMembership,
} from '@/app/collab/CollabLocalProjectRepository';
import { rotateAuthorityTransferOrigin } from '@/app/collab/git/CollabGitOriginPolicy';
import { LanAuthorityTransferClient } from '@/app/collab/lan/authority-transfer/LanAuthorityTransferClient';
import { listPrivateIpv4Addresses } from '@/app/collab/lan/LanHostCoordinator';
import { LanTlsIdentity } from '@/app/collab/lan/LanTlsIdentity';
import { ProjectOperationAdmission } from '@/app/collab/ProjectOperationAdmission';
import type { CloudAuthorityConnection } from '@/app/collab/remote-authority/CloudAuthorityAdapter';
import { cloudProjectGitRemoteUrl } from '@/app/collab/remote-authority/CloudAuthorityUrls';
import type { CollabAuthorityLifecyclePort } from '@/app/collab/remote-authority/CollabAuthorityLifecyclePort';

const PROJECT_ID = 'project-production-effects';
const MEMBER_ID = 'member-production-host';
const TRANSFER_ID = 'transfer-production-effects';
const OPERATION_ID = 'intent-production-effects';
const HOST_CREDENTIAL = Buffer.alloc(32, 7).toString('base64url');
const CLOUD_RECEIPT_KEYS = generateKeyPairSync('ed25519');
const CLOUD_RECEIPT_PUBLIC_KEY = (
  CLOUD_RECEIPT_KEYS.publicKey.export({ format: 'jwk' }) as JsonWebKey
).x!;

function cloudReceiptVerifier() {
  return {
    projectId: PROJECT_ID,
    receiptKeyId: 'receipt-key-production-cloud',
    receiptPublicKey: CLOUD_RECEIPT_PUBLIC_KEY,
    receiptPublicKeyEncoding: 'base64url-raw' as const,
    signatureAlgorithm: 'ed25519' as const,
    transferId: TRANSFER_ID,
  };
}

function signCloudRelinquishmentProof(
  payload: CollabAuthorityRelinquishmentProofSigningPayload,
): CollabAuthorityRelinquishmentProof {
  return {
    ...payload,
    certificate: sign(
      null,
      Buffer.from(encodeCollabAuthorityRelinquishmentProofSigningInput(payload), 'utf8'),
      CLOUD_RECEIPT_KEYS.privateKey,
    ).toString('base64url'),
  };
}

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
  const foundations = new Set<ClaudianCollabService>();
  const features = new Set<ReturnType<typeof createProductionFeatureSubcomposition>['feature']>();

  beforeAll(async () => {
    SQL = await initSqlJs();
  });

  beforeEach(async () => {
    sourceRoot = await mkdtemp(path.join(tmpdir(), 'claudian-transfer-source-'));
    targetRoot = await mkdtemp(path.join(tmpdir(), 'claudian-transfer-target-'));
  });

  afterEach(async () => {
    await Promise.allSettled([...features].map(feature => feature.close()));
    features.clear();
    await Promise.allSettled([...foundations].map(service => service.close()));
    foundations.clear();
    jest.restoreAllMocks();
    await Promise.all([
      rm(sourceRoot, { force: true, recursive: true }),
      rm(targetRoot, { force: true, recursive: true }),
    ]);
  });

  it('retains a Cloud-to-LAN target preparation until disposal succeeds', async () => {
    const dispose = jest.fn()
      .mockRejectedValueOnce(new Error('simulated target cleanup failure'))
      .mockResolvedValue(undefined);
    const effects = new ProductionCloudToLanTargetEffects({
      cloudSession: {} as CloudAuthorityConnection,
      convergence: {} as AuthorityTransferLocalConvergence,
      foundation: {
        lanHost: {
          prepareAuthorityTransferTarget: jest.fn(async () => ({
            caCertificatePem: '-----BEGIN CERTIFICATE-----\npublic\n-----END CERTIFICATE-----',
            caFingerprint: 'c'.repeat(64),
            dispose,
            endpoint: 'https://127.0.0.1:54545',
          })),
        },
      } as never,
      persistence: {} as never,
      projectId: PROJECT_ID,
    });

    await effects.prepareTarget();
    await expect(effects.dispose()).rejects.toThrow('simulated target cleanup failure');
    await expect(effects.dispose()).resolves.toBeUndefined();

    expect(dispose).toHaveBeenCalledTimes(2);
  });

  it('retains a cancelled Cloud-to-LAN target preparation until disposal succeeds', async () => {
    const dispose = jest.fn()
      .mockRejectedValueOnce(new Error('simulated target cancellation cleanup failure'))
      .mockResolvedValue(undefined);
    const discardAuthorityTransferTarget = jest.fn(async () => undefined);
    const removeReservedProjectsFolderChild = jest.fn(async () => true);
    const effects = new ProductionCloudToLanTargetEffects({
      cloudSession: {} as CloudAuthorityConnection,
      convergence: {} as AuthorityTransferLocalConvergence,
      foundation: {
        discardAuthorityTransferTarget,
        hostInstallations: { inspect: jest.fn(async () => 'absent') },
        lanHost: {
          prepareAuthorityTransferTarget: jest.fn(async () => ({
            caCertificatePem: '-----BEGIN CERTIFICATE-----\npublic\n-----END CERTIFICATE-----',
            caFingerprint: 'c'.repeat(64),
            dispose,
            endpoint: 'https://127.0.0.1:54545',
          })),
          stopAuthorityTransferRoute: jest.fn(async () => undefined),
        },
        local: {
          projects: {
            loadMembership: jest.fn(async () => ({
              project: { workspacePath: '/vault/Projects/Portable' },
            })),
          },
          workspace: { removeReservedProjectsFolderChild },
        },
      } as never,
      persistence: {} as never,
      projectId: PROJECT_ID,
    });
    const record = createAuthorityTransferRecord({
      lifecycleOwnership: 'owned',
      localRole: 'target',
      operationIntentId: OPERATION_ID,
      ownerInstallationKey: TEST_INSTALLATION_A,
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: {
        ...status('cloud-to-lan', 'cancelled', 'https://127.0.0.1:54545'),
        state: 'cancelled',
      },
    });

    await effects.prepareTarget();
    await expect(effects.cancelStaging(record)).rejects.toThrow(
      'simulated target cancellation cleanup failure',
    );
    await expect(effects.cancelStaging(record)).resolves.toBeUndefined();

    expect(dispose).toHaveBeenCalledTimes(2);
    expect(discardAuthorityTransferTarget).toHaveBeenCalledTimes(1);
    expect(removeReservedProjectsFolderChild).toHaveBeenCalledTimes(1);
  });

  it.each([
    { generation: 1, onlineRecovery: false },
    { generation: 2, onlineRecovery: false },
    { generation: 3, onlineRecovery: false },
    { generation: 1, onlineRecovery: true },
  ])('cancels a returning target with LAN generation $generation and online recovery $onlineRecovery', async ({ generation, onlineRecovery }) => {
    const targetFoundation = foundation(targetRoot);
    const cloudServerUrl = 'https://cloud.example.test/';
    await targetFoundation.local.workspace.claimProjectsFolder('workspace');
    await targetFoundation.local.projects.saveMembership({
      authority: {
        authorityGeneration: 2,
        bindingVersion: COLLAB_CLOUD_BINDING_VERSION,
        gitRemoteUrl: cloudProjectGitRemoteUrl(cloudServerUrl, PROJECT_ID),
        kind: 'cloud',
        serverUrl: cloudServerUrl,
        wireVersion: COLLAB_PROTOCOL_VERSION,
      },
      createdAt: '2026-08-28T00:00:00.000Z',
      lastEventSequence: 0,
      member: {
        displayName: 'Former Host',
        id: MEMBER_ID,
        personalRef: `refs/heads/members/${MEMBER_ID}`,
        role: 'manager',
      },
      project: { id: PROJECT_ID, name: 'Portable', workspacePath: 'workspace/portable' },
      schemaVersion: 3,
      updatedAt: '2026-08-28T00:00:00.000Z',
    });
    const formerAuthority = await targetFoundation.createAuthority(PROJECT_ID);
    await formerAuthority.database.mutate(connection => {
      formerAuthority.projects.initialize(connection, {
        createdAt: '2026-08-08T00:00:00.000Z',
        hostCredentialHash: createHash('sha256').update(HOST_CREDENTIAL).digest(),
        hostDisplayName: 'Former Host',
        hostMemberId: MEMBER_ID,
        name: 'Portable',
        projectId: PROJECT_ID,
      });
      new AuthorityMetadataRepository().installGeneration(connection, generation);
    });
    const repositoryPath = path.join(formerAuthority.authorityDirectory, 'repository.git');
    git(formerAuthority.authorityDirectory, ['init', '--bare', 'repository.git']);
    const formerRepositoryHead = await readFile(path.join(repositoryPath, 'HEAD'), 'utf8');
    const effects = new ProductionCloudToLanTargetEffects({
      cloudSession: { serverUrl: cloudServerUrl },
      convergence: {} as AuthorityTransferLocalConvergence,
      foundation: targetFoundation,
      now: () => new Date('2026-08-28T00:02:00.000Z'),
      persistence: targetFoundation.authorityTransfers,
      projectId: PROJECT_ID,
    });
    try {
      const prepared = await effects.prepareTarget();
      const collecting = createAuthorityTransferRecord({
        lifecycleOwnership: 'owned',
        localRole: 'target',
        operationIntentId: OPERATION_ID,
        ownerInstallationKey: TEST_INSTALLATION_A,
        stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
        status: status('cloud-to-lan', 'collecting-readiness', prepared.targetUrl),
      });
      await effects.acceptanceRequest(collecting);
      const targetEntry = publishCloudToLanTargetEntry(createCloudToLanTargetEntry({
        createdAt: collecting.status.createdAt,
        expiresAt: collecting.status.expiresAt,
        operationIntentId: 'prepare-cancelled-return',
        ownerInstallationKey: TEST_INSTALLATION_A,
        projectId: PROJECT_ID,
        selectedTargetMemberId: MEMBER_ID,
        selectedTargetPersonalRef: `refs/heads/members/${MEMBER_ID}`,
        sourceAuthorityGeneration: 2,
        sourceCloudUrl: cloudServerUrl,
      }), { ...prepared, publishedAt: collecting.status.createdAt });
      await targetFoundation.local.projects.authorityTransferEntries.saveTarget(
        handoffCloudToLanTargetEntry(targetEntry, collecting),
      );
      const cancelled = createAuthorityTransferRecord({
        ...collecting,
        status: status('cloud-to-lan', 'cancel-intent', prepared.targetUrl, 'a'.repeat(64)),
      });
      await targetFoundation.local.projects.authorityTransferRecords.save(cancelled);
      const cancel = async () => {
        const proof = await effects.invalidateStaging(cancelled);
        const replay = await effects.invalidateStaging(cancelled);
        const terminal = createAuthorityTransferRecord({
          ...cancelled,
          status: { ...cancelled.status, phase: 'cancelled', state: 'cancelled' },
        });
        if (!onlineRecovery) {
          await targetFoundation.local.projects.authorityTransferRecords.save(terminal);
        }
        let observed = terminal.status;
        const recovered = createCollabFeatureSubcomposition({
          cloudAuthority: {
            connectAuthorityTransfer: async (binding: object) => ({
              ...binding,
              dispose: () => undefined,
              lifecycle: {
                authorityTransfer: async (operation: string) => {
                  if (operation === 'confirmCloudToLanTargetInvalidated'
                    || operation === 'getProjectAuthorityTransfer') return observed;
                  throw new Error(`Unexpected recovery operation ${operation}`);
                },
              },
              readSnapshot: async () => ({
                currentMember: { id: MEMBER_ID, personalRef: `refs/heads/members/${MEMBER_ID}` },
                project: { authorityGeneration: 2, id: PROJECT_ID },
              }),
              supports: () => true,
            }),
          } as never,
          foundation: targetFoundation,
          projectSetup: new CollabProjectSetupService(targetFoundation, {
            installationKey: TEST_INSTALLATION_A,
            vaultRoot: targetRoot,
          }),
          vaultRoot: targetRoot,
        });
        await recovered.feature.initialize();
        await recovered.feature.restoreLifecycle();
        let nextAcceptance: unknown = null;
        try {
          if (onlineRecovery) {
            const descriptor = await recovered.authorityTransfer.prepareCloudToLanTarget({
              operationIntentId: 'prepare-after-recovered-cancellation',
              projectId: PROJECT_ID,
            });
            observed = {
              ...status('cloud-to-lan', 'cancelled', descriptor.targetUrl),
              createdAt: descriptor.publishedAt,
              expiresAt: new Date(Date.parse(descriptor.publishedAt) + 60_000).toISOString(),
              state: 'cancelled',
              transferId: 'transfer-after-recovered-cancellation',
              updatedAt: descriptor.publishedAt,
            };
            const handle = cloudToLanTransferHandle(recordCloudToLanManagerStatus(
              markCloudToLanManagerBeginPossiblySent(createCloudToLanManagerEntry({
                createdAt: descriptor.publishedAt,
                descriptor,
                expiresAt: new Date(Date.parse(descriptor.publishedAt) + 60_000).toISOString(),
                initiatingMemberId: MEMBER_ID,
                initiatingPersonalRef: `refs/heads/members/${MEMBER_ID}`,
                operationIntentId: 'begin-after-recovered-cancellation',
                ownerInstallationKey: TEST_INSTALLATION_A,
              })),
              observed,
            ));
            nextAcceptance = await recovered.authorityTransfer.acceptCloudToLanTransfer({ handle })
              .catch((error: unknown) => ({
                error: (error as { safeContext?: { reason?: string } }).safeContext?.reason,
              }));
          }
        } finally {
          await recovered.feature.close();
        }
        return { nextAcceptance, proof, replayMatches: JSON.stringify(replay) === JSON.stringify(proof) };
      };
      const outcome = await cancel().catch((error: unknown) => {
        if (generation === 1) throw error;
        return { error: (error as { safeContext?: { reason?: string } }).safeContext?.reason };
      });
      expect(outcome).toMatchObject(generation === 1 ? {
        nextAcceptance: onlineRecovery ? {
          state: 'cancelled',
          transferId: 'transfer-after-recovered-cancellation',
        } : null,
        proof: {
          projectId: PROJECT_ID,
          sourceAuthority: { generation: 2, kind: 'cloud' },
          targetAuthority: { generation: 3, kind: 'lan' },
          transferId: TRANSFER_ID,
        },
        replayMatches: true,
      } : { error: 'authority-transfer-former-source-not-replaceable' });
      expect(await targetFoundation.hostInstallations.inspect(PROJECT_ID)).toBe('hosted-here');
      expect(await formerAuthority.database.read(connection => formerAuthority.projects.get(connection)?.authorityGeneration))
        .toBe(generation);
      expect(await readFile(path.join(repositoryPath, 'HEAD'), 'utf8')).toBe(formerRepositoryHead);
    } finally {
      await effects.dispose();
      await targetFoundation.close();
    }
  });

  it('durably invalidates a staged Cloud-to-LAN target and replays one exact signed cleanup proof', async () => {
    const now = new Date('2026-08-28T00:02:00.000Z');
    const signer = await new LanTlsIdentity(targetRoot, {
      installationKey: TEST_INSTALLATION_A,
      now: () => now,
    }).hostCaSigner();
    const stagingPath = path.join(targetRoot, 'target-staging');
    const statesAtDiscard: unknown[] = [];
    const discardAuthorityTransferTarget = jest.fn(async () => {
      statesAtDiscard.push(JSON.parse(await readFile(
        path.join(stagingPath, 'target-private.json'),
        'utf8',
      )));
    });
    const startAuthorityTransferRoute = jest.fn(async () => undefined);
    const stopAuthorityTransferRoute = jest.fn(async () => undefined);
    const membership = {
      authority: {
        kind: 'cloud',
        serverUrl: 'https://cloud.example.test/',
      },
      member: { id: MEMBER_ID },
      project: { workspacePath: 'Projects/Portable' },
    };
    const foundation = {
      discardAuthorityTransferTarget,
      hostInstallations: { inspect: jest.fn(async () => 'absent') },
      lanHost: {
        hostCaSigner: jest.fn(async () => signer),
        prepareAuthorityTransferTarget: jest.fn(async () => ({
          caCertificatePem: signer.caCertificatePem,
          caFingerprint: signer.caFingerprint,
          dispose: jest.fn(async () => undefined),
          endpoint: 'https://127.0.0.1:54545',
        })),
        startAuthorityTransferRoute,
        stopAuthorityTransferRoute,
      },
      local: {
        projects: { loadMembership: jest.fn(async () => membership) },
        workspace: {
          reserveProjectsFolderChild: jest.fn(async () => ({ absolutePath: stagingPath })),
        },
      },
    };
    const createEffects = () => new ProductionCloudToLanTargetEffects({
      cloudSession: { serverUrl: 'https://cloud.example.test/' },
      convergence: {} as AuthorityTransferLocalConvergence,
      foundation: foundation as never,
      now: () => now,
      persistence: {} as never,
      projectId: PROJECT_ID,
    });
    const collectingRecord = createAuthorityTransferRecord({
      lifecycleOwnership: 'owned',
      localRole: 'target',
      operationIntentId: OPERATION_ID,
      ownerInstallationKey: TEST_INSTALLATION_A,
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: status(
        'cloud-to-lan',
        'collecting-readiness',
        'https://127.0.0.1:54545',
      ),
    });
    const firstEffects = createEffects();
    await firstEffects.acceptanceRequest(collectingRecord);
    const targetStatePath = path.join(stagingPath, 'target-private.json');
    const currentTargetState = JSON.parse(await readFile(targetStatePath, 'utf8')) as Record<
      string,
      unknown
    >;
    const { cleanup: _cleanup, ...legacyTargetState } = currentTargetState;
    legacyTargetState.schemaVersion = 1;
    const legacyTargetStateBytes = `${JSON.stringify(legacyTargetState)}\n`;
    await writeFile(targetStatePath, legacyTargetStateBytes, { mode: 0o600 });
    await expect(createEffects().acceptanceRequest(collectingRecord)).rejects.toMatchObject({
      code: 'durable-progress-recovery-required',
      safeContext: { reason: 'authority-transfer-target-state-invalid' },
    });
    await expect(readFile(targetStatePath, 'utf8')).resolves.toBe(legacyTargetStateBytes);
    await writeFile(targetStatePath, `${JSON.stringify(currentTargetState)}\n`, { mode: 0o600 });
    const targetStateBeforeStage = JSON.parse(await readFile(targetStatePath, 'utf8')) as {
      claimBatch: unknown;
    };
    const unsignedLocalBatch = {
      batchRevision: 1,
      batchSha256: '0'.repeat(64),
      checkpointSha256: 'a'.repeat(64),
      claims: [],
      expiresAt: '2026-09-27T00:00:00.000Z',
      projectId: PROJECT_ID,
      targetAuthorityGeneration: 3,
      transferId: TRANSFER_ID,
    };
    const localBatch = {
      ...unsignedLocalBatch,
      batchSha256: createHash('sha256')
        .update(encodeCollabTransferredMembershipClaimBatchDigestInput(unsignedLocalBatch), 'utf8')
        .digest('hex'),
    };
    targetStateBeforeStage.claimBatch = localBatch;
    await writeFile(targetStatePath, `${JSON.stringify(targetStateBeforeStage)}\n`, { mode: 0o600 });
    const cancellationRecord = createAuthorityTransferRecord({
      lifecycleOwnership: 'owned',
      localRole: 'target',
      operationIntentId: OPERATION_ID,
      ownerInstallationKey: TEST_INSTALLATION_A,
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: status(
        'cloud-to-lan',
        'cancel-intent',
        'https://127.0.0.1:54545',
        localBatch.checkpointSha256,
      ),
    });

    const firstProof = await firstEffects.invalidateStaging(cancellationRecord);
    const replayedProof = await createEffects().invalidateStaging(cancellationRecord);

    expect(replayedProof).toEqual(firstProof);
    expect(firstProof).toMatchObject({
      batchRevision: localBatch.batchRevision,
      batchSha256: localBatch.batchSha256,
      checkpointSha256: localBatch.checkpointSha256,
      stageSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(statesAtDiscard[0]).toMatchObject({
      cleanup: {
        cleanupSha256: firstProof.cleanupSha256,
        invalidatedAt: firstProof.invalidatedAt,
        operationIntentId: firstProof.operationIntentId,
        proof: null,
      },
      schemaVersion: 3,
      transferId: TRANSFER_ID,
    });
    expect(statesAtDiscard[1]).toMatchObject({ cleanup: { proof: firstProof } });
    const targetState = JSON.parse(await readFile(targetStatePath, 'utf8')) as {
      readonly cleanup: { readonly proof: typeof firstProof };
      readonly receiptKey: { readonly publicKey: string };
    };
    expect(targetState.cleanup.proof).toEqual(firstProof);
    const { signature, ...signingPayload } = firstProof;
    expect(verify(
      null,
      Buffer.from(encodeCollabCloudToLanTargetCleanupProofSigningInput(signingPayload), 'utf8'),
      createPublicKey({
        format: 'jwk',
        key: {
          crv: 'Ed25519',
          kty: 'OKP',
          x: targetState.receiptKey.publicKey,
        },
      }),
      Buffer.from(signature, 'base64url'),
    )).toBe(true);
    expect(startAuthorityTransferRoute).toHaveBeenCalledTimes(1);
    expect(stopAuthorityTransferRoute).toHaveBeenCalledTimes(2);
    expect(discardAuthorityTransferTarget).toHaveBeenCalledTimes(2);
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
          stopAuthorityTransferRoute: jest.fn(async () => {
            events.push('stop-route');
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
      'stop-route',
    ]);
  });

  it('settles an empty completed LAN source without retaining a blocking terminal route', async () => {
    const endpoint = 'https://127.0.0.1:54545';
    const completed = status('lan-to-cloud', 'completed', 'https://cloud.example.test/');
    const completedRecord = createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      lifecycleOwnership: 'owned',
      localRole: 'source',
      operationIntentId: OPERATION_ID,
      sourceLanEndpoint: endpoint,
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: {
        ...completed,
        batchRevision: 1,
        batchSha256: 'b'.repeat(64),
        checkpointSha256: 'a'.repeat(64),
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
      lanToCloudHost: jest.fn(async () => { events.push('converge-online'); }),
      lanToCloudHostOffline: jest.fn(async () => { events.push('converge-offline'); }),
    } as unknown as AuthorityTransferLocalConvergence;
    const persistence = {
      completeTerminalCleanup: jest.fn(async () => { events.push('cleanup'); }),
      expireTerminalResponder: jest.fn(async () => { events.push('expire'); }),
      load: jest.fn(async () => completedRecord),
      isRetainedClaimBatchEmpty: jest.fn(async () => true),
    };
    const stopAuthorityTransferRoute = jest.fn(async () => { events.push('stop-route'); });
    const effects = new ProductionLanToCloudSourceEffects({
      cloudSession: {
        readSnapshot: jest.fn(async () => ({ project: { id: PROJECT_ID } })),
      } as never,
      convergence,
      foundation: {
        inspectAuthority: jest.fn(async () => ({ database: {} })),
        lanHost: {
          activateAuthorityTransferTerminalSource: jest.fn(async () => {
            events.push('activate-route');
          }),
          relinquishProjectForAuthorityTransfer: jest.fn(async () => {
            events.push('relinquish');
          }),
          stopAuthorityTransferRoute,
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

    await effects.activateTerminal(completedRecord);

    expect(persistence.isRetainedClaimBatchEmpty).toHaveBeenCalledWith(
      PROJECT_ID,
      TRANSFER_ID,
    );
    expect(stopAuthorityTransferRoute).toHaveBeenCalledWith(PROJECT_ID, 'terminal-source', TRANSFER_ID);
    expect(events).toEqual([
      'relinquish',
      'activate-route',
      'converge-online',
      'converge-offline',
      'expire',
      'remove-staging',
      'cleanup',
      'stop-route',
    ]);
  });

  it('removes the terminal route when empty-source cleanup resumes after responder expiry', async () => {
    const endpoint = 'https://127.0.0.1:54545';
    const completed = status('lan-to-cloud', 'completed', 'https://cloud.example.test/');
    const completedRecord = createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      lifecycleOwnership: 'owned',
      localRole: 'source',
      operationIntentId: OPERATION_ID,
      sourceLanEndpoint: endpoint,
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: {
        ...completed,
        batchRevision: 1,
        batchSha256: 'b'.repeat(64),
        checkpointSha256: 'a'.repeat(64),
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
    let currentRecord = completedRecord;
    const persistence = {
      completeTerminalCleanup: jest.fn(async () => undefined),
      expireTerminalResponder: jest.fn(async () => {
        if (currentRecord.terminalResponder?.state === 'active') {
          currentRecord = expireAuthorityTransferTerminalResponder(currentRecord);
        }
      }),
      isRetainedClaimBatchEmpty: jest.fn(async () => true),
      load: jest.fn(async () => currentRecord),
    };
    const removeReservedProjectsFolderChild = jest.fn()
      .mockRejectedValueOnce(new Error('simulated cleanup failure after responder expiry'))
      .mockResolvedValue(undefined);
    const stopAuthorityTransferRoute = jest.fn(async () => undefined);
    const effects = new ProductionLanToCloudSourceEffects({
      cloudSession: {
        readSnapshot: jest.fn(async () => ({ project: { id: PROJECT_ID } })),
      } as never,
      convergence: {
        lanToCloudHost: jest.fn(async () => undefined),
        lanToCloudHostOffline: jest.fn(async () => undefined),
      } as unknown as AuthorityTransferLocalConvergence,
      foundation: {
        inspectAuthority: jest.fn(async () => ({ database: {} })),
        lanHost: {
          activateAuthorityTransferTerminalSource: jest.fn(async () => undefined),
          relinquishProjectForAuthorityTransfer: jest.fn(async () => undefined),
          stopAuthorityTransferRoute,
        },
        local: {
          projects: {
            loadMembership: jest.fn(async () => ({
              project: { workspacePath: '/vault/Projects/Portable' },
            })),
          },
          workspace: { removeReservedProjectsFolderChild },
        },
      } as never,
      persistence: persistence as never,
      projectId: PROJECT_ID,
    });

    await expect(effects.activateTerminal(completedRecord)).rejects.toThrow(
      'simulated cleanup failure after responder expiry',
    );
    expect(currentRecord.terminalResponder?.state).toBe('expired');
    expect(stopAuthorityTransferRoute).not.toHaveBeenCalled();

    await expect(effects.restoreCompleted(currentRecord)).resolves.toBeUndefined();

    expect(removeReservedProjectsFolderChild).toHaveBeenCalledTimes(2);
    expect(persistence.completeTerminalCleanup).toHaveBeenCalledTimes(1);
    expect(stopAuthorityTransferRoute).toHaveBeenCalledWith(PROJECT_ID, 'terminal-source', TRANSFER_ID);
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
        principalId: 'vault-source-credential',
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
      const exact = await sourceFoundation.authorityTransfers.load(PROJECT_ID);
      if (!exact) throw new Error('Missing completed source transfer');
      const nextTarget = createCloudToLanTargetEntry({
        createdAt: new Date().toISOString(), expiresAt: '2026-09-26T00:00:00.000Z',
        operationIntentId: 'next-target-preparation', ownerInstallationKey: TEST_INSTALLATION_A,
        projectId: PROJECT_ID, selectedTargetMemberId: MEMBER_ID,
        selectedTargetPersonalRef: `refs/heads/members/${MEMBER_ID}`,
        sourceAuthorityGeneration: 2, sourceCloudUrl: targetUrl,
      });
      await sourceFoundation.authorityTransfers.prepareCloudToLanTargetEntry(nextTarget);
      await sourceFoundation.closeAuthority(PROJECT_ID);
      await sourceFoundation.hostInstallations.removeOwned(PROJECT_ID);
      const terminalRequest = { projectId: PROJECT_ID, transferId: exact.transferId };
      await expect(client.requestWithMember('getProjectAuthorityTransfer', terminalRequest, peerCredential))
        .resolves.toEqual(completed);
      await sourceFoundation.lanHost.stopAuthorityTransferRoute(PROJECT_ID, 'terminal-source', exact.transferId);
      await new ProductionLanToCloudSourceEffects({
        cloudSession: null, foundation: sourceFoundation, persistence: sourceFoundation.authorityTransfers,
        convergence: {} as AuthorityTransferLocalConvergence, projectId: PROJECT_ID,
      }).restoreRetained(exact);
      await expect(client.requestWithMember('getProjectAuthorityTransfer', terminalRequest, peerCredential))
        .resolves.toEqual(completed);
      await expect(sourceFoundation.authorityTransfers.loadCloudToLanTargetEntry(PROJECT_ID)).resolves.toEqual(nextTarget);
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

  it.each(['none', 'before-ack-write', 'after-ack-write', 'after-send-journal', 'lost-response'] as const)(
    'recovers LAN cancellation after %s', async fault => {
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
      await initialFoundation.authorityTransfers.markLanToCloudBeginPossiblySent(record);
      await initialFoundation.authorityTransfers.prepareLanToCloudCancellation(cancellation);
      await initialFoundation.authorityTransfers.markLanToCloudCancellationPossiblySent(cancellation);
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
        let acknowledgedRequest: unknown;
        let interrupted = false;
        const entries = reopenedFoundation.local.projects.authorityTransferEntries;
        const saveSource = entries.saveSource.bind(entries);
        const persistence = new AuthorityTransferPersistence({
          ...reopenedFoundation.local.projects,
          authorityTransferEntries: {
            ...entries,
            saveSource: async value => {
              const preparing = value.cancellation?.expectedPhase === 'target-cleaned'
                && value.cancellation.submission === 'not-sent';
              const marking = value.cancellation?.expectedPhase === 'target-cleaned'
                && value.cancellation.submission === 'possibly-sent';
              if (!interrupted && preparing && fault === 'before-ack-write') {
                interrupted = true;
                throw new Error(fault);
              }
              await saveSource(value);
              if (!interrupted && ((preparing && fault === 'after-ack-write')
                || (marking && fault === 'after-send-journal'))) {
                interrupted = true;
                throw new Error(fault);
              }
            },
          },
        }, { isRecoveryOwner: key => key === TEST_INSTALLATION_A });
        const cloud: Pick<CollabAuthorityLifecyclePort, 'authorityTransfer'> = {
          authorityTransfer: (async (operation: string, request: { expectedPhase: string }) => {
            if (operation !== 'cancelProjectAuthorityTransfer') throw new Error('Unexpected Cloud operation');
            if (request.expectedPhase !== 'target-cleaned') {
              return { ...transferStatus, phase: 'target-cleaned', updatedAt: '2026-08-28T00:01:00.000Z' };
            }
            expect(reopenedFoundation.lanHost.isProjectRunning(PROJECT_ID)).toBe(true);
            const saved = await reopenedFoundation.authorityTransfers.loadSourceEntry(PROJECT_ID);
            expect(saved?.cancellation).toMatchObject({ ...request, submission: 'possibly-sent' });
            expect(request).toEqual(acknowledgedRequest ?? request);
            acknowledgedRequest = request;
            if (fault === 'lost-response' && !interrupted) {
              interrupted = true;
              throw new Error(fault);
            }
            return { ...transferStatus, phase: 'cancelled', state: 'cancelled', updatedAt: '2026-08-28T00:02:00.000Z' };
          }) as CollabAuthorityLifecyclePort['authorityTransfer'],
        };
        const createCoordinator = () => new LanToCloudSourceCoordinator({
          cloud: cloud as CollabAuthorityLifecyclePort,
          installationKey: TEST_INSTALLATION_A,
          persistence,
          source: new ProductionLanToCloudSourceEffects({
            cloudSession: null,
            convergence: new AuthorityTransferLocalConvergence({
              projects: reopenedFoundation.local.projects,
              workspace: reopenedFoundation.local.workspace,
              activity: { transitionProject: (_projectId, operation) => operation() },
              authorityProjectionTransitions: {
                run: (projectId, operation) => reopenedFoundation.runAuthorityProjectionTransition(projectId, operation),
              },
              git: {
                rotate: async input => rotateAuthorityTransferOrigin(
                  (await reopenedFoundation.requireGitFoundation()).repositories,
                  input,
                ),
              },
            }),
            foundation: reopenedFoundation,
            persistence,
            projectId: PROJECT_ID,
          }),
        });
        const firstResult = await createCoordinator().resume(PROJECT_ID).then(
          value => ({ phase: value.phase }),
          error => ({ error: (error as Error).message }),
        );
        expect(firstResult).toEqual(fault === 'none'
          ? { phase: 'cancelled' }
          : { error: fault });
        await expect(createCoordinator().resume(PROJECT_ID))
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
    },
  );

  it('cleans a cancelled Cloud-to-LAN target after restart without reconnecting Cloud', async () => {
    const initialFoundation = foundation(sourceRoot);
    const initialComposition = createCollabFeatureSubcomposition({
      foundation: initialFoundation,
      projectSetup: new CollabProjectSetupService(initialFoundation, {
        installationKey: TEST_INSTALLATION_A,
        createCredential: () => HOST_CREDENTIAL,
        createId: kind => {
          if (kind === 'member') return MEMBER_ID;
          if (kind === 'operation') return 'create-cancelled-target-effects';
          return PROJECT_ID;
        },
        now: () => new Date('2026-08-08T00:00:00.000Z'),
        vaultRoot: sourceRoot,
      }),
      vaultRoot: sourceRoot,
    });
    await initialComposition.feature.initialize();
    await initialComposition.feature.createProject({
      memberDisplayName: 'Alice',
      name: 'Portable',
    });
    const membership = await initialFoundation.local.projects.loadMembership(PROJECT_ID);
    if (!membership || membership.authority.kind !== 'lan') {
      throw new Error('Missing initial LAN membership');
    }
    await initialComposition.feature.close();
    await initialFoundation.close();

    const seededFoundation = foundation(targetRoot);
    await seededFoundation.local.workspace.claimProjectsFolder('workspace');
    await mkdir(path.join(targetRoot, 'workspace', 'portable'), {
      mode: 0o700,
      recursive: true,
    });
    const cloudServerUrl = 'https://cloud.example.test/';
    await seededFoundation.local.projects.saveMembership({
      authority: {
        authorityGeneration: 2,
        bindingVersion: COLLAB_CLOUD_BINDING_VERSION,
        gitRemoteUrl: cloudProjectGitRemoteUrl(cloudServerUrl, PROJECT_ID),
        kind: 'cloud',
        serverUrl: cloudServerUrl,
        wireVersion: COLLAB_PROTOCOL_VERSION,
      },
      createdAt: membership.createdAt,
      lastEventSequence: 0,
      member: {
        displayName: membership.member.displayName,
        id: membership.member.id,
        personalRef: membership.member.personalRef,
        role: membership.member.role,
      },
      project: membership.project,
      schemaVersion: membership.schemaVersion,
      updatedAt: membership.updatedAt,
    });
    const cancelledRecord = createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      lifecycleOwnership: 'owned',
      localRole: 'target',
      operationIntentId: OPERATION_ID,
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: {
        ...status('cloud-to-lan', 'cancelled', 'https://127.0.0.1:54545'),
        state: 'cancelled',
      },
    });
    await seededFoundation.local.projects.authorityTransferRecords.save(cancelledRecord);
    const staging = await seededFoundation.local.workspace.reserveProjectsFolderChild(
      'workspace',
      {
        childName: cancelledRecord.stagingDirectoryName,
        operationId: cancelledRecord.transferId,
        projectId: cancelledRecord.projectId,
        purpose: 'authority-transfer-staging',
      },
    );
    await mkdir(staging.absolutePath, { mode: 0o700 });
    await seededFoundation.close();

    const connect = jest.fn(async () => {
      throw new Error('cancelled target recovery must not reconnect Cloud');
    });
    const create = jest.fn(async () => {
      throw new Error('cancelled target recovery must not create a Cloud session');
    });
    const reopenedFoundation = foundation(targetRoot);
    const reopenedComposition = createCollabFeatureSubcomposition({
      cloudAuthority: {
        authorityKind: 'cloud',
        connect,
        create,
        connectPendingLeave: async () => {
          throw new Error('This recovery must not open a Cloud Leave connection');
        },
        connectPendingRetirement: async () => {
          throw new Error('This recovery must not open a Cloud Retirement connection');
        },
        connectAuthorityTransfer: async () => {
          throw new Error('Cancelled target recovery must not connect Cloud authority transfer');
        },
      },
      foundation: reopenedFoundation,
      projectSetup: new CollabProjectSetupService(reopenedFoundation, {
        installationKey: TEST_INSTALLATION_A,
        vaultRoot: targetRoot,
      }),
      vaultRoot: targetRoot,
    });
    try {
      await reopenedComposition.feature.initialize();
      await reopenedComposition.feature.restoreLifecycle();
      expect(connect).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
      await expect(access(staging.absolutePath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(reopenedFoundation.authorityTransfers.load(PROJECT_ID)).resolves.toMatchObject({
        status: { phase: 'cancelled', state: 'cancelled' },
        terminalCleanupCompleted: true,
      });
    } finally {
      await reopenedComposition.feature.close();
      await reopenedFoundation.close();
    }
  });

  async function captureSource(includePeer = true) {
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
    if (includePeer) {
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
    }
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
      principalId: 'vault-source-credential',
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
    const sourceProofEnvelope = JSON.parse(Buffer.from(
      captured.sourceProof,
      'base64url',
    ).toString('utf8')) as {
      readonly caCertificatePem: string;
      readonly certificate: string;
      readonly payload: { readonly sourcePrincipalId: string };
      readonly receiptKeyId: string;
      readonly receiptPublicKey: string;
      readonly schemaVersion: number;
    };
    expect(sourceProofEnvelope).toMatchObject({
      payload: { sourcePrincipalId: 'vault-source-credential' },
      schemaVersion: 2,
    });
    const { caCertificatePem, certificate, ...sourceProofSigningPayload } = sourceProofEnvelope;
    expect(verify(
      'sha256',
      Buffer.from(JSON.stringify(sourceProofSigningPayload), 'utf8'),
      {
        key: caCertificatePem,
        padding: constants.RSA_PKCS1_PSS_PADDING,
        saltLength: 32,
      },
      Buffer.from(certificate, 'base64url'),
    )).toBe(true);
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

  it('replaces an obsolete pre-begin source proof but preserves possibly-sent replay bytes', async () => {
    const {
      sourceEffects,
      sourceFeature,
      sourceFoundation,
      sourceRecord,
      sourceStaging,
    } = await captureSource();
    const sourceProofPath = path.join(sourceStaging.absolutePath, 'source-proof.json');
    const obsoleteProof = Buffer.from(JSON.stringify({
      caCertificatePem: 'legacy',
      certificate: Buffer.alloc(64, 1).toString('base64url'),
      payload: { projectId: PROJECT_ID },
      receiptKeyId: 'legacy-receipt-key',
      receiptPublicKey: Buffer.alloc(32, 1).toString('base64url'),
      schemaVersion: 1,
    }), 'utf8').toString('base64url');
    try {
      const durableSourceRecord = createAuthorityTransferRecord({
        ownerInstallationKey: TEST_INSTALLATION_A,
        lifecycleOwnership: 'owned',
        localRole: 'source',
        operationIntentId: OPERATION_ID,
        sourceLanEndpoint: 'https://127.0.0.1:54545',
        stagingDirectoryName: sourceRecord.stagingDirectoryName,
        status: sourceRecord.status,
      });
      const sourceEntry = createAuthorityTransferEntryRecord({
        ownerInstallationKey: TEST_INSTALLATION_A,
        proposedByMemberId: MEMBER_ID,
        request: {
          expectedAuthorityGeneration: 1,
          idempotencyKey: OPERATION_ID,
          projectId: PROJECT_ID,
          targetUrl: sourceRecord.status.targetUrl,
        },
        status: sourceRecord.status,
      });
      await sourceFoundation.authorityTransfers.proposeEntry(sourceEntry);
      await sourceFoundation.authorityTransfers.handoffEntry(sourceEntry, durableSourceRecord);
      await writeFile(
        sourceProofPath,
        `${JSON.stringify({ proof: obsoleteProof })}\n`,
        { mode: 0o600 },
      );
      const recovered = await sourceEffects.capture(durableSourceRecord);
      recovered.artifacts.forEach(artifact => artifact.body.destroy());
      expect(JSON.parse(Buffer.from(recovered.sourceProof, 'base64url').toString('utf8')))
        .toMatchObject({ schemaVersion: 2 });
      const currentProofBytes = await readFile(sourceProofPath);

      await sourceFoundation.authorityTransfers.markLanToCloudBeginPossiblySent(
        durableSourceRecord,
      );
      const possiblySentBytes = `${JSON.stringify({ proof: obsoleteProof })}\n`;
      await writeFile(sourceProofPath, possiblySentBytes, { mode: 0o600 });
      await expect(sourceEffects.capture(durableSourceRecord)).rejects.toMatchObject({
        code: 'durable-progress-recovery-required',
        safeContext: { reason: 'authority-transfer-source-proof-replay-invalid' },
      });
      expect(await readFile(sourceProofPath, 'utf8')).toBe(possiblySentBytes);

      await rm(sourceProofPath);
      await expect(sourceEffects.capture(durableSourceRecord)).rejects.toMatchObject({
        code: 'durable-progress-recovery-required',
        safeContext: { reason: 'authority-transfer-source-proof-replay-invalid' },
      });
      await expect(access(sourceProofPath)).rejects.toMatchObject({ code: 'ENOENT' });

      await writeFile(sourceProofPath, currentProofBytes, { mode: 0o600 });
      const coordinationPath = path.join(sourceStaging.absolutePath, 'coordination.ndjson');
      const damagedCoordinationBytes = Buffer.concat([
        await readFile(coordinationPath),
        Buffer.from('\n{"damaged":true}\n', 'utf8'),
      ]);
      await writeFile(coordinationPath, damagedCoordinationBytes, { mode: 0o600 });
      await expect(sourceEffects.capture(durableSourceRecord)).rejects.toMatchObject({
        code: 'durable-progress-recovery-required',
        safeContext: { reason: 'authority-transfer-source-proof-replay-invalid' },
      });
      expect(await readFile(sourceProofPath)).toEqual(currentProofBytes);
      expect(await readFile(coordinationPath)).toEqual(damagedCoordinationBytes);

      const possiblySentSourceEntry = await sourceFoundation.authorityTransfers.loadSourceEntry(
        PROJECT_ID,
      );
      if (!possiblySentSourceEntry) throw new Error('Missing possibly-sent source entry');
      expect(
        await sourceFoundation.local.projects.authorityTransferEntries.removeSource(
          possiblySentSourceEntry,
        ),
      ).toBe(true);
      await expect(sourceEffects.capture(durableSourceRecord)).rejects.toMatchObject({
        code: 'durable-progress-recovery-required',
        safeContext: { reason: 'authority-transfer-source-proof-replay-invalid' },
      });
      expect(await readFile(sourceProofPath)).toEqual(currentProofBytes);
      expect(await readFile(coordinationPath)).toEqual(damagedCoordinationBytes);
    } finally {
      await sourceFeature.close();
      await sourceFoundation.close();
    }
  });

  async function prepareCloudToLanTarget(moveAddress = false) {
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

    const environment = {
      addresses: moveAddress ? ['127.0.0.1'] : listPrivateIpv4Addresses(),
      beforeConvergence: null as (() => Promise<void>) | null,
      now: new Date('2026-08-28T00:03:00.000Z'),
    };
    let checkTargetAddress: () => Promise<void> = async () => undefined;
    const createTargetFoundation = () => foundation(targetRoot, TEST_INSTALLATION_A, {
      createAddressMonitor: check => { checkTargetAddress = check; return { close: () => undefined }; },
      getPrivateIpv4Addresses: () => environment.addresses,
    });
    let targetFoundation = createTargetFoundation();
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
        displayName: 'Bob',
        id: 'member-production-peer',
        personalRef: 'refs/heads/members/member-production-peer',
        role: 'member',
      },
      project: sourceMembership.project,
      schemaVersion: sourceMembership.schemaVersion,
      updatedAt: sourceMembership.updatedAt,
    });
    const cloudSession = {
      dispose: jest.fn(),
      projectId: PROJECT_ID,
      readSnapshot: jest.fn(async () => {
        throw new Error('post-begin ordinary Cloud snapshot must stay closed');
      }),
      serverUrl: cloudServerUrl,
    } as unknown as CloudAuthorityConnection;
    const initialGitFoundation = await targetFoundation.requireGitFoundation();
    await initialGitFoundation.repositories.configureLocalRepository(
      path.join(targetRoot, 'workspace', 'portable'),
      {
        memberId: 'member-production-peer',
        personalRef: 'refs/heads/members/member-production-peer',
        projectId: PROJECT_ID,
        userDisplayName: 'Bob',
      },
    );
    const createRecoveryConvergence = async () => {
      const gitFoundation = await targetFoundation.requireGitFoundation();
      return new AuthorityTransferLocalConvergence({
        activity: { transitionProject: async (_projectId, operation) => {
          await environment.beforeConvergence?.();
          await operation();
        } },
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
    };
    const convergence = await createRecoveryConvergence();
    let recoveryConvergence = convergence;
    const activeRouteTransition = jest.spyOn(
      targetFoundation.lanHost,
      'transitionAuthorityTransferRoute',
    );
    const targetEffects = new ProductionCloudToLanTargetEffects({
      cloudSession,
      convergence,
      foundation: targetFoundation,
      now: () => environment.now,
      persistence: targetFoundation.authorityTransfers,
      projectId: PROJECT_ID,
    });
    const prepared = await targetEffects.prepareTarget();
    if (moveAddress) {
      environment.addresses = listPrivateIpv4Addresses();
      if (environment.addresses.length === 0) throw new Error('A private address is required for transfer recovery');
      await checkTargetAddress();
    }
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
    expect(acceptance.targetHostMemberId).toBe('member-production-peer');
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
    const stageArtifacts = () => [
      'checkpoint.json',
      'coordination.ndjson',
      'repository.bundle',
    ].map((artifact) => {
      const typed = artifact as CollabCloudAuthorityTransferArtifact;
      const bytes = artifactBytes.get(typed);
      if (!bytes) throw new Error(`Missing ${artifact}`);
      return { artifact: typed, body: Readable.from([bytes]), byteCount: bytes.byteLength };
    });
    return {
      createRecoveryConvergence,
      prepared,
      activeRouteTransition,
      checkAddress: () => checkTargetAddress(),
      cloudSession,
      environment,
      get foundation() { return targetFoundation; },
      recoveringEffects: () => new ProductionCloudToLanTargetEffects({
        cloudSession: null,
        convergence: recoveryConvergence,
        foundation: targetFoundation,
        now: () => environment.now,
        persistence: targetFoundation.authorityTransfers,
        projectId: PROJECT_ID,
      }),
      restart: async () => {
        await targetFoundation.close();
        targetFoundation = createTargetFoundation();
        recoveryConvergence = await createRecoveryConvergence();
      },
      requireAuthority: async () => {
        const authority = await targetFoundation.inspectAuthority(PROJECT_ID);
        if (!authority) throw new Error('Missing imported target authority');
        return authority;
      },
      sourceFeature,
      sourceFoundation,
      stageArtifacts,
      stagedRecord,
      targetEffects,
      targetManifest,
      targetStaging,
    };
  }

  async function stageCloudToLanTarget(preparedTarget?: Awaited<ReturnType<typeof prepareCloudToLanTarget>>) {
    const target = preparedTarget ?? await prepareCloudToLanTarget();
    const {
      foundation: targetFoundation, prepared, stageArtifacts, stagedRecord,
      targetEffects, targetManifest,
    } = target;
    const staged = await targetEffects.stage(stagedRecord, stageArtifacts());

    expect(staged.checkpointSha256).toBe(targetManifest.manifestSha256);
    expect(staged.claimBatch.claims).toEqual([
      expect.objectContaining({ memberId: MEMBER_ID }),
    ]);
    await targetFoundation.local.projects.authorityTransferRecords.save(stagedRecord);
    const targetStageOperationIntentId = authorityTransferChildIdempotencyKey(
      OPERATION_ID,
      'stage',
    );
    const retainedTargetClaims = await targetFoundation.authorityTransfers.retainClaimBatch({
      batch: staged.claimBatch,
      operationIntentId: targetStageOperationIntentId,
      purpose: 'target-delivery',
    });
    await targetFoundation.authorityTransfers.acknowledgeClaimBatch({
      batchRevision: staged.claimBatch.batchRevision,
      batchSha256: staged.claimBatch.batchSha256,
      checkpointSha256: staged.claimBatch.checkpointSha256,
      committedAt: retainedTargetClaims.createdAt,
      custodyAuthority: { generation: 2, kind: 'cloud' },
      operationIntentId: targetStageOperationIntentId,
      projectId: PROJECT_ID,
      receiptId: 'custody-receipt-production-target',
      submittedByMemberId: 'member-production-peer',
      targetAuthorityGeneration: 3,
      transferId: TRANSFER_ID,
    });
    const targetAuthority = await targetFoundation.inspectAuthority(PROJECT_ID);
    expect(targetAuthority).toBeNull();
    await expect(access(path.join(
      targetRoot,
      '.claudian',
      'collab',
      'authorities',
      PROJECT_ID,
      '.claudian-authority.json',
    ))).rejects.toMatchObject({ code: 'ENOENT' });
    const relinquishmentProof = signCloudRelinquishmentProof({
      batchRevision: staged.claimBatch.batchRevision,
      batchSha256: staged.claimBatch.batchSha256,
      certificateAlgorithm: 'ed25519' as const,
      checkpointSha256: staged.checkpointSha256,
      committedAt: '2026-08-28T00:02:00.000Z',
      operationIntentId: 'intent-cloud-relinquishment',
      projectId: PROJECT_ID,
      sourceAuthority: { generation: 2, kind: 'cloud' as const },
      sourceHostMemberId: null,
      targetAuthority: { generation: 3, kind: 'lan' as const },
      transferId: TRANSFER_ID,
    });
    const completedStatus: CollabAuthorityTransferStatus = {
      ...status(
        'cloud-to-lan',
        'completed',
        stagedRecord.status.targetUrl,
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
      receiptVerifier: cloudReceiptVerifier(),
      stagingDirectoryName: stagedRecord.stagingDirectoryName,
      status: completedStatus,
    });
    await targetFoundation.local.projects.authorityTransferRecords.save(completedRecord);
    const targetEntry = publishCloudToLanTargetEntry(createCloudToLanTargetEntry({
      createdAt: '2026-08-28T00:00:00.000Z',
      expiresAt: completedStatus.expiresAt,
      operationIntentId: 'intent-production-target-preparation',
      ownerInstallationKey: TEST_INSTALLATION_A,
      projectId: PROJECT_ID,
      selectedTargetMemberId: 'member-production-peer',
      selectedTargetPersonalRef: 'refs/heads/members/member-production-peer',
      sourceAuthorityGeneration: 2,
      sourceCloudUrl: 'https://cloud.example.test/',
    }), {
      caCertificatePem: prepared.caCertificatePem,
      caFingerprint: prepared.caFingerprint,
      publishedAt: '2026-08-28T00:00:30.000Z',
      targetUrl: stagedRecord.status.targetUrl,
    });
    await targetFoundation.local.projects.authorityTransferEntries.saveTarget(
      handoffCloudToLanTargetEntry(targetEntry, completedRecord),
    );
    return Object.assign(target, {
      completedRecord, relinquishmentProof, staged, targetEntry,
      targetStatePath: path.join(target.targetStaging.absolutePath, 'target-private.json'),
    });
  }

  async function activateCloudToLanTarget(stagedTarget?: Awaited<ReturnType<typeof stageCloudToLanTarget>>) {
    const target = stagedTarget ?? await stageCloudToLanTarget();
    await target.targetEffects.activate(target.completedRecord, target.relinquishmentProof);
    const targetAuthority = await target.requireAuthority();
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
    return Object.assign(target, { targetAuthority });
  }

  async function restoreStoppedCloudToLanTarget(moveAddress = false) {
    const target = await activateCloudToLanTarget(
      await stageCloudToLanTarget(await prepareCloudToLanTarget(moveAddress)),
    );
    await target.recoveringEffects().restoreCompleted(target.completedRecord);
    await target.foundation.lanHost.stopProject(PROJECT_ID);
    const exactTargetState = await readFile(target.targetStatePath, 'utf8');
    if (moveAddress) target.environment.addresses = ['127.0.0.1'];
    await target.restart();
    const preRecoveryMembership = await target.foundation.local.projects.loadMembership(PROJECT_ID);
    if (!preRecoveryMembership || preRecoveryMembership.authority.kind !== 'lan') {
      throw new Error('Missing pre-recovery target membership');
    }
    await expect(target.foundation.lanHost.hostCaSigner()).resolves.toMatchObject({
      caCertificatePem: preRecoveryMembership.authority.hostCaCertificatePem,
      caFingerprint: preRecoveryMembership.authority.hostCaFingerprint,
    });
    await expect(readFile(target.targetStatePath, 'utf8')).resolves.toBe(exactTargetState);
    const recoveredRouteStart = jest.spyOn(
      target.foundation.lanHost,
      'startAuthorityTransferRoute',
    );
    const restartedComposition = createCollabFeatureSubcomposition({
      foundation: target.foundation,
      projectSetup: new CollabProjectSetupService(target.foundation, {
        installationKey: TEST_INSTALLATION_A,
        vaultRoot: targetRoot,
      }),
      vaultRoot: targetRoot,
    });
    await restartedComposition.feature.initialize();
    await expect(restartedComposition.feature.restoreLifecycle()).resolves.toBeUndefined();
    target.targetAuthority = await target.requireAuthority();
    const recoveredRegistration = recoveredRouteStart.mock.calls.find(
      ([registration]) => registration.state === 'target-active',
    )?.[0];
    if (recoveredRegistration?.state !== 'target-active') {
      throw new Error('Missing recovered Cloud-to-LAN target route');
    }

    expect(target.foundation.lanHost.isProjectRunning(PROJECT_ID)).toBe(false);
    await expect(target.foundation.local.projects.loadMembership(PROJECT_ID))
      .resolves.toMatchObject({
        hostOwnership: { autoStart: false, ownsAuthority: true },
      });
    const claimantCredential = Buffer.alloc(32, 9).toString('base64url');
    const claim = target.staged.claimBatch.claims[0];
    if (!claim) throw new Error('Missing transferred Member claim');
    const recoveredRoute = await target.foundation.lanHost.startAuthorityTransferRoute(recoveredRegistration);
    if (moveAddress) {
      expect(new URL(recoveredRoute.endpoint).hostname).toBe('127.0.0.1');
      expect(recoveredRoute.endpoint).not.toBe(preRecoveryMembership.authority.endpoint);
    }
    const claimClient = new LanAuthorityTransferClient({
      authorityGeneration: 3,
      caCertificatePem: preRecoveryMembership.authority.hostCaCertificatePem!,
      caFingerprint: preRecoveryMembership.authority.hostCaFingerprint!,
      endpoint: preRecoveryMembership.authority.endpoint!,
      projectId: PROJECT_ID,
    }, {
      discovery: { discoverProjectCandidates: async () => [recoveredRoute] },
    });
    const claimRequest = {
      claim: claim.claim,
      credentialHash: createHash('sha256')
        .update(claimantCredential, 'utf8')
        .digest('hex'),
      idempotencyKey: 'claim-production-manager',
      projectId: PROJECT_ID,
      transferId: TRANSFER_ID,
    };
    const firstReceipt = await claimClient.claimTransferredMembership(claimRequest);
    const replayedReceipt = await claimClient.claimTransferredMembership(claimRequest);
    expect(replayedReceipt).toEqual(firstReceipt);
    expect(firstReceipt.memberId).toBe(MEMBER_ID);
    expect(await target.targetAuthority?.database.read(connection => connection.get(`
      SELECT access_state, credential_hash
      FROM members
      WHERE member_id = '${MEMBER_ID}'
    `))).toEqual({
      access_state: 'bound',
      credential_hash: createHash('sha256')
        .update(claimantCredential, 'utf8')
        .digest(),
    });
    return Object.assign(target, {
      claimClient, claimRequest, firstReceipt, recoveredRegistration, restartedComposition,
    });
  }

  it.each([false, true])('activates Cloud-to-LAN and recovers its route (address movement: %s)', async (moveAddress) => {
    const target = await activateCloudToLanTarget(
      await stageCloudToLanTarget(await prepareCloudToLanTarget(moveAddress)),
    );
    await target.recoveringEffects().restoreCompleted(target.completedRecord);
    expect(target.foundation.lanHost.isProjectRunning(PROJECT_ID)).toBe(true);
    const repeatedRecoveryStart = jest.spyOn(
      target.foundation.lanHost,
      'startProjectAfterCloudToLanTargetRecovery',
    );
    if (moveAddress) {
      target.environment.beforeConvergence = async () => {
        target.environment.beforeConvergence = null;
        target.environment.addresses = ['127.0.0.1'];
        await target.checkAddress();
      };
    }
    await expect(target.recoveringEffects().restoreCompleted(target.completedRecord)).resolves.toBeUndefined();
    const activeTargetEndpoint = target.foundation.lanHost.getActiveProjectRoute(PROJECT_ID)?.endpoint;
    expect(activeTargetEndpoint).toBeDefined();
    await expect(target.foundation.local.projects.loadMembership(PROJECT_ID)).resolves.toMatchObject({
      authority: { endpoint: activeTargetEndpoint },
    });
    expect(git(path.join(targetRoot, 'workspace', 'portable'), ['remote', 'get-url', 'origin']).trim())
      .toBe(`${activeTargetEndpoint}/v1/git/${PROJECT_ID}/repository.git`);
    expect(repeatedRecoveryStart).not.toHaveBeenCalled();
    await expect(target.foundation.local.projects.loadMembership(PROJECT_ID)).resolves.toMatchObject({
      authority: { kind: 'lan' },
      hostOwnership: { autoStart: true, ownsAuthority: true },
      member: { id: 'member-production-peer', role: 'member' },
    });
    expect(await target.targetAuthority?.database.read(connection => connection.get(
      'SELECT state FROM project WHERE singleton = 1',
    ))).toEqual({ state: 'active' });
    const targetMembership = await target.foundation.local.projects.loadMembership(PROJECT_ID);
    if (!targetMembership || targetMembership.authority.kind !== 'lan') {
      throw new Error('Missing activated target membership');
    }
    expect(await target.targetAuthority?.database.read(connection => connection.get(
      'SELECT credential_hash FROM members WHERE member_id = ?',
      [targetMembership.member.id],
    ))).toEqual({
      credential_hash: createHash('sha256')
        .update((targetMembership as CollabLocalLanMembershipRecord).member.credential, 'utf8')
        .digest(),
    });

    if (moveAddress) target.environment.addresses = ['127.0.0.1'];
    await target.restart();
    const autoStartRecoveryRoute = jest.spyOn(
      target.foundation.lanHost,
      'startAuthorityTransferRoute',
    );
    const autoStartRecoveryComposition = createCollabFeatureSubcomposition({
      foundation: target.foundation,
      projectSetup: new CollabProjectSetupService(target.foundation, {
        installationKey: TEST_INSTALLATION_A,
        vaultRoot: targetRoot,
      }),
      vaultRoot: targetRoot,
    });
    await autoStartRecoveryComposition.feature.initialize();
    await expect(autoStartRecoveryComposition.feature.restoreLifecycle())
      .resolves.toBeUndefined();
    expect(target.foundation.lanHost.isProjectRunning(PROJECT_ID)).toBe(true);
    expect(autoStartRecoveryRoute.mock.calls.some(
      ([registration]) => registration.state === 'target-active',
    )).toBe(true);
    target.targetAuthority = await target.requireAuthority();
    await target.foundation.lanHost.stopProject(PROJECT_ID);
    await expect(target.foundation.local.projects.loadMembership(PROJECT_ID))
      .resolves.toMatchObject({
        authority: { kind: 'lan' },
        hostOwnership: { autoStart: false, ownsAuthority: true },
      });

  });

  it('rejects changed target ownership and imported identity before staging', async () => {
    const target = await prepareCloudToLanTarget();
    const exactPreparedMembership = await target.foundation.local.projects.loadMembership(
      PROJECT_ID,
    );
    if (!exactPreparedMembership || !isCollabLocalCloudMembership(exactPreparedMembership)) {
      throw new Error('Missing prepared target Cloud membership');
    }
    const preparedStatePath = path.join(target.targetStaging.absolutePath, 'target-private.json');
    const exactPreparedState = await readFile(preparedStatePath, 'utf8');
    const mismatchedPreparedState = JSON.parse(exactPreparedState) as {
      receiptKey: { privateKey: string };
    };
    mismatchedPreparedState.receiptKey.privateKey = generateKeyPairSync('ed25519').privateKey
      .export({ format: 'der', type: 'pkcs8' })
      .toString('base64url');
    await writeFile(
      preparedStatePath,
      `${JSON.stringify(mismatchedPreparedState)}\n`,
      { mode: 0o600 },
    );
    await expect(target.targetEffects.stage(target.stagedRecord, target.stageArtifacts())).rejects.toMatchObject({
      safeContext: { reason: 'authority-transfer-target-state-owner-mismatch' },
    });
    await expect(target.foundation.inspectAuthority(PROJECT_ID)).resolves.toBeNull();
    await writeFile(preparedStatePath, exactPreparedState, { mode: 0o600 });
    await target.foundation.local.projects.saveMembership({
      ...exactPreparedMembership,
      member: {
        ...exactPreparedMembership.member,
        id: 'member-mutated-after-acceptance',
        personalRef: 'refs/heads/members/member-mutated-after-acceptance',
      },
    });
    await expect(target.targetEffects.stage(target.stagedRecord, target.stageArtifacts())).rejects.toMatchObject({
      safeContext: { reason: 'authority-transfer-target-imported-identity-mismatch' },
    });
    await target.foundation.local.projects.saveMembership(exactPreparedMembership);
  });

  it('replaces only the retired predecessor and recovers interrupted removal', async () => {
    const target = await prepareCloudToLanTarget();
    // Returning to the former Host must replace its retired generation-1 authority.
    const retiredSource = await target.foundation.createAuthority(PROJECT_ID);
    await retiredSource.database.mutate(connection => retiredSource.projects.initialize(connection, {
      createdAt: '2026-08-08T00:00:00.000Z',
      hostCredentialHash: createHash('sha256').update(HOST_CREDENTIAL).digest(),
      hostDisplayName: 'Former Host',
      hostMemberId: MEMBER_ID,
      name: 'Portable',
      projectId: PROJECT_ID,
    }));
    git(retiredSource.authorityDirectory, ['init', '--bare', 'repository.git']);
    await target.foundation.local.projects.authorityTransferRecords.save(target.stagedRecord);
    for (const generation of [2, 3]) {
      await retiredSource.database.mutate(connection => new AuthorityMetadataRepository().installGeneration(connection, generation));
      await expect(target.targetEffects.stage(target.stagedRecord, target.stageArtifacts())).rejects.toMatchObject({
        safeContext: { reason: 'authority-transfer-former-source-not-replaceable' },
      });
      expect(await retiredSource.database.read(connection => retiredSource.projects.get(connection)?.authorityGeneration))
        .toBe(generation);
    }
    await retiredSource.database.mutate(connection => new AuthorityMetadataRepository().installGeneration(connection, 1));
    const removeOwned = target.foundation.hostInstallations.removeOwned.bind(target.foundation.hostInstallations);
    jest.spyOn(target.foundation.hostInstallations, 'removeOwned').mockImplementationOnce(async projectId => {
      await removeOwned(projectId);
      throw new Error('interrupted after retired authority removal');
    });
    await expect(target.targetEffects.stage(target.stagedRecord, target.stageArtifacts()))
      .rejects.toThrow('interrupted after retired authority removal');
    await stageCloudToLanTarget(target);
  });

  it('rejects corrupted target claims, credentials, and proofs before activation', async () => {
    const target = await stageCloudToLanTarget();
    const stagedTargetStatePath = path.join(target.targetStaging.absolutePath, 'target-private.json');
    const exactStagedTargetState = await readFile(stagedTargetStatePath, 'utf8');
    const invalidClaimState = JSON.parse(exactStagedTargetState) as {
      claimBatch: { claims: Array<{ claim: string }> };
    };
    if (!invalidClaimState.claimBatch.claims[0]) {
      throw new Error('Missing staged imported claim');
    }
    invalidClaimState.claimBatch.claims[0].claim = Buffer.alloc(32, 8).toString('base64url');
    await writeFile(stagedTargetStatePath, `${JSON.stringify(invalidClaimState)}\n`);
    await expect(target.targetEffects.activate(target.completedRecord, target.relinquishmentProof)).rejects.toMatchObject({
      safeContext: { reason: 'authority-transfer-target-state-owner-mismatch' },
    });
    await expect(access(path.join(
      targetRoot,
      '.claudian',
      'collab',
      'authorities',
      PROJECT_ID,
      '.claudian-authority.json',
    ))).rejects.toMatchObject({ code: 'ENOENT' });
    const invalidCredentialState = JSON.parse(exactStagedTargetState) as {
      hostCredential: string;
    };
    invalidCredentialState.hostCredential = Buffer.alloc(32, 8).toString('base64url');
    await writeFile(stagedTargetStatePath, `${JSON.stringify(invalidCredentialState)}\n`);
    await expect(target.targetEffects.activate(target.completedRecord, target.relinquishmentProof)).rejects.toMatchObject({
      safeContext: { reason: 'authority-transfer-target-state-owner-mismatch' },
    });
    await expect(access(path.join(
      targetRoot,
      '.claudian',
      'collab',
      'authorities',
      PROJECT_ID,
      '.claudian-authority.json',
    ))).rejects.toMatchObject({ code: 'ENOENT' });
    const invalidStagedTargetState = JSON.parse(exactStagedTargetState) as {
      targetProof: string;
    };
    const invalidStagedTargetProof = JSON.parse(
      Buffer.from(invalidStagedTargetState.targetProof, 'base64url').toString('utf8'),
    ) as { payload: { receiptKeyId: string } };
    invalidStagedTargetProof.payload.receiptKeyId = 'tampered-before-binding';
    invalidStagedTargetState.targetProof = Buffer.from(
      JSON.stringify(invalidStagedTargetProof),
      'utf8',
    ).toString('base64url');
    await writeFile(stagedTargetStatePath, `${JSON.stringify(invalidStagedTargetState)}\n`);
    await expect(target.targetEffects.activate(target.completedRecord, target.relinquishmentProof)).rejects.toMatchObject({
      safeContext: { reason: 'authority-transfer-target-proof-invalid' },
    });
    await expect(access(path.join(
      targetRoot,
      '.claudian',
      'collab',
      'authorities',
      PROJECT_ID,
      '.claudian-authority.json',
    ))).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(stagedTargetStatePath, exactStagedTargetState);
    const stagedCredential = (JSON.parse(exactStagedTargetState) as {
      hostCredential: string;
    }).hostCredential;
    const writeStagedCredential = async (credentialHash: Uint8Array) => {
      const authority = await target.foundation.openAuthorityTransferTarget(
        PROJECT_ID,
        TEST_INSTALLATION_A,
      );
      try {
        await authority.database.mutate(connection => connection.run(
          'UPDATE members SET credential_hash = ? WHERE member_id = ?',
          [credentialHash, 'member-production-peer'],
        ));
        // Preserve the imported directory shape while injecting credential corruption.
        await rm(path.join(authority.authorityDirectory, 'collab.db.bak'));
      } finally {
        await authority.database.close();
      }
    };
    await writeStagedCredential(createHash('sha256')
      .update(Buffer.from(stagedCredential, 'base64url'))
      .digest());
    await expect(target.targetEffects.activate(target.completedRecord, target.relinquishmentProof)).rejects.toMatchObject({
      safeContext: { reason: 'authority-transfer-target-state-owner-mismatch' },
    });
    await expect(target.foundation.inspectAuthority(PROJECT_ID)).resolves.toBeNull();
    await writeStagedCredential(createHash('sha256').update(stagedCredential, 'utf8').digest());
    await activateCloudToLanTarget(target);
  });

  it('retains target custody when expiry precedes local convergence', async () => {
    const target = await activateCloudToLanTarget();
    const exactTargetState = await readFile(target.targetStatePath, 'utf8');
    const activeRegistration = target.activeRouteTransition.mock.calls[0]?.[0].next;
    if (activeRegistration?.state !== 'target-active') {
      throw new Error('Missing active Cloud-to-LAN target route');
    }
    const expireClaims = jest.spyOn(
      target.foundation.authorityTransfers,
      'expireClaims',
    ).mockResolvedValueOnce();
    target.environment.now = new Date('2026-10-01T00:00:00.000Z');

    await expect(activeRegistration.service.expire())
      .rejects.toMatchObject({
        safeContext: { reason: 'authority-transfer-target-convergence-incomplete' },
      });
    await expect(readFile(target.targetStatePath, 'utf8')).resolves.toBe(exactTargetState);
    await expect(target.foundation.local.projects.loadMembership(PROJECT_ID))
      .resolves.toMatchObject({ authority: { kind: 'cloud' } });
    await expect(target.foundation.authorityTransfers.load(PROJECT_ID)).resolves.toMatchObject({
      status: { phase: 'completed', state: 'completed' },
      terminalCleanupCompleted: false,
    });
    expect(expireClaims).not.toHaveBeenCalled();
    expireClaims.mockRestore();
    target.environment.now = new Date('2026-08-28T00:03:00.000Z');
  });

  it('recovers interrupted convergence without publishing an inconsistent route', async () => {
    const target = await activateCloudToLanTarget();
    const exactTargetState = await readFile(target.targetStatePath, 'utf8');
    await target.foundation.lanHost.stopAuthorityTransferRoute(PROJECT_ID, 'target-active');
    const recoveryRouteMemberships: CollabLocalMembershipRecord[] = [];
    const originalStartAuthorityTransferRoute = target.foundation.lanHost
      .startAuthorityTransferRoute.bind(target.foundation.lanHost);
    const recoveryRouteStart = jest.spyOn(
      target.foundation.lanHost,
      'startAuthorityTransferRoute',
    ).mockImplementation(async registration => {
      const membership = await target.foundation.local.projects.loadMembership(PROJECT_ID);
      if (!membership) throw new Error('Missing target membership at route publication');
      recoveryRouteMemberships.push(membership);
      return originalStartAuthorityTransferRoute(registration);
    });

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
    await writeFile(target.targetStatePath, `${JSON.stringify(tamperedTargetState)}\n`);
    await expect(target.recoveringEffects().restoreCompleted(target.completedRecord)).rejects.toMatchObject({
      safeContext: { reason: 'authority-transfer-target-proof-invalid' },
    });
    await expect(target.foundation.local.projects.loadMembership(PROJECT_ID))
      .resolves.toMatchObject({ authority: { kind: 'cloud' } });
    await writeFile(target.targetStatePath, exactTargetState);

    const snapshotReadsBeforeRecovery = target.cloudSession.readSnapshot as jest.Mock;
    const snapshotReadCount = snapshotReadsBeforeRecovery.mock.calls.length;
    const repairIndex = jest.spyOn(
      target.foundation.local.projects,
      'repairIndexFromMemberships',
    );
    repairIndex.mockRejectedValueOnce(new Error('simulated post-membership crash'));

    await expect(target.recoveringEffects().restoreCompleted(target.completedRecord))
      .rejects.toThrow('simulated post-membership crash');
    expect(recoveryRouteStart).not.toHaveBeenCalled();
    const convertedMembership = await target.foundation.local.projects.loadMembership(PROJECT_ID);
    if (!convertedMembership || convertedMembership.authority.kind !== 'lan') {
      throw new Error('Missing converted target membership');
    }
    const exactConvertedMembership = convertedMembership as CollabLocalLanMembershipRecord;
    await target.targetAuthority.database.mutate(connection => {
      connection.run(
        "UPDATE members SET role = 'manager' WHERE member_id = ?",
        [exactConvertedMembership.member.id],
      );
    });
    await expect(target.recoveringEffects().restoreCompleted(target.completedRecord)).rejects.toMatchObject({
      safeContext: { reason: 'authority-transfer-target-convergence-incomplete' },
    });
    expect(recoveryRouteStart).not.toHaveBeenCalled();
    expect(target.foundation.lanHost.isProjectRunning(PROJECT_ID)).toBe(false);
    await target.targetAuthority.database.mutate(connection => {
      connection.run(
        "UPDATE members SET role = 'member' WHERE member_id = ?",
        [exactConvertedMembership.member.id],
      );
    });
    await target.foundation.local.projects.saveMembership({
      ...exactConvertedMembership,
      authority: {
        ...exactConvertedMembership.authority,
        hostCaFingerprint: 'f'.repeat(64),
      },
    });
    await expect(target.recoveringEffects().restoreCompleted(target.completedRecord)).rejects.toMatchObject({
      safeContext: { reason: 'authority-transfer-lan-membership-conflict' },
    });
    expect(repairIndex).toHaveBeenCalledTimes(2);
    await target.foundation.local.projects.saveMembership(exactConvertedMembership);
    expect(await target.targetAuthority.database.read(connection => connection.get(`
      SELECT
        m.access_state,
        m.display_name,
        m.personal_ref,
        m.role,
        p.name AS project_name,
        p.state AS project_state,
        (SELECT COALESCE(MAX(sequence), 0) FROM events) AS event_sequence
      FROM project p
      JOIN members m ON m.member_id = p.host_member_id
      WHERE p.singleton = 1
    `))).toEqual({
      access_state: 'bound',
      display_name: exactConvertedMembership.member.displayName,
      event_sequence: exactConvertedMembership.lastEventSequence,
      personal_ref: exactConvertedMembership.member.personalRef,
      project_name: exactConvertedMembership.project.name,
      project_state: 'active',
      role: exactConvertedMembership.member.role,
    });
    await expect(target.recoveringEffects().restoreCompleted(target.completedRecord)).resolves.toBeUndefined();
    expect(recoveryRouteStart).toHaveBeenCalledTimes(1);
    expect(recoveryRouteMemberships).toEqual([
      expect.objectContaining({
        authority: expect.objectContaining({ kind: 'lan' }),
        member: expect.objectContaining({
          displayName: exactConvertedMembership.member.displayName,
          id: exactConvertedMembership.member.id,
          role: exactConvertedMembership.member.role,
        }),
      }),
    ]);
    expect(snapshotReadsBeforeRecovery).toHaveBeenCalledTimes(snapshotReadCount);

    expect(target.foundation.lanHost.isProjectRunning(PROJECT_ID)).toBe(true);
    const recoveredEndpoint = target.foundation.lanHost.getActiveProjectRoute(PROJECT_ID)?.endpoint;
    expect(recoveredEndpoint).toBeDefined();
    await expect(target.foundation.local.projects.loadMembership(PROJECT_ID)).resolves.toMatchObject({
      authority: { endpoint: recoveredEndpoint },
      hostOwnership: { autoStart: true, ownsAuthority: true },
    });
    expect(git(path.join(targetRoot, 'workspace', 'portable'), ['remote', 'get-url', 'origin']).trim())
      .toBe(`${recoveredEndpoint}/v1/git/${PROJECT_ID}/repository.git`);

  });

  it('blocks lifecycle and Host restoration without durable auto-start ownership', async () => {
    const target = await activateCloudToLanTarget();
    await target.recoveringEffects().restoreCompleted(target.completedRecord);
    await target.foundation.lanHost.stopProject(PROJECT_ID);
    await target.restart();
    const invalidMembership = await target.foundation.local.projects.loadMembership(PROJECT_ID);
    if (!invalidMembership || invalidMembership.authority.kind !== 'lan') {
      throw new Error('Missing invalid-recovery target membership');
    }
    await target.foundation.local.projects.saveMembership({
      ...invalidMembership,
      hostOwnership: { ownsAuthority: true },
    });
    const invalidRecoveryRouteStart = jest.spyOn(
      target.foundation.lanHost,
      'startAuthorityTransferRoute',
    );
    const invalidRecoveryComposition = createCollabFeatureSubcomposition({
      foundation: target.foundation,
      projectSetup: new CollabProjectSetupService(target.foundation, {
        installationKey: TEST_INSTALLATION_A,
        vaultRoot: targetRoot,
      }),
      vaultRoot: targetRoot,
    });
    await invalidRecoveryComposition.feature.initialize();
    await expect(invalidRecoveryComposition.feature.restoreLifecycle()).rejects.toMatchObject({
      code: 'durable-progress-recovery-required',
    });
    await expect(invalidRecoveryComposition.feature.restoreHosts()).rejects.toMatchObject({
      code: 'durable-progress-recovery-required',
    });
    expect(invalidRecoveryRouteStart).not.toHaveBeenCalled();
    expect(target.foundation.lanHost.isProjectRunning(PROJECT_ID)).toBe(false);
    await invalidRecoveryComposition.feature.close();
    await target.foundation.close();

  });

  it('retains exact claim replay after the next generation relinquishes LAN authority', async () => {
    const target = await restoreStoppedCloudToLanTarget();
    const { claimClient, claimRequest, firstReceipt, recoveredRegistration, restartedComposition } = target;
    const interruptedRequest = { ...claimRequest, idempotencyKey: 'claim-interrupted-before-receipt' };
    const actualRename = fsPromises.rename;
    const receiptWrite = jest.spyOn(fsPromises, 'rename').mockImplementation(async (from, to) => {
      if (String(to).endsWith('/target-private.json')) {
        const partial = JSON.parse(await readFile(from, 'utf8')) as { receipts: Record<string, { operationIntentId: string }> };
        if (Object.values(partial.receipts).some(receipt => receipt.operationIntentId === interruptedRequest.idempotencyKey)) {
          throw new Error('simulated receipt persistence failure');
        }
      }
      return actualRename(from, to);
    });
    await expect(claimClient.claimTransferredMembership(interruptedRequest)).rejects.toMatchObject({ code: 'operation-failed' });
    receiptWrite.mockRestore();

    const nextStatus: CollabAuthorityTransferStatus = {
      ...status('lan-to-cloud', 'collecting-readiness', 'https://cloud.example.test/'),
      sourceAuthority: { generation: 3, kind: 'lan' },
      targetAuthority: { generation: 4, kind: 'cloud' },
      transferId: 'transfer-next-cloud-generation',
    };
    const nextEntry = createAuthorityTransferEntryRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      proposedByMemberId: 'member-production-peer',
      request: { projectId: PROJECT_ID, expectedAuthorityGeneration: 3,
        idempotencyKey: 'intent-next-cloud-generation', targetUrl: nextStatus.targetUrl },
      status: nextStatus,
    });
    await target.foundation.authorityTransfers.proposeEntry(nextEntry);
    const nextRecord = createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A, lifecycleOwnership: 'owned', localRole: 'source',
      operationIntentId: nextEntry.request.idempotencyKey,
      sourceLanEndpoint: new URL(target.completedRecord.status.targetUrl).origin,
      stagingDirectoryName: `.claudian-authority-transfer-${nextStatus.transferId}`,
      status: { ...nextStatus, phase: 'source-quiesced' },
    });
    await target.foundation.authorityTransfers.handoffEntry(nextEntry, createAuthorityTransferRecord({ ...nextRecord, status: nextStatus }));
    await target.foundation.authorityTransfers.advance(nextRecord, 'collecting-readiness');
    await new ProductionLanToCloudSourceEffects({
      retainCommittedTargetRedemptions: (targetRecord, source, members) => target.recoveringEffects().retainCommittedRedemptions(targetRecord, source, members),
      cloudSession: { principalId: 'principal:next-host' } as CloudAuthorityConnection, convergence: await target.createRecoveryConvergence(), foundation: target.foundation,
      persistence: target.foundation.authorityTransfers, projectId: PROJECT_ID,
    }).capture(nextRecord);

    await expect(recoveredRegistration.service.claimTransferredMembership({
      ...claimRequest, idempotencyKey: 'late-claim-after-quiescence',
    })).rejects.toMatchObject({
      code: 'durable-progress-recovery-required',
      safeContext: { reason: 'authority-transfer-authority-quiesced' },
    });
    await expect(claimClient.claimTransferredMembership({
      ...claimRequest, idempotencyKey: 'late-claim-after-quiescence',
    })).rejects.toMatchObject({ code: 'operation-failed' });
    await expect(claimClient.claimTransferredMembership(claimRequest)).resolves.toEqual(firstReceipt);
    await target.foundation.closeAuthority(PROJECT_ID);
    await target.foundation.hostInstallations.removeOwned(PROJECT_ID);
    await expect(claimClient.claimTransferredMembership(claimRequest)).resolves.toEqual(firstReceipt);
    const recoveredReceipt = await claimClient.claimTransferredMembership(interruptedRequest);
    expect(recoveredReceipt).toMatchObject({ memberId: MEMBER_ID, operationIntentId: interruptedRequest.idempotencyKey, targetAuthorityGeneration: 3 });
    await expect(claimClient.claimTransferredMembership(interruptedRequest)).resolves.toEqual(recoveredReceipt);

    await expect(claimClient.claimTransferredMembership({
      ...claimRequest, credentialHash: 'a'.repeat(64),
    })).rejects.toMatchObject({ code: 'authority-transfer-stale' });
    await expect(target.recoveringEffects().restoreRetained(target.completedRecord)).resolves.toBeUndefined();
    target.environment.now = new Date('2026-10-01T00:00:00.000Z');
    const expiredPersistence = new AuthorityTransferPersistence(target.foundation.local.projects, {
      isRecoveryOwner: owner => owner === TEST_INSTALLATION_A, now: () => target.environment.now,
    });
    await expect(new ProductionCloudToLanTargetEffects({
      cloudSession: null, convergence: await target.createRecoveryConvergence(), foundation: target.foundation,
      now: () => target.environment.now, persistence: expiredPersistence, projectId: PROJECT_ID,
    }).restoreRetained(target.completedRecord)).resolves.toBeUndefined();
    await expiredPersistence.close();
    await expect(target.foundation.authorityTransfers.load(PROJECT_ID)).resolves.toEqual(nextRecord);
    await expect(target.foundation.authorityTransfers.load(PROJECT_ID, TRANSFER_ID)).resolves.toMatchObject({ terminalCleanupCompleted: true });
    await restartedComposition.feature.close();
    await target.sourceFeature.close();
    await target.sourceFoundation.close();
    await target.foundation.close();
  });

  it.each([false, true])('recovers interrupted claim expiry and restores ordinary Host service (address movement: %s)', async (moveAddress) => {
    const target = await restoreStoppedCloudToLanTarget(moveAddress);
    const { restartedComposition } = target;
    expect(target.foundation.lanHost.isProjectRunning(PROJECT_ID)).toBe(false);
    await expect(target.foundation.lanHost.startProject(PROJECT_ID)).resolves.toMatchObject({
      projectId: PROJECT_ID,
      status: 'running',
    });
    const recoveredMembership = await target.foundation.local.projects.loadMembership(PROJECT_ID);
    if (!recoveredMembership || recoveredMembership.authority.kind !== 'lan') {
      throw new Error('Missing recovered target membership');
    }
    await target.targetAuthority.database.mutate(connection => {
      target.targetAuthority!.events.append(connection, {
        actorMemberId: recoveredMembership.member.id,
        createdAt: '2026-08-28T00:04:00.000Z',
        kind: 'membership.updated',
        payload: { projectId: PROJECT_ID },
      });
    });
    await target.foundation.local.projects.saveMembership({
      ...recoveredMembership,
      lastEventSequence: recoveredMembership.lastEventSequence + 1,
      updatedAt: '2026-08-28T00:04:00.000Z',
    });
    await target.foundation.lanHost.stopProject(PROJECT_ID);
    expect(target.foundation.lanHost.isProjectRunning(PROJECT_ID)).toBe(false);
    await restartedComposition.feature.close();
    await target.restart();
    const expiryRouteStart = jest.spyOn(
      target.foundation.lanHost,
      'startAuthorityTransferRoute',
    );
    await expect(target.recoveringEffects().restoreCompleted(target.completedRecord)).resolves.toBeUndefined();
    const expiryRegistration = expiryRouteStart.mock.calls.find(
      ([registration]) => registration.state === 'target-active',
    )?.[0];
    if (expiryRegistration?.state !== 'target-active') {
      throw new Error('Missing expiry recovery Cloud-to-LAN target route');
    }
    jest.spyOn(target.foundation.authorityTransfers, 'expireClaims').mockResolvedValue();
    const completeTerminalCleanup = jest.spyOn(
      target.foundation.authorityTransfers,
      'completeTerminalCleanup',
    ).mockRejectedValueOnce(new Error('simulated crash after target-private unlink'));
    target.environment.now = new Date('2026-10-01T00:00:00.000Z');

    await expect(expiryRegistration.service.expire())
      .rejects.toThrow('simulated crash after target-private unlink');
    await expect(access(target.targetStatePath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(target.foundation.authorityTransfers.load(PROJECT_ID)).resolves.toMatchObject({
      terminalCleanupCompleted: false,
    });
    const stopExpiredRoute = jest.spyOn(
      target.foundation.lanHost,
      'stopAuthorityTransferRoute',
    );
    const assertTargetIdentity = jest.spyOn(
      target.foundation.authorityTransfers,
      'assertCloudToLanCompletedTargetIdentity',
    );
    await expect(target.recoveringEffects().restoreCompleted(target.completedRecord)).resolves.toBeUndefined();
    expect(stopExpiredRoute).toHaveBeenCalledWith(PROJECT_ID, 'target-active', TRANSFER_ID);
    expect(assertTargetIdentity).toHaveBeenCalledWith({
      memberId: 'member-production-peer',
      operationIntentId: OPERATION_ID,
      personalRef: 'refs/heads/members/member-production-peer',
      projectId: PROJECT_ID,
      transferId: TRANSFER_ID,
    });
    expect(completeTerminalCleanup).toHaveBeenCalledTimes(2);
    await expect(target.foundation.authorityTransfers.load(PROJECT_ID)).resolves.toMatchObject({
      terminalCleanupCompleted: true,
    });
    await target.foundation.local.projects.authorityTransferEntries.saveTarget(
      handoffCloudToLanTargetEntry(target.targetEntry, target.completedRecord),
    );
    await expect(target.foundation.local.projects.authorityTransferEntries.load(PROJECT_ID))
      .resolves.toMatchObject({ target: { phase: 'handed-off' } });
    await expect(expiryRegistration.service.expire()).resolves.toBeUndefined();
    expect(completeTerminalCleanup).toHaveBeenCalledTimes(3);
    await expect(target.foundation.local.projects.authorityTransferEntries.load(PROJECT_ID))
      .resolves.toMatchObject({ target: { phase: 'handed-off' } });
    expect(target.foundation.lanHost.isProjectRunning(PROJECT_ID)).toBe(false);
    await expect(target.foundation.lanHost.startProject(PROJECT_ID)).resolves.toMatchObject({
      projectId: PROJECT_ID,
      status: 'running',
    });
    await expect(access(path.join(
      targetRoot,
      '.claudian',
      'collab',
      'projects',
      PROJECT_ID,
      'authority-transfer-claims.json',
    ))).rejects.toMatchObject({ code: 'ENOENT' });
    await target.sourceFeature.close();
    await target.sourceFoundation.close();
    await target.foundation.close();
  });

  it.each([false, true])('moves Cloud authority through the composed feature facade (single Member: %s)', async (singleMember) => {
    const {
      artifactBytes,
      repositoryBytes,
      sourceCoordinationBytes,
      sourceFeature,
      sourceFoundation,
      sourceManifestBytes,
      sourceMembership,
    } = await captureSource(!singleMember);
    const targetMemberId = singleMember ? MEMBER_ID : 'member-production-peer';
    const managerRoot = await mkdtemp(path.join(tmpdir(), 'claudian-transfer-manager-'));
    const cloudServerUrl = 'https://cloud.example.test/';
    const sourceManifest = decodeCollabProjectCheckpointManifest(
      JSON.parse(sourceManifestBytes.toString('utf8')),
    );
    const records = sourceCoordinationBytes.toString('utf8').trimEnd().split('\n')
      .map(line => JSON.parse(line) as Record<string, unknown>);
    const project = records[0] as { value: Record<string, unknown> };
    project.value.authorityGeneration = 2;
    const coordinationBytes = Buffer.from(
      `${records.map(record => JSON.stringify(record)).join('\n')}\n`,
      'utf8',
    );
    const manifest = createAuthorityTransferCheckpointManifest({
      artifacts: [
        {
          byteCount: coordinationBytes.byteLength,
          name: 'coordination.ndjson',
          sha256: createHash('sha256').update(coordinationBytes).digest('hex'),
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
    artifactBytes.set('coordination.ndjson', coordinationBytes);
    artifactBytes.set(
      'checkpoint.json',
      Buffer.from(encodeCollabProjectCheckpointManifestCanonicalJson(manifest), 'utf8'),
    );

    let begun = false;
    let transferredClaimBatch: CollabTransferredMembershipClaimBatch | null = null;
    let transferStatus: CollabAuthorityTransferStatus | null = null;
    const members = [
      {
        bindingState: 'bound' as const,
        displayName: 'Alice',
        importedClaimGeneration: null,
        importedClaimState: 'not-applicable' as const,
        memberId: MEMBER_ID,
        membershipRevision: 1,
        role: 'manager' as const,
      },
      {
        bindingState: 'bound' as const,
        displayName: 'Bob',
        importedClaimGeneration: null,
        importedClaimState: 'not-applicable' as const,
        memberId: 'member-production-peer',
        membershipRevision: 1,
        role: 'member' as const,
      },
    ];
    if (singleMember) members.pop();
    const transferLifecycle = {
      authorityTransfer: jest.fn(async (operation: string, request: never) => {
        const input = request as Record<string, unknown>;
        if (operation === 'beginCloudToLanTransfer') {
          begun = true;
          transferStatus = status(
            'cloud-to-lan',
            'collecting-readiness',
            input.targetUrl as string,
          );
          return transferStatus;
        }
        if (operation === 'getAuthorityTransferReceiptVerifier') {
          return cloudReceiptVerifier();
        }
        if (!transferStatus) throw new Error('Transfer has not begun');
        if (operation === 'getProjectAuthorityTransfer') {
          if (transferStatus.phase === 'cloud-quiesced') {
            transferStatus = {
              ...transferStatus,
              checkpointSha256: manifest.manifestSha256,
              phase: 'checkpoint-captured',
              updatedAt: '2026-08-28T00:02:00.000Z',
            };
          }
          return transferStatus;
        }
        if (operation === 'getTransferredMembershipClaim') {
          const batch = transferredClaimBatch;
          const claim = batch?.claims.find(candidate => candidate.memberId === MEMBER_ID);
          if (!batch || !claim) throw new Error('Transferred Manager claim is unavailable');
          return {
            ...claim,
            expiresAt: batch.expiresAt,
            projectId: batch.projectId,
            targetAuthorityGeneration: batch.targetAuthorityGeneration,
            transferId: batch.transferId,
          };
        }
        if (operation === 'acknowledgeTransferredMembershipClaimRedemption') {
          const receipt = input.receipt as { readonly memberId: string; readonly receiptId: string };
          return {
            acknowledgedAt: '2026-08-28T00:05:00.000Z',
            memberId: receipt.memberId,
            projectId: PROJECT_ID,
            receiptId: receipt.receiptId,
            transferId: TRANSFER_ID,
          };
        }
        if (operation === 'acceptCloudToLanTransferTarget') {
          transferStatus = {
            ...transferStatus,
            phase: 'cloud-quiesced',
            updatedAt: '2026-08-28T00:01:00.000Z',
          };
          return transferStatus;
        }
        if (operation === 'reportCloudToLanTargetStaged') {
          const staged = input as unknown as {
            readonly checkpointSha256: string;
            readonly claimBatch: CollabTransferredMembershipClaimBatch;
            readonly idempotencyKey: string;
          };
          transferredClaimBatch = staged.claimBatch;
          const proof = signCloudRelinquishmentProof({
            batchRevision: staged.claimBatch.batchRevision,
            batchSha256: staged.claimBatch.batchSha256,
            certificateAlgorithm: 'ed25519' as const,
            checkpointSha256: staged.checkpointSha256,
            committedAt: '2026-08-28T00:03:00.000Z',
            operationIntentId: 'intent-cloud-relinquishment',
            projectId: PROJECT_ID,
            sourceAuthority: { generation: 2, kind: 'cloud' as const },
            sourceHostMemberId: null,
            targetAuthority: { generation: 3, kind: 'lan' as const },
            transferId: TRANSFER_ID,
          });
          transferStatus = {
            ...transferStatus,
            batchRevision: staged.claimBatch.batchRevision,
            batchSha256: staged.claimBatch.batchSha256,
            checkpointSha256: staged.checkpointSha256,
            phase: 'cloud-relinquished',
            relinquishmentProof: proof,
            updatedAt: '2026-08-28T00:03:00.000Z',
          };
          return {
            batchRevision: staged.claimBatch.batchRevision,
            batchSha256: staged.claimBatch.batchSha256,
            checkpointSha256: staged.checkpointSha256,
            committedAt: new Date(Date.now() + 60_000).toISOString(),
            custodyAuthority: { generation: 2, kind: 'cloud' as const },
            operationIntentId: staged.idempotencyKey,
            projectId: PROJECT_ID,
            receiptId: 'receipt-composed-cloud-to-lan',
            submittedByMemberId: targetMemberId,
            targetAuthorityGeneration: 3,
            transferId: TRANSFER_ID,
          };
        }
        if (operation === 'confirmCloudToLanTargetActive') {
          transferStatus = {
            ...transferStatus,
            phase: 'completed',
            state: 'completed',
            updatedAt: '2026-08-28T00:04:00.000Z',
          };
          return transferStatus;
        }
        throw new Error(`Unexpected Cloud operation ${operation}`);
      }),
      downloadAuthorityTransferArtifact: jest.fn(async (
        input: { readonly artifact: CollabCloudAuthorityTransferArtifact },
      ) => {
        const bytes = artifactBytes.get(input.artifact);
        if (!bytes) throw new Error(`Missing ${input.artifact}`);
        return { body: Readable.from([bytes]), byteCount: bytes.byteLength };
      }),
      retirement: jest.fn(),
      uploadAuthorityTransferArtifact: jest.fn(),
    };
    const snapshot = (memberId: string) => {
      if (begun) throw new Error('post-begin ordinary Cloud snapshot must stay closed');
      const listed = members.find(member => member.memberId === memberId);
      if (!listed) throw new Error('Unknown composed Cloud Member');
      return {
        currentMember: {
          activatedAt: sourceMembership.createdAt,
          createdAt: sourceMembership.createdAt,
          displayName: listed.displayName,
          id: listed.memberId,
          personalRef: `refs/heads/members/${listed.memberId}`,
          role: listed.role,
          status: 'active' as const,
        },
        eventSequence: 3,
        members: [],
        openRequests: [],
        openTicketCount: 0,
        project: {
          authorityGeneration: 2,
          authorityKind: 'cloud' as const,
          createdAt: sourceMembership.createdAt,
          id: PROJECT_ID,
          mainOid: sourceManifest.expectedMainOid,
          mainRef: 'refs/heads/main' as const,
          name: sourceMembership.project.name,
        },
        ticketHighlights: [],
      };
    };
    const cloudAuthority = {
      authorityKind: 'cloud' as const,
      connect: jest.fn(async () => {
        throw new Error('Fresh composed flow must use its bound membership');
      }),
      connectPendingLeave: async () => {
        throw new Error('This flow must not open a Cloud Leave connection');
      },
      connectPendingRetirement: async () => {
        throw new Error('This flow must not open a Cloud Retirement connection');
      },
      connectAuthorityTransfer: jest.fn(async (binding: {
        readonly authorityGeneration: number;
        readonly memberId: string;
        readonly personalRef: string;
        readonly projectId: string;
        readonly serverUrl: string;
      }) => ({
        ...binding,
        dispose: jest.fn(),
        lifecycle: transferLifecycle,
        listProjectMembers: jest.fn(async () => {
          if (begun) throw new Error('Post-begin membership read must stay closed');
          return {
            authorityGeneration: 2,
            managerSetGeneration: 1,
            members,
            projectId: PROJECT_ID,
          };
        }),
        readSnapshot: jest.fn(async () => snapshot(binding.memberId)),
        supports: (capability: CollabCloudCapability) => (
          capability === 'authority-transfer'
        ),
      })),
      create: jest.fn(async (membership: { readonly member: { readonly id: string } }) => {
        const memberId = membership.member.id;
        return {
          authorityKind: 'cloud' as const,
          control: { readSnapshot: jest.fn(async () => snapshot(memberId)) },
          dispose: jest.fn(),
          lifecycle: transferLifecycle,
          membership: {
            authorityKind: 'cloud' as const,
            cloudMembership: jest.fn(async (operation: string) => {
              if (operation !== 'listProjectMembers' || begun) {
                throw new Error('Unexpected or post-begin membership read');
              }
              return {
                authorityGeneration: 2,
                managerSetGeneration: 1,
                members,
                projectId: PROJECT_ID,
              };
            }),
          },
          supports: (capability: CollabCloudCapability) => (
            capability === 'authority-transfer'
          ),
        };
      }),
    };

    const seed = async (
      root: string,
      installationKey: typeof TEST_INSTALLATION_A | typeof TEST_INSTALLATION_B,
      member: typeof members[number],
    ) => {
      const seeded = foundation(root, installationKey);
      await seeded.local.workspace.claimProjectsFolder('workspace');
      git(root, [
        'clone',
        '--quiet',
        path.join(sourceRoot, 'workspace', 'portable'),
        path.join(root, 'workspace', 'portable'),
      ]);
      git(path.join(root, 'workspace', 'portable'), [
        'remote',
        'set-url',
        'origin',
        cloudProjectGitRemoteUrl(cloudServerUrl, PROJECT_ID),
      ]);
      await seeded.local.projects.saveMembership({
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
          displayName: member.displayName,
          id: member.memberId,
          personalRef: `refs/heads/members/${member.memberId}`,
          role: member.role,
        },
        project: sourceMembership.project,
        schemaVersion: sourceMembership.schemaVersion,
        updatedAt: sourceMembership.updatedAt,
      });
      await seeded.local.projects.repairIndexFromMemberships();
      const repositories = (await seeded.requireGitFoundation()).repositories;
      await repositories.configureLocalRepository(path.join(root, 'workspace', 'portable'), {
        memberId: member.memberId,
        personalRef: `refs/heads/members/${member.memberId}`,
        projectId: PROJECT_ID,
        userDisplayName: member.displayName,
      });
      const composition = createCollabFeatureSubcomposition({
        cloudAuthority: cloudAuthority as never,
        foundation: seeded,
        projectSetup: new CollabProjectSetupService(seeded, {
          installationKey,
          vaultRoot: root,
        }),
        vaultRoot: root,
      });
      await expect(composition.feature.initialize()).resolves.toMatchObject({
        status: 'success',
      });
      return { composition, foundation: seeded };
    };

    let target = await seed(targetRoot, TEST_INSTALLATION_B, singleMember ? members[0] : members[1]);
    const manager = singleMember ? target : await seed(managerRoot, TEST_INSTALLATION_A, members[0]);
    try {
      const { accepted, handle } = await (async () => {
        if (singleMember) {
          const result = await target.composition.feature.moveCloudToLan(PROJECT_ID);
          if (result.status !== 'success') {
            if ('error' in result) throw result.error;
            throw new Error(`Local move returned ${result.status}`);
          }
          const view = await target.composition.feature.readCloudToLanTransfer(PROJECT_ID);
          if (view.status !== 'success' || !view.value?.target?.handle) {
            throw new Error('Missing durable completed target handle');
          }
          return { accepted: result, handle: view.value.target.handle };
        }
      const prepared = await target.composition.feature.prepareCloudToLanTarget({
        projectId: PROJECT_ID,
      });
      if (prepared.status !== 'success') {
        if ('error' in prepared) throw prepared.error;
        throw new Error(`Target preparation returned ${prepared.status}`);
      }
      expect(prepared).toMatchObject({
        status: 'success',
        value: { selectedTargetMemberId: targetMemberId },
      });
      const begunResult = await manager.composition.feature.beginCloudToLanTransfer({
        descriptor: prepared.value,
      });
      expect(begunResult).toMatchObject({
        status: 'success',
        value: { selectedTargetMemberId: targetMemberId },
      });
      if (begunResult.status !== 'success') throw new Error('Manager begin failed');
      return {
        accepted: await target.composition.feature.acceptCloudToLanTransfer(begunResult.value),
        handle: begunResult.value,
      };
      })();
      expect(accepted).toMatchObject({ status: 'success' });
      if (accepted.status !== 'success') {
        if ('error' in accepted) throw accepted.error;
        throw new Error(`Target acceptance returned ${accepted.status}`);
      }
      expect(accepted.value).toMatchObject({ state: 'completed' });
      await expect(target.composition.feature.acceptCloudToLanTransfer(handle))
        .resolves.toMatchObject({ status: 'success', value: { state: 'completed' } });
      const observed = singleMember ? accepted
        : await manager.composition.feature.observeCloudToLanTransfer(PROJECT_ID);
      if (observed.status !== 'success') {
        if ('error' in observed) throw observed.error;
        throw new Error(`Manager observation returned ${observed.status}`);
      }
      expect(observed.value).toMatchObject({ state: 'completed' });
      expect(cloudAuthority.connectAuthorityTransfer).toHaveBeenCalled();
      await expect(target.foundation.local.projects.loadMembership(PROJECT_ID))
        .resolves.toMatchObject({
          authority: { kind: 'lan' },
          hostOwnership: { autoStart: true, ownsAuthority: true },
          member: { id: targetMemberId, role: singleMember ? 'manager' : 'member' },
        });
      await expect(manager.foundation.local.projects.loadMembership(PROJECT_ID))
        .resolves.toMatchObject({
          authority: { kind: 'lan' },
          hostOwnership: { ownsAuthority: singleMember },
          member: { id: MEMBER_ID, role: 'manager' },
        });
      await expect(manager.foundation.authorityTransfers.loadCloudToLanManagerEntry(PROJECT_ID))
        .resolves.toBeNull();
      await target.composition.feature.close();
      await target.foundation.close();
      const restartedTarget = foundation(targetRoot, TEST_INSTALLATION_B);
      target = {
        foundation: restartedTarget,
        composition: createCollabFeatureSubcomposition({
          cloudAuthority: cloudAuthority as never,
          foundation: restartedTarget,
          projectSetup: new CollabProjectSetupService(restartedTarget, {
            installationKey: TEST_INSTALLATION_B,
            vaultRoot: targetRoot,
          }),
          vaultRoot: targetRoot,
        }),
      };
      await target.composition.feature.initialize();
      cloudAuthority.connectAuthorityTransfer.mockRejectedValue(new Error('completed retry must stay local'));
      await expect(target.composition.feature.acceptCloudToLanTransfer(handle))
        .resolves.toMatchObject({ status: 'success', value: { state: 'completed' } });
      const nextProposal = await target.composition.feature.proposeLanToCloudTransfer({
            projectId: PROJECT_ID,
            serverUrl: cloudServerUrl,
          });
      expect({ proposal: nextProposal }).toMatchObject({
        proposal: {
          status: 'success',
          value: {
            direction: 'lan-to-cloud',
            phase: 'collecting-readiness',
            sourceAuthority: { generation: 3, kind: 'lan' },
            targetAuthority: { generation: 4, kind: 'cloud' },
          },
        },
      });
      expect(target.foundation.lanHost.isProjectRunning(PROJECT_ID)).toBe(true);
      {
        const sourceBinding = await target.composition.authorityTransfer.bindLanToCloudSource({
          cloudSession: {
            projectId: PROJECT_ID,
            serverUrl: cloudServerUrl,
            supports: () => true,
          } as unknown as CloudAuthorityConnection,
          projectId: PROJECT_ID,
        });
        await sourceBinding.dispose();

      }

      const pendingSource = await target.foundation.authorityTransfers.loadSourceEntry(PROJECT_ID);
      await target.composition.feature.close();
      await target.foundation.close();
      const nextFoundation = foundation(targetRoot, TEST_INSTALLATION_B);
      target = {
        foundation: nextFoundation,
        composition: createCollabFeatureSubcomposition({
          cloudAuthority: cloudAuthority as never, foundation: nextFoundation,
          projectSetup: new CollabProjectSetupService(nextFoundation, {
            installationKey: TEST_INSTALLATION_B, vaultRoot: targetRoot,
          }), vaultRoot: targetRoot,
        }),
      };
      await target.composition.feature.initialize();
      await expect(target.composition.feature.restoreLifecycle()).resolves.toBeUndefined();
      await expect(target.composition.feature.restoreHosts()).resolves.toBeUndefined();
      await expect(target.foundation.authorityTransfers.loadSourceEntry(PROJECT_ID)).resolves.toEqual(pendingSource);
      expect(target.foundation.lanHost.isProjectRunning(PROJECT_ID)).toBe(true);
    } finally {
      await Promise.all([
        manager.composition.feature.close(),
        target.composition.feature.close(),
      ]);
      await Promise.all([
        manager.foundation.close(),
        target.foundation.close(),
        sourceFeature.close(),
      ]);
      await sourceFoundation.close();
      await rm(managerRoot, { force: true, recursive: true });
    }
  });

  function createCollabFeatureSubcomposition(
    options: Parameters<typeof createProductionFeatureSubcomposition>[0],
  ): ReturnType<typeof createProductionFeatureSubcomposition> {
    const composition = createProductionFeatureSubcomposition(options);
    features.add(composition.feature);
    return composition;
  }

  function foundation(
    vaultRoot: string,
    installationKey: typeof TEST_INSTALLATION_A | typeof TEST_INSTALLATION_B = TEST_INSTALLATION_A,
    lanHost?: ConstructorParameters<typeof ClaudianCollabService>[0]['lanHost'],
  ): ClaudianCollabService {
    const service = new ClaudianCollabService({
      createAuthorityDatabase: authorityDirectory => (
        new SqlJsProjectDatabase(authorityDirectory, { loadSqlJs: async () => SQL })
      ),
      getConfiguredGitPath: () => '',
      installationKey,
      ...(lanHost ? { lanHost } : {}),
      obsidianConfigDirectory: '.obsidian',
      vaultRoot,
    });
    foundations.add(service);
    return service;
  }
});
