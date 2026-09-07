import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  COLLAB_CLOUD_BINDING_VERSION,
  COLLAB_PROTOCOL_VERSION,
  type CollabAuthorityTransferStatus,
  type CollabTransferredMembershipClaimBatch,
  encodeCollabTransferredMembershipClaimBatchDigestInput,
} from '@claudian-collab/protocol';
import { TEST_INSTALLATION_A } from '@test/helpers/installations';
import initSqlJs, { type SqlJsStatic } from 'sql.js';

import {
  ClaudianCollabService,
  CollabProjectSetupService,
  createCollabFeatureSubcomposition,
} from '@/app/collab';
import { SqlJsProjectDatabase } from '@/app/collab/authority/SqlJsProjectDatabase';
import {
  createAuthorityTransferRecord,
} from '@/app/collab/authority-transfer/AuthorityTransferRecord';
import {
  advanceAuthorityTransferClaimantRecord,
  createAuthorityTransferClaimantRecord,
} from '@/app/collab/authority-transfer/claim/AuthorityTransferClaimantRecord';
import {
  createAuthorityTransferClaimBatchCommitmentRecord,
} from '@/app/collab/authority-transfer/persistence/AuthorityTransferClaimBatchCommitmentRecord';
import {
  createAuthorityTransferClaimCustodyRecord,
  decodeAuthorityTransferClaimCustodyRecord,
} from '@/app/collab/authority-transfer/persistence/AuthorityTransferClaimCustodyRecord';
import { InvitationCodec } from '@/app/collab/lan/InvitationCodec';
import { listPrivateIpv4Addresses } from '@/app/collab/lan/LanHostCoordinator';
import type {
  CloudAuthorityLifecycleSession,
} from '@/app/collab/remote-authority/CloudAuthorityAdapter';
import type { CollabCloudProjectSnapshot } from '@/core/collab';

const PROJECT_ID = 'project-m2';
const MEMBER_ID = 'member-host';
const OPERATION_ID = 'create-project-m2';
const CREDENTIAL = 'M'.repeat(43);

jest.setTimeout(30_000);

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  return result.stdout.trim();
}

