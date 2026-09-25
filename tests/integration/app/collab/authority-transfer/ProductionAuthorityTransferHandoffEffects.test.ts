import { createHash } from 'node:crypto';
import fsPromises from 'node:fs/promises';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { COLLAB_CLOUD_BINDING_VERSION, COLLAB_PROTOCOL_VERSION, type CollabAuthorityTransferStatus, type CollabCloudAuthorityTransferArtifact, type CollabCloudCapability, type CollabTransferredMembershipClaimBatch, decodeCollabProjectCheckpointManifest, encodeCollabProjectCheckpointManifestCanonicalJson } from '@claudian-collab/protocol';
import { CollabFixtureSnapshot } from '@test/helpers/collab/CollabFixtureSnapshot';
import { cloudReceiptVerifier, git, HOST_CREDENTIAL, MEMBER_ID, productionAuthorityTransferFixture,PROJECT_ID, signCloudRelinquishmentProof, status, TRANSFER_ID } from '@test/helpers/collab/ProductionAuthorityTransferFixture';
import { TEST_INSTALLATION_A, TEST_INSTALLATION_B } from '@test/helpers/installations';
import { testTime } from '@test/helpers/testClock';

import { CollabProjectSetupService } from '@/app/collab';
import { HostTransferRepository } from '@/app/collab/authority/HostTransferRepository';
import { createAuthorityTransferEntryRecord } from '@/app/collab/authority-transfer/AuthorityTransferEntryRecord';
import type { AuthorityTransferLocalConvergence } from '@/app/collab/authority-transfer/AuthorityTransferLocalConvergence';
import { authorityTransferChildIdempotencyKey } from '@/app/collab/authority-transfer/AuthorityTransferOperationIdentity';
import { createAuthorityTransferCheckpointManifest } from '@/app/collab/authority-transfer/checkpoint/AuthorityTransferCheckpointManifest';
import { LanToCloudSourceCoordinator } from '@/app/collab/authority-transfer/lan-to-cloud/LanToCloudSourceCoordinator';
import { ProductionLanToCloudSourceEffects } from '@/app/collab/authority-transfer/lan-to-cloud/ProductionLanToCloudSourceEffects';
import { isCollabLocalLanMembership } from '@/app/collab/CollabLocalProjectRepository';
import { HostTrustTransitionService } from '@/app/collab/host-transfer/HostTrustTransitionService';
import { LanAuthorityTransferClient } from '@/app/collab/lan/authority-transfer/LanAuthorityTransferClient';
import type { CloudAuthorityConnection } from '@/app/collab/remote-authority/CloudAuthorityAdapter';
import { cloudProjectGitRemoteUrl } from '@/app/collab/remote-authority/CloudAuthorityUrls';
import type { CollabAuthorityLifecyclePort } from '@/app/collab/remote-authority/CollabAuthorityLifecyclePort';
import type { CollabAuthorityEventConnectionInput } from '@/app/collab/remote-authority/CollabAuthoritySession';

jest.setTimeout(30_000);

jest.mock('sql.js/dist/sql-wasm.wasm', () => ({
  __esModule: true,
  default: jest.requireActual('node:fs').readFileSync(require.resolve('sql.js/dist/sql-wasm.wasm')),
}));

