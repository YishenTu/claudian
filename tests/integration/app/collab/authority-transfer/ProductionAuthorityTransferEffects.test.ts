import { createHash, createPublicKey, verify } from 'node:crypto';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { COLLAB_CLOUD_BINDING_VERSION, COLLAB_PROTOCOL_VERSION, type CollabAuthorityTransferStatus, type CollabCloudCapability, type CollabTransferredMembershipClaimBatch, decodeCollabProjectCheckpointCoordinationNdjson, decodeCollabProjectCheckpointManifest, encodeCollabCloudToLanTargetCleanupProofSigningInput, encodeCollabTransferredMembershipClaimBatchDigestInput, validateCollabProjectCheckpointConsistency } from '@claudian-collab/protocol';
import { git, HOST_CREDENTIAL, MEMBER_ID, OPERATION_ID, productionAuthorityTransferFixture,PROJECT_ID, signCloudRelinquishmentProof, status, TRANSFER_ID } from '@test/helpers/collab/ProductionAuthorityTransferFixture';
import { TEST_INSTALLATION_A, TEST_INSTALLATION_B } from '@test/helpers/installations';
import { testClock, testDate, testTime } from '@test/helpers/testClock';

import { CollabProjectSetupService } from '@/app/collab';
import { CollabProjectWorkSessionRegistry } from '@/app/collab/activity/CollabProjectWorkSession';
import { AuthorityMetadataRepository } from '@/app/collab/authority/AuthorityMetadataRepository';
import { createAuthorityTransferEntryRecord, createAuthorityTransferRequesterEntry } from '@/app/collab/authority-transfer/AuthorityTransferEntryRecord';
import { AuthorityTransferLocalConvergence } from '@/app/collab/authority-transfer/AuthorityTransferLocalConvergence';
import { AuthorityTransferLocalFence } from '@/app/collab/authority-transfer/AuthorityTransferLocalFence';
import { authorityTransferChildIdempotencyKey } from '@/app/collab/authority-transfer/AuthorityTransferOperationIdentity';
import { AuthorityTransferReadModel } from '@/app/collab/authority-transfer/AuthorityTransferReadModel';
import { createAuthorityTransferRecord, expireAuthorityTransferTerminalResponder } from '@/app/collab/authority-transfer/AuthorityTransferRecord';
import { cloudToLanTransferHandle, createCloudToLanManagerEntry, createCloudToLanTargetEntry, handoffCloudToLanTargetEntry, markCloudToLanManagerBeginPossiblySent, publishCloudToLanTargetEntry, recordCloudToLanManagerStatus } from '@/app/collab/authority-transfer/cloud-to-lan/CloudToLanTransferEntryRecord';
import { ProductionCloudToLanTargetEffects } from '@/app/collab/authority-transfer/cloud-to-lan/ProductionCloudToLanTargetEffects';
import { LanToCloudSourceCoordinator } from '@/app/collab/authority-transfer/lan-to-cloud/LanToCloudSourceCoordinator';
import { ProductionLanToCloudSourceEffects } from '@/app/collab/authority-transfer/lan-to-cloud/ProductionLanToCloudSourceEffects';
import { AuthorityTransferPersistence } from '@/app/collab/authority-transfer/persistence/AuthorityTransferPersistence';
import { isCollabLocalLanMembership } from '@/app/collab/CollabLocalProjectRepository';
import { rotateAuthorityTransferOrigin } from '@/app/collab/git/CollabGitOriginPolicy';
import { LanAuthorityTransferClient } from '@/app/collab/lan/authority-transfer/LanAuthorityTransferClient';
import { LanTlsIdentity } from '@/app/collab/lan/LanTlsIdentity';
import { CollabProjectLifecycleSubsystem } from '@/app/collab/lifecycle/CollabProjectLifecycleSubsystem';
import { ProjectOperationAdmission } from '@/app/collab/ProjectOperationAdmission';
import type { CloudAuthorityConnection } from '@/app/collab/remote-authority/CloudAuthorityAdapter';
import { cloudProjectGitRemoteUrl } from '@/app/collab/remote-authority/CloudAuthorityUrls';
import type { CollabAuthorityLifecyclePort } from '@/app/collab/remote-authority/CollabAuthorityLifecyclePort';