describe('G3 local Project milestone gate', () => {
  let SQL: SqlJsStatic;
  let vaultRoot: string;

  beforeAll(async () => {
    SQL = await initSqlJs();
  });

  beforeEach(async () => {
    vaultRoot = await mkdtemp(path.join(tmpdir(), 'claudian-m2-gate-'));
  });

  afterEach(async () => {
    if (vaultRoot) await rm(vaultRoot, { force: true, recursive: true });
  });

  function createFoundation(configuredGitPath = ''): ClaudianCollabService {
    return new ClaudianCollabService({
      createAuthorityDatabase: authorityDirectory => (
        new SqlJsProjectDatabase(authorityDirectory, { loadSqlJs: async () => SQL })
      ),
      getConfiguredGitPath: () => configuredGitPath,
      installationKey: TEST_INSTALLATION_A,
      obsidianConfigDirectory: '.obsidian',
      vaultRoot,
    });
  }

  it('creates and reloads one independent empty Project', async () => {
    const foundation = createFoundation();
    const setup = new CollabProjectSetupService(foundation, {
      installationKey: TEST_INSTALLATION_A,
      createCredential: () => CREDENTIAL,
      createId: kind => {
        if (kind === 'member') return MEMBER_ID;
        if (kind === 'operation') return OPERATION_ID;
        return PROJECT_ID;
      },
      now: () => new Date('2026-08-08T00:00:00.000Z'),
      vaultRoot,
    });
    const feature = createCollabFeatureSubcomposition({
      foundation,
      projectSetup: setup,
      vaultRoot,
    }).feature;

    await expect(feature.initialize()).resolves.toMatchObject({ status: 'success' });
    await expect(feature.createProject({
      memberDisplayName: 'Alice',
      name: 'M2 Notes',
    })).resolves.toEqual({
      status: 'success',
      value: expect.objectContaining({
        health: 'healthy',
        id: PROJECT_ID,
        workspacePath: 'workspace/m2-notes',
      }),
    });
    const runtime = await foundation.resolveGitRuntime();
    if (runtime.status !== 'available') throw new Error('Native Git unavailable in M2 gate');
    expect(git(path.join(vaultRoot, 'workspace', 'm2-notes'), [
      'ls-tree',
      '--name-only',
      'HEAD',
    ])).toBe('');
    expect(git(path.join(vaultRoot, 'workspace', 'm2-notes'), [
      'rev-list',
      '--count',
      'HEAD',
    ])).toBe('1');
    await feature.close();
    await foundation.close();

    git(vaultRoot, ['init', '--quiet', '--initial-branch=main']);
    expect(git(vaultRoot, [
      'check-ignore',
      'workspace/m2-notes/.git/config',
      '.claudian/collab/projects/project-m2/membership.json',
    ]).split('\n').sort()).toEqual([
      '.claudian/collab/projects/project-m2/membership.json',
      'workspace/m2-notes/.git/config',
    ]);

    const reopenedFoundation = createFoundation(runtime.runtime.executablePath);
    const reopenedSetup = new CollabProjectSetupService(reopenedFoundation, { installationKey: TEST_INSTALLATION_A, vaultRoot });
    const reopenedFeature = createCollabFeatureSubcomposition({
      foundation: reopenedFoundation,
      projectSetup: reopenedSetup,
      vaultRoot,
    }).feature;
    await expect(reopenedFeature.initialize()).resolves.toMatchObject({
      status: 'success',
      value: {
        lifecycle: 'ready',
        projects: [expect.objectContaining({
          health: 'healthy',
          id: PROJECT_ID,
          role: 'manager',
        })],
        selectedProjectId: PROJECT_ID,
      },
    });
    const authority = await reopenedFoundation.openAuthority(PROJECT_ID);
    await expect(authority.database.read(connection => authority.projects.get(connection)))
      .resolves.toMatchObject({
        managerSetGeneration: 0,
        projectId: PROJECT_ID,
        snapshotGeneration: 2,
      });
    await reopenedFeature.close();
    await reopenedFoundation.close();
  });

  it('publishes through the universal LAN lane after the owning Host address rebinds', async () => {
    const reboundAddress = listPrivateIpv4Addresses()[0];
    if (!reboundAddress) return;
    let addresses = ['127.0.0.1'];
    let checkAddress!: () => Promise<void>;
    const invitationCodec = new InvitationCodec({ isAddressAllowed: () => true });
    const foundation = new ClaudianCollabService({
      createAuthorityDatabase: authorityDirectory => (
        new SqlJsProjectDatabase(authorityDirectory, { loadSqlJs: async () => SQL })
      ),
      getConfiguredGitPath: () => '',
      installationKey: TEST_INSTALLATION_A,
      invitationCodec,
      lanHost: {
        createAddressMonitor: check => {
          checkAddress = check;
          return { close: jest.fn() };
        },
        createInvitationCodec: () => invitationCodec,
        getPrivateIpv4Addresses: () => addresses,
        portCandidates: [0],
      },
      obsidianConfigDirectory: '.obsidian',
      vaultRoot,
    });
    const feature = createCollabFeatureSubcomposition({
      foundation,
      projectSetup: new CollabProjectSetupService(foundation, {
        installationKey: TEST_INSTALLATION_A,
        createCredential: () => CREDENTIAL,
        createId: kind => {
          if (kind === 'member') return MEMBER_ID;
          if (kind === 'operation') return OPERATION_ID;
          return PROJECT_ID;
        },
        vaultRoot,
      }),
      vaultRoot,
    }).feature;

    try {
      await feature.initialize();
      const project = await feature.createProject({
        memberDisplayName: 'Alice',
        name: 'M2 Notes',
      });
      expect(project.status).toBe('success');
      await feature.startHost(PROJECT_ID);
      const repositoryPath = path.join(vaultRoot, 'workspace', 'm2-notes');
      await writeFile(path.join(repositoryPath, 'note.md'), 'before rebind\n');
      await expect(feature.publish({ description: 'Before rebind', projectId: PROJECT_ID }))
        .resolves.toMatchObject({ status: 'success' });

      addresses = [reboundAddress];
      await checkAddress();
      await writeFile(path.join(repositoryPath, 'note.md'), 'after rebind\n');

      await expect(feature.publish({ description: 'After rebind', projectId: PROJECT_ID }))
        .resolves.toMatchObject({ status: 'success' });
    } finally {
      await feature.close();
      await foundation.close();
    }
  });

  it('recovers a completed LAN-to-Cloud source and converges its old Host membership', async () => {
    const foundation = createFoundation();
    const setup = new CollabProjectSetupService(foundation, {
      installationKey: TEST_INSTALLATION_A,
      createCredential: () => CREDENTIAL,
      createId: kind => {
        if (kind === 'member') return MEMBER_ID;
        if (kind === 'operation') return OPERATION_ID;
        return PROJECT_ID;
      },
      now: () => new Date('2026-08-08T00:00:00.000Z'),
      vaultRoot,
    });
    const subcomposition = createCollabFeatureSubcomposition({
      foundation,
      projectSetup: setup,
      vaultRoot,
    });
    const transferId = 'transfer-product-runtime';
    const operationIntentId = 'intent-product-runtime';
    const checkpointSha256 = 'c'.repeat(64);
    const unsignedBatch: CollabTransferredMembershipClaimBatch = {
      batchRevision: 1,
      batchSha256: '0'.repeat(64),
      checkpointSha256,
      claims: [],
      expiresAt: '2026-09-27T00:00:00.000Z',
      projectId: PROJECT_ID,
      targetAuthorityGeneration: 2,
      transferId,
    };
    const claimBatch: CollabTransferredMembershipClaimBatch = {
      ...unsignedBatch,
      batchSha256: createHash('sha256')
        .update(encodeCollabTransferredMembershipClaimBatchDigestInput(unsignedBatch), 'utf8')
        .digest('hex'),
    };
    const proof = {
      batchRevision: 1,
      batchSha256: claimBatch.batchSha256,
      certificate: Buffer.alloc(64, 2).toString('base64url'),
      certificateAlgorithm: 'ed25519' as const,
      checkpointSha256,
      committedAt: '2026-08-27T00:02:00.000Z',
      operationIntentId,
      projectId: PROJECT_ID,
      sourceAuthority: { generation: 1, kind: 'lan' as const },
      sourceHostMemberId: MEMBER_ID,
      targetAuthority: { generation: 2, kind: 'cloud' as const },
      transferId,
    };
    const transferStatus = (
      phase: 'source-relinquished' | 'completed',
    ): CollabAuthorityTransferStatus => ({
      batchRevision: 1,
      batchSha256: claimBatch.batchSha256,
      checkpointSha256,
      createdAt: '2026-08-27T00:00:00.000Z',
      direction: 'lan-to-cloud',
      expiresAt: '2026-09-27T00:00:00.000Z',
      phase,
      projectId: PROJECT_ID,
      relinquishmentProof: proof,
      sourceAuthority: { generation: 1, kind: 'lan' },
      state: phase === 'completed' ? 'completed' : 'active',
      targetAuthority: { generation: 2, kind: 'cloud' },
      targetUrl: 'https://cloud.example.test/',
      transferId,
      updatedAt: phase === 'completed'
        ? '2026-08-27T00:03:00.000Z'
        : '2026-08-27T00:02:00.000Z',
    });
    const record = createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      lifecycleOwnership: 'owned',
      localRole: 'source',
      operationIntentId,
      stagingDirectoryName: `.claudian-authority-transfer-${transferId}`,
      status: transferStatus('source-relinquished'),
    });
    const custody = decodeAuthorityTransferClaimCustodyRecord({
      ...createAuthorityTransferClaimCustodyRecord({
        batch: claimBatch,
        createdAt: '2026-08-27T00:01:00.000Z',
        operationIntentId,
        purpose: 'source-terminal',
      }),
      custodyReceipt: {
        batchRevision: 1,
        batchSha256: claimBatch.batchSha256,
        checkpointSha256,
        committedAt: '2026-08-27T00:01:30.000Z',
        custodyAuthority: { generation: 1, kind: 'lan' },
        operationIntentId,
        projectId: PROJECT_ID,
        receiptId: 'custody-receipt-product-runtime',
        submittedByMemberId: MEMBER_ID,
        targetAuthorityGeneration: 2,
        transferId,
      },
      updatedAt: '2026-08-27T00:01:30.000Z',
    });
    const snapshot = (): CollabCloudProjectSnapshot => ({
      currentMember: {
        activatedAt: '2026-08-08T00:00:00.000Z',
        createdAt: '2026-08-08T00:00:00.000Z',
        displayName: 'Alice',
        id: MEMBER_ID,
        personalRef: `refs/heads/members/${MEMBER_ID}`,
        role: 'manager',
        status: 'active',
      },
      eventSequence: 7,
      members: [],
      openRequests: [],
      openTicketCount: 0,
      project: {
        authorityKind: 'cloud',
        createdAt: '2026-08-08T00:00:00.000Z',
        id: PROJECT_ID,
        mainOid: git(path.join(vaultRoot, 'workspace', 'm2-notes'), ['rev-parse', 'HEAD']),
        mainRef: 'refs/heads/main',
        name: 'M2 Notes',
      },
      ticketHighlights: [],
    });
    const readSnapshot = jest.fn(async () => snapshot());
    const cloudSession = {
      developmentActorId: MEMBER_ID,
      dispose: jest.fn(),
      lifecycle: {
        authorityTransfer: jest.fn(async (operation: string) => {
          if (operation === 'getAuthorityTransferReceiptVerifier') {
            return {
              projectId: PROJECT_ID,
              receiptKeyId: 'receipt-key-product-runtime',
              receiptPublicKey: Buffer.alloc(32, 3).toString('base64url'),
              receiptPublicKeyEncoding: 'base64url-raw',
              signatureAlgorithm: 'ed25519',
              transferId,
            };
          }
          return transferStatus('completed');
        }),
      },
      projectId: PROJECT_ID,
      readSnapshot,
      serverUrl: 'https://cloud.example.test/',
      supports: (capability: string) => (
        capability === 'authority-transfer' || capability === 'project-snapshot'
      ),
    } as unknown as CloudAuthorityLifecycleSession;
    await subcomposition.feature.initialize();
    await subcomposition.feature.createProject({
      memberDisplayName: 'Alice',
      name: 'M2 Notes',
    });
    expect(foundation.lanHost.isProjectRunning(PROJECT_ID)).toBe(true);
    const sourceMembership = await foundation.local.projects.loadMembership(PROJECT_ID);
    if (
      !sourceMembership
      || sourceMembership.authority.kind !== 'lan'
      || !sourceMembership.authority.endpoint
    ) throw new Error('Expected running LAN source membership');
    await foundation.local.projects.authorityTransferRecords.save(
      createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
        lifecycleOwnership: record.lifecycleOwnership,
        localRole: record.localRole,
        operationIntentId: record.operationIntentId,
        sourceLanEndpoint: sourceMembership.authority.endpoint,
        stagingDirectoryName: record.stagingDirectoryName,
        status: transferStatus('completed'),
      }),
    );
    await foundation.local.projects.authorityTransferClaims.save(custody);
    await foundation.local.projects.authorityTransferClaimCommitments.save(
      createAuthorityTransferClaimBatchCommitmentRecord(custody),
    );
    await foundation.lanHost.quiesceProjectForAuthorityTransfer(PROJECT_ID);
    await foundation.lanHost.relinquishProjectForAuthorityTransfer(PROJECT_ID);

    await subcomposition.feature.close();
    await foundation.close();

    const reopenedFoundation = createFoundation();
    const reopened = createCollabFeatureSubcomposition({
      cloudAuthority: {
        create: jest.fn() as never,
        createLifecycle: jest.fn(async () => cloudSession),
      },
      foundation: reopenedFoundation,
      projectSetup: new CollabProjectSetupService(reopenedFoundation, { installationKey: TEST_INSTALLATION_A, vaultRoot }),
      vaultRoot,
    });
    const restoreTerminalRoute = jest.spyOn(
      reopenedFoundation.lanHost,
      'startAuthorityTransferRoute',
    );
    readSnapshot.mockRejectedValueOnce(new Error('simulated Cloud snapshot outage'));
    await expect(reopened.feature.restoreLifecycle()).rejects.toThrow();
    expect(restoreTerminalRoute).toHaveBeenCalledTimes(1);
    await expect(reopened.feature.restoreLifecycle()).resolves.toBeUndefined();
    const convergedMembership = await reopenedFoundation.local.projects.loadMembership(PROJECT_ID);
    expect(convergedMembership).toMatchObject({ authority: { kind: 'cloud' } });
    expect(convergedMembership).not.toHaveProperty('hostOwnership');
    expect(readSnapshot).toHaveBeenCalledTimes(2);
    expect(restoreTerminalRoute).toHaveBeenCalledTimes(2);
    await expect(reopenedFoundation.lanHost.startProject(PROJECT_ID)).rejects.toMatchObject({
      code: 'durable-progress-recovery-required',
      safeContext: { reason: 'authority-transfer-source-relinquished' },
    });
    await reopened.feature.close();
    await reopenedFoundation.close();
  });

  it.each(['lan-to-cloud', 'cloud-to-lan'] as const)(
    'recovers a %s claimant after membership conversion committed first',
    async (direction) => {
      const foundation = createFoundation();
      const setup = new CollabProjectSetupService(foundation, {
      installationKey: TEST_INSTALLATION_A,
        createCredential: () => CREDENTIAL,
        createId: kind => {
          if (kind === 'member') return MEMBER_ID;
          if (kind === 'operation') return OPERATION_ID;
          return PROJECT_ID;
        },
        now: () => new Date('2026-08-08T00:00:00.000Z'),
        vaultRoot,
      });
      const feature = createCollabFeatureSubcomposition({
        foundation,
        projectSetup: setup,
        vaultRoot,
      }).feature;
      await feature.initialize();
      await feature.createProject({ memberDisplayName: 'Alice', name: 'M2 Notes' });
      const membership = await foundation.local.projects.loadMembership(PROJECT_ID);
      if (!membership || membership.authority.kind !== 'lan') {
        throw new Error('Expected initial LAN membership');
      }
      const transferId = `transfer-claimant-cross-write-${direction}`;
      const operationIntentId = `intent-claimant-cross-write-${direction}`;
      const checkpointSha256 = 'd'.repeat(64);
      const claimValue = Buffer.alloc(32, 8).toString('base64url');
      const targetCredential = Buffer.alloc(32, 9).toString('base64url');
      const targetUrl = direction === 'lan-to-cloud'
        ? 'https://cloud.example.test/'
        : 'https://192.168.1.20:54545/';
      const lanTarget = direction === 'cloud-to-lan'
        ? {
            caCertificatePem: '-----BEGIN CERTIFICATE-----\npublic-ca\n-----END CERTIFICATE-----\n',
            caFingerprint: 'e'.repeat(64),
            endpoint: targetUrl,
          }
        : null;
      const sourceAuthority = direction === 'lan-to-cloud'
        ? { generation: 1, kind: 'lan' as const }
        : { generation: 1, kind: 'cloud' as const };
      const targetAuthority = direction === 'lan-to-cloud'
        ? { generation: 2, kind: 'cloud' as const }
        : { generation: 2, kind: 'lan' as const };
      const status: CollabAuthorityTransferStatus = {
        batchRevision: 1,
        batchSha256: 'b'.repeat(64),
        checkpointSha256,
        createdAt: '2026-08-27T00:00:00.000Z',
        direction,
        expiresAt: '2026-09-27T00:00:00.000Z',
        phase: 'completed',
        projectId: PROJECT_ID,
        relinquishmentProof: {
          batchRevision: 1,
          batchSha256: 'b'.repeat(64),
          certificate: Buffer.alloc(64, 2).toString('base64url'),
          certificateAlgorithm: 'ed25519',
          checkpointSha256,
          committedAt: '2026-08-27T00:00:08.000Z',
          operationIntentId: `intent-source-${direction}`,
          projectId: PROJECT_ID,
          sourceAuthority,
          sourceHostMemberId: direction === 'lan-to-cloud' ? MEMBER_ID : null,
          targetAuthority,
          transferId,
        } as never,
        sourceAuthority,
        state: 'completed',
        targetAuthority,
        targetUrl,
        transferId,
        updatedAt: '2026-08-27T00:00:10.000Z',
      };
      let claimant = createAuthorityTransferClaimantRecord({
        createdAt: '2026-08-27T00:00:00.000Z',
        lanTarget,
        memberId: MEMBER_ID,
        operationIntentId,
        status,
      });
      claimant = advanceAuthorityTransferClaimantRecord(claimant, {
        claim: {
          claim: claimValue,
          expiresAt: status.expiresAt,
          memberId: MEMBER_ID,
          projectId: PROJECT_ID,
          targetAuthorityGeneration: 2,
          transferId,
        },
        phase: 'claim-retained',
        updatedAt: '2026-08-27T00:00:01.000Z',
      });
      claimant = advanceAuthorityTransferClaimantRecord(claimant, {
        phase: 'credential-persisted',
        targetCredential: direction === 'cloud-to-lan' ? targetCredential : null,
        updatedAt: '2026-08-27T00:00:02.000Z',
      });
      claimant = advanceAuthorityTransferClaimantRecord(claimant, {
        phase: 'target-claimed',
        redemptionReceipt: {
          checkpointSha256,
          claimSha256: createHash('sha256').update(claimValue, 'utf8').digest('hex'),
          memberId: MEMBER_ID,
          operationIntentId,
          projectId: PROJECT_ID,
          receiptId: `receipt-${direction}`,
          receiptKeyId: `receipt-key-${direction}`,
          redeemedAt: '2026-08-27T00:01:00.000Z',
          signature: Buffer.alloc(64, 3).toString('base64url'),
          signatureAlgorithm: 'ed25519',
          targetAuthorityGeneration: 2,
          transferId,
        },
        updatedAt: '2026-08-27T00:01:00.000Z',
      });
      claimant = advanceAuthorityTransferClaimantRecord(claimant, {
        phase: 'source-acknowledged',
        updatedAt: '2026-08-27T00:01:01.000Z',
      });
      if (direction === 'lan-to-cloud') {
        await foundation.local.projects.saveMembership({
          authority: {
            authorityGeneration: 2,
            bindingVersion: COLLAB_CLOUD_BINDING_VERSION,
            developmentActorId: MEMBER_ID,
            gitRemoteUrl: `https://cloud.example.test/v2/projects/${PROJECT_ID}/repository.git`,
            kind: 'cloud',
            serverUrl: 'https://cloud.example.test/',
            wireVersion: COLLAB_PROTOCOL_VERSION,
          },
          createdAt: membership.createdAt,
          lastEventSequence: 7,
          member: {
            displayName: membership.member.displayName,
            id: membership.member.id,
            personalRef: membership.member.personalRef,
            role: membership.member.role,
          },
          project: membership.project,
          schemaVersion: membership.schemaVersion,
          updatedAt: '2026-08-27T00:01:01.000Z',
        });
      } else {
        await foundation.local.projects.saveMembership({
          ...membership,
          authority: {
            endpoint: new URL(targetUrl).origin,
            gitRemoteUrl: `${new URL(targetUrl).origin}/v1/git/${PROJECT_ID}/repository.git`,
            hostCaCertificatePem: lanTarget!.caCertificatePem,
            hostCaFingerprint: lanTarget!.caFingerprint,
            kind: 'lan',
          },
          hostOwnership: { autoStart: false, ownsAuthority: false },
          member: { ...membership.member, credential: targetCredential },
          updatedAt: '2026-08-27T00:01:01.000Z',
        });
      }
      await foundation.local.projects.authorityTransferClaimants.save(claimant);
      await feature.close();
      await foundation.close();

      const reopenedFoundation = createFoundation();
      const createLifecycle = jest.fn(async () => {
        throw new Error('Cloud source must remain unavailable');
      });
      const reopened = createCollabFeatureSubcomposition({
        cloudAuthority: { create: jest.fn() as never, createLifecycle },
        foundation: reopenedFoundation,
        projectSetup: new CollabProjectSetupService(reopenedFoundation, { installationKey: TEST_INSTALLATION_A, vaultRoot }),
        vaultRoot,
      });

      await expect(reopened.feature.restoreLifecycle()).resolves.toBeUndefined();
      await expect(
        reopenedFoundation.local.projects.authorityTransferClaimants.load(PROJECT_ID),
      ).resolves.toBeNull();
      expect(createLifecycle).not.toHaveBeenCalled();
      await reopened.feature.close();
      await reopenedFoundation.close();
    },
  );

  it('finishes expired terminal-source staging cleanup after restart', async () => {
    const foundation = createFoundation();
    const setup = new CollabProjectSetupService(foundation, {
      installationKey: TEST_INSTALLATION_A,
      createCredential: () => CREDENTIAL,
      createId: kind => {
        if (kind === 'member') return MEMBER_ID;
        if (kind === 'operation') return OPERATION_ID;
        return PROJECT_ID;
      },
      now: () => new Date('2026-08-08T00:00:00.000Z'),
      vaultRoot,
    });
    const feature = createCollabFeatureSubcomposition({
      foundation,
      projectSetup: setup,
      vaultRoot,
    }).feature;
    await feature.initialize();
    await feature.createProject({ memberDisplayName: 'Alice', name: 'M2 Notes' });
    const transferId = 'transfer-terminal-restart';
    const operationIntentId = 'intent-terminal-restart';
    const checkpointSha256 = 'c'.repeat(64);
    const unsignedClaimBatch: CollabTransferredMembershipClaimBatch = {
      batchRevision: 1,
      batchSha256: '0'.repeat(64),
      checkpointSha256,
      claims: [],
      expiresAt: '2026-07-01T00:00:00.000Z',
      projectId: PROJECT_ID,
      targetAuthorityGeneration: 2,
      transferId,
    };
    const claimBatch: CollabTransferredMembershipClaimBatch = {
      ...unsignedClaimBatch,
      batchSha256: createHash('sha256')
        .update(encodeCollabTransferredMembershipClaimBatchDigestInput(unsignedClaimBatch), 'utf8')
        .digest('hex'),
    };
    const stagingDirectoryName = `.claudian-authority-transfer-${transferId}`;
    const reserved = await foundation.local.workspace.reserveProjectsFolderChild('workspace', {
      childName: stagingDirectoryName,
      operationId: transferId,
      projectId: PROJECT_ID,
      purpose: 'authority-transfer-staging',
    });
    await mkdir(reserved.absolutePath, { mode: 0o700 });
    await foundation.local.projects.authorityTransferRecords.save(
      createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      lifecycleOwnership: 'owned',
      localRole: 'source',
      operationIntentId,
      stagingDirectoryName,
      status: {
        batchRevision: 1,
        batchSha256: claimBatch.batchSha256,
        checkpointSha256,
        createdAt: '2026-06-01T00:00:00.000Z',
        direction: 'lan-to-cloud',
        expiresAt: '2026-07-01T00:00:00.000Z',
        phase: 'completed',
        projectId: PROJECT_ID,
        relinquishmentProof: {
          batchRevision: 1,
          batchSha256: claimBatch.batchSha256,
          certificate: Buffer.alloc(64, 7).toString('base64url'),
          certificateAlgorithm: 'ed25519',
          checkpointSha256,
          committedAt: '2026-06-01T00:00:01.000Z',
          operationIntentId,
          projectId: PROJECT_ID,
          sourceAuthority: { generation: 1, kind: 'lan' },
          sourceHostMemberId: MEMBER_ID,
          targetAuthority: { generation: 2, kind: 'cloud' },
          transferId,
        },
        sourceAuthority: { generation: 1, kind: 'lan' },
        state: 'completed',
        targetAuthority: { generation: 2, kind: 'cloud' },
        targetUrl: 'https://cloud.example.test/',
        transferId,
        updatedAt: '2026-06-01T00:00:02.000Z',
      },
      }),
    );
    const retainedClaims = decodeAuthorityTransferClaimCustodyRecord({
      ...createAuthorityTransferClaimCustodyRecord({
        batch: claimBatch,
        createdAt: '2026-06-01T00:00:00.000Z',
        operationIntentId,
        purpose: 'source-terminal',
      }),
      custodyReceipt: {
        batchRevision: 1,
        batchSha256: claimBatch.batchSha256,
        checkpointSha256,
        committedAt: '2026-06-01T00:00:00.500Z',
        custodyAuthority: { generation: 1, kind: 'lan' },
        operationIntentId,
        projectId: PROJECT_ID,
        receiptId: 'custody-receipt-terminal-restart',
        submittedByMemberId: MEMBER_ID,
        targetAuthorityGeneration: 2,
        transferId,
      },
      updatedAt: '2026-06-01T00:00:00.500Z',
    });
    await foundation.local.projects.authorityTransferClaims.save(retainedClaims);
    await foundation.local.projects.authorityTransferClaimCommitments.save(
      createAuthorityTransferClaimBatchCommitmentRecord(retainedClaims),
    );
    await feature.close();
    await foundation.close();

    const reopenedFoundation = createFoundation();
    const reopened = createCollabFeatureSubcomposition({
      foundation: reopenedFoundation,
      projectSetup: new CollabProjectSetupService(reopenedFoundation, { installationKey: TEST_INSTALLATION_A, vaultRoot }),
      vaultRoot,
    }).feature;
    await expect(reopened.restoreLifecycle()).resolves.toBeUndefined();
    await expect(reopenedFoundation.authorityTransfers.inspectLifecycleOwner(PROJECT_ID))
      .resolves.toBe('terminal');
    await expect(lstat(reserved.absolutePath).catch(() => null)).resolves.toBeNull();

    await reopened.close();
    await reopenedFoundation.close();
  });
});
