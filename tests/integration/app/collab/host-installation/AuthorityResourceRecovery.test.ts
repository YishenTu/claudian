import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { TEST_INSTALLATION_A, TEST_INSTALLATION_B } from '@test/helpers/installations';
import initSqlJs, { type SqlJsStatic } from 'sql.js';

import { HostTransferAuthorityService } from '@/app/collab/authority/HostTransferAuthorityService';
import { ProjectRetirementAuthorityService } from '@/app/collab/authority/ProjectRetirementAuthorityService';
import { type AuthorityDatabaseConnection, SqlJsProjectDatabase } from '@/app/collab/authority/SqlJsProjectDatabase';
import { ClaudianCollabService } from '@/app/collab/ClaudianCollabService';
import { decodeHostTransferRecoveryRecord } from '@/app/collab/host-transfer/HostTransferRecoveryRecord';
import { HostTrustTransitionService } from '@/app/collab/host-transfer/HostTrustTransitionService';
import { LanTlsIdentity } from '@/app/collab/lan/LanTlsIdentity';
import { RetirementTombstoneRepository } from '@/app/collab/retirement/RetirementTombstoneRepository';

const CREATED_AT = '2026-08-08T00:00:00.000Z';

jest.setTimeout(120_000);

const PROJECT_ID = 'project-alpha';
const RETIRED_AT = new Date('2020-01-02T00:00:00.000Z');

