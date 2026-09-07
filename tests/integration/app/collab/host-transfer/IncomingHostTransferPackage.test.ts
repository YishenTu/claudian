import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { CollabWorkspaceService } from '@/app/collab/CollabWorkspaceService';
import { createHostTransferPackageManifest, digestHostTransferPackageManifest } from '@/app/collab/host-transfer/HostTransferPackage';
import { advanceHostTransferRecoveryRecord, createHostTransferRecoveryRecord } from '@/app/collab/host-transfer/HostTransferRecovery';
import { IncomingHostTransferPackage } from '@/app/collab/host-transfer/IncomingHostTransferPackage';

const NOW = '2026-08-13T00:00:00.000Z';
const MAIN_OID = '1'.repeat(40);
const MEMBER_OID = '2'.repeat(40);

describe('IncomingHostTransferPackage', () => {
  let root: string;
  let workspace: CollabWorkspaceService;
  let authorityDirectory: string;
  let stagingDirectory: string;
  let run: jest.Mock;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'claudian-incoming-package-'));
    workspace = new CollabWorkspaceService(root);
    await workspace.claimProjectsFolder('Projects');
    const reserved = await workspace.reserveProjectsFolderChild('Projects', {
      childName: '.claudian-host-transfer-transfer-alpha',
      operationId: 'transfer-alpha',
      projectId: 'project-alpha',
      purpose: 'host-transfer-staging',
    });
    stagingDirectory = reserved.absolutePath;
    await mkdir(stagingDirectory);
    authorityDirectory = path.join(root, '.claudian', 'collab', 'authorities', 'project-alpha');
    run = jest.fn(async ({ args }: { readonly args: readonly string[] }) => {
      if (args[0] === 'bundle' && args[1] === 'list-heads') {
        return result(`${MAIN_OID} refs/heads/main\n${MEMBER_OID} refs/heads/members/member-target\n`);
      }
      if (args[0] === 'clone') await mkdir(args.at(-1)!);
      if (args[0] === 'rev-parse') return result('sha1\n');
      if (args[0] === 'for-each-ref') {
        return result(`${MAIN_OID} refs/heads/main\n${MEMBER_OID} refs/heads/members/member-target\n`);
      }
      return result('');
    });
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it('streams, validates, installs, and activates one exact package idempotently', async () => {
    const git = Buffer.from('bundle bytes');
    const authority = Buffer.from('inert database bytes');
    const activated = Buffer.from('activated database bytes');
    const manifest = createHostTransferPackageManifest({
      authorityMainOid: MAIN_OID,
      authoritySnapshot: identity(authority),
      createdAt: NOW,
      gitBundle: identity(git),
      gitObjectFormat: 'sha1',
      projectId: 'project-alpha',
      proofChainDigest: '3'.repeat(64),
      sourceAuthorityGeneration: 4,
      targetCaFingerprint: '4'.repeat(64),
      targetHostMemberId: 'member-target',
      transferId: 'transfer-alpha',
    });
    const record = stagedRecord(digestHostTransferPackageManifest(manifest));
    const snapshots = {
      activate: jest.fn().mockResolvedValue({ bytes: activated, eventSequence: 12 }),
      inspectInert: jest.fn().mockResolvedValue({
        eventSequence: 11,
        expectedRefs: ['refs/heads/main', 'refs/heads/members/member-target'],
        proofChain: [],
      }),
      validateRecoveryMigration: jest.fn().mockResolvedValue(undefined),
    };
    const repositories = {
      assertHealthy: jest.fn().mockResolvedValue(undefined),
      configureHostedRepository: jest.fn().mockResolvedValue(undefined),
      resolveRef: jest.fn().mockResolvedValue(MAIN_OID),
    };
    const service = new IncomingHostTransferPackage({
      ensureAuthorityDirectory: async () => {
        await mkdir(authorityDirectory, { recursive: true });
        return authorityDirectory;
      },
      projectsFolder: 'Projects',
      readPinnedSourceCa: jest.fn().mockResolvedValue('source-ca'),
      repositories: repositories as never,
      resolveWorkingRepository: jest.fn().mockResolvedValue(root),
      runner: { run } as never,
      snapshots: snapshots as never,
      workspace,
    });

    await expect(service.stageAndValidate({
      authoritySnapshot: chunks(authority),
      gitBundle: chunks(git),
      manifest,
      record: acceptedRecord(),
    })).resolves.toEqual({ manifestDigest: digestHostTransferPackageManifest(manifest) });
    await expect(readFile(
      path.join(stagingDirectory, 'host-transfer-metadata.json'),
      'utf8',
    )).resolves.toBe(JSON.stringify(manifest));
    const certificate = {
      cutoverAt: NOW,
      manifestDigest: digestHostTransferPackageManifest(manifest),
      projectId: 'project-alpha',
      schemaVersion: 1 as const,
      signature: '5'.repeat(64),
      signatureAlgorithm: 'rsa-pss-sha256' as const,
      targetCaFingerprint: '4'.repeat(64),
      targetHostMemberId: 'member-target',
      transferId: 'transfer-alpha',
    };
    await expect(service.installAndActivate({
      activationCertificate: certificate,
      manifestDigest: certificate.manifestDigest,
      record,
    })).resolves.toEqual({
      eventSequence: 12,
    });
    await expect(readFile(path.join(authorityDirectory, 'collab.db')))
      .resolves.toEqual(activated);
    await expect(service.installAndActivate({
      activationCertificate: certificate,
      manifestDigest: certificate.manifestDigest,
      record,
    })).resolves.toMatchObject({ eventSequence: 12 });
    expect(run.mock.calls.filter(([call]) => call.args[0] === 'clone')).toHaveLength(1);
  });

  it('removes partial streamed artifacts and never activates on digest failure', async () => {
    const bytes = Buffer.from('bundle bytes');
    const manifest = createHostTransferPackageManifest({
      authorityMainOid: MAIN_OID,
      authoritySnapshot: identity(Buffer.from('database')),
      createdAt: NOW,
      gitBundle: { ...identity(bytes), sha256: 'f'.repeat(64) },
      gitObjectFormat: 'sha1',
      projectId: 'project-alpha',
      proofChainDigest: '3'.repeat(64),
      sourceAuthorityGeneration: 4,
      targetCaFingerprint: '4'.repeat(64),
      targetHostMemberId: 'member-target',
      transferId: 'transfer-alpha',
    });
    const service = new IncomingHostTransferPackage({
      ensureAuthorityDirectory: jest.fn(),
      projectsFolder: 'Projects',
      readPinnedSourceCa: jest.fn(),
      repositories: {} as never,
      resolveWorkingRepository: jest.fn(),
      runner: { run } as never,
      snapshots: {} as never,
      workspace,
    });

    await expect(service.stageAndValidate({
      authoritySnapshot: chunks(Buffer.from('database')),
      gitBundle: chunks(bytes),
      manifest,
      record: acceptedRecord(),
    })).rejects.toMatchObject({ code: 'authority-integrity-error' });
  });

  it('recovers only a bound v8 package and reconciles both installed-primary crash windows', async () => {
    const git = Buffer.from('legacy bundle bytes');
    const authority = Buffer.from('bound inert v8 database bytes');
    const legacyActivated = Buffer.from('activated v8 database bytes');
    const migratedActivated = Buffer.from('activated migrated v9 database bytes');
    const manifest = {
      ...createHostTransferPackageManifest({
        authorityMainOid: MAIN_OID,
        authoritySnapshot: identity(authority),
        createdAt: NOW,
        gitBundle: identity(git),
        gitObjectFormat: 'sha1',
        projectId: 'project-alpha',
        proofChainDigest: '3'.repeat(64),
        sourceAuthorityGeneration: 4,
        targetCaFingerprint: '4'.repeat(64),
        targetHostMemberId: 'member-target',
        transferId: 'transfer-alpha',
      }),
      authoritySchemaVersion: 8 as const,
    };
    const manifestDigest = digestHostTransferPackageManifest(manifest);
    const certificate = activation(manifestDigest);
    const snapshots = {
      activate: jest.fn().mockResolvedValue({
        bytes: migratedActivated,
        eventSequence: 12,
        legacyActivatedBytes: legacyActivated,
      }),
      inspectInert: jest.fn().mockResolvedValue({
        eventSequence: 11,
        expectedRefs: ['refs/heads/main', 'refs/heads/members/member-target'],
        proofChain: [],
      }),
      validateRecoveryMigration: jest.fn().mockResolvedValue(undefined),
    };
    const service = incomingPackage(snapshots);

    await expect(service.stageAndValidate({
      authoritySnapshot: chunks(authority),
      gitBundle: chunks(git),
      manifest,
      record: acceptedRecord(),
    })).resolves.toEqual({ manifestDigest });
    expect(snapshots.inspectInert).toHaveBeenCalledWith(expect.objectContaining({
      sourceHostMemberId: 'member-source',
    }));
    await expect(service.stageAndValidate({
      authoritySnapshot: chunks(authority),
      gitBundle: chunks(git),
      manifest,
      record: { ...acceptedRecord(), direction: 'outgoing' },
    })).rejects.toMatchObject({
      safeContext: { reason: 'host-transfer-target-recovery-record-invalid' },
    });

    await mkdir(authorityDirectory, { recursive: true });
    const legacyOwner = installOwner(manifestDigest, legacyActivated);
    await writeFile(
      path.join(authorityDirectory, '.host-transfer-install-owner.json'),
      JSON.stringify(legacyOwner),
    );
    await writeFile(path.join(authorityDirectory, 'collab.db'), legacyActivated);
    const record = activatedRecord(manifestDigest, certificate);
    await expect(service.installAndActivate({
      activationCertificate: certificate,
      manifestDigest,
      record,
    })).resolves.toEqual({ eventSequence: 12 });
    await expect(readFile(path.join(authorityDirectory, 'collab.db')))
      .resolves.toEqual(migratedActivated);

    await writeFile(
      path.join(authorityDirectory, '.host-transfer-install-owner.json'),
      JSON.stringify(legacyOwner),
    );
    await writeFile(
      path.join(authorityDirectory, '.host-transfer-installed.json'),
      JSON.stringify(legacyOwner),
    );
    await expect(service.installAndActivate({
      activationCertificate: certificate,
      manifestDigest,
      record,
    })).resolves.toEqual({ eventSequence: 12 });
    await expect(readFile(
      path.join(authorityDirectory, '.host-transfer-install-owner.json'),
      'utf8',
    )).resolves.toContain(sha256(migratedActivated));
    await expect(readFile(
      path.join(authorityDirectory, '.host-transfer-installed.json'),
      'utf8',
    )).resolves.toContain(sha256(migratedActivated));

    await writeFile(path.join(authorityDirectory, 'collab.db'), 'collision');
    await expect(service.installAndActivate({
      activationCertificate: certificate,
      manifestDigest,
      record,
    })).rejects.toMatchObject({
      safeContext: { reason: 'host-transfer-target-authority-collision' },
    });
  });

  function incomingPackage(snapshots: object) {
    const repositories = {
      assertHealthy: jest.fn().mockResolvedValue(undefined),
      configureHostedRepository: jest.fn().mockResolvedValue(undefined),
      resolveRef: jest.fn().mockResolvedValue(MAIN_OID),
    };
    return new IncomingHostTransferPackage({
      ensureAuthorityDirectory: async () => {
        await mkdir(authorityDirectory, { recursive: true });
        return authorityDirectory;
      },
      projectsFolder: 'Projects',
      readPinnedSourceCa: jest.fn().mockResolvedValue('source-ca'),
      repositories: repositories as never,
      resolveWorkingRepository: jest.fn().mockResolvedValue(root),
      runner: { run } as never,
      snapshots: snapshots as never,
      workspace,
    });
  }
});

