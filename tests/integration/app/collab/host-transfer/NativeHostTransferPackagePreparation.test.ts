import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import initSqlJs, { type SqlJsStatic } from 'sql.js';

import { HostTransferRepository } from '@/app/collab/authority/HostTransferRepository';
import { ProjectAuthorityRepository } from '@/app/collab/authority/ProjectAuthorityRepository';
import { SqlJsProjectDatabase } from '@/app/collab/authority/SqlJsProjectDatabase';
import { COLLAB_AUTHORITY_SCHEMA_VERSION } from '@/app/collab/CollabSchemaVersions';
import { GitCommandRunner } from '@/app/collab/git/GitCommandRunner';
import { GitRepositoryService } from '@/app/collab/git/GitRepositoryService';
import { HostTransferAuthoritySnapshot } from '@/app/collab/host-transfer/HostTransferAuthoritySnapshot';
import { digestHostTransferPackageManifest } from '@/app/collab/host-transfer/HostTransferPackage';
import { NativeHostTransferPackagePreparation } from '@/app/collab/host-transfer/NativeHostTransferPackagePreparation';
import { COLLAB_HOST_TRANSFER_PROTOCOL_VERSION } from '@/app/collab/lan/LanCollabConstants';
import type { CollabHostTrustTransitionProof } from '@/core/collab';

const NOW = '2026-08-13T00:00:00.000Z';
const LATER = '2026-08-13T00:01:00.000Z';
const proof: CollabHostTrustTransitionProof = {
  issuedAt: NOW,
  nextCaCertificatePem: '-----BEGIN CERTIFICATE-----\ntarget\n-----END CERTIFICATE-----\n',
  nextCaFingerprint: 'b'.repeat(64),
  previousCaFingerprint: 'a'.repeat(64),
  projectId: 'project-alpha',
  schemaVersion: 1,
  signature: 'c'.repeat(64),
  signatureAlgorithm: 'rsa-pss-sha256',
  transferId: 'transfer-alpha',
};