describe('authority resource recovery', () => {
  let root: string;
  let sql: SqlJsStatic;
  const services: ClaudianCollabService[] = [];
  beforeAll(async () => { sql = await initSqlJs(); });
  beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'claudian-resource-recovery-')); });
  afterEach(async () => {
    await Promise.allSettled(services.splice(0).map(service => service.close()));
    await rm(root, { recursive: true, force: true });
  });

  function foundation(): ClaudianCollabService {
    const service = new ClaudianCollabService({
      createAuthorityDatabase: (directory, resourceAdmission) => new SqlJsProjectDatabase(directory, { resourceAdmission, loadSqlJs: async () => sql }),
      installationKey: TEST_INSTALLATION_A, getConfiguredGitPath: () => '',
      obsidianConfigDirectory: '.obsidian', vaultRoot: root,
      lanHost: { getPrivateIpv4Addresses: () => ['127.0.0.1'], portCandidates: [0] },
    });
    services.push(service);
    return service;
  }

  async function interruptedRetirement(retiredAt = RETIRED_AT) {
    const service = foundation();
    const authority = await service.createAuthority(PROJECT_ID);
    await authority.database.mutate(connection => authority.projects.initialize(connection, {
      projectId: PROJECT_ID, name: 'Alpha', createdAt: '2020-01-01T00:00:00.000Z',
      hostCredentialHash: new Uint8Array(32).fill(1), hostDisplayName: 'Host', hostMemberId: 'member-host',
    }));
    const retirement = new ProjectRetirementAuthorityService(authority.database,
      new RetirementTombstoneRepository(service.local.projects, { now: () => retiredAt, isRecoveryOwner: () => true }), {
        resourceId: authority.resource.resourceId, installationKey: TEST_INSTALLATION_A, now: () => retiredAt,
        onTombstoneCommitted: () => { throw new Error('process stopped after tombstone'); },
      });
    await expect(retirement.retire('member-host', {
      expectedHostMemberId: 'member-host', managerActorMemberId: 'member-host', projectId: PROJECT_ID,
      idempotencyKey: 'retire-alpha', operationId: 'retire-operation-alpha', requestFingerprint: 'a'.repeat(64),
    })).rejects.toBeDefined();
    await service.close();
    return authority.resource;
  }

  it('finishes exact retirement after the tombstone commits before the SQL terminal phase', async () => {
    const retired = await interruptedRetirement();
    const reopened = foundation();
    await expect(reopened.restoreRetirementResponders((_projectId, operation) => operation())).resolves.toBeUndefined();
    await expect(stat(retired.authorityDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([false, true])('retains terminal recovery after authority cleanup despite local projection failure: %s', async projectionFails => {
    const retired = await interruptedRetirement(new Date());
    const reopened = foundation();
    if (projectionFails) {
      await reopened.local.projects.upsertProject({
        id: PROJECT_ID, name: 'Alpha', workspacePath: 'Projects/Alpha', authorityKind: 'lan',
        createdAt: CREATED_AT, updatedAt: CREATED_AT,
      });
      reopened.setRetirementHandler({ handle: async () => { throw new Error('local projection unavailable'); } });
    }
    await expect(reopened.restoreRetirementResponders((_projectId, operation) => operation())).resolves.toBeUndefined();
    await expect(stat(retired.authorityDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await reopened.local.projects.loadRetirementTombstone(PROJECT_ID)).not.toBeNull();
    expect((await reopened.local.projects.loadIndex()).projects).toHaveLength(projectionFails ? 1 : 0);
  });

  it('converges the expired local projection while authority and terminal proof still exist', async () => {
    const retired = await interruptedRetirement();
    const reopened = foundation();
    const entry = {
      id: PROJECT_ID, name: 'Alpha', workspacePath: 'Projects/Alpha', authorityKind: 'lan' as const,
      createdAt: '2020-01-01T00:00:00.000Z', updatedAt: CREATED_AT,
    };
    await reopened.local.projects.upsertProject(entry);
    reopened.setRetirementHandler({ handle: async result => {
      expect((await stat(retired.authorityDirectory)).isDirectory()).toBe(true);
      expect(await reopened.local.projects.loadRetirementTombstone(PROJECT_ID)).not.toBeNull();
      await reopened.local.projects.upsertProject({ ...entry, lifecycle: 'retired', cleanupStatus: 'pending', retiredAt: result.retiredAt });
    } });
    await reopened.restoreRetirementResponders((_projectId, operation) => operation());
    expect((await reopened.local.projects.loadIndex()).projects[0]).toMatchObject({ lifecycle: 'retired' });
    await expect(stat(retired.authorityDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await reopened.local.projects.loadRetirementTombstone(PROJECT_ID)).toBeNull();
  });

  it.each(['collab.db', 'collab.db.tmp'])('preserves a replacement authority with copied SQL in %s during retirement recovery', async fileName => {
    const retired = await interruptedRetirement();
    const bytes = await readFile(path.join(retired.authorityDirectory, 'collab.db'));
    const reopened = foundation();
    const old = await reopened.local.projects.assertOwnedAuthorityDirectory(PROJECT_ID);
    expect(old.resourceId).toBe(retired.resourceId);
    await reopened.local.projects.removeOwnedAuthorityDirectory(old);
    const replacement = await reopened.local.projects.createOwnedAuthorityDirectory(PROJECT_ID);
    await writeFile(path.join(replacement.authorityDirectory, fileName), bytes);
    await writeFile(path.join(replacement.authorityDirectory, 'keep.txt'), 'new authority');
    await expect(reopened.restoreRetirementResponders((_projectId, operation) => operation())).rejects.toMatchObject({
      code: 'operation-failed',
    });
    expect(await readFile(path.join(replacement.authorityDirectory, 'keep.txt'), 'utf8')).toBe('new authority');
    expect(await readFile(path.join(replacement.authorityDirectory, fileName))).toEqual(bytes);
  });

  it('keeps physical work admitted through nested SQL and rejects detach until settlement', async () => {
    const app = foundation();
    const authority = await app.createAuthority(PROJECT_ID);
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { started = resolve; });
    const running = app.local.projects.withAuthorityDirectory(authority.resource, async () => {
      started();
      await gate;
      await authority.database.read(() => undefined);
    });
    await ready;
    try {
      const other = await app.local.projects.createOwnedAuthorityDirectory('project-other');
      await expect(app.local.projects.withAuthorityDirectory(other, () => writeFile(path.join(other.authorityDirectory, 'keep.txt'), 'other project'))).resolves.toBeUndefined();
      await expect(app.local.projects.bindOwnedAuthorityOperation(authority.resource, {
        kind: 'setup', operationId: 'setup-alpha', transferId: null, sourceGeneration: null, targetGeneration: null,
      })).rejects.toMatchObject({ safeContext: { reason: 'authority-resource-busy' } });
      await expect(app.local.projects.removeOwnedAuthorityDirectory(authority.resource)).rejects.toMatchObject({
        safeContext: { reason: 'authority-resource-busy' },
      });
    } finally {
      release();
    }
    await running;
    await expect(app.local.projects.removeOwnedAuthorityDirectory(authority.resource)).resolves.toBe(true);
  }, 5_000);

  it('rejects retained SQL access after its authority resource is replaced', async () => {
    const app = foundation();
    const authority = await app.createAuthority(PROJECT_ID);
    await authority.database.mutate(connection => authority.projects.initialize(connection, {
      projectId: PROJECT_ID, name: 'Alpha', createdAt: CREATED_AT,
      hostCredentialHash: new Uint8Array(32).fill(9), hostDisplayName: 'Host', hostMemberId: 'member-host',
    }));
    await app.local.projects.removeOwnedAuthorityDirectory(authority.resource);
    const replacement = await app.local.projects.createOwnedAuthorityDirectory(PROJECT_ID);
    const primary = path.join(replacement.authorityDirectory, 'collab.db');
    await writeFile(primary, 'replacement image');
    await expect(authority.database.mutate(connection => connection.run("UPDATE project SET name = 'Old write'"))).rejects.toBeDefined();
    expect(await readFile(primary, 'utf8')).toBe('replacement image');
    await expect(authority.database.read(connection => authority.projects.get(connection))).rejects.toBeDefined();
    await expect(authority.database.exportSnapshot()).rejects.toBeDefined();
  });

  async function completedSource(schemaVersion: 2 | 3) {
    const app = foundation();
    const authority = await app.createAuthority(PROJECT_ID);
    await authority.database.mutate(connection => {
      authority.projects.initialize(connection, {
        projectId: PROJECT_ID, name: 'Alpha', createdAt: CREATED_AT,
        hostCredentialHash: new Uint8Array(32).fill(9), hostDisplayName: 'Host', hostMemberId: 'member-host',
      });
      insertMember(connection, 'member-target');
    });
    const sourceVault = path.join(root, 'source-vault');
    const targetVault = path.join(root, 'target-vault');
    await Promise.all([mkdir(sourceVault), mkdir(targetVault)]);
    const sourceIdentity = new LanTlsIdentity(sourceVault, {
      installationKey: TEST_INSTALLATION_A, now: () => new Date(CREATED_AT),
    });
    const targetIdentity = new LanTlsIdentity(targetVault, {
      installationKey: TEST_INSTALLATION_B, now: () => new Date(CREATED_AT),
    });
    const service = new HostTransferAuthorityService(authority, {
      createTransferId: () => 'transfer-one', now: () => new Date(CREATED_AT),
    });
    await service.create('member-host', {
      expectedHostMemberId: 'member-host',
      idempotencyKey: 'offer-one',
      projectId: 'project-alpha',
      targetMemberId: 'member-target',
    });
    const targetCa = await targetIdentity.loadOrCreate();
    await service.accept('member-target', {
      idempotencyKey: 'accept-one',
      projectId: 'project-alpha',
      receiverCredential: Buffer.alloc(32, 4).toString('base64url'),
      targetCaCertificatePem: targetCa.caCertificatePem,
      targetCaFingerprint: targetCa.caFingerprint,
      targetEndpoint: 'https://192.168.1.9:54545',
      transferId: 'transfer-one',
    });
    await service.advance({
      expectedPhase: 'accepted',
      nextPhase: 'quiescing',
      transferId: 'transfer-one',
    });
    await service.advance({
      expectedPhase: 'quiescing',
      manifestDigest: 'a'.repeat(64),
      nextPhase: 'staged',
      transferId: 'transfer-one',
    });

    const trust = new HostTrustTransitionService();
    const sourceSigner = await sourceIdentity.hostCaSigner();
    const proof = await trust.signTransition(sourceSigner, {
      issuedAt: CREATED_AT,
      nextCaCertificatePem: targetCa.caCertificatePem,
      projectId: 'project-alpha',
      transferId: 'transfer-one',
    });
    const activation = await trust.signActivation(sourceSigner, {
      cutoverAt: CREATED_AT,
      manifestDigest: 'a'.repeat(64),
      projectId: 'project-alpha',
      targetCaFingerprint: targetCa.caFingerprint,
      targetHostMemberId: 'member-target',
      transferId: 'transfer-one',
    });
    await service.relinquish({
      activationCertificate: activation,
      previousCaCertificatePem: sourceSigner.caCertificatePem,
      projectId: 'project-alpha',
      proof,
      transferId: 'transfer-one',
    });


    await service.advance({ expectedPhase: 'authority-relinquished', nextPhase: 'target-active', transferId: 'transfer-one' });
    await service.advance({ expectedPhase: 'target-active', nextPhase: 'completed', transferId: 'transfer-one' });
    await app.local.projects.hostTransferRecovery.save(decodeHostTransferRecoveryRecord({
      schemaVersion, ownerInstallationKey: TEST_INSTALLATION_A,
      ...(schemaVersion === 3 ? { sourceResourceId: authority.resource.resourceId } : {}),
      kind: 'host-transfer-recovery', direction: 'outgoing', projectId: PROJECT_ID,
      transferId: 'transfer-one', sourceHostMemberId: 'member-host', targetHostMemberId: 'member-target',
      phase: 'completed', targetEndpoint: 'https://127.0.0.1:1',
      targetCaCertificatePem: targetCa.caCertificatePem, targetCaFingerprint: targetCa.caFingerprint,
      receiverCredential: Buffer.alloc(32, 4).toString('base64url'), receiverCredentialHash: null,
      targetTerminalResponseReceived: true, stagingDirectoryName: null,
      manifestDigest: 'a'.repeat(64), activationCertificate: JSON.stringify(activation),
      createdAt: CREATED_AT, updatedAt: CREATED_AT,
    }));
    await app.local.projects.upsertProject({
      id: PROJECT_ID, name: 'Alpha', workspacePath: 'Projects/Alpha', authorityKind: 'lan',
      createdAt: CREATED_AT, updatedAt: CREATED_AT,
    });
    await app.close();
    return authority.resource;
  }

  function resumePhysicalTransfer(app: ClaudianCollabService) {
    return app.createHostTransferService({
      readCoordinationSnapshot: async () => { throw new Error('completed transfer has no live snapshot'); },
    }, (_projectId, operation) => operation(), () => undefined).resume();
  }

  it.each([2, 3] as const)('cleans the exact completed physical source after restart from format %s', async schemaVersion => {
    const source = await completedSource(schemaVersion);
    const reopened = foundation();
    await expect(resumePhysicalTransfer(reopened)).resolves.toBeUndefined();
    await expect(stat(source.authorityDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await reopened.local.projects.hostTransferRecovery.load(PROJECT_ID, 'outgoing')).toBeNull();
  });

  it('preserves a recreated physical source even when it contains the completed source database', async () => {
    const source = await completedSource(3);
    const bytes = await readFile(path.join(source.authorityDirectory, 'collab.db'));
    const reopened = foundation();
    await reopened.local.projects.removeOwnedAuthorityDirectory(await reopened.local.projects.assertOwnedAuthorityDirectory(PROJECT_ID));
    const replacement = await reopened.local.projects.createOwnedAuthorityDirectory(PROJECT_ID);
    await writeFile(path.join(replacement.authorityDirectory, 'collab.db'), bytes);
    await expect(resumePhysicalTransfer(reopened)).rejects.toMatchObject({ code: 'operation-failed' });
    expect(await readFile(path.join(replacement.authorityDirectory, 'collab.db'))).toEqual(bytes);
    expect(await reopened.local.projects.hostTransferRecovery.load(PROJECT_ID, 'outgoing')).not.toBeNull();
  });
});

function insertMember(connection: AuthorityDatabaseConnection, memberId: string): void {
  connection.run(
    `INSERT INTO members (
      member_id, display_name, personal_ref, role, status, credential_hash,
      join_attempt_id, created_at, activated_at, revoked_at
    ) VALUES (?, ?, ?, 'member', 'active', ?, NULL, ?, ?, NULL)`,
    [
      memberId,
      memberId,
      `refs/heads/members/${memberId}`,
      new Uint8Array(32).fill(3),
      CREATED_AT,
      CREATED_AT,
    ],
  );
}