jest.setTimeout(30_000);

jest.mock('sql.js/dist/sql-wasm.wasm', () => ({
  __esModule: true,
  default: jest.requireActual('node:fs').readFileSync(require.resolve('sql.js/dist/sql-wasm.wasm')),
}));

describe('production authority-transfer source and cancellation effects', () => {
  const fixture = productionAuthorityTransferFixture();
  const { captureSource, createCollabFeatureSubcomposition, foundation } = fixture;
  let sourceRoot: string;
  let targetRoot: string;
  beforeEach(() => {
    sourceRoot = fixture.sourceRoot;
    targetRoot = fixture.targetRoot;
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
      now: testClock({ days: 1, minutes: 2 }),
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
                  if (operation === 'registerCloudToLanPreparation') return { withdrawnAt: null };
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
    const now = testDate({ days: 1, minutes: 2 });
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
      expiresAt: testTime({ days: 31 }),
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
        expiresAt: testTime({ days: 2 }),
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
    let settled = false;
    const persistence = {
      settleCompletedTransfer: jest.fn(async () => { settled = true; events.push('settle'); }),
      completeTerminalCleanup: jest.fn(async () => { events.push('cleanup'); }),
      expireTerminalResponder: jest.fn(async () => { events.push('expire'); }),
      load: jest.fn(async (_id: string, transferId?: string) => settled && !transferId ? null : completedRecord),
    };
    const effects = new ProductionLanToCloudSourceEffects({
      cloudSession: null,
      convergence,
      foundation: {
        detachTransferredLanSource: jest.fn(async () => { events.push('detach'); }),
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
      'detach',
      'settle',
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
      settleCompletedTransfer: jest.fn(async () => undefined),
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
        detachTransferredLanSource: jest.fn(async () => undefined),
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
      now: testClock({ days: -19 }),
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
      const exact = await sourceFoundation.authorityTransfers.load(PROJECT_ID, completed.transferId);
      if (!exact) throw new Error('Missing completed source transfer');
      const nextTarget = createCloudToLanTargetEntry({
        createdAt: testTime({ days: 1, minutes: 3 }), expiresAt: testTime({ days: 30 }),
        operationIntentId: 'next-target-preparation', ownerInstallationKey: TEST_INSTALLATION_A,
        projectId: PROJECT_ID, selectedTargetMemberId: MEMBER_ID,
        selectedTargetPersonalRef: `refs/heads/members/${MEMBER_ID}`,
        sourceAuthorityGeneration: 2, sourceCloudUrl: targetUrl,
      });
      await sourceFoundation.authorityTransfers.prepareCloudToLanTargetEntry(nextTarget);
      await expect(sourceFoundation.inspectAuthority(PROJECT_ID)).resolves.toBeNull();
      const terminalRequest = { projectId: PROJECT_ID, transferId: exact.transferId };
      await expect(client.requestWithMember('getProjectAuthorityTransfer', terminalRequest, peerCredential))
        .resolves.toEqual(completed);
      await sourceFoundation.lanHost.stopAuthorityTransferRoute(PROJECT_ID, 'terminal-source', exact.transferId);
      const routeStart = jest.spyOn(sourceFoundation.lanHost, 'startAuthorityTransferRoute');
      await new ProductionLanToCloudSourceEffects({
        cloudSession: null, foundation: sourceFoundation, persistence: sourceFoundation.authorityTransfers,
        convergence: {} as AuthorityTransferLocalConvergence, projectId: PROJECT_ID,
      }).restoreRetained(exact);
      const restoredSession = await routeStart.mock.results[0]?.value;
      routeStart.mockRestore();
      if (!restoredSession) throw new Error('Missing restored terminal listener');
      const restoredClient = new LanAuthorityTransferClient({
        caCertificatePem: membership.authority.hostCaCertificatePem!,
        caFingerprint: membership.authority.hostCaFingerprint!,
        endpoint: restoredSession.endpoint,
        projectId: PROJECT_ID,
      });
      await expect(restoredClient.requestWithMember('getProjectAuthorityTransfer', terminalRequest, peerCredential))
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
      now: testClock({ days: -19 }),
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
        now: testClock({ days: -19 }),
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
      settleLocalAuthorityAdvance: identity => reopenedFoundation.authorityTransfers.settleLocalAuthorityAdvance(identity),
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
        now: testClock({ days: -19 }),
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

  it.each(['left', 'revoked'] as const)('exports a valid checkpoint while retaining %s member history and source refs', async departedStatus => {
    const captured = await captureSource(true, departedStatus);
    try {
      const manifest = decodeCollabProjectCheckpointManifest(JSON.parse(captured.sourceManifestBytes.toString('utf8')));
      const records = decodeCollabProjectCheckpointCoordinationNdjson(captured.sourceCoordinationBytes.toString('utf8'), manifest.profile);
      expect(() => validateCollabProjectCheckpointConsistency(manifest, records)).not.toThrow();
      expect(manifest.refs.map(ref => ref.name)).toEqual([
        'refs/heads/main', 'refs/heads/members/member-production-host', 'refs/heads/members/member-production-peer',
      ]);
      expect(records).toContainEqual(expect.objectContaining({
        kind: 'member', value: expect.objectContaining({ memberId: 'member-departed', status: departedStatus }),
      }));
      const authority = await captured.sourceFoundation.openAuthority(PROJECT_ID);
      const repository = path.join(authority.authorityDirectory, 'repository.git');
      expect(git(repository, ['rev-parse', 'refs/heads/members/member-departed'])).toBe(manifest.expectedMainOid);
    } finally {
      await captured.sourceFeature.close();
      await captured.sourceFoundation.close();
    }
  });

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
      settleLocalAuthorityAdvance: identity => sourceFoundation.authorityTransfers.settleLocalAuthorityAdvance(identity),
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

  it('converges two real working copies through three roundtrips and replays interrupted settlement after restart', async () => {
    const captured = await captureSource();
    await captured.sourceFeature.close();
    await captured.sourceFoundation.close();
    if (!isCollabLocalLanMembership(captured.sourceMembership)) throw new Error('Expected LAN source');
    const roots = [sourceRoot, targetRoot];
    const keys = [TEST_INSTALLATION_A, TEST_INSTALLATION_B] as const;
    const members = [MEMBER_ID, 'member-production-peer'];
    const worktrees = roots.map(root => path.join(root, 'workspace', 'portable'));
    const devices = roots.map((root, i) => foundation(root, keys[i]));
    await devices[1].local.workspace.claimProjectsFolder('workspace');
    git(targetRoot, ['clone', '--no-hardlinks', worktrees[0], worktrees[1]]);
    await devices[1].local.projects.saveMembership({ ...captured.sourceMembership,
      member: { ...captured.sourceMembership.member, id: members[1], personalRef: `refs/heads/members/${members[1]}`, role: 'member' },
      hostOwnership: { autoStart: false, ownsAuthority: false },
    });
    await devices[1].local.projects.repairIndexFromMemberships();
    git(worktrees[1], ['remote', 'set-url', 'origin', captured.sourceMembership.authority.gitRemoteUrl!]);
    for (let i = 0; i < devices.length; i++) {
      await (await devices[i].requireGitFoundation()).repositories.configureLocalRepository(worktrees[i], {
        projectId: PROJECT_ID, memberId: members[i], personalRef: `refs/heads/members/${members[i]}`, userDisplayName: members[i],
      });
      await writeFile(path.join(worktrees[i], 'private-draft.md'), `private draft on device ${i}\n`);
    }
    const before = await Promise.all(worktrees.map(async directory => ({
      head: git(directory, ['rev-parse', 'HEAD']), status: git(directory, ['status', '--porcelain']),
      draft: await readFile(path.join(directory, 'private-draft.md'), 'utf8'),
    })));
    const pastSources: Parameters<AuthorityTransferLocalConvergence['lanToCloudHost']>[0][][] = [[], []];
    let host = 0;
    let failSettlement = false;
    const run = async (index: number, operation: (convergence: AuthorityTransferLocalConvergence) => Promise<void>) => {
      const device = devices[index];
      const lifecycle = new CollabProjectLifecycleSubsystem({
        closeRecovery: () => undefined, recoveryStages: [], hostTransfer: {} as never, localExit: {} as never, retirement: {} as never,
        durableOwners: [{ name: 'authority-transfer', inspect: projectId => device.authorityTransfers.inspectLifecycleOwner(projectId) }],
      });
      const admission = new ProjectOperationAdmission();
      const sessions = new CollabProjectWorkSessionRegistry();
      const fence = new AuthorityTransferLocalFence({
        admission: {
          suspendProjectAdmission: id => admission.suspendProject(id),
          resumeProjectAdmission: token => admission.resumeProject(token),
          drainAdmittedOperations: id => admission.drainAdmittedOperations(id),
        },
        workSessions: {
          suspendProject: id => sessions.suspendProject(id),
          resumeProject: async token => { if (!await sessions.resumeProject(token)) throw new Error('Session did not resume'); },
        },
      });
      const convergence = new AuthorityTransferLocalConvergence({
        activity: { transitionProject: (projectId, effect) => lifecycle.runExclusive(projectId, 'authority-transfer', 'continuation', () => fence.run(projectId, effect)) },
        authorityProjectionTransitions: { run: (projectId, effect) => device.runAuthorityProjectionTransition(projectId, effect) },
        git: { rotate: async input => rotateAuthorityTransferOrigin((await device.requireGitFoundation()).repositories, input) },
        projects: device.local.projects, workspace: device.local.workspace,
        settleLocalAuthorityAdvance: async identity => {
          if (failSettlement) throw new Error('interrupted requester settlement');
          await device.authorityTransfers.settleLocalAuthorityAdvance(identity);
        },
      });
      try {
        await operation(convergence);
        await expect(admission.runProject(() => PROJECT_ID, 'active', async () => 'readable')).resolves.toBe('readable');
      } finally { await sessions.close(); }
    };
    for (const generation of [2, 4, 6]) {
      const requester = 1 - host;
      await devices[requester].authorityTransfers.submitRequesterEntry(createAuthorityTransferRequesterEntry({
        installationKey: keys[requester], proposedAt: new Date().toISOString(), proposedByMemberId: members[requester],
        request: { projectId: PROJECT_ID, expectedAuthorityGeneration: generation - 1, idempotencyKey: `round-${generation}`, targetUrl: 'https://cloud.example.test/' },
      }));
      const proofBase = { batchRevision: 1, batchSha256: 'b'.repeat(64), checkpointSha256: 'a'.repeat(64),
        certificateAlgorithm: 'ed25519' as const, committedAt: '2026-08-28T00:01:00.000Z',
        operationIntentId: `round-${generation}`, projectId: PROJECT_ID, transferId: TRANSFER_ID };
      const toCloud: CollabAuthorityTransferStatus = { ...status('lan-to-cloud', 'completed', 'https://cloud.example.test/'), state: 'completed',
        sourceAuthority: { kind: 'lan', generation: generation - 1 }, targetAuthority: { kind: 'cloud', generation },
        relinquishmentProof: signCloudRelinquishmentProof({ ...proofBase,
          sourceAuthority: { kind: 'lan', generation: generation - 1 }, targetAuthority: { kind: 'cloud', generation }, sourceHostMemberId: members[host] }) };
      for (let i = 0; i < devices.length; i++) {
        const membership = (await devices[i].local.projects.loadMembership(PROJECT_ID))!;
        const currentMember = { ...membership.member, activatedAt: membership.createdAt, createdAt: membership.createdAt, status: 'active' as const };
        const input = { status: toCloud, snapshot: { currentMember, eventSequence: generation, members: [currentMember], openRequests: [],
          openTicketCount: 0, ticketHighlights: [], project: { id: PROJECT_ID, name: membership.project.name,
            createdAt: membership.createdAt, authorityKind: 'cloud' as const, authorityGeneration: generation,
            mainOid: before[i].head, mainRef: 'refs/heads/main' as const } } };
        if (i === host) pastSources[i].push(input);
        failSettlement = i === requester;
        const failure = await run(i, convergence => i === host ? convergence.lanToCloudHost(input) : convergence.lanToCloudMember(input))
          .then(() => null, (error: Error) => error.message);
        expect(failure).toBe(i === requester ? 'interrupted requester settlement' : null);
        expect(await devices[i].authorityTransfers.loadRequesterEntry(PROJECT_ID, keys[i]) !== null).toBe(i === requester);
        if (failSettlement) {
          await devices[i].close();
          devices[i] = foundation(roots[i], keys[i]);
          failSettlement = false;
          // Resume through the explicit recovery entry after the automatic write succeeded.
          await run(i, convergence => convergence.restoreCloudMembership(input));
        }
        expect(await devices[i].authorityTransfers.loadRequesterEntry(PROJECT_ID, keys[i])).toBeNull();
        for (const previous of pastSources[i].filter(move => move.status.targetAuthority.generation < generation)) {
          await run(i, convergence => convergence.lanToCloudHost(previous));
          await run(i, convergence => convergence.lanToCloudHostOffline(previous.status));
        }
        expect((await devices[i].local.projects.loadMembership(PROJECT_ID))?.authority).toMatchObject({ kind: 'cloud', authorityGeneration: generation });
      }
      host = requester;
      const endpoint = `https://127.0.0.1:${54545 + host}`;
      const toLan: CollabAuthorityTransferStatus = { ...status('cloud-to-lan', 'completed', endpoint, 'a'.repeat(64), generation), state: 'completed',
        relinquishmentProof: signCloudRelinquishmentProof({ ...proofBase,
          sourceAuthority: { kind: 'cloud', generation }, targetAuthority: { kind: 'lan', generation: generation + 1 }, sourceHostMemberId: null }) };
      for (let i = 0; i < devices.length; i++) {
        const membership = (await devices[i].local.projects.loadMembership(PROJECT_ID))!;
        const input = { endpoint, status: toLan, memberCredential: HOST_CREDENTIAL,
          hostCaCertificatePem: captured.sourceMembership.authority.hostCaCertificatePem!,
          hostCaFingerprint: captured.sourceMembership.authority.hostCaFingerprint!,
          identity: { project: membership.project, authorityGeneration: generation + 1, eventSequence: generation + 1, currentMember: membership.member } };
        if (i === host) await run(i, convergence => convergence.cloudToLanHost({ ...input, withEndpoint: effect => effect(endpoint) }));
        else await run(i, convergence => convergence.cloudToLanMember(input));
        for (const previous of pastSources[i]) {
          await run(i, convergence => convergence.lanToCloudHost(previous));
          await run(i, convergence => convergence.lanToCloudHostOffline(previous.status));
        }
        await devices[i].close();
        devices[i] = foundation(roots[i], keys[i]);
        expect(await devices[i].local.projects.loadMembership(PROJECT_ID)).toMatchObject({
          project: { workspacePath: 'workspace/portable' }, member: { id: members[i], personalRef: `refs/heads/members/${members[i]}` },
          authority: { kind: 'lan', authorityGeneration: generation + 1 }, hostOwnership: { ownsAuthority: i === host },
        });
        expect(await new AuthorityTransferReadModel(devices[i].authorityTransfers, keys[i]).readLanToCloudTransfer(PROJECT_ID, generation + 1)).toBeNull();
        expect(git(worktrees[i], ['remote', 'get-url', 'origin'])).toBe(`${endpoint}/v1/git/${PROJECT_ID}/repository.git`);
        expect({ head: git(worktrees[i], ['rev-parse', 'HEAD']), status: git(worktrees[i], ['status', '--porcelain']),
          draft: await readFile(path.join(worktrees[i], 'private-draft.md'), 'utf8') }).toEqual(before[i]);
      }
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
});
