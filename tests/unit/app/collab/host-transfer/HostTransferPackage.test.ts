import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { COLLAB_AUTHORITY_SCHEMA_VERSION } from '@/app/collab/CollabSchemaVersions';
import {
  createHostTransferPackageManifest,
  decodeHostTransferPackageManifest,
  digestHostTransferPackageManifest,
  HostTransferArtifactStore,
  HostTransferGitBundleBuilder,
  parseHostTransferPackageManifest,
  parseHostTransferRecoveryPackageManifest,
  serializeHostTransferPackageManifest,
} from '@/app/collab/host-transfer/HostTransferPackage';
import { COLLAB_HOST_TRANSFER_PROTOCOL_VERSION } from '@/app/collab/lan/LanCollabConstants';

describe('HostTransferPackage', () => {
  let operationDirectory: string;

  beforeEach(async () => {
    operationDirectory = await mkdtemp(path.join(tmpdir(), 'claudian-host-package-'));
  });

  afterEach(async () => {
    await rm(operationDirectory, { force: true, recursive: true });
  });

  function manifest() {
    return createHostTransferPackageManifest({
      authorityMainOid: 'a'.repeat(40),
      authoritySnapshot: { byteCount: 20, sha256: 'b'.repeat(64) },
      createdAt: '2026-08-08T00:00:00.000Z',
      gitBundle: { byteCount: 10, sha256: 'c'.repeat(64) },
      gitObjectFormat: 'sha1',
      projectId: 'project-1',
      proofChainDigest: 'd'.repeat(64),
      sourceAuthorityGeneration: 12,
      targetCaFingerprint: 'e'.repeat(64),
      targetHostMemberId: 'member-2',
      transferId: 'transfer-1',
    });
  }

  it('round-trips one strict canonical manifest and rejects unknown fields', () => {
    const value = manifest();
    const serialized = serializeHostTransferPackageManifest(value);

    expect(value).toMatchObject({
      authoritySchemaVersion: COLLAB_AUTHORITY_SCHEMA_VERSION,
      protocolVersion: COLLAB_HOST_TRANSFER_PROTOCOL_VERSION,
    });
    expect(parseHostTransferPackageManifest(serialized)).toEqual(value);
    expect(digestHostTransferPackageManifest(value)).toMatch(/^[0-9a-f]{64}$/);
    expect(() => decodeHostTransferPackageManifest({
      ...value,
      receiverCredential: 'secret',
    })).toThrow();
    expect(() => decodeHostTransferPackageManifest({
      ...value,
      gitBundle: { ...value.gitBundle, path: '/private/bundle' },
    })).toThrow();
  });

  it('applies Project, Member, transfer, and Git OID boundaries by semantic field', () => {
    const value = manifest();
    expect(() => decodeHostTransferPackageManifest({
      ...value,
      projectId: `p${'a'.repeat(63)}`,
      targetHostMemberId: `m${'a'.repeat(63)}`,
      transferId: `t${'a'.repeat(127)}`,
    })).not.toThrow();
    expect(() => decodeHostTransferPackageManifest({
      ...value,
      projectId: `p${'a'.repeat(64)}`,
    })).toThrow();
    expect(() => decodeHostTransferPackageManifest({
      ...value,
      targetHostMemberId: `m${'a'.repeat(64)}`,
    })).toThrow();
    expect(() => decodeHostTransferPackageManifest({
      ...value,
      transferId: `t${'a'.repeat(128)}`,
    })).toThrow();
    expect(() => decodeHostTransferPackageManifest({
      ...value,
      authorityMainOid: 'a'.repeat(64),
      gitObjectFormat: 'sha256',
    })).not.toThrow();
    expect(() => decodeHostTransferPackageManifest({
      ...value,
      authorityMainOid: 'A'.repeat(40),
    })).toThrow();
  });

  it.each([8, 9, 10] as const)(
    'accepts schema %s only through the explicit incoming recovery decoder',
    authoritySchemaVersion => {
    const legacy = {
      ...manifest(),
      authoritySchemaVersion,
    };
    const serialized = JSON.stringify(legacy);

    expect(() => parseHostTransferPackageManifest(serialized)).toThrow();
    expect(parseHostTransferRecoveryPackageManifest(serialized)).toEqual(legacy);
    expect(digestHostTransferPackageManifest(
      parseHostTransferRecoveryPackageManifest(serialized),
    )).toBe(createHash('sha256').update(serialized, 'utf8').digest('hex'));
    },
  );

  it('streams an exact artifact atomically and replays only identical bytes', async () => {
    const bytes = Buffer.from('streamed authority package');
    const expected = {
      byteCount: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
    const store = new HostTransferArtifactStore(operationDirectory);
    async function* chunks() {
      yield bytes.subarray(0, 8);
      yield bytes.subarray(8);
    }

    await expect(store.receive('git-bundle', chunks(), expected)).resolves.toBe(
      path.join(operationDirectory, 'authority.bundle'),
    );
    await expect(store.receive('git-bundle', chunks(), expected)).resolves.toBe(
      path.join(operationDirectory, 'authority.bundle'),
    );
    await expect(store.receive('git-bundle', chunks(), {
      ...expected,
      sha256: 'f'.repeat(64),
    })).rejects.toBeDefined();
  });

  it('cleans partial files on cancellation and digest mismatch', async () => {
    const bytes = Buffer.from('partial package');
    const store = new HostTransferArtifactStore(operationDirectory);
    const controller = new AbortController();
    async function* cancelledChunks() {
      yield bytes.subarray(0, 4);
      controller.abort();
      yield bytes.subarray(4);
    }

    await expect(store.receive('authority-snapshot', cancelledChunks(), {
      byteCount: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }, controller.signal)).rejects.toMatchObject({ code: 'cancelled' });
    expect(await readdir(operationDirectory)).toEqual([]);

    async function* chunks() { yield bytes; }
    await expect(store.receive('authority-snapshot', chunks(), {
      byteCount: bytes.byteLength,
      sha256: 'a'.repeat(64),
    })).rejects.toBeDefined();
    expect(await readdir(operationDirectory)).toEqual([]);
  });

  it('builds and verifies a native all-ref bundle before returning its identity', async () => {
    const bundlePath = path.join(operationDirectory, 'out.bundle');
    const run = jest.fn(async ({ args }: { readonly args: readonly string[] }) => {
      if (args[1] === 'create') await writeFile(bundlePath, 'bundle bytes');
      return { exitCode: 0, stderr: '', stdout: Buffer.alloc(0) };
    });
    const builder = new HostTransferGitBundleBuilder({ run } as never);

    const identity = await builder.createAllRefsBundle(operationDirectory, bundlePath);

    expect(identity.byteCount).toBe(Buffer.byteLength('bundle bytes'));
    expect(run).toHaveBeenNthCalledWith(1, expect.objectContaining({
      args: ['bundle', 'create', bundlePath, '--all'],
    }));
    expect(run).toHaveBeenNthCalledWith(2, expect.objectContaining({
      args: ['bundle', 'verify', bundlePath],
    }));
  });
});