function identity(bytes: Uint8Array) {
  return { byteCount: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
}

async function* chunks(bytes: Uint8Array) {
  yield bytes.subarray(0, Math.max(1, Math.floor(bytes.byteLength / 2)));
  yield bytes.subarray(Math.max(1, Math.floor(bytes.byteLength / 2)));
}

function acceptedRecord() {
  return createHostTransferRecoveryRecord({
    ownerInstallationKey: "device-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    createdAt: NOW, direction: 'incoming', projectId: 'project-alpha',
    receiverCredential: Buffer.alloc(32, 1).toString('base64url'),
    sourceHostMemberId: 'member-source',
    stagingDirectoryName: '.claudian-host-transfer-transfer-alpha',
    targetCaCertificatePem: '-----BEGIN CERTIFICATE-----\ntarget\n-----END CERTIFICATE-----\n',
    targetCaFingerprint: '4'.repeat(64),
    targetEndpoint: 'https://192.168.1.20:27000', targetHostMemberId: 'member-target',
    transferId: 'transfer-alpha',
  });
}

function stagedRecord(manifestDigest: string) {
  const accepted = acceptedRecord();
  const quiescing = advanceHostTransferRecoveryRecord(accepted, 'quiescing', NOW);
  return advanceHostTransferRecoveryRecord(quiescing, 'staged', NOW, { manifestDigest });
}

function result(stdout: string) {
  return { exitCode: 0, stderr: '', stdout: Buffer.from(stdout) };
}

function activation(manifestDigest: string) {
  return {
    cutoverAt: NOW,
    manifestDigest,
    projectId: 'project-alpha',
    schemaVersion: 1 as const,
    signature: '5'.repeat(64),
    signatureAlgorithm: 'rsa-pss-sha256' as const,
    targetCaFingerprint: '4'.repeat(64),
    targetHostMemberId: 'member-target',
    transferId: 'transfer-alpha',
  };
}

function activatedRecord(
  manifestDigest: string,
  certificate: ReturnType<typeof activation>,
) {
  return advanceHostTransferRecoveryRecord(
    stagedRecord(manifestDigest),
    'authority-relinquished',
    NOW,
    { activationCertificate: certificate },
  );
}

function installOwner(manifestDigest: string, bytes: Uint8Array) {
  return {
    activatedSnapshotDigest: sha256(bytes),
    manifestDigest,
    owner: 'claudian-host-transfer-install',
    projectId: 'project-alpha',
    schemaVersion: 1,
    transferId: 'transfer-alpha',
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
