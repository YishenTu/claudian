import { createHash, generateKeyPairSync } from 'node:crypto';
import fsPromises from 'node:fs/promises';
import { access, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { type CollabAuthorityTransferStatus } from '@claudian-collab/protocol';
import { git, HOST_CREDENTIAL, MEMBER_ID, OPERATION_ID, productionAuthorityTransferFixture,PROJECT_ID, status, TRANSFER_ID } from '@test/helpers/collab/ProductionAuthorityTransferFixture';
import { TEST_INSTALLATION_A, TEST_INSTALLATION_B } from '@test/helpers/installations';
import { testDate, testTime } from '@test/helpers/testClock';

import { CollabProjectSetupService } from '@/app/collab';
import { AuthorityMetadataRepository } from '@/app/collab/authority/AuthorityMetadataRepository';
import { createAuthorityTransferEntryRecord } from '@/app/collab/authority-transfer/AuthorityTransferEntryRecord';
import { createAuthorityTransferRecord } from '@/app/collab/authority-transfer/AuthorityTransferRecord';
import { advanceAuthorityTransferClaimantRecord, createAuthorityTransferClaimantRecord } from '@/app/collab/authority-transfer/claim/AuthorityTransferClaimantRecord';
import { ProductionCloudToLANTargetEffects } from '@/app/collab/authority-transfer/cloud-to-lan/ProductionCloudToLANTargetEffects';
import { ProductionLANToCloudSourceEffects } from '@/app/collab/authority-transfer/lan-to-cloud/ProductionLANToCloudSourceEffects';
import { AuthorityTransferPersistence } from '@/app/collab/authority-transfer/persistence/AuthorityTransferPersistence';
import { type CollabLocalLANMembershipRecord, type CollabLocalMembershipRecord, isCollabLocalCloudMembership } from '@/app/collab/CollabLocalProjectRepository';
import { PinnedCollabHTTPClient } from '@/app/collab/lan/CollabHTTPClient';
import { MembershipControlClient } from '@/app/collab/membership/MembershipControlClient';
import { decodeLANMembershipClaimInvitation, encodeLANMembershipClaimInvitation } from '@/app/collab/project/LANMembershipClaimInvitation';
import type { CloudAuthorityConnection } from '@/app/collab/remote-authority/CloudAuthorityAdapter';

jest.setTimeout(30_000);

jest.mock('sql.js/dist/sql-wasm.wasm', () => ({
  __esModule: true,
  default: jest.requireActual('node:fs').readFileSync(require.resolve('sql.js/dist/sql-wasm.wasm')),
}));

describe('production Cloud-to-LAN target recovery effects', () => {
  const fixture = productionAuthorityTransferFixture();
  const { prepareCloudToLanTarget, stageCloudToLanTarget, activateCloudToLanTarget, restoreStoppedCloudToLanTarget, createCollabFeatureSubcomposition, foundation } = fixture;
  let sourceRoot: string;
  let targetRoot: string;
  beforeEach(() => {
    sourceRoot = fixture.sourceRoot;
    targetRoot = fixture.targetRoot;
  });

  it('releases completed Cloud import ownership while preserving member claim replay', async () => {
    const target = await restoreStoppedCloudToLanTarget();
    try {
      await expect(target.foundation.authorityTransfers.load(PROJECT_ID)).resolves.toBeNull();
      await expect(target.foundation.authorityTransfers.inspectLifecycleOwner(PROJECT_ID)).resolves.toBe('absent');
      await expect(target.claimClient.claimTransferredMembership(target.claimRequest))
        .resolves.toEqual(target.firstReceipt);
      await expect(target.restartedComposition.feature.startHost(PROJECT_ID))
        .resolves.toMatchObject({ status: 'success' });
    } finally {
      await target.restartedComposition.feature.close();
    }
  });

  it.each(['none', 'confirmed', 'origin-written'] as const)('restores an older LAN Member through a current recovery string without changing local work (previous attempt: %s)', async previousAttempt => {
    const target = await activateCloudToLanTarget();
    await target.recoveringEffects().restoreCompleted(target.completedRecord);
    await target.targetAuthority.database.mutate(connection => {
      connection.run("UPDATE members SET role = 'manager' WHERE member_id = 'member-production-peer'");
      connection.run('UPDATE project SET manager_set_generation = manager_set_generation + 1');
    });
    const host = await target.foundation.local.projects.loadMembership(PROJECT_ID);
    if (!host || host.authority.kind !== 'lan' || !('credential' in host.member)) throw new Error('Missing current LAN Host');
    const targetHost = { caCertificatePem: host.authority.hostCaCertificatePem!, caFingerprint: host.authority.hostCaFingerprint!, endpoint: host.authority.endpoint! };
    const control = new MembershipControlClient(new PinnedCollabHTTPClient({ ...targetHost, projectId: PROJECT_ID }, 10_000));
    const members = await control.listProjectMembers({ projectId: PROJECT_ID, memberCredential: host.member.credential });
    const offline = members.members.find(member => member.memberId === MEMBER_ID)!;
    const issued = await control.reissueTransferredMembershipClaim({ projectId: PROJECT_ID, memberId: MEMBER_ID,
      expectedClaimGeneration: offline.importedClaimGeneration!, expectedMembershipRevision: offline.membershipRevision,
      expectedManagerSetGeneration: members.managerSetGeneration, idempotencyKey: 'restore-offline-member', memberCredential: host.member.credential });
    const encoded = encodeLANMembershipClaimInvitation({ claim: issued, targetHost });
    expect(decodeLANMembershipClaimInvitation(encoded).claim.memberId).toBe(MEMBER_ID);
    const clientRoot = await mkdtemp(path.join(tmpdir(), 'claudian-restoring-member-'));
    const clientFoundation = foundation(clientRoot, TEST_INSTALLATION_B);
    try {
      await clientFoundation.local.workspace.claimProjectsFolder('workspace');
      const old = await target.sourceFoundation.local.projects.loadMembership(PROJECT_ID);
      if (!old || old.authority.kind !== 'lan') throw new Error('Missing old LAN membership');
      const worktree = path.join(clientRoot, old.project.workspacePath);
      await fsPromises.cp(path.join(sourceRoot, old.project.workspacePath), worktree, { recursive: true });
      await writeFile(path.join(worktree, 'uncommitted.md'), 'Local work survives recovery.\n');
      const before = git(worktree, ['status', '--porcelain']);
      const head = git(worktree, ['rev-parse', 'HEAD']);
      await clientFoundation.local.projects.saveMembership({ ...old, hostOwnership: { ownsAuthority: false, autoStart: false } } as CollabLocalLANMembershipRecord);
      await clientFoundation.local.projects.repairIndexFromMemberships();
      if (previousAttempt !== 'none') {
        const priorStatus: CollabAuthorityTransferStatus = {
          ...status('lan-to-cloud', 'completed', 'https://intermediate.example.test/'),
          state: 'completed', batchRevision: 1, batchSha256: 'b'.repeat(64), checkpointSha256: 'a'.repeat(64),
          relinquishmentProof: {
            batchRevision: 1, batchSha256: 'b'.repeat(64), checkpointSha256: 'a'.repeat(64),
            certificate: Buffer.alloc(64, 2).toString('base64url'), certificateAlgorithm: 'ed25519',
            committedAt: testTime({ days: 1, minutes: 2 }), operationIntentId: OPERATION_ID, projectId: PROJECT_ID,
            sourceAuthority: { generation: 1, kind: 'lan' }, sourceHostMemberId: MEMBER_ID,
            targetAuthority: { generation: 2, kind: 'cloud' }, transferId: TRANSFER_ID,
          },
        };
        const claim = { claim: Buffer.alloc(32, 4).toString('base64url'), expiresAt: priorStatus.expiresAt,
          memberId: MEMBER_ID, projectId: PROJECT_ID, targetAuthorityGeneration: 2, transferId: TRANSFER_ID };
        let pending = createAuthorityTransferClaimantRecord({ cloudPrincipalId: 'vault-' + 'a'.repeat(64),
          createdAt: priorStatus.createdAt, memberId: MEMBER_ID, operationIntentId: 'old-automatic-claim', status: priorStatus });
        pending = advanceAuthorityTransferClaimantRecord(pending, { phase: 'claim-retained', claim, updatedAt: priorStatus.updatedAt });
        pending = advanceAuthorityTransferClaimantRecord(pending, { phase: 'credential-persisted', updatedAt: priorStatus.updatedAt });
        pending = advanceAuthorityTransferClaimantRecord(pending, { phase: 'target-claimed', updatedAt: testTime({ days: 1, minutes: 3 }),
          redemptionReceipt: { checkpointSha256: 'a'.repeat(64), claimSha256: createHash('sha256').update(claim.claim).digest('hex'),
            memberId: MEMBER_ID, projectId: PROJECT_ID, transferId: TRANSFER_ID, targetAuthorityGeneration: 2,
            operationIntentId: 'old-automatic-claim', receiptId: 'old-receipt', receiptKeyId: 'old-key',
            redeemedAt: testTime({ days: 1, minutes: 3 }), signature: Buffer.alloc(64, 3).toString('base64url'), signatureAlgorithm: 'ed25519' } });
        pending = advanceAuthorityTransferClaimantRecord(pending, { phase: 'source-acknowledged', updatedAt: pending.updatedAt });
        await clientFoundation.local.projects.authorityTransferClaimants.save(pending);
        if (previousAttempt === 'origin-written') git(worktree, ['remote', 'set-url', 'origin', `https://intermediate.example.test/v10/projects/${PROJECT_ID}/repository.git`]);
      }
      const client = createCollabFeatureSubcomposition({ foundation: clientFoundation,
        projectSetup: new CollabProjectSetupService(clientFoundation, { installationKey: TEST_INSTALLATION_B, vaultRoot: clientRoot }), vaultRoot: clientRoot });
      await client.feature.initialize();
      const restored = await client.feature.reconnectProject({ projectId: PROJECT_ID, encodedInvitation: encoded });
      expect(restored.status).toBe('success');
      expect(await clientFoundation.local.projects.loadMembership(PROJECT_ID)).toMatchObject({
        authority: { kind: 'lan', authorityGeneration: 3, hostCaFingerprint: targetHost.caFingerprint },
        member: { id: MEMBER_ID, personalRef: old.member.personalRef }, project: old.project,
      });
      expect(git(worktree, ['status', '--porcelain'])).toBe(before);
      expect(git(worktree, ['rev-parse', 'HEAD'])).toBe(head);
      expect(await readFile(path.join(worktree, 'uncommitted.md'), 'utf8')).toBe('Local work survives recovery.\n');
      expect(await clientFoundation.local.projects.authorityTransferClaimants.load(PROJECT_ID)).toBeNull();
      await client.feature.close();
    } finally {
      await clientFoundation.close();
      await rm(clientRoot, { force: true, recursive: true });
    }
  });

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
        .update((targetMembership as CollabLocalLANMembershipRecord).member.credential, 'utf8')
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
    await expect(autoStartRecoveryComposition.feature.restoreHosts()).resolves.toBeUndefined();
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

  it.each(['collab.db', 'collab.db.tmp', 'collab.db.bak'])('preserves a markerless SQL collision in %s during legacy target import recovery', async fileName => {
    const target = await prepareCloudToLanTarget();
    await target.foundation.local.projects.authorityTransferRecords.save(target.stagedRecord);
    const unrelated = await target.foundation.createAuthority(PROJECT_ID);
    await unrelated.database.mutate(connection => unrelated.projects.initialize(connection, {
      createdAt: testTime({ days: -19 }), hostCredentialHash: new Uint8Array(32).fill(7),
      hostDisplayName: 'Other Host', hostMemberId: 'member-other', name: 'Other', projectId: 'project-other',
    }));
    await target.foundation.closeAuthority(PROJECT_ID);
    await rm(path.join(unrelated.authorityDirectory, '.claudian-authority.json'));
    await rm(path.join(unrelated.authorityDirectory, 'collab.db.bak'), { force: true });
    if (fileName !== 'collab.db') await rename(path.join(unrelated.authorityDirectory, 'collab.db'), path.join(unrelated.authorityDirectory, fileName));
    const original = await readFile(path.join(unrelated.authorityDirectory, fileName));
    await expect(target.targetEffects.stage(target.stagedRecord, target.stageArtifacts())).rejects.toMatchObject({
      safeContext: { reason: 'authority-transfer-target-state-owner-mismatch' },
    });
    expect(await readFile(path.join(unrelated.authorityDirectory, fileName))).toEqual(original);
    await expect(access(path.join(unrelated.authorityDirectory, '.claudian-authority-resource.json'))).rejects.toMatchObject({ code: 'ENOENT' });
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

  it.each(['stage', 'cancel'] as const)('handles an older local LAN authority after skipped generations during %s', async action => {
    const target = await prepareCloudToLanTarget(false, 4);
    const former = await target.foundation.createAuthority(PROJECT_ID);
    await former.database.mutate(connection => former.projects.initialize(connection, {
      createdAt: testTime({ days: -19 }),
      hostCredentialHash: createHash('sha256').update(HOST_CREDENTIAL).digest(),
      hostDisplayName: 'Former Host', hostMemberId: MEMBER_ID, name: 'Portable', projectId: PROJECT_ID,
    }));
    git(former.authorityDirectory, ['init', '--bare', 'repository.git']);
    const record = action === 'stage' ? target.stagedRecord : createAuthorityTransferRecord({
      ...target.stagedRecord, status: { ...target.stagedRecord.status, phase: 'cancel-intent' },
    });
    await target.foundation.local.projects.authorityTransferRecords.save(record);
    let outcome: unknown;
    if (action === 'stage') {
      const staged = await target.targetEffects.stage(record, target.stageArtifacts());
      outcome = { checkpointSha256: staged.checkpointSha256 };
    } else {
      const before = await readFile(path.join(former.authorityDirectory, 'collab.db'));
      const proof = await target.targetEffects.invalidateStaging(record);
      outcome = { sourceGeneration: proof.sourceAuthority.generation, targetGeneration: proof.targetAuthority.generation,
        formerAuthorityUnchanged: (await readFile(path.join(former.authorityDirectory, 'collab.db'))).equals(before) };
    }
    expect(outcome).toEqual(action === 'stage' ? { checkpointSha256: target.targetManifest.manifestSha256 }
      : { sourceGeneration: 4, targetGeneration: 5, formerAuthorityUnchanged: true });
    expect(target.foundation.lanHost.isProjectRunning(PROJECT_ID)).toBe(false);
  });

  it('replaces only the retired predecessor and recovers interrupted removal', async () => {
    const target = await prepareCloudToLanTarget();
    // Returning to the former Host must replace its retired generation-1 authority.
    const retiredSource = await target.foundation.createAuthority(PROJECT_ID);
    await retiredSource.database.mutate(connection => retiredSource.projects.initialize(connection, {
      createdAt: testTime({ days: -19 }),
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
      const authority = await target.foundation.openAuthorityTransferTarget(target.completedRecord);
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
    target.environment.now = testDate({ days: 35 });

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
    target.environment.now = testDate({ days: 1, minutes: 3 });
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
    const exactConvertedMembership = convertedMembership as CollabLocalLANMembershipRecord;
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

  it('restores claim replay independently of ordinary Host auto-start', async () => {
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
      hostOwnership: { autoStart: false, ownsAuthority: true },
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
    await expect(invalidRecoveryComposition.feature.restoreLifecycle()).resolves.toBeUndefined();
    await expect(invalidRecoveryComposition.feature.restoreHosts()).resolves.toBeUndefined();
    expect(invalidRecoveryRouteStart).toHaveBeenCalled();
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
      if (path.basename(String(to)) === 'target-private.json') {
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
    await new ProductionLANToCloudSourceEffects({
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
    await target.foundation.hostInstallations.removeOwned(await target.foundation.hostInstallations.assertOwned(PROJECT_ID, 'cleanup'));
    await expect(claimClient.claimTransferredMembership(claimRequest)).resolves.toEqual(firstReceipt);
    const recoveredReceipt = await claimClient.claimTransferredMembership(interruptedRequest);
    expect(recoveredReceipt).toMatchObject({ memberId: MEMBER_ID, operationIntentId: interruptedRequest.idempotencyKey, targetAuthorityGeneration: 3 });
    await expect(claimClient.claimTransferredMembership(interruptedRequest)).resolves.toEqual(recoveredReceipt);

    await expect(claimClient.claimTransferredMembership({
      ...claimRequest, credentialHash: 'a'.repeat(64),
    })).rejects.toMatchObject({ code: 'authority-transfer-stale' });
    await expect(target.recoveringEffects().restoreRetained(target.completedRecord)).resolves.toBeUndefined();
    target.environment.now = testDate({ days: 35 });
    const expiredPersistence = new AuthorityTransferPersistence(target.foundation.local.projects, {
      isRecoveryOwner: owner => owner === TEST_INSTALLATION_A, now: () => target.environment.now,
    });
    await expect(new ProductionCloudToLANTargetEffects({
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
        createdAt: testTime({ days: 1, minutes: 4 }),
        kind: 'membership.updated',
        payload: { projectId: PROJECT_ID },
      });
    });
    await target.foundation.local.projects.saveMembership({
      ...recoveredMembership,
      lastEventSequence: recoveredMembership.lastEventSequence + 1,
      updatedAt: testTime({ days: 1, minutes: 4 }),
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
    target.environment.now = testDate({ days: 35 });

    await expect(expiryRegistration.service.expire())
      .rejects.toThrow('simulated crash after target-private unlink');
    await expect(access(target.targetStatePath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(target.foundation.authorityTransfers.load(PROJECT_ID, TRANSFER_ID)).resolves.toMatchObject({
      terminalCleanupCompleted: false,
    });
    const stopExpiredRoute = jest.spyOn(
      target.foundation.lanHost,
      'stopAuthorityTransferRoute',
    );
    await expect(target.recoveringEffects().restoreCompleted(target.completedRecord)).resolves.toBeUndefined();
    expect(stopExpiredRoute).toHaveBeenCalledWith(PROJECT_ID, 'target-active', TRANSFER_ID);
    expect(completeTerminalCleanup).toHaveBeenCalledTimes(2);
    await expect(target.foundation.authorityTransfers.load(PROJECT_ID, TRANSFER_ID)).resolves.toMatchObject({
      terminalCleanupCompleted: true,
    });
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
});