describe('production authority-transfer hosting handoff effects', () => {
  const fixture = productionAuthorityTransferFixture();
  const { captureSource, restoreStoppedCloudToLanTarget, createCollabFeatureSubcomposition, foundation } = fixture;
  let sourceRoot: string;
  let targetRoot: string;
  beforeEach(() => {
    sourceRoot = fixture.sourceRoot;
    targetRoot = fixture.targetRoot;
  });

  let importedSnapshot: CollabFixtureSnapshot | undefined;
  let importedClaims: Pick<Awaited<ReturnType<typeof restoreStoppedCloudToLanTarget>>, 'claimRequest' | 'firstReceipt'>;

  afterAll(async () => { await importedSnapshot?.dispose(); });

  async function restoreImportedHost() {
    // These cases vary physical handoff after a completed import. Keep the
    // full import-to-offer journey in the separate test below.
    if (!importedSnapshot) {
      const imported = await restoreStoppedCloudToLanTarget();
      importedClaims = structuredClone({ claimRequest: imported.claimRequest, firstReceipt: imported.firstReceipt });
      await fixture.closeParticipants();
      importedSnapshot = await CollabFixtureSnapshot.capture(targetRoot);
    }
    await importedSnapshot.restore();
    let host = foundation(targetRoot);
    const membership = await host.local.projects.loadMembership(PROJECT_ID);
    if (membership?.authority.kind !== 'lan') throw new Error('Missing imported Host membership');
    const routeStart = jest.spyOn(host.lanHost, 'startAuthorityTransferRoute');
    const restartedComposition = createCollabFeatureSubcomposition({
      foundation: host,
      projectSetup: new CollabProjectSetupService(host, { installationKey: TEST_INSTALLATION_A, vaultRoot: targetRoot }),
      vaultRoot: targetRoot,
    });
    await restartedComposition.feature.initialize();
    await restartedComposition.feature.restoreLifecycle();
    const route = await routeStart.mock.results[0]?.value;
    routeStart.mockRestore();
    if (!route) throw new Error('Missing imported claim responder');
    const targetAuthority = await host.inspectAuthority(PROJECT_ID);
    if (!targetAuthority) throw new Error('Missing imported authority');
    const claimClient = new LanAuthorityTransferClient({
      authorityGeneration: 3,
      caCertificatePem: membership.authority.hostCaCertificatePem!,
      caFingerprint: membership.authority.hostCaFingerprint!,
      endpoint: route.endpoint,
      projectId: PROJECT_ID,
    });
    const { claimRequest, firstReceipt } = structuredClone(importedClaims);
    return {
      claimRequest, firstReceipt, claimClient, restartedComposition, targetAuthority,
      get foundation() { return host; },
      restart: async () => {
        await host.close();
        host = foundation(targetRoot);
      },
    };
  }

  it('offers a new physical Host handoff after Cloud import while retaining claim replay', async () => {
    const target = await restoreStoppedCloudToLanTarget();
    try {
      await target.restartedComposition.feature.startHost(PROJECT_ID);
      const handle = {
        schemaVersion: 1 as const,
        operationIntentId: target.completedRecord.operationIntentId,
        preparationId: target.targetEntry.operationIntentId,
        projectId: PROJECT_ID,
        selectedTargetMemberId: target.targetEntry.selectedTargetMemberId,
        sourceAuthorityGeneration: target.targetEntry.sourceAuthorityGeneration,
        sourceCloudUrl: target.targetEntry.sourceCloudUrl,
        targetUrl: target.completedRecord.status.targetUrl,
        transferId: TRANSFER_ID,
      };
      await expect(target.restartedComposition.feature.createHostTransfer({
        projectId: PROJECT_ID, targetMemberId: 'member-missing',
      })).resolves.toMatchObject({ status: 'failure' });
      await expect(target.restartedComposition.feature.acceptCloudToLanTransfer(handle))
        .resolves.toMatchObject({ status: 'success', value: { state: 'completed' } });
      await expect(target.claimClient.claimTransferredMembership({
        ...target.claimRequest, idempotencyKey: 'claim-after-rejected-host-offer',
      })).resolves.toMatchObject({ memberId: MEMBER_ID });
      const actualRename = fsPromises.rename;
      const retentionWrite = jest.spyOn(fsPromises, 'rename').mockImplementation(async (from, to) => {
        if (String(to).split(path.sep).includes('authority-transfer-history')) throw new Error('simulated retention persistence failure');
        return actualRename(from, to);
      });
      await expect(target.restartedComposition.feature.createHostTransfer({
        projectId: PROJECT_ID, targetMemberId: MEMBER_ID,
      })).resolves.toMatchObject({ status: 'success' });
      retentionWrite.mockRestore();
      await expect(target.restartedComposition.feature.restoreLifecycle()).resolves.toBeUndefined();
      const snapshot = await target.restartedComposition.feature.readSnapshot(PROJECT_ID);
      if (snapshot.status !== 'success') throw new Error('Missing Host snapshot');
      expect(snapshot.value.snapshot).toMatchObject({
        hostTransfer: { targetMemberId: MEMBER_ID, phase: 'offered' },
      });
      expect(await target.foundation.authorityTransfers.inspectLifecycleOwner(PROJECT_ID)).toBe('absent');
      expect(await target.foundation.authorityTransfers.listRetained(PROJECT_ID))
        .toEqual(expect.arrayContaining([expect.objectContaining({ transferId: TRANSFER_ID })]));
      await expect(target.claimClient.claimTransferredMembership(target.claimRequest))
        .resolves.toEqual(target.firstReceipt);
    } finally {
      await target.restartedComposition.feature.close();
    }
  });

  // This workflow combines native Git/SQL transfer, restart and recovery; its
  // Windows execution exceeds the ordinary 30-second isolated-test budget.
  it.each(['absent', 'older', 'interrupted', 'projection-interrupted', 'activation-interrupted', 'same', 'newer'] as const)('completes or safely rejects physical Host handoff after Cloud import (former local authority: %s)', async formerState => {
    const target = await restoreImportedHost();
    const receiverRoot = await mkdtemp(path.join(tmpdir(), 'claudian-after-cloud-handoff-'));
    const receiverFoundation = foundation(receiverRoot, TEST_INSTALLATION_B);
    const receiver = createCollabFeatureSubcomposition({
      foundation: receiverFoundation,
      projectSetup: new CollabProjectSetupService(receiverFoundation, {
        installationKey: TEST_INSTALLATION_B, vaultRoot: receiverRoot,
      }),
      vaultRoot: receiverRoot,
    });
    try {
      await target.targetAuthority.database.mutate(connection => {
        connection.run("UPDATE members SET role = 'manager' WHERE member_id = 'member-production-peer'");
        connection.run('UPDATE project SET manager_set_generation = manager_set_generation + 1');
      });
      await target.restartedComposition.feature.startHost(PROJECT_ID);
      const sourceMembership = await target.foundation.local.projects.loadMembership(PROJECT_ID);
      if (sourceMembership?.authority.kind !== 'lan') throw new Error('Missing source LAN membership');
      const pinnedSourceCa = sourceMembership.authority.hostCaCertificatePem!;
      await receiver.feature.initialize();
      const invitation = await target.restartedComposition.feature.createInvitation(PROJECT_ID);
      if (invitation.status !== 'success') throw new Error('Missing invitation');
      const joined = await receiver.feature.joinProject({
        encodedInvitation: invitation.value.encodedInvitation, memberDisplayName: 'Next Host',
      });
      if (joined.status !== 'success') throw new Error('Receiver join failed');
      let formerDirectory: string | undefined;
      let formerBytes: Buffer | undefined;
      if (formerState !== 'absent') {
        const former = await receiverFoundation.createAuthority(PROJECT_ID);
        await former.database.mutate(connection => former.projects.initialize(connection, {
          createdAt: '2026-08-08T00:00:00.000Z',
          hostCredentialHash: createHash('sha256').update(HOST_CREDENTIAL).digest(),
          hostDisplayName: 'Former Host', hostMemberId: MEMBER_ID, name: 'Portable', projectId: PROJECT_ID,
        }));
        if (formerState === 'same' || formerState === 'newer') {
          await former.database.mutate(connection => connection.run(
            'UPDATE authority_metadata SET authority_generation = ?', [formerState === 'same' ? 3 : 5],
          ));
        }
        await receiverFoundation.local.projects.bindOwnedAuthorityOperation(former.resource, {
          kind: 'setup', operationId: 'former-host-setup', transferId: null,
          sourceGeneration: null, targetGeneration: 1,
        });
        git(former.authorityDirectory, ['init', '--bare', 'repository.git']);
        await receiverFoundation.closeAuthority(PROJECT_ID);
        formerDirectory = former.authorityDirectory;
        formerBytes = await readFile(path.join(formerDirectory, 'collab.db'));
      }
      const interruptedRequest = { ...target.claimRequest, idempotencyKey: 'claim-before-physical-handoff' };
      const actualRename = fsPromises.rename;
      const receiptWrite = jest.spyOn(fsPromises, 'rename').mockImplementation(async (from, to) => {
        if (path.basename(String(to)) === 'target-private.json') {
          const partial = JSON.parse(await readFile(from, 'utf8')) as { receipts: Record<string, { operationIntentId: string }> };
          if (Object.values(partial.receipts).some(receipt => receipt.operationIntentId === interruptedRequest.idempotencyKey)) {
            throw new Error('simulated receipt persistence failure');
          }
        }
        return actualRename(from, to);
      });
      await expect(target.claimClient.claimTransferredMembership(interruptedRequest))
        .rejects.toMatchObject({ code: 'operation-failed' });
      receiptWrite.mockRestore();
      const local = await receiverFoundation.local.projects.loadMembership(PROJECT_ID);
      if (!local) throw new Error('Receiver membership missing');
      const worktree = path.join(receiverRoot, local.project.workspacePath);
      await writeFile(path.join(worktree, 'uncommitted.md'), 'Preserve receiver work.\n');
      const beforeWork = { head: git(worktree, ['rev-parse', 'HEAD']), status: git(worktree, ['status', '--porcelain']) };
      let detachInterrupted = false;
      let targetTicketId: string | undefined;
      const detachWrite = jest.spyOn(fsPromises, 'rename').mockImplementation(async (from, to) => {
        if (formerState === 'interrupted' && !detachInterrupted && String(from) === formerDirectory
          && String(to).endsWith('.tree')) {
          detachInterrupted = true;
          throw new Error('simulated authority detachment interruption');
        }
        if (formerState === 'activation-interrupted' && !detachInterrupted
          && String(to) === path.join(receiverRoot, '.claudian/collab/projects', PROJECT_ID, 'host-transfer-recovery.json')) {
          const next = JSON.parse(await readFile(from, 'utf8')) as { phase: string };
          if (next.phase === 'completed') {
            detachInterrupted = true;
            throw new Error('simulated interruption after target route activation');
          }
        }
        if (formerState === 'projection-interrupted' && !detachInterrupted
          && String(to) === path.join(receiverRoot, '.claudian/collab/projects', PROJECT_ID, 'membership.json')) {
          const next = JSON.parse(await readFile(from, 'utf8')) as { hostOwnership?: { ownsAuthority?: boolean } };
          if (next.hostOwnership?.ownsAuthority) {
            await actualRename(from, to);
            detachInterrupted = true;
            throw new Error('simulated interruption after target projection commit');
          }
        }
        return actualRename(from, to);
      });
      await expect(target.restartedComposition.feature.createHostTransfer({
        projectId: PROJECT_ID, targetMemberId: local.member.id,
      })).resolves.toMatchObject({ status: 'success' });
      await expect(target.claimClient.claimTransferredMembership({
        ...target.claimRequest, idempotencyKey: 'late-claim-after-physical-offer',
      })).rejects.toMatchObject({ code: 'operation-failed' });
      const deadline = Date.now() + 20_000;
      let transferId: string | undefined;
      while (Date.now() < deadline) {
        const snapshot = await receiver.feature.readSnapshot(PROJECT_ID);
        if (snapshot.status === 'success' && 'hostTransfer' in snapshot.value.snapshot) {
          transferId = snapshot.value.snapshot.hostTransfer?.transferId;
          if (transferId) break;
        }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      if (!transferId) throw new Error('Host offer did not arrive');
      await expect(receiver.feature.acceptHostTransfer({ projectId: PROJECT_ID, transferId }))
        .resolves.toMatchObject({ status: 'success' });
      const assertProjectionRemainsInert = async () => {
        await expect(receiver.feature.startHost(PROJECT_ID)).resolves.toMatchObject({
          status: 'failure', error: { code: 'durable-progress-recovery-required' },
        });
        expect(receiverFoundation.lanHost.isProjectRunning(PROJECT_ID)).toBe(false);
      };
      const assertRejectedTransferPreservesAuthority = async () => {
        await expect(receiver.feature.restoreLifecycle()).rejects.toMatchObject({
          safeContext: { reason: 'host-transfer-former-source-not-replaceable' },
        });
        expect(await readFile(path.join(formerDirectory!, 'collab.db'))).toEqual(formerBytes);
        expect(receiverFoundation.lanHost.isProjectRunning(PROJECT_ID)).toBe(false);
        expect(target.foundation.lanHost.isProjectRunning(PROJECT_ID)).toBe(false);
        expect({ head: git(worktree, ['rev-parse', 'HEAD']), status: git(worktree, ['status', '--porcelain']) }).toEqual(beforeWork);
      };
      if (formerState === 'same' || formerState === 'newer' || formerState === 'interrupted' || formerState === 'projection-interrupted' || formerState === 'activation-interrupted') {
        while (Date.now() < deadline) {
          const recovery = await receiverFoundation.local.projects.hostTransferRecovery.load(PROJECT_ID, 'incoming');
          if (formerState.endsWith('interrupted') ? detachInterrupted : recovery?.phase === 'authority-relinquished') break;
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        if (!formerState.endsWith('interrupted')) {
          await assertRejectedTransferPreservesAuthority();
          detachWrite.mockRestore();
          return;
        }
        if (!detachInterrupted) throw new Error('Expected authority detachment interruption');
        if (formerState === 'projection-interrupted') await assertProjectionRemainsInert();
        if (formerState === 'activation-interrupted') {
          const created = await receiver.feature.createTicket({ projectId: PROJECT_ID, title: 'Keep after activation', body: 'Committed target work' });
          if (created.status !== 'success') throw new Error('Target mutation failed');
          targetTicketId = created.value.ticket.id;
        }
        await receiver.feature.restoreLifecycle().catch(error => { throw new Error('receiver recovery failed', { cause: error }); });
        await target.restartedComposition.feature.restoreLifecycle().catch(error => { throw new Error('source recovery failed', { cause: error }); });
      }
      detachWrite.mockRestore();
      while (Date.now() < deadline) {
        const membership = await receiverFoundation.local.projects.loadMembership(PROJECT_ID);
        const previousHost = await target.foundation.local.projects.loadMembership(PROJECT_ID);
        if (membership && isCollabLocalLanMembership(membership) && membership.hostOwnership.ownsAuthority
          && previousHost && isCollabLocalLanMembership(previousHost) && !previousHost.hostOwnership.ownsAuthority) break;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      await expect(receiverFoundation.local.projects.loadMembership(PROJECT_ID))
        .resolves.toMatchObject({ hostOwnership: { ownsAuthority: true }, authority: { authorityGeneration: 3 } });
      await expect(target.foundation.local.projects.loadMembership(PROJECT_ID))
        .resolves.toMatchObject({ hostOwnership: { ownsAuthority: false } });
      await expect(target.restartedComposition.feature.readSnapshot(PROJECT_ID)).resolves.toMatchObject({
        status: 'success', value: { source: 'online', snapshot: { project: { hostMemberId: local.member.id } } },
      });
      await expect(receiver.feature.readSnapshot(PROJECT_ID)).resolves.toMatchObject({
        status: 'success', value: { source: 'online', snapshot: { project: { hostMemberId: local.member.id } } },
      });
      expect({ head: git(worktree, ['rev-parse', 'HEAD']), status: git(worktree, ['status', '--porcelain']) }).toEqual(beforeWork);
      expect(await readFile(path.join(worktree, 'uncommitted.md'), 'utf8')).toBe('Preserve receiver work.\n');
      const retainedTicket = targetTicketId ? await receiver.feature.readTicket(PROJECT_ID, targetTicketId) : null;
      expect(retainedTicket?.status === 'success'
        ? { title: retainedTicket.value.detail.ticket.title, body: retainedTicket.value.detail.body } : retainedTicket)
        .toEqual(formerState === 'activation-interrupted'
          ? { title: 'Keep after activation', body: 'Committed target work' } : null);

      const currentAuthority = await receiverFoundation.openAuthority(PROJECT_ID);
      const committed = await currentAuthority.database.read(connection => ({
        certificate: new HostTransferRepository().get(connection, transferId!)?.activationCertificate,
        proofs: new HostTransferRepository().listActivationProofs(connection, 3),
      }));
      expect(committed.certificate?.authorityProof).toMatchObject({ authorityGeneration: 3 });
      expect(committed.proofs).toHaveLength(1);
      expect(committed.proofs[0]).toMatchObject({
        authorityGeneration: 3, transferId, targetHostMemberId: local.member.id,
      });
      if (!committed.certificate) throw new Error('Missing committed Host activation certificate');
      expect(() => new HostTrustTransitionService().verifyActivation(
        committed.certificate!, pinnedSourceCa, {
          ...committed.certificate!, authorityGeneration: 3,
        },
      )).not.toThrow();

      await expect(target.claimClient.claimTransferredMembership(target.claimRequest))
        .resolves.toEqual(target.firstReceipt);
      await expect(target.claimClient.claimTransferredMembership(interruptedRequest))
        .resolves.toMatchObject({ memberId: MEMBER_ID, operationIntentId: interruptedRequest.idempotencyKey });
      await target.restartedComposition.feature.close();
      await target.restart();
      const restoredRouteStart = jest.spyOn(target.foundation.lanHost, 'startAuthorityTransferRoute');
      const restarted = createCollabFeatureSubcomposition({
        foundation: target.foundation,
        projectSetup: new CollabProjectSetupService(target.foundation, {
          installationKey: TEST_INSTALLATION_A, vaultRoot: targetRoot,
        }),
        vaultRoot: targetRoot,
      });
      try {
        await restarted.feature.initialize();
        await restarted.feature.restoreLifecycle().catch(error => { throw new Error('source restart recovery failed', { cause: error }); });
        const restoredSession = await restoredRouteStart.mock.results[0]?.value;
        restoredRouteStart.mockRestore();
        if (!restoredSession) throw new Error('Missing restored terminal listener');
        const restoredClaimClient = new LanAuthorityTransferClient({
          caCertificatePem: sourceMembership.authority.hostCaCertificatePem!,
          caFingerprint: sourceMembership.authority.hostCaFingerprint!,
          endpoint: restoredSession.endpoint,
          projectId: PROJECT_ID,
        });
        await expect(restoredClaimClient.claimTransferredMembership(interruptedRequest))
          .resolves.toMatchObject({ memberId: MEMBER_ID, operationIntentId: interruptedRequest.idempotencyKey });
        await expect(target.foundation.inspectAuthority(PROJECT_ID)).resolves.toBeNull();
      } finally {
        await restarted.feature.close();
      }
      const nextStatus: CollabAuthorityTransferStatus = {
        ...status('lan-to-cloud', 'collecting-readiness', 'https://cloud.example.test/'),
        sourceAuthority: { generation: 3, kind: 'lan' },
        targetAuthority: { generation: 4, kind: 'cloud' },
        transferId: 'transfer-return-after-handoff',
      };
      const nextEntry = createAuthorityTransferEntryRecord({
        ownerInstallationKey: TEST_INSTALLATION_B, proposedByMemberId: local.member.id,
        request: { projectId: PROJECT_ID, expectedAuthorityGeneration: 3,
          idempotencyKey: 'intent-return-after-handoff', targetUrl: nextStatus.targetUrl },
        status: nextStatus,
      });
      await receiverFoundation.authorityTransfers.proposeEntry(nextEntry);
      const submitted = jest.fn(async () => { throw new Error('Cloud request captured'); });
      const coordinator = new LanToCloudSourceCoordinator({
        cloud: { authorityTransfer: submitted } as unknown as CollabAuthorityLifecyclePort,
        installationKey: TEST_INSTALLATION_B, persistence: receiverFoundation.authorityTransfers,
        source: new ProductionLanToCloudSourceEffects({
          cloudSession: { principalId: 'principal:receiving-host' } as CloudAuthorityConnection,
          convergence: {} as AuthorityTransferLocalConvergence, foundation: receiverFoundation,
          persistence: receiverFoundation.authorityTransfers, projectId: PROJECT_ID,
        }),
      });
      await expect(coordinator.acceptAndTransfer({
        projectId: PROJECT_ID, transferId: nextStatus.transferId, expectedAuthorityGeneration: 3,
        targetUrl: nextStatus.targetUrl,
        idempotencyKey: authorityTransferChildIdempotencyKey(nextEntry.request.idempotencyKey, 'accept'),
      })).rejects.toThrow('Cloud request captured');
      expect(submitted).toHaveBeenCalledWith('beginLanToCloudTransfer', expect.objectContaining({
        expectedSourceAuthorityGeneration: 3, sourceHostMemberId: local.member.id,
        hostActivationProofs: committed.proofs,
      }), {});
    } finally {
      await receiver.feature.close();
      await receiverFoundation.close();
      await target.restartedComposition.feature.close();
      await rm(receiverRoot, { recursive: true, force: true });
    }
  }, 90_000);

  // This workflow combines native Git/SQL transfer, restart and recovery; its
  // Windows execution exceeds the ordinary 30-second isolated-test budget.
  it.each([[false, false], [true, false], [true, true]])('moves Cloud authority through the composed feature facade (single Member: %s, interrupted Manager settlement: %s)', async (singleMember, interruptManagerSettlement) => {
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

    const observers = new Set<CollabAuthorityEventConnectionInput>();
    let begun = false;
    let hostingPreparation: Record<string, unknown> | null = null;
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
        if (operation === 'registerCloudToLanPreparation') {
          hostingPreparation ??= { caCertificatePem: input.caCertificatePem, caFingerprint: input.caFingerprint,
            createdAt: testTime({ days: 1 }), expiresAt: input.expiresAt,
            preparationId: input.idempotencyKey, projectId: PROJECT_ID, sourceAuthorityGeneration: 2,
            targetHostMemberId: targetMemberId, targetUrl: input.targetUrl, withdrawnAt: null };
          return hostingPreparation;
        }
        if (operation === 'listCloudToLanPreparations') return { preparations: begun || !hostingPreparation ? [] : [hostingPreparation] };
        if (operation === 'getCloudToLanPreparationApproval') return { approval: transferStatus };
        if (operation === 'beginCloudToLanTransfer') {
          begun = true;
          transferStatus = status(
            'cloud-to-lan',
            'collecting-readiness',
            input.targetUrl as string,
          );
          for (const observer of observers) void observer.onInvalidation({ kind: 'snapshot', sequence: 1 }).catch(() => undefined);
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
            committedAt: new Date(target.foundation.now().getTime() + 60_000).toISOString(),
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
          events: { connect: (input: CollabAuthorityEventConnectionInput) => {
            observers.add(input);
            queueMicrotask(() => input.onConnectionResult?.());
            return { dispose: () => { observers.delete(input); } };
          } },
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
    const replayAccepted = async (handle: Parameters<typeof target.composition.feature.acceptCloudToLanTransfer>[0]) => {
      await expect(target.composition.feature.acceptCloudToLanTransfer(handle))
        .resolves.toMatchObject({ status: 'success', value: { state: 'completed' } });
    };
    const recoverInterruptedManager = async (result: { status: string }) => {
      expect(result.status).not.toBe('success');
      expect(await target.foundation.authorityTransfers.load(PROJECT_ID)).toBeNull();
      expect(await target.foundation.authorityTransfers.loadCloudToLanManagerEntry(PROJECT_ID))
        .toMatchObject({ phase: 'observing' });
      cloudAuthority.connectAuthorityTransfer.mockRejectedValue(new Error('old Cloud is offline'));
      await expect(target.composition.feature.restoreLifecycle()).resolves.toBeUndefined();
      await expect(target.composition.feature.proposeLanToCloudTransfer({
        projectId: PROJECT_ID, serverUrl: cloudServerUrl,
      })).resolves.toMatchObject({ status: 'success', value: { phase: 'collecting-readiness' } });
      const binding = await target.composition.authorityTransfer.bindLanToCloudSource({
        cloudSession: { projectId: PROJECT_ID, serverUrl: cloudServerUrl, supports: () => true } as unknown as CloudAuthorityConnection,
        projectId: PROJECT_ID,
      });
      await binding.dispose();
    };
    try {
      const { accepted, handle } = await (async () => {
        if (singleMember) {
          const actualRename = fsPromises.rename;
          const interruptedSettlement = interruptManagerSettlement
            ? jest.spyOn(fsPromises, 'rename').mockImplementation(async (from, to) => {
              if (path.basename(String(to)) === 'manager.json') {
                const entry = JSON.parse(await readFile(from, 'utf8'));
                if (entry.phase === 'settled') throw new Error('process stopped after target archival');
              }
              return actualRename(from, to);
            }) : null;
          let result = await target.composition.feature.moveCloudToLan(PROJECT_ID);
          interruptedSettlement?.mockRestore();
          if (interruptManagerSettlement) {
            await recoverInterruptedManager(result);
            result = { status: 'success', value: transferStatus! };
          }
          if (result.status !== 'success') {
            if ('error' in result) throw result.error;
            throw new Error(`Local move returned ${result.status}`);
          }
          return { accepted: result, handle: null };
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
        projectId: PROJECT_ID, preparationId: prepared.value.preparationId,
      });
      expect(begunResult).toMatchObject({
        status: 'success',
        value: { selectedTargetMemberId: targetMemberId },
      });
      if (begunResult.status !== 'success') throw new Error('Manager begin failed');
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const record = await target.foundation.authorityTransfers.load(PROJECT_ID, begunResult.value.transferId);
        if (record?.status.state === 'completed') return {
          accepted: { status: 'success' as const, value: record.status }, handle: begunResult.value,
        };
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      const stalled = await target.foundation.local.projects.authorityTransferRecords.load(PROJECT_ID);
      throw new Error(JSON.stringify({ reason: 'receiver-stalled', observers: observers.size, phase: stalled?.status.phase, operations: transferLifecycle.authorityTransfer.mock.calls.map(call => call[0]) }));
      })();
      expect(accepted).toMatchObject({ status: 'success' });
      if (accepted.status !== 'success') {
        if ('error' in accepted) throw accepted.error;
        throw new Error(`Target acceptance returned ${accepted.status}`);
      }
      expect(accepted.value).toMatchObject({ state: 'completed' });
      if (handle) await replayAccepted(handle);
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
      if (handle) await replayAccepted(handle);
      await target.composition.feature.restoreHosts();
      const nextProposal = await target.composition.feature.proposeLanToCloudTransfer({
            projectId: PROJECT_ID,
            serverUrl: cloudServerUrl,
          });
      if (nextProposal.status === 'failure') throw nextProposal.error;
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
  }, 90_000);
});
