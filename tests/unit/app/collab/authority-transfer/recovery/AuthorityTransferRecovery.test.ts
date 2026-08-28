import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  type CollabAuthorityTransferStatus,
  type CollabTransferredMembershipClaimBatch,
  encodeCollabTransferredMembershipClaimBatchDigestInput,
} from '@claudian-collab/protocol';
import {
  TEST_INSTALLATION_A,
  TEST_INSTALLATION_B,
} from '@test/helpers/installations';

import {
  createAuthorityTransferRecord,
  decodeAuthorityTransferRecord,
} from '@/app/collab/authority-transfer/AuthorityTransferRecord';
import {
  createAuthorityTransferClaimBatchCommitmentRecord,
} from '@/app/collab/authority-transfer/persistence/AuthorityTransferClaimBatchCommitmentRecord';
import {
  createAuthorityTransferClaimCustodyRecord,
} from '@/app/collab/authority-transfer/persistence/AuthorityTransferClaimCustodyRecord';
import {
  AuthorityTransferPersistence,
} from '@/app/collab/authority-transfer/persistence/AuthorityTransferPersistence';
import {
  AuthorityTransferRecovery,
} from '@/app/collab/authority-transfer/recovery/AuthorityTransferRecovery';
import { CollabLocalProjectRepository } from '@/app/collab/CollabLocalProjectRepository';
import {
  createHostTransferRecoveryRecord,
} from '@/app/collab/host-transfer/HostTransferRecovery';
import {
  type CollabProjectLifecycleDurableOwner,
  CollabProjectLifecycleSubsystem,
} from '@/app/collab/lifecycle/CollabProjectLifecycleSubsystem';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const PROJECT_ID = 'project-alpha';

function claimBatch(): CollabTransferredMembershipClaimBatch {
  const unsigned: CollabTransferredMembershipClaimBatch = {
    batchRevision: 1,
    batchSha256: '0'.repeat(64),
    checkpointSha256: 'a'.repeat(64),
    claims: [
      { claim: 'A'.repeat(43), memberId: 'member-alpha' },
      { claim: 'B'.repeat(43), memberId: 'member-beta' },
    ],
    expiresAt: '2026-09-30T00:00:00.000Z',
    projectId: PROJECT_ID,
    targetAuthorityGeneration: 2,
    transferId: 'transfer-one',
  };
  return {
    ...unsigned,
    batchSha256: createHash('sha256')
      .update(encodeCollabTransferredMembershipClaimBatchDigestInput(unsigned), 'utf8')
      .digest('hex'),
  };
}

function status(
  phase: 'cancelled' | 'collecting-readiness' | 'source-quiesced',
  projectId = PROJECT_ID,
  transferId = 'transfer-one',
): CollabAuthorityTransferStatus {
  return {
    batchRevision: null,
    batchSha256: null,
    checkpointSha256: null,
    createdAt: '2026-08-26T00:00:00.000Z',
    direction: 'lan-to-cloud',
    expiresAt: '2026-09-30T00:00:00.000Z',
    phase,
    projectId,
    relinquishmentProof: null,
    sourceAuthority: { generation: 1, kind: 'lan' },
    state: phase === 'cancelled' ? 'cancelled' : 'active',
    targetAuthority: { generation: 2, kind: 'cloud' },
    targetUrl: 'http://127.0.0.1:8787/',
    transferId,
    updatedAt: phase === 'collecting-readiness'
      ? '2026-08-26T00:00:00.000Z'
      : phase === 'source-quiesced'
        ? '2026-08-26T00:01:00.000Z'
        : '2026-08-26T00:02:00.000Z',
  };
}

function lifecycle() {
  return new CollabProjectLifecycleSubsystem({
    closeRecovery: jest.fn().mockResolvedValue(undefined),
    durableOwners: [],
    hostTransfer: {} as never,
    localExit: {} as never,
    recoveryStages: [],
    retirement: {} as never,
  });
}

