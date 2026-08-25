import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import initSqlJs, { type SqlJsStatic } from 'sql.js';

import { AuthorityEventRepository } from '@/app/collab/authority/AuthorityEventRepository';
import { AuthorityIdempotencyRepository } from '@/app/collab/authority/AuthorityIdempotencyRepository';
import { HostTransferAuthorityService } from '@/app/collab/authority/HostTransferAuthorityService';
import { ManagerResponsibilityService } from '@/app/collab/authority/ManagerResponsibilityService';
import { MembershipAdminService } from '@/app/collab/authority/MembershipAdminService';
import { ProjectAuthorityRepository } from '@/app/collab/authority/ProjectAuthorityRepository';
import { ProjectRetirementAuthorityService } from '@/app/collab/authority/ProjectRetirementAuthorityService';
import {
  type AuthorityDatabaseConnection,
  SqlJsProjectDatabase,
} from '@/app/collab/authority/SqlJsProjectDatabase';
import { COLLAB_AUTHORITY_SCHEMA_VERSION, COLLAB_LOCAL_PROJECT_SCHEMA_VERSION } from '@/app/collab/CollabSchemaVersions';
import { assertHostTransferTransition } from '@/app/collab/host-transfer/HostTransferPhaseMachine';
import { HostTrustTransitionService } from '@/app/collab/host-transfer/HostTrustTransitionService';
import { COLLAB_CONTROL_PROTOCOL_VERSION } from '@/app/collab/lan/LanCollabConstants';
import { lanCollabControlOperationCodec } from '@/app/collab/lan/LanCollabControlOperationCodecs';
import { LanTlsIdentity } from '@/app/collab/lan/LanTlsIdentity';
import { RetirementTerminalService } from '@/app/collab/retirement/RetirementTerminalService';
import { RetirementTombstoneRepository } from '@/app/collab/retirement/RetirementTombstoneRepository';