describe('NativeHostTransferPackagePreparation', () => {
  let root: string;
  let authorityDirectory: string;
  let repositoryPath: string;
  let database: SqlJsProjectDatabase;
  let repositories: GitRepositoryService;
  let runner: GitCommandRunner;
  let SQL: SqlJsStatic;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'claudian-host-transfer-package-'));
    authorityDirectory = path.join(root, 'authority');
    repositoryPath = path.join(authorityDirectory, 'repository.git');
    const emptyConfigPath = path.join(root, 'empty-gitconfig');
    await mkdir(authorityDirectory);
    await readFile(emptyConfigPath).catch(async () => {
      await writeFile(emptyConfigPath, '');
    });
    runner = new GitCommandRunner({
      emptyConfigPath,
      executablePath: 'git',
    });
    repositories = new GitRepositoryService(runner);
    await mkdir(repositoryPath);
    await repositories.initializeBareRepository(repositoryPath);
    const work = path.join(root, 'work');
    await mkdir(work);
    await runner.run({ args: ['init', '--quiet', '--initial-branch=main'], cwd: work });
    await runner.run({
      args: ['commit', '--allow-empty', '-m', 'Initial'],
      cwd: work,
      identity: { email: 'test@example.com', name: 'Test' },
    });
    await runner.run({ args: ['remote', 'add', 'origin', repositoryPath], cwd: work });
    await runner.run({ args: ['push', 'origin', 'main'], cwd: work });

    SQL = await initSqlJs();
    database = new SqlJsProjectDatabase(authorityDirectory, { loadSqlJs: async () => SQL });
    await database.open();
    await database.mutate(connection => {
      new ProjectAuthorityRepository().initialize(connection, {
        createdAt: NOW,
        hostCredentialHash: new Uint8Array(32).fill(1),
        hostDisplayName: 'Source Host',
        hostMemberId: 'member-source',
        name: 'Project Alpha',
        projectId: 'project-alpha',
      });
      connection.run(
        `INSERT INTO members (
          member_id, display_name, personal_ref, role, status, credential_hash,
          join_attempt_id, created_at, activated_at, revoked_at
        ) VALUES (?, ?, ?, 'member', 'active', ?, NULL, ?, ?, NULL)`,
        [
          'member-target', 'Target', 'refs/heads/members/member-target',
          new Uint8Array(32).fill(2), NOW, NOW,
        ],
      );
      const transfers = new HostTransferRepository();
      transfers.createOffer(connection, {
        actorMemberId: 'member-source', expiresAt: '2026-08-14T00:00:00.000Z',
        offeredAt: NOW, projectId: 'project-alpha',
        targetHostMemberId: 'member-target', transferId: 'transfer-alpha',
      });
      transfers.accept(connection, {
        actorMemberId: 'member-target', projectId: 'project-alpha',
        receiverCredential: Buffer.alloc(32, 4).toString('base64url'),
        targetCaCertificatePem: proof.nextCaCertificatePem,
        targetCaFingerprint: proof.nextCaFingerprint,
        targetEndpoint: 'https://192.168.1.20:27000', transferId: 'transfer-alpha',
        updatedAt: NOW,
      });
      transfers.advance(connection, {
        expectedPhase: 'accepted', nextPhase: 'quiescing',
        transferId: 'transfer-alpha', updatedAt: NOW,
      });
    });
  });

  afterEach(async () => {
    await database.close();
    await rm(root, { force: true, recursive: true });
  });

  it('persists one exact restorable bundle, inert snapshot, proof, and canonical manifest', async () => {
    const service = new NativeHostTransferPackagePreparation({
      authorityDirectory,
      database,
      now: () => new Date(NOW),
      repositoryPath,
      repositories,
      runner,
      snapshots: new HostTransferAuthoritySnapshot({ loadSqlJs: async () => SQL }),
    });

    const prepared = await service.prepare({
      projectId: 'project-alpha', proof,
      targetCaFingerprint: proof.nextCaFingerprint,
      targetHostMemberId: 'member-target', transferId: 'transfer-alpha',
    });
    const restored = await service.restore({
      manifestDigest: prepared.manifestDigest,
      projectId: 'project-alpha', transferId: 'transfer-alpha',
    });
    await expect(service.prepare({
      projectId: 'project-alpha',
      proof: { ...proof, issuedAt: LATER, signature: 'd'.repeat(64) },
      targetCaFingerprint: proof.nextCaFingerprint,
      targetHostMemberId: 'member-target',
      transferId: 'transfer-alpha',
    })).resolves.toMatchObject({
      manifest: prepared.manifest,
      proof,
    });
    const [gitBytes, databaseBytes] = await Promise.all([
      collect(restored.gitBundle), collect(restored.authoritySnapshot),
    ]);

    expect(createHash('sha256').update(gitBytes).digest('hex'))
      .toBe(prepared.manifest.gitBundle.sha256);
    expect(createHash('sha256').update(databaseBytes).digest('hex'))
      .toBe(prepared.manifest.authoritySnapshot.sha256);
    expect(prepared.manifest).toMatchObject({
      authoritySchemaVersion: COLLAB_AUTHORITY_SCHEMA_VERSION,
      protocolVersion: COLLAB_HOST_TRANSFER_PROTOCOL_VERSION,
    });
    await expect(readFile(
      path.join(
        authorityDirectory,
        'host-transfers',
        'transfer-alpha',
        'host-transfer-metadata.json',
      ),
      'utf8',
    )).resolves.toBe(JSON.stringify(prepared.manifest));
    expect(restored.manifest).toEqual(prepared.manifest);
    expect(restored.proof).toEqual(proof);
  });

  it('rejects operation ownership or digest drift on restore', async () => {
    const service = new NativeHostTransferPackagePreparation({
      authorityDirectory, database, now: () => new Date(NOW), repositoryPath,
      repositories, runner,
      snapshots: new HostTransferAuthoritySnapshot({ loadSqlJs: async () => SQL }),
    });
    const prepared = await service.prepare({
      projectId: 'project-alpha', proof,
      targetCaFingerprint: proof.nextCaFingerprint,
      targetHostMemberId: 'member-target', transferId: 'transfer-alpha',
    });

    await expect(service.restore({
      manifestDigest: 'd'.repeat(64), projectId: 'project-alpha',
      transferId: 'transfer-alpha',
    })).rejects.toMatchObject({ code: 'authority-integrity-error' });
    await expect(service.restore({
      manifestDigest: prepared.manifestDigest, projectId: 'project-other',
      transferId: 'transfer-alpha',
    })).rejects.toMatchObject({ code: 'authority-integrity-error' });
  });

  it('restores an already-owned schema 8 package without treating it as new output', async () => {
    const service = new NativeHostTransferPackagePreparation({
      authorityDirectory, database, now: () => new Date(NOW), repositoryPath,
      repositories, runner,
      snapshots: new HostTransferAuthoritySnapshot({ loadSqlJs: async () => SQL }),
    });
    const prepared = await service.prepare({
      projectId: 'project-alpha', proof,
      targetCaFingerprint: proof.nextCaFingerprint,
      targetHostMemberId: 'member-target', transferId: 'transfer-alpha',
    });
    const legacyManifest = {
      ...prepared.manifest,
      authoritySchemaVersion: 8 as const,
    };
    await writeFile(
      path.join(
        authorityDirectory,
        'host-transfers',
        'transfer-alpha',
        'host-transfer-metadata.json',
      ),
      JSON.stringify(legacyManifest),
    );

    await expect(service.restore({
      manifestDigest: digestHostTransferPackageManifest(legacyManifest),
      projectId: 'project-alpha',
      transferId: 'transfer-alpha',
    })).resolves.toMatchObject({ manifest: legacyManifest });
  });
});

async function collect(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of source) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
