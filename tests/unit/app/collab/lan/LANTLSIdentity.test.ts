import { randomBytes, X509Certificate } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSecureContext } from 'node:tls';

import { testClock } from '@test/helpers/testClock';

import {
  fingerprintCertificatePem,
  LANTLSIdentity,
} from '@/app/collab/lan/LANTLSIdentity';
import type { CollabError } from '@/core/collab/ClaudianCollabError';
import { parseInstallationKey } from '@/core/device/InstallationKey';

jest.setTimeout(60_000);

jest.mock('node:crypto', () => ({
  ...jest.requireActual('node:crypto'),
  randomBytes: jest.fn(jest.requireActual('node:crypto').randomBytes),
}));

const INSTALLATION_A = parseInstallationKey(`device-${'a'.repeat(64)}`);
const INSTALLATION_B = parseInstallationKey(`device-${'b'.repeat(64)}`);

describe('LANTLSIdentity', () => {
  let vaultRoot: string;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(path.join(tmpdir(), 'claudian-tls-identity-'));
  });

  afterEach(async () => {
    jest.mocked(randomBytes).mockReset();
    jest.mocked(randomBytes).mockImplementation(jest.requireActual('node:crypto').randomBytes);
    await rm(vaultRoot, { force: true, recursive: true });
  });

  it.each([
    '00010000000000000000000000000000',
    '00000100000000000000000000000000',
    '00800000000000000000000000000000',
    '80010000000000000000000000000000',
    '00000000000000000000000000000000',
  ])('issues a TLS-usable chain with serial entropy %s', async (entropy) => {
    jest.mocked(randomBytes).mockImplementation(() => Buffer.from(entropy, 'hex'));
    const issued = await new LANTLSIdentity(vaultRoot, {
      installationKey: INSTALLATION_A,
    }).issueServerIdentity('192.168.1.42');

    expect(() => createSecureContext({
      cert: issued.certificateChainPem,
      key: issued.privateKeyPem,
      ca: issued.caCertificatePem,
    })).not.toThrow();
  });

  it('persists one Vault Host CA behind the private Collab guard', async () => {
    const first = await new LANTLSIdentity(vaultRoot, {
      installationKey: INSTALLATION_A,
    }).loadOrCreate();
    const reopened = await new LANTLSIdentity(vaultRoot, {
      installationKey: INSTALLATION_A,
    }).loadOrCreate();

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
      'installations',
      INSTALLATION_A,
      'tls',
      'host-ca.json',
    ));
    const identityMode = identityStat.mode & 0o777;
    expect(identityMode).toBe(process.platform === 'win32' ? identityMode : 0o600);
  });

  it('issues a short-lived server leaf with the selected IP SAN and CA chain', async () => {
    const identity = new LANTLSIdentity(vaultRoot, {
      installationKey: INSTALLATION_A,
      now: testClock({ days: -19 }),
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
    const identity = new LANTLSIdentity(vaultRoot, { installationKey: INSTALLATION_A });
    await identity.loadOrCreate();
    const identityPath = path.join(
      vaultRoot,
      '.claudian',
      'collab',
      'installations',
      INSTALLATION_A,
      'tls',
      'host-ca.json',
    );
    await writeFile(identityPath, '{"schemaVersion":1,"certificatePem":"broken"}');

    await expect(new LANTLSIdentity(vaultRoot, {
      installationKey: INSTALLATION_A,
    }).loadOrCreate()).rejects.toEqual(
      expect.objectContaining<Partial<CollabError>>({
        code: 'authority-integrity-error',
      }),
    );
  });

  it('never selects or changes another installation copied Host CA', async () => {
    const aIdentityPath = path.join(
      vaultRoot,
      '.claudian',
      'collab',
      'installations',
      INSTALLATION_A,
      'tls',
      'host-ca.json',
    );
    const a = await new LANTLSIdentity(vaultRoot, {
      installationKey: INSTALLATION_A,
    }).loadOrCreate();
    const copiedA = await readFile(aIdentityPath, 'utf8');

    const b = await new LANTLSIdentity(vaultRoot, {
      installationKey: INSTALLATION_B,
    }).loadOrCreate();

    expect(b.caFingerprint).not.toBe(a.caFingerprint);
    await expect(readFile(aIdentityPath, 'utf8')).resolves.toBe(copiedA);
    await expect(stat(path.join(
      vaultRoot,
      '.claudian',
      'collab',
      'installations',
      INSTALLATION_B,
      'tls',
      'host-ca.json',
    ))).resolves.toMatchObject({});
  });

  it('validates and copies the legacy global CA before explicit marker claim', async () => {
    const aIdentityPath = path.join(
      vaultRoot,
      '.claudian',
      'collab',
      'installations',
      INSTALLATION_A,
      'tls',
      'host-ca.json',
    );
    const generated = await new LANTLSIdentity(vaultRoot, {
      installationKey: INSTALLATION_A,
    }).loadOrCreate();
    const persisted = await readFile(aIdentityPath, 'utf8');
    const legacyPath = path.join(vaultRoot, '.claudian', 'collab', 'tls', 'host-ca.json');
    await mkdir(path.dirname(legacyPath), { recursive: true });
    await writeFile(legacyPath, persisted, { mode: 0o600 });
    await rm(path.join(
      vaultRoot,
      '.claudian',
      'collab',
      'installations',
      INSTALLATION_A,
    ), { recursive: true });

    const adopted = await new LANTLSIdentity(vaultRoot, {
      installationKey: INSTALLATION_A,
    }).adoptLegacyGlobalIdentity(generated.caFingerprint);

    expect(adopted.caFingerprint).toBe(generated.caFingerprint);
    await expect(readFile(aIdentityPath, 'utf8')).resolves.toBe(persisted);
    await expect(readFile(legacyPath, 'utf8')).resolves.toBe(persisted);
  });
});