describe('Project exit foundation gate', () => {
  let SQL: SqlJsStatic;
  let root: string;
  let database: SqlJsProjectDatabase;

  beforeAll(async () => {
    SQL = await initSqlJs();
  });

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'claudian-project-exit-foundation-'));
    const authorityDirectory = path.join(root, 'authority');
    await mkdir(authorityDirectory);
    database = new SqlJsProjectDatabase(authorityDirectory, {
      loadSqlJs: async () => SQL,
    });
    await database.open();
    await database.mutate(connection => {
      new ProjectAuthorityRepository().initialize(connection, {
        createdAt: '2026-08-13T00:00:00.000Z',
        hostCredentialHash: new Uint8Array(32).fill(1),
        hostDisplayName: 'Host',
        hostMemberId: 'member-host',
        name: 'Alpha',
        projectId: 'project-alpha',
      });
      insertMember(connection, 'member-target');
    });
  });

  afterEach(async () => {
    await database.close();
    await rm(root, { force: true, recursive: true });
  });

  it('freezes the v9/v2/v12 contract and strict lifecycle envelopes', () => {
    expect({
      authority: COLLAB_AUTHORITY_SCHEMA_VERSION,
      local: COLLAB_LOCAL_PROJECT_SCHEMA_VERSION,
      protocol: COLLAB_CONTROL_PROTOCOL_VERSION,
    }).toEqual({ authority: 12, local: 3, protocol: 9 });
    expect(lanCollabControlOperationCodec('leaveProject').decodeRequest({
      expectedHostMemberId: 'member-host',
      expectedMemberId: 'member-target',
      idempotencyKey: 'leave-one',
      idempotencyManagerMemberId: null,
      projectId: 'project-alpha',
    }).status).toBe('ok');
    expect(lanCollabControlOperationCodec('retireProject').decodeResponse({
      data: {
        projectId: 'project-alpha',
        retiredAt: '2026-08-13T08:00:00.000Z',
      },
      protocolVersion: COLLAB_CONTROL_PROTOCOL_VERSION,
      requestId: 'retire-response',
    })).toEqual({
      projectId: 'project-alpha',
      retiredAt: '2026-08-13T08:00:00.000Z',
    });
  });

  it('keeps responsibility validity participant-scoped instead of generation-bound', async () => {
    const service = new ManagerResponsibilityService({
      database,
      events: new AuthorityEventRepository(),
      idempotency: new AuthorityIdempotencyRepository(),
      presence: { hasAuthenticatedPresence: () => true },
    }, {
      createOfferId: () => 'offer-foundation',
      now: () => new Date('2026-08-13T01:00:00.000Z'),
    });

    await service.create('member-host', {
      idempotencyKey: 'offer-foundation-key',
      projectId: 'project-alpha',
      purpose: 'manager-promotion',
      targetMemberId: 'member-target',
    });

    await expect(database.read(connection => connection.all(`
      PRAGMA table_info(manager_responsibility_offers)
    `).map(column => column.name))).resolves.not.toContain('source_manager_generation');
  });

  it('exposes only legal Host transfer progression and no rollback after cutover', () => {
    expect(() => assertHostTransferTransition('offered', 'accepted')).not.toThrow();
    expect(() => assertHostTransferTransition('staged', 'authority-relinquished')).not.toThrow();
    expect(() => assertHostTransferTransition('authority-relinquished', 'staged'))
      .toThrow(expect.objectContaining({ code: 'host-transfer-pending' }));
    expect(() => assertHostTransferTransition('completed', 'offered'))
      .toThrow(expect.objectContaining({ code: 'host-transfer-pending' }));
  });

  it('keeps terminal storage behind a minimum no-secret record boundary', async () => {
    const store = new MemoryTombstoneStore();
    const repository = new RetirementTombstoneRepository(store, {
      now: () => new Date('2026-08-13T08:00:00.000Z'),
    });
    await repository.savePrepared({
      expiresAt: '2026-09-12T08:00:00.000Z',
      formerMembers: [{
        acknowledgedAt: null,
        credentialHash: 'a'.repeat(64),
        memberId: 'member-host',
      }],
      hostTransitionProofs: [],
      kind: 'retirement-tombstone',
      projectId: 'project-alpha',
      replay: {
        actorMemberId: 'member-host',
        idempotencyKey: 'retire-one',
        requestFingerprint: 'b'.repeat(64),
      },
      result: {
        projectId: 'project-alpha',
        retiredAt: '2026-08-13T08:00:00.000Z',
      },
      retiredAt: '2026-08-13T08:00:00.000Z',
      schemaVersion: 1,
    });

    const json = JSON.stringify(store.record);
    expect(json).not.toMatch(/private.?key|receiver.?credential|workspacePath|ticketId|requestId/i);
  });

  it('runs Leave, Manager succession, Host handoff, and Retire as ordered terminal domains', async () => {
    const events = new AuthorityEventRepository();
    const idempotency = new AuthorityIdempotencyRepository();
    const presence = { hasAuthenticatedPresence: () => true };
    const managerResponsibilities = new ManagerResponsibilityService({
      database,
      events,
      idempotency,
      presence,
    }, {
      createOfferId: () => 'offer-milestone',
      now: () => new Date('2026-08-13T01:00:00.000Z'),
    });
    const membership = new MembershipAdminService({ database, events, idempotency }, {
      now: () => new Date('2026-08-13T01:01:00.000Z'),
      presence,
    });

    await expect(membership.leaveProject('member-target', {
      expectedHostMemberId: 'member-host',
      expectedMemberId: 'member-target',
      idempotencyKey: 'leave-milestone',
      idempotencyManagerMemberId: null,
      projectId: 'project-alpha',
    })).resolves.toMatchObject({ memberId: 'member-target', status: 'left' });

    await database.mutate(current => insertMember(current, 'member-successor'));
    const offer = await managerResponsibilities.create('member-host', {
      idempotencyKey: 'offer-milestone',
      projectId: 'project-alpha',
      purpose: 'manager-promotion',
      targetMemberId: 'member-successor',
    });
    await managerResponsibilities.acknowledge('member-successor', {
      expectedTargetMemberId: 'member-successor',
      idempotencyKey: 'ack-milestone',
      offerId: offer.offerId,
      projectId: 'project-alpha',
    });
    await expect(membership.promoteManager('member-host', {
      idempotencyKey: 'transfer-manager-milestone',
      managerResponsibilityOfferId: offer.offerId,
      projectId: 'project-alpha',
      targetMemberId: 'member-successor',
    })).resolves.toMatchObject({
      managerSetGeneration: 1,
      promotedMemberId: 'member-successor',
    });

    const hostTransfers = new HostTransferAuthorityService({ database, events }, {
      createTransferId: () => 'transfer-milestone',
      now: () => new Date('2026-08-13T01:02:00.000Z'),
    });
    await expect(hostTransfers.create('member-host', {
      expectedHostMemberId: 'member-host',
      idempotencyKey: 'host-offer-milestone',
      projectId: 'project-alpha',
      targetMemberId: 'member-successor',
    })).resolves.toMatchObject({ phase: 'offered', transferId: 'transfer-milestone' });
    const sourceVault = path.join(root, 'source-vault');
    const targetVault = path.join(root, 'target-vault');
    await Promise.all([mkdir(sourceVault), mkdir(targetVault)]);
    const sourceIdentity = new LanTlsIdentity(sourceVault);
    const targetIdentity = new LanTlsIdentity(targetVault);
    const [sourceSigner, targetCa] = await Promise.all([
      sourceIdentity.hostCaSigner(),
      targetIdentity.loadOrCreate(),
    ]);
    await hostTransfers.accept('member-successor', {
      idempotencyKey: 'host-accept-milestone',
      projectId: 'project-alpha',
      receiverCredential: Buffer.alloc(32, 7).toString('base64url'),
      targetCaCertificatePem: targetCa.caCertificatePem,
      targetCaFingerprint: targetCa.caFingerprint,
      targetEndpoint: 'https://192.168.1.9:54545',
      transferId: 'transfer-milestone',
    });
    await hostTransfers.advance({
      expectedPhase: 'accepted',
      nextPhase: 'quiescing',
      transferId: 'transfer-milestone',
    });
    await hostTransfers.advance({
      expectedPhase: 'quiescing',
      manifestDigest: 'e'.repeat(64),
      nextPhase: 'staged',
      transferId: 'transfer-milestone',
    });
    const trust = new HostTrustTransitionService();
    const proof = await trust.signTransition(sourceSigner, {
      issuedAt: '2026-08-13T01:02:00.000Z',
      nextCaCertificatePem: targetCa.caCertificatePem,
      projectId: 'project-alpha',
      transferId: 'transfer-milestone',
    });
    const activationCertificate = await trust.signActivation(sourceSigner, {
      cutoverAt: '2026-08-13T01:02:00.000Z',
      manifestDigest: 'e'.repeat(64),
      projectId: 'project-alpha',
      targetCaFingerprint: targetCa.caFingerprint,
      targetHostMemberId: 'member-successor',
      transferId: 'transfer-milestone',
    });
    await hostTransfers.relinquish({
      activationCertificate,
      previousCaCertificatePem: sourceSigner.caCertificatePem,
      projectId: 'project-alpha',
      proof,
      transferId: 'transfer-milestone',
    });
    await hostTransfers.advance({
      expectedPhase: 'authority-relinquished',
      nextPhase: 'target-active',
      transferId: 'transfer-milestone',
    });
    await hostTransfers.advance({
      expectedPhase: 'target-active',
      nextPhase: 'completed',
      transferId: 'transfer-milestone',
    });
    const successorCredential = Buffer.alloc(32, 2).toString('base64url');
    await database.mutate(current => current.run(
      'UPDATE members SET credential_hash = ? WHERE member_id = ?',
      [createHash('sha256').update(successorCredential).digest(), 'member-successor'],
    ));

    const tombstones = new RetirementTombstoneRepository(new MemoryTombstoneStore(), {
      now: () => new Date('2026-08-13T01:04:00.000Z'),
    });
    const retirement = new ProjectRetirementAuthorityService(database, tombstones, {
      now: () => new Date('2026-08-13T01:04:00.000Z'),
    });
    const retired = await retirement.retire('member-successor', {
      expectedHostMemberId: 'member-successor',
      idempotencyKey: 'retire-milestone',
      managerActorMemberId: 'member-successor',
      operationId: 'retire-milestone',
      projectId: 'project-alpha',
      requestFingerprint: 'd'.repeat(64),
    });
    const terminal = new RetirementTerminalService(tombstones);
    await expect(terminal.getResult('project-alpha', successorCredential))
      .resolves.toEqual(retired);
    await expect(database.read(current => current.get(
      'SELECT state, host_member_id, manager_set_generation FROM project WHERE singleton = 1',
    ))).resolves.toEqual({
      host_member_id: 'member-successor',
      manager_set_generation: 1,
      state: 'disabled',
    });
  }, 30_000);
});

function insertMember(connection: AuthorityDatabaseConnection, memberId: string): void {
  connection.run(`
    INSERT INTO members (
      member_id, display_name, personal_ref, role, status, credential_hash,
      created_at, activated_at
    ) VALUES (?, 'Target', ?, 'member', 'active', ?, ?, ?)
  `, [
    memberId,
    `refs/heads/members/${memberId}`,
    new Uint8Array(32).fill(2),
    '2026-08-13T00:00:00.000Z',
    '2026-08-13T00:00:00.000Z',
  ]);
}

class MemoryTombstoneStore {
  record: unknown = null;

  listRetirementTombstoneProjectIds(): Promise<readonly string[]> {
    return Promise.resolve(this.record ? ['project-alpha'] : []);
  }

  loadRetirementTombstone(): Promise<never> {
    return Promise.resolve(this.record as never);
  }

  removeRetirementTombstone(): Promise<boolean> {
    this.record = null;
    return Promise.resolve(true);
  }

  saveRetirementTombstone(record: unknown): Promise<void> {
    this.record = structuredClone(record);
    return Promise.resolve();
  }
}