describe('AuthorityTransferRecovery', () => {
  let vaultRoot: string;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(path.join(tmpdir(), 'claudian-transfer-recovery-'));
  });

  afterEach(async () => {
    await rm(vaultRoot, { force: true, recursive: true });
  });

  it('enumerates startup state and reacquires the lifecycle arbiter for recovery', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    const persistence = new AuthorityTransferPersistence(repository, { isRecoveryOwner: () => true });
    await repository.authorityTransferRecords.save(createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      lifecycleOwnership: 'owned',
      localRole: 'source',
      operationIntentId: 'intent-one',
      stagingDirectoryName: '.claudian-authority-transfer-transfer-one',
      status: status('collecting-readiness'),
    }));
    const resume = jest.fn().mockResolvedValue(undefined);
    const recovery = new AuthorityTransferRecovery(persistence, { resume }, () => undefined);
    const subsystem = lifecycle();
    recovery.register(subsystem);

    await subsystem.lifecycleRecovery.resume();

    expect(resume).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: PROJECT_ID, transferId: 'transfer-one' }),
      {},
    );
  });

  it('rejects a foreign installation owner before commitment repair or runtime effects', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    const persistence = new AuthorityTransferPersistence(repository, { isRecoveryOwner: () => true });
    await repository.authorityTransferRecords.save(createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      lifecycleOwnership: 'owned',
      localRole: 'source',
      operationIntentId: 'intent-one',
      stagingDirectoryName: '.claudian-authority-transfer-transfer-one',
      status: status('collecting-readiness'),
    }));
    const repair = jest.spyOn(persistence, 'recoverInterruptedClaimCommitment');
    const resume = jest.fn().mockResolvedValue(undefined);
    const assertRecoveryOwner = jest.fn(() => {
      throw new Error('foreign installation recovery');
    });
    const recovery = new AuthorityTransferRecovery(
      persistence,
      { resume },
      assertRecoveryOwner,
    );
    const subsystem = lifecycle();
    recovery.register(subsystem);

    await expect(subsystem.lifecycleRecovery.resume())
      .rejects.toThrow('foreign installation recovery');
    expect(assertRecoveryOwner).toHaveBeenCalledWith(TEST_INSTALLATION_A, PROJECT_ID);
    expect(repair).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
  });

  it('keeps a foreign synchronized transfer inert during lifecycle inspection and recovery', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    const persistence = new AuthorityTransferPersistence(repository, {
      isRecoveryOwner: ownerInstallationKey => ownerInstallationKey === TEST_INSTALLATION_B,
    });
    await repository.authorityTransferRecords.save(createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      lifecycleOwnership: 'owned',
      localRole: 'source',
      operationIntentId: 'intent-one',
      stagingDirectoryName: '.claudian-authority-transfer-transfer-one',
      status: status('collecting-readiness'),
    }));
    const repair = jest.spyOn(persistence, 'recoverInterruptedClaimCommitment');
    const resume = jest.fn().mockResolvedValue(undefined);
    const recovery = new AuthorityTransferRecovery(persistence, { resume }, () => {
      throw new CollabError({
        code: 'durable-progress-recovery-required',
        safeContext: { reason: 'host-installation-recovery-owner-mismatch' },
      });
    });
    const subsystem = lifecycle();
    recovery.register(subsystem);

    await expect(subsystem.lifecycleRecovery.resume()).resolves.toBeUndefined();
    await expect(persistence.inspectLifecycleOwner(PROJECT_ID)).resolves.toBe('absent');
    expect(repair).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
  });

  it('surfaces an ownerless legacy transfer instead of treating it as foreign', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    const current = createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      lifecycleOwnership: 'owned',
      localRole: 'source',
      operationIntentId: 'intent-one',
      stagingDirectoryName: '.claudian-authority-transfer-transfer-one',
      status: status('collecting-readiness'),
    });
    const { ownerInstallationKey: _ownerInstallationKey, ...withoutOwner } = current;
    await repository.authorityTransferRecords.save(decodeAuthorityTransferRecord({
      ...withoutOwner,
      schemaVersion: 1,
    }));
    const persistence = new AuthorityTransferPersistence(repository, {
      isRecoveryOwner: ownerInstallationKey => ownerInstallationKey === TEST_INSTALLATION_A,
    });
    const resume = jest.fn().mockResolvedValue(undefined);
    const recovery = new AuthorityTransferRecovery(persistence, { resume }, ownerInstallationKey => {
      if (ownerInstallationKey === undefined) {
        throw new CollabError({
          code: 'durable-progress-recovery-required',
          safeContext: { reason: 'host-installation-recovery-owner-mismatch' },
        });
      }
    });
    const subsystem = lifecycle();
    recovery.register(subsystem);

    await expect(subsystem.lifecycleRecovery.resume()).rejects.toMatchObject({
      code: 'durable-progress-recovery-required',
    });
    await expect(persistence.inspectLifecycleOwner(PROJECT_ID)).resolves.toBe('nonterminal');
    expect(resume).not.toHaveBeenCalled();
  });

  it('reconstructs a proposal runtime without starting Host-owned cutover', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    const persistence = new AuthorityTransferPersistence(repository, { isRecoveryOwner: () => true });
    await repository.authorityTransferRecords.save(createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      lifecycleOwnership: 'proposal',
      localRole: 'source',
      operationIntentId: 'intent-one',
      stagingDirectoryName: '.claudian-authority-transfer-transfer-one',
      status: status('collecting-readiness'),
    }));
    const prepare = jest.fn().mockResolvedValue(undefined);
    const resume = jest.fn().mockResolvedValue(undefined);
    const recovery = new AuthorityTransferRecovery(persistence, { prepare, resume }, () => undefined);
    const subsystem = lifecycle();
    recovery.register(subsystem);

    await subsystem.lifecycleRecovery.resume();

    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({
      lifecycleOwnership: 'proposal',
      transferId: 'transfer-one',
    }));
    expect(resume).not.toHaveBeenCalled();
  });

  it('repairs an interrupted unacknowledged commitment before resuming its owner', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    const persistence = new AuthorityTransferPersistence(repository, { isRecoveryOwner: () => true });
    await repository.authorityTransferRecords.save(createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      lifecycleOwnership: 'owned',
      localRole: 'source',
      operationIntentId: 'intent-one',
      stagingDirectoryName: '.claudian-authority-transfer-transfer-one',
      status: status('collecting-readiness'),
    }));
    await repository.authorityTransferClaims.save(createAuthorityTransferClaimCustodyRecord({
      batch: claimBatch(),
      createdAt: '2026-08-26T00:00:30.000Z',
      operationIntentId: 'intent-one',
      purpose: 'source-terminal',
    }));
    const resume = jest.fn().mockResolvedValue(undefined);
    const recovery = new AuthorityTransferRecovery(persistence, { resume }, () => undefined);
    const subsystem = lifecycle();
    recovery.register(subsystem);

    await expect(subsystem.lifecycleRecovery.resume()).resolves.toBeUndefined();

    expect(resume).toHaveBeenCalledTimes(1);
    await expect(repository.authorityTransferClaimCommitments.load(PROJECT_ID))
      .resolves.toMatchObject({ batchRevision: 1, projectId: PROJECT_ID });
  });

  it('resumes a terminal checkpoint until exact operation cleanup is durable', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    const persistence = new AuthorityTransferPersistence(repository, { isRecoveryOwner: () => true });
    await repository.authorityTransferRecords.save(createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      lifecycleOwnership: 'owned',
      localRole: 'source',
      operationIntentId: 'intent-one',
      stagingDirectoryName: '.claudian-authority-transfer-transfer-one',
      status: status('cancelled'),
    }));
    const resume = jest.fn(async record => persistence.completeTerminalCleanup({
      operationIntentId: record.operationIntentId,
      projectId: record.projectId,
      stagingDirectoryName: record.stagingDirectoryName,
      transferId: record.transferId,
    }));
    const recovery = new AuthorityTransferRecovery(persistence, { resume }, () => undefined);
    const subsystem = lifecycle();
    recovery.register(subsystem);

    await expect(subsystem.lifecycleRecovery.resume()).resolves.toBeUndefined();

    expect(resume).toHaveBeenCalledWith(expect.objectContaining({
      terminalCleanupCompleted: false,
      transferId: 'transfer-one',
    }), {});
    await expect(persistence.inspectLifecycleOwner(PROJECT_ID)).resolves.toBe('terminal');
  });

  it('resumes terminal cleanup after custody removal but before commitment removal', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    const persistence = new AuthorityTransferPersistence(repository, { isRecoveryOwner: () => true });
    const batch = claimBatch();
    await repository.authorityTransferRecords.save(createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      lifecycleOwnership: 'owned',
      localRole: 'source',
      operationIntentId: 'intent-one',
      stagingDirectoryName: '.claudian-authority-transfer-transfer-one',
      status: {
        ...status('cancelled'),
        batchRevision: batch.batchRevision,
        batchSha256: batch.batchSha256,
        checkpointSha256: batch.checkpointSha256,
      },
    }));
    const custody = createAuthorityTransferClaimCustodyRecord({
      batch,
      createdAt: '2026-08-26T00:00:30.000Z',
      operationIntentId: 'intent-one',
      purpose: 'source-terminal',
    });
    await repository.authorityTransferClaimCommitments.save(
      createAuthorityTransferClaimBatchCommitmentRecord(custody),
    );
    const resume = jest.fn(async record => persistence.completeTerminalCleanup({
      operationIntentId: record.operationIntentId,
      projectId: record.projectId,
      stagingDirectoryName: record.stagingDirectoryName,
      transferId: record.transferId,
    }));
    const recovery = new AuthorityTransferRecovery(persistence, { resume }, () => undefined);
    const subsystem = lifecycle();
    recovery.register(subsystem);

    await expect(subsystem.lifecycleRecovery.resume()).resolves.toBeUndefined();

    expect(resume).toHaveBeenCalledTimes(1);
    await expect(repository.authorityTransferClaimCommitments.load(PROJECT_ID))
      .resolves.toBeNull();
    await expect(persistence.inspectLifecycleOwner(PROJECT_ID)).resolves.toBe('terminal');
  });

  it('does not let a competing lifecycle owner bypass a nonterminal transfer', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    const persistence = new AuthorityTransferPersistence(repository, { isRecoveryOwner: () => true });
    await repository.authorityTransferRecords.save(createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      localRole: 'source',
      operationIntentId: 'intent-one',
      stagingDirectoryName: '.claudian-authority-transfer-transfer-one',
      status: status('source-quiesced'),
    }));
    const recovery = new AuthorityTransferRecovery(persistence, {
      resume: jest.fn().mockResolvedValue(undefined),
    }, () => undefined);
    const subsystem = lifecycle();
    recovery.register(subsystem);

    await expect(subsystem.runExclusive(
      PROJECT_ID,
      'retirement',
      'operation',
      async () => 'must-not-run',
    )).rejects.toMatchObject({
      code: 'durable-progress-recovery-required',
      safeContext: { reason: 'lifecycle-owner-pending' },
    });
  });

  it('fails closed when two real owner records are simultaneously nonterminal', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    const persistence = new AuthorityTransferPersistence(repository, { isRecoveryOwner: () => true });
    await repository.authorityTransferRecords.save(createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      localRole: 'source',
      operationIntentId: 'intent-one',
      stagingDirectoryName: '.claudian-authority-transfer-transfer-one',
      status: status('source-quiesced'),
    }));
    await repository.hostTransferRecovery.save(createHostTransferRecoveryRecord({
      ownerInstallationKey: "device-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      createdAt: '2026-08-26T00:00:00.000Z',
      direction: 'incoming',
      projectId: PROJECT_ID,
      receiverCredential: 'A'.repeat(43),
      sourceHostMemberId: 'member-source',
      stagingDirectoryName: '.claudian-host-transfer-transfer-host',
      targetCaCertificatePem: '-----BEGIN CERTIFICATE-----\nQUJD\n-----END CERTIFICATE-----\n',
      targetCaFingerprint: 'b'.repeat(64),
      targetEndpoint: 'https://192.168.1.20:27001',
      targetHostMemberId: 'member-target',
      transferId: 'transfer-host',
    }));
    const hostTransferOwner: CollabProjectLifecycleDurableOwner = {
      name: 'host-transfer',
      inspect: async projectId => {
        const record = await repository.hostTransferRecovery.load(projectId, 'incoming');
        return record ? 'nonterminal' : 'absent';
      },
    };
    const recovery = new AuthorityTransferRecovery(persistence, {
      resume: jest.fn().mockResolvedValue(undefined),
    }, () => undefined);
    const subsystem = lifecycle();
    subsystem.registerDurableOwner(hostTransferOwner);
    recovery.register(subsystem);

    await expect(subsystem.lifecycleRecovery.resume()).rejects.toMatchObject({
      code: 'durable-progress-recovery-required',
      safeContext: { reason: 'lifecycle-owner-ambiguous' },
    });
  });

  it('does not treat a proposal as irreversible lifecycle ownership', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    const persistence = new AuthorityTransferPersistence(repository, { isRecoveryOwner: () => true });
    await persistence.create(createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      localRole: 'source',
      operationIntentId: 'intent-one',
      stagingDirectoryName: '.claudian-authority-transfer-transfer-one',
      status: status('collecting-readiness'),
    }));
    const recovery = new AuthorityTransferRecovery(persistence, {
      resume: jest.fn().mockResolvedValue(undefined),
    }, () => undefined);
    const subsystem = lifecycle();
    recovery.register(subsystem);
    const operation = jest.fn().mockResolvedValue('admitted');

    await expect(subsystem.runExclusive(
      PROJECT_ID,
      'retirement',
      'operation',
      operation,
    )).resolves.toBe('admitted');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('continues recovering later Projects before reporting the first failure', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    const persistence = new AuthorityTransferPersistence(repository, { isRecoveryOwner: () => true });
    for (const [projectId, transferId] of [
      ['project-alpha', 'transfer-alpha'],
      ['project-beta', 'transfer-beta'],
    ] as const) {
      await repository.authorityTransferRecords.save(createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
        lifecycleOwnership: 'owned',
        localRole: 'source',
        operationIntentId: `intent-${projectId}`,
        stagingDirectoryName: `.claudian-authority-transfer-${transferId}`,
        status: status('collecting-readiness', projectId, transferId),
      }));
    }
    const firstError = new Error('alpha recovery unavailable');
    const resumed: string[] = [];
    const recovery = new AuthorityTransferRecovery(persistence, {
      resume: jest.fn(async record => {
        resumed.push(record.projectId);
        if (record.projectId === 'project-alpha') throw firstError;
      }),
    }, () => undefined);
    const subsystem = lifecycle();
    recovery.register(subsystem);

    await expect(subsystem.lifecycleRecovery.resume()).rejects.toBe(firstError);
    expect(resumed).toEqual(['project-alpha', 'project-beta']);
  });

  it('isolates a corrupt Project document while recovering later Projects', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    const persistence = new AuthorityTransferPersistence(repository, { isRecoveryOwner: () => true });
    await repository.authorityTransferRecords.save(createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      lifecycleOwnership: 'owned',
      localRole: 'source',
      operationIntentId: 'intent-beta',
      stagingDirectoryName: '.claudian-authority-transfer-transfer-beta',
      status: status('collecting-readiness', 'project-beta', 'transfer-beta'),
    }));
    const corruptPath = path.join(vaultRoot, repository.getProjectPaths(PROJECT_ID).authorityTransfer);
    await mkdir(path.dirname(corruptPath), { recursive: true });
    await writeFile(corruptPath, '{', { mode: 0o600 });
    const resumed: string[] = [];
    const recovery = new AuthorityTransferRecovery(persistence, {
      resume: jest.fn(async record => { resumed.push(record.projectId); }),
    }, () => undefined);
    const subsystem = lifecycle();
    recovery.register(subsystem);

    await expect(subsystem.lifecycleRecovery.resume()).rejects.toMatchObject({
      code: 'durable-progress-recovery-required',
      safeContext: { reason: 'lifecycle-owner-inspection-failed' },
    });
    expect(resumed).toEqual(['project-beta']);
  });

  it('recovers valid Projects before reporting a malformed catalog entry', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    const persistence = new AuthorityTransferPersistence(repository, { isRecoveryOwner: () => true });
    await repository.authorityTransferRecords.save(createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      lifecycleOwnership: 'owned',
      localRole: 'source',
      operationIntentId: 'intent-beta',
      stagingDirectoryName: '.claudian-authority-transfer-transfer-beta',
      status: status('collecting-readiness', 'project-beta', 'transfer-beta'),
    }));
    await mkdir(path.join(vaultRoot, '.claudian', 'collab', 'projects', 'invalid project'), {
      recursive: true,
    });
    const resumed: string[] = [];
    const recovery = new AuthorityTransferRecovery(persistence, {
      resume: jest.fn(async record => { resumed.push(record.projectId); }),
    }, () => undefined);
    const subsystem = lifecycle();
    recovery.register(subsystem);

    await expect(subsystem.lifecycleRecovery.resume()).rejects.toMatchObject({
      code: 'durable-progress-recovery-required',
      safeContext: { reason: 'authority-transfer-catalog-invalid' },
    });
    expect(resumed).toEqual(['project-beta']);
  });

  it('reloads durable state after waiting for the Project lifecycle arbiter', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    const persistence = new AuthorityTransferPersistence(repository, { isRecoveryOwner: () => true });
    await persistence.create(createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      lifecycleOwnership: 'owned',
      localRole: 'source',
      operationIntentId: 'intent-one',
      stagingDirectoryName: '.claudian-authority-transfer-transfer-one',
      status: status('collecting-readiness'),
    }));
    const resume = jest.fn().mockResolvedValue(undefined);
    const recovery = new AuthorityTransferRecovery(persistence, { resume }, () => undefined);
    const subsystem = lifecycle();
    recovery.register(subsystem);
    let releaseBlocker!: () => void;
    let enteredBlocker!: () => void;
    const blockerEntered = new Promise<void>(resolve => {
      enteredBlocker = resolve;
    });
    const blocker = new Promise<void>(resolve => {
      releaseBlocker = resolve;
    });
    const admitted = subsystem.runExclusive(
      PROJECT_ID,
      'authority-transfer',
      'recovery',
      async () => {
        enteredBlocker();
        await blocker;
      },
    );
    await blockerEntered;
    const recovering = subsystem.lifecycleRecovery.resume();
    const advanced = createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      localRole: 'source',
      operationIntentId: 'intent-one',
      stagingDirectoryName: '.claudian-authority-transfer-transfer-one',
      status: status('source-quiesced'),
    });
    await persistence.advance(advanced, 'collecting-readiness');
    releaseBlocker();

    await admitted;
    await recovering;
    expect(resume).toHaveBeenCalledWith(advanced, {});
  });
});
