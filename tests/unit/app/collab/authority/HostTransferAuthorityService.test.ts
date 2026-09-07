import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { TEST_INSTALLATION_A, TEST_INSTALLATION_B } from '@test/helpers/installations';
import initSqlJs, { type SqlJsStatic } from 'sql.js';

import { AuthorityEventRepository } from '@/app/collab/authority/AuthorityEventRepository';
import { HostTransferAuthorityService } from '@/app/collab/authority/HostTransferAuthorityService';
import { HostTransferRepository } from '@/app/collab/authority/HostTransferRepository';
import { ProjectAuthorityRepository } from '@/app/collab/authority/ProjectAuthorityRepository';
import {
  type AuthorityDatabaseConnection,
  SqlJsProjectDatabase,
} from '@/app/collab/authority/SqlJsProjectDatabase';
import { HostTrustTransitionService } from '@/app/collab/host-transfer/HostTrustTransitionService';
import { LanTlsIdentity } from '@/app/collab/lan/LanTlsIdentity';

const CREATED_AT = '2026-08-08T00:00:00.000Z';

jest.setTimeout(120_000);

describe('HostTransferAuthorityService', () => {
  let SQL: SqlJsStatic;
  let database: SqlJsProjectDatabase;
  let root: string;
  let sourceIdentity: LanTlsIdentity;
  let targetIdentity: LanTlsIdentity;
  let service: HostTransferAuthorityService;
  let clock: Date;

  beforeAll(async () => {
    SQL = await initSqlJs();
  });

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'claudian-host-authority-'));
    const authorityDirectory = path.join(root, 'authority');
    await mkdir(authorityDirectory);
    database = new SqlJsProjectDatabase(authorityDirectory, {
      loadSqlJs: async () => SQL,
    });
    await database.open();
    await database.mutate(connection => {
      new ProjectAuthorityRepository().initialize(connection, {
        createdAt: CREATED_AT,
        hostCredentialHash: new Uint8Array(32).fill(9),
        hostDisplayName: 'Host',
        hostMemberId: 'member-host',
        name: 'Alpha',
        projectId: 'project-alpha',
      });
      insertMember(connection, 'member-target');
      insertMember(connection, 'member-other');
    });
    const sourceVault = path.join(root, 'source-vault');
    const targetVault = path.join(root, 'target-vault');
    await Promise.all([mkdir(sourceVault), mkdir(targetVault)]);
    sourceIdentity = new LanTlsIdentity(sourceVault, {
      installationKey: TEST_INSTALLATION_A,
      now: () => new Date(CREATED_AT),
    });
    targetIdentity = new LanTlsIdentity(targetVault, {
      installationKey: TEST_INSTALLATION_B,
      now: () => new Date(CREATED_AT),
    });
    clock = new Date(CREATED_AT);
    service = new HostTransferAuthorityService({
      database,
      events: new AuthorityEventRepository(),
    }, {
      createTransferId: () => 'transfer-one',
      now: () => new Date(clock),
    });
  });

  afterEach(async () => {
    await database.close();
    await rm(root, { force: true, recursive: true });
  });

  it('offers exactly one transfer, replays idempotently, and accepts only by the target', async () => {
    const request = {
      expectedHostMemberId: 'member-host',
      idempotencyKey: 'offer-one',
      projectId: 'project-alpha',
      targetMemberId: 'member-target',
    };
    const offered = await service.create('member-host', request);
    await expect(service.getCurrent('member-host', 'project-alpha')).resolves.toEqual(offered);
    await expect(service.getCurrent('member-target', 'project-alpha')).resolves.toEqual({
      ...offered,
      canAccept: true,
      canCancel: false,
      canDecline: true,
    });
    await expect(service.getCurrent('member-other', 'project-alpha')).resolves.toBeNull();
    await expect(service.create('member-host', request)).resolves.toEqual(offered);
    await expect(service.create('member-host', {
      ...request,
      idempotencyKey: 'offer-two',
      targetMemberId: 'member-other',
    })).rejects.toMatchObject({ code: 'host-transfer-pending' });

    const targetCa = await targetIdentity.loadOrCreate();
    const acceptRequest = {
      idempotencyKey: 'accept-one',
      projectId: 'project-alpha',
      receiverCredential: Buffer.alloc(32, 4).toString('base64url'),
      targetCaCertificatePem: targetCa.caCertificatePem,
      targetCaFingerprint: targetCa.caFingerprint,
      targetEndpoint: 'https://192.168.1.9:54545',
      transferId: 'transfer-one',
    };
    await expect(service.accept('member-other', acceptRequest)).rejects.toMatchObject({
      code: 'authorization-denied',
    });
    await expect(service.accept('member-target', acceptRequest)).resolves.toMatchObject({
      canAccept: false,
      phase: 'accepted',
    });
    await expect(service.getCurrent('member-target', 'project-alpha')).resolves.toMatchObject({
      phase: 'accepted',
      transferId: 'transfer-one',
    });
    const stored = await database.read(connection => (
      new HostTransferRepository().get(connection, 'transfer-one')
    ));
    expect(stored?.receiverCredential).toBe(acceptRequest.receiverCredential);
    expect(Object.keys(stored ?? {})).not.toContain('receiverCredential');
    expect(JSON.stringify(stored)).not.toContain(acceptRequest.receiverCredential);
    expect(await database.read(connection => connection.get(
      "SELECT COUNT(*) AS count FROM idempotency_results WHERE operation_kind = 'transfer-host'",
    )?.count)).toBe(2);
  });

  it('persists the legal phases and atomically cuts over the Host pointer with proof chain', async () => {
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
    const relinquished = await service.relinquish({
      activationCertificate: activation,
      previousCaCertificatePem: sourceSigner.caCertificatePem,
      projectId: 'project-alpha',
      proof,
      transferId: 'transfer-one',
    });

    expect(relinquished.phase).toBe('authority-relinquished');
    expect(await database.read(connection => connection.get(
      'SELECT host_member_id FROM project WHERE singleton = 1',
    ))).toEqual({ host_member_id: 'member-target' });
    expect(await service.listProofs()).toEqual([proof]);
    await expect(service.advance({
      expectedPhase: 'authority-relinquished',
      nextPhase: 'cancelled',
      transferId: 'transfer-one',
    })).rejects.toBeDefined();
    await service.advance({
      expectedPhase: 'authority-relinquished',
      nextPhase: 'target-active',
      transferId: 'transfer-one',
    });
    const completed = await service.advance({
      expectedPhase: 'target-active',
      nextPhase: 'completed',
      transferId: 'transfer-one',
    });
    expect(completed.phase).toBe('completed');
    expect(completed.receiverCredential).toBeNull();
  });

  it('allows the source Host to cancel after staging but before relinquishment', async () => {
    await service.create('member-host', {
      expectedHostMemberId: 'member-host',
      idempotencyKey: 'offer-cancel-staged',
      projectId: 'project-alpha',
      targetMemberId: 'member-target',
    });
    const targetCa = await targetIdentity.loadOrCreate();
    await service.accept('member-target', {
      idempotencyKey: 'accept-cancel-staged',
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

    await expect(service.cancel('member-host', {
      expectedHostMemberId: 'member-host',
      idempotencyKey: 'cancel-staged',
      projectId: 'project-alpha',
      transferId: 'transfer-one',
    })).resolves.toEqual(expect.objectContaining({
      canCancel: false,
      phase: 'cancelled',
    }));
  });

  it('allows only the target to decline and only the source Host to cancel', async () => {
    await service.create('member-host', {
      expectedHostMemberId: 'member-host',
      idempotencyKey: 'offer-decline',
      projectId: 'project-alpha',
      targetMemberId: 'member-target',
    });

    await expect(service.decline('member-other', {
      expectedTargetMemberId: 'member-other',
      idempotencyKey: 'decline-other',
      projectId: 'project-alpha',
      transferId: 'transfer-one',
    })).rejects.toMatchObject({ code: 'authorization-denied' });
    await expect(service.cancel('member-other', {
      expectedHostMemberId: 'member-other',
      idempotencyKey: 'cancel-other',
      projectId: 'project-alpha',
      transferId: 'transfer-one',
    })).rejects.toMatchObject({ code: 'authorization-denied' });
    await expect(service.decline('member-target', {
      expectedTargetMemberId: 'member-target',
      idempotencyKey: 'decline-target',
      projectId: 'project-alpha',
      transferId: 'transfer-one',
    })).resolves.toEqual(expect.objectContaining({ phase: 'declined' }));
  });

  it('durably expires an unaccepted offer after 24 hours', async () => {
    await service.create('member-host', {
      expectedHostMemberId: 'member-host',
      idempotencyKey: 'offer-expiry',
      projectId: 'project-alpha',
      targetMemberId: 'member-target',
    });
    clock = new Date('2026-08-09T00:00:00.000Z');
    const targetCa = await targetIdentity.loadOrCreate();

    await expect(service.accept('member-target', {
      idempotencyKey: 'accept-expired',
      projectId: 'project-alpha',
      receiverCredential: Buffer.alloc(32, 4).toString('base64url'),
      targetCaCertificatePem: targetCa.caCertificatePem,
      targetCaFingerprint: targetCa.caFingerprint,
      targetEndpoint: 'https://192.168.1.9:54545',
      transferId: 'transfer-one',
    })).resolves.toEqual(expect.objectContaining({ phase: 'expired' }));
    await expect(database.read(connection => (
      new HostTransferRepository().get(connection, 'transfer-one')
    ))).resolves.toEqual(expect.objectContaining({
      phase: 'expired',
      receiverCredential: null,
    }));
  });

  it('restores a pending offer from the durable authority snapshot after restart', async () => {
    await service.create('member-host', {
      expectedHostMemberId: 'member-host',
      idempotencyKey: 'offer-one',
      projectId: 'project-alpha',
      targetMemberId: 'member-target',
    });
    const authorityDirectory = path.join(root, 'authority');
    await database.close();
    database = new SqlJsProjectDatabase(authorityDirectory, { loadSqlJs: async () => SQL });
    await database.open();

    const restored = await database.read(connection => (
      new HostTransferRepository().getNonterminal(connection)
    ));
    expect(restored).toMatchObject({ phase: 'offered', transferId: 'transfer-one' });
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
