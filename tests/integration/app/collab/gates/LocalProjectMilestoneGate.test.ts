import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  type CollabAuthorityTransferStatus,
  type CollabTransferredMembershipClaimBatch,
  encodeCollabTransferredMembershipClaimBatchDigestInput,
} from '@claudian-collab/protocol';
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
  createAuthorityTransferClaimBatchCommitmentRecord,
} from '@/app/collab/authority-transfer/persistence/AuthorityTransferClaimBatchCommitmentRecord';
import {
  createAuthorityTransferClaimCustodyRecord,
  decodeAuthorityTransferClaimCustodyRecord,
} from '@/app/collab/authority-transfer/persistence/AuthorityTransferClaimCustodyRecord';
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
      obsidianConfigDirectory: '.obsidian',
      vaultRoot,
    });
  }

  it('creates and reloads one independent empty Project', async () => {
    const foundation = createFoundation();
    const setup = new CollabProjectSetupService(foundation, {
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
    const reopenedSetup = new CollabProjectSetupService(reopenedFoundation, { vaultRoot });
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

  it('binds product-owned LAN-to-Cloud recovery and preserves the terminal route', async () => {
    const foundation = createFoundation();
    const setup = new CollabProjectSetupService(foundation, {
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
      readSnapshot: jest.fn(async () => snapshot()),
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
    await subcomposition.authorityTransfer.bindLanToCloudSource({
      cloudSession,
      projectId: PROJECT_ID,
    });
    await foundation.local.projects.authorityTransferRecords.save(record);
    await foundation.local.projects.authorityTransferClaims.save(custody);
    await foundation.local.projects.authorityTransferClaimCommitments.save(
      createAuthorityTransferClaimBatchCommitmentRecord(custody),
    );
    await foundation.lanHost.quiesceProjectForAuthorityTransfer(PROJECT_ID);
    await foundation.lanHost.relinquishProjectForAuthorityTransfer(PROJECT_ID);

    await expect(subcomposition.feature.restoreLifecycle()).resolves.toBeUndefined();
    expect(foundation.lanHost.isProjectRunning(PROJECT_ID)).toBe(false);
    await expect(foundation.lanHost.startProject(PROJECT_ID)).rejects.toMatchObject({
      code: 'durable-progress-recovery-required',
      safeContext: { reason: 'authority-transfer-source-relinquished' },
    });
    const convergedMembership = await foundation.local.projects.loadMembership(PROJECT_ID);
    expect(convergedMembership).toMatchObject({ authority: { kind: 'cloud' } });
    expect(convergedMembership).not.toHaveProperty('hostOwnership');

    await subcomposition.feature.close();
    await foundation.close();

    const reopenedFoundation = createFoundation();
    const reopened = createCollabFeatureSubcomposition({
      foundation: reopenedFoundation,
      projectSetup: new CollabProjectSetupService(reopenedFoundation, { vaultRoot }),
      vaultRoot,
    });
    await expect(reopened.feature.restoreLifecycle()).resolves.toBeUndefined();
    await expect(reopenedFoundation.lanHost.startProject(PROJECT_ID)).rejects.toMatchObject({
      code: 'durable-progress-recovery-required',
      safeContext: { reason: 'authority-transfer-source-relinquished' },
    });
    await reopened.feature.close();
    await reopenedFoundation.close();
  });

  it('finishes expired terminal-source staging cleanup after restart', async () => {
    const foundation = createFoundation();
    const setup = new CollabProjectSetupService(foundation, {
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
    await foundation.authorityTransfers.expireTerminalResponder(PROJECT_ID, transferId);
    await feature.close();
    await foundation.close();

    const reopenedFoundation = createFoundation();
    const reopened = createCollabFeatureSubcomposition({
      foundation: reopenedFoundation,
      projectSetup: new CollabProjectSetupService(reopenedFoundation, { vaultRoot }),
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
