import { X509Certificate } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  fingerprintCertificatePem,
  LanTlsIdentity,
} from '@/app/collab/lan/LanTlsIdentity';
import type { CollabError } from '@/core/collab/ClaudianCollabError';

jest.setTimeout(60_000);

describe('LanTlsIdentity', () => {
  let vaultRoot: string;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(path.join(tmpdir(), 'claudian-tls-identity-'));
  });

  afterEach(async () => {
    await rm(vaultRoot, { force: true, recursive: true });
  });

  it('persists one Vault Host CA behind the private Collab guard', async () => {
    const first = await new LanTlsIdentity(vaultRoot).loadOrCreate();
    const reopened = await new LanTlsIdentity(vaultRoot).loadOrCreate();

    expect(reopened).toEqual(first);
    expect(first.caFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprintCertificatePem(first.caCertificatePem)).toBe(first.caFingerprint);
    expect(new X509Certificate(first.caCertificatePem).ca).toBe(true);
    await expect(readFile(
      path.join(vaultRoot, '.claudian', 'collab', '.gitignore'),
      'utf8',
    )).resolves.toBe('/*\n');
    const identityStat = await stat(path.join(
      vaultRoot,
      '.claudian',
      'collab',
      'tls',
      'host-ca.json',
    ));
    const identityMode = identityStat.mode & 0o777;
    expect(identityMode).toBe(process.platform === 'win32' ? identityMode : 0o600);
  });

  it('issues a short-lived server leaf with the selected IP SAN and CA chain', async () => {
    const identity = new LanTlsIdentity(vaultRoot, {
      now: () => new Date('2026-08-08T00:00:00.000Z'),
    });

    const issued = await identity.issueServerIdentity('192.168.1.42');
    const leaf = new X509Certificate(issued.certificatePem);

    expect(leaf.ca).toBe(false);
    expect(leaf.subjectAltName).toContain('IP Address:192.168.1.42');
    expect(leaf.checkIP('192.168.1.42')).toBe('192.168.1.42');
    expect(leaf.checkIP('192.168.1.43')).toBeUndefined();
    expect(issued.certificateChainPem).toBe(
      `${issued.certificatePem.trim()}\n${issued.caCertificatePem.trim()}\n`,
    );
    expect(issued.notAfter.getTime()).toBeGreaterThan(issued.notBefore.getTime());
  });

  it('fails closed on a corrupt persisted identity instead of replacing it', async () => {
    const identity = new LanTlsIdentity(vaultRoot);
    await identity.loadOrCreate();
    const identityPath = path.join(
      vaultRoot,
      '.claudian',
      'collab',
      'tls',
      'host-ca.json',
    );
    await writeFile(identityPath, '{"schemaVersion":1,"certificatePem":"broken"}');

    await expect(new LanTlsIdentity(vaultRoot).loadOrCreate()).rejects.toEqual(
      expect.objectContaining<Partial<CollabError>>({
        code: 'authority-integrity-error',
      }),
    );
  });
});
