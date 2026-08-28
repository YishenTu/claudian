import {
  constants as cryptoConstants,
  createPublicKey,
  generateKeyPair as generateNodeKeyPair,
  randomBytes,
  sign,
  X509Certificate,
} from 'node:crypto';
import { lstat, open, readFile, unlink } from 'node:fs/promises';
import { isIP } from 'node:net';

import forgeAsn1 from 'node-forge/lib/asn1';
import forgePem from 'node-forge/lib/pem';
import forgeSha256 from 'node-forge/lib/sha256';
import forgePki from 'node-forge/lib/x509';

import {
  ensureCollabContainerGuard,
  ensureCollabVaultDirectory,
  resolveCollabVaultPath,
  writeCollabFileAtomically,
} from '@/app/collab/CollabFilesystemBoundary';
import { CollabError } from '@/core/collab/ClaudianCollabError';
import { type InstallationKey, parseInstallationKey } from '@/core/device/InstallationKey';

const LEGACY_TLS_DIRECTORY = '.claudian/collab/tls';
const LEGACY_HOST_CA_PATH = `${LEGACY_TLS_DIRECTORY}/host-ca.json`;
const HOST_CA_SCHEMA_VERSION = 1;
const CA_VALIDITY_MS = 10 * 365 * 24 * 60 * 60 * 1000;
const LEAF_VALIDITY_MS = 24 * 60 * 60 * 1000;
const CERTIFICATE_CLOCK_SKEW_MS = 5 * 60 * 1000;
const IDENTITY_LOCK_TIMEOUT_MS = 10_000;
const STALE_IDENTITY_LOCK_MS = 2 * 60 * 1000;

interface PersistedHostCa {
  readonly schemaVersion: typeof HOST_CA_SCHEMA_VERSION;
  readonly certificatePem: string;
  readonly privateKeyPem: string;
}

export interface LanTlsHostCa {
  readonly caCertificatePem: string;
  readonly caFingerprint: string;
  readonly caPrivateKeyPem: string;
}

export interface LanTlsServerIdentity {
  readonly caCertificatePem: string;
  readonly caFingerprint: string;
  readonly certificateChainPem: string;
  readonly certificatePem: string;
  readonly notAfter: Date;
  readonly notBefore: Date;
  readonly privateKeyPem: string;
}

/**
 * Narrow signing capability used by Project-scoped Host handoff proofs.
 * The Vault CA private key remains captured by this object and is never
 * projected into transfer state or transport DTOs.
 */
export interface LanTlsHostCaSigner {
  readonly caCertificatePem: string;
  readonly caFingerprint: string;
  signRsaPssSha256(payload: Uint8Array): Promise<string>;
}

export interface LanTlsIdentityOptions {
  readonly installationKey: InstallationKey;
  readonly now?: () => Date;
}

export interface IssueServerIdentityOptions {
  readonly now?: Date;
  readonly validityMs?: number;
}

function tlsIdentityError(
  reason: string,
  code: 'authority-integrity-error' | 'operation-failed' | 'operation-timeout'
    = 'authority-integrity-error',
): CollabError {
  return new CollabError({
    code,
    recoveryActions: code === 'operation-timeout'
      ? ['retry']
      : ['open-diagnostics'],
    safeContext: { reason },
  });
}

function normalizePem(pem: string): string {
  return `${pem.replace(/\r\n?/g, '\n').trim()}\n`;
}

function privateKeyFromPem(pem: string): ReturnType<typeof forgePki.privateKeyFromAsn1> {
  const message = forgePem.decode(pem)[0];
  const procType = message?.procType as { readonly type?: unknown } | null | undefined;
  if (
    !message
    || (message.type !== 'PRIVATE KEY' && message.type !== 'RSA PRIVATE KEY')
    || procType?.type === 'ENCRYPTED'
  ) {
    throw new Error('Unsupported RSA private key PEM');
  }
  return forgePki.privateKeyFromAsn1(forgeAsn1.fromDer(message.body));
}

function certificateSerial(): string {
  const bytes = randomBytes(16);
  bytes[0] &= 0x7f;
  if (bytes.every(value => value === 0)) bytes[bytes.length - 1] = 1;
  return bytes.toString('hex');
}

function generateRsaKeyPair(): Promise<{
  readonly privateKeyPem: string;
  readonly publicKeyPem: string;
}> {
  return new Promise((resolve, reject) => {
    generateNodeKeyPair('rsa', { modulusLength: 2048 }, (error, publicKey, privateKey) => {
      if (error) {
        reject(tlsIdentityError('key-generation-failed', 'operation-failed'));
        return;
      }
      try {
        resolve({
          privateKeyPem: normalizePem(privateKey.export({
            format: 'pem',
            type: 'pkcs1',
          }).toString()),
          publicKeyPem: normalizePem(publicKey.export({
            format: 'pem',
            type: 'pkcs1',
          }).toString()),
        });
      } catch {
        reject(tlsIdentityError('key-generation-failed', 'operation-failed'));
      }
    });
  });
}

function publicKeysMatch(certificate: X509Certificate, privateKeyPem: string): boolean {
  try {
    const certificateKey = certificate.publicKey.export({ format: 'der', type: 'spki' });
    const privateKey = createPublicKey(privateKeyPem).export({ format: 'der', type: 'spki' });
    return Buffer.from(certificateKey).equals(Buffer.from(privateKey));
  } catch {
    return false;
  }
}

export function fingerprintCertificatePem(certificatePem: string): string {
  try {
    return new X509Certificate(certificatePem).fingerprint256
      .replaceAll(':', '')
      .toLocaleLowerCase('en-US');
  } catch {
    throw tlsIdentityError('certificate-invalid');
  }
}

export class LanTlsIdentity {
  private readonly hostCaLockPath: string;
  private readonly hostCaPath: string;
  private identityPromise: Promise<LanTlsHostCa> | null = null;
  private readonly installationKey: InstallationKey;
  private readonly now: () => Date;
  private readonly tlsDirectory: string;

  constructor(
    private readonly vaultRoot: string,
    options: LanTlsIdentityOptions,
  ) {
    this.installationKey = parseInstallationKey(options.installationKey);
    this.tlsDirectory = `.claudian/collab/installations/${this.installationKey}/tls`;
    this.hostCaPath = `${this.tlsDirectory}/host-ca.json`;
    this.hostCaLockPath = `${this.tlsDirectory}/host-ca.lock`;
    this.now = options.now ?? (() => new Date());
  }

  loadOrCreate(): Promise<LanTlsHostCa> {
    if (this.identityPromise) return this.identityPromise;
    const pending = this.loadOrCreateUnlocked();
    this.identityPromise = pending;
    const clearPending = () => {
      if (this.identityPromise === pending) this.identityPromise = null;
    };
    void pending.then(clearPending, clearPending);
    return pending;
  }

  async hostCaSigner(): Promise<LanTlsHostCaSigner> {
    const hostCa = await this.loadOrCreate();
    return Object.freeze({
      caCertificatePem: hostCa.caCertificatePem,
      caFingerprint: hostCa.caFingerprint,
      signRsaPssSha256: async (payload: Uint8Array): Promise<string> => sign(
        'sha256',
        payload,
        {
          key: hostCa.caPrivateKeyPem,
          padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
          saltLength: 32,
        },
      ).toString('base64url'),
    });
  }

  async adoptLegacyGlobalIdentity(
    expectedFingerprint: string | null,
  ): Promise<LanTlsHostCa> {
    await ensureCollabContainerGuard(this.vaultRoot, '.claudian/collab', {
      privateContainer: true,
    });
    await ensureCollabVaultDirectory(
      this.vaultRoot,
      `.claudian/collab/installations/${this.installationKey}`,
      { mode: 0o700 },
    );
    await ensureCollabVaultDirectory(this.vaultRoot, this.tlsDirectory, { mode: 0o700 });
    return this.withIdentityLock(async () => {
      const current = await this.readPersistedIdentity(this.hostCaPath);
      if (current) {
        this.assertExpectedFingerprint(current, expectedFingerprint);
        return current;
      }
      const legacy = await this.readPersistedIdentity(LEGACY_HOST_CA_PATH);
      if (!legacy) {
        if (expectedFingerprint !== null) {
          throw tlsIdentityError('legacy-host-ca-missing');
        }
        const created = await this.createHostCa();
        await this.persistHostCa(created);
        return created;
      }
      this.assertExpectedFingerprint(legacy, expectedFingerprint);
      await this.persistHostCa(legacy);
      return legacy;
    });
  }

  async issueServerIdentity(
    address: string,
    options: IssueServerIdentityOptions = {},
  ): Promise<LanTlsServerIdentity> {
    if (isIP(address) !== 4) {
      throw tlsIdentityError('server-address-must-be-ipv4', 'operation-failed');
    }
    const hostCa = await this.loadOrCreate();
    const caCertificate = forgePki.certificateFromPem(hostCa.caCertificatePem);
    const caPrivateKey = privateKeyFromPem(hostCa.caPrivateKeyPem);
    const keyPairPem = await generateRsaKeyPair();
    const certificate = forgePki.createCertificate();
    const issuedAt = options.now ?? this.now();
    const validityMs = options.validityMs ?? LEAF_VALIDITY_MS;
    if (!Number.isFinite(validityMs) || validityMs <= 0) {
      throw tlsIdentityError('leaf-validity-invalid', 'operation-failed');
    }
    const notBefore = new Date(issuedAt.getTime() - CERTIFICATE_CLOCK_SKEW_MS);
    const notAfter = new Date(issuedAt.getTime() + validityMs);

    certificate.publicKey = forgePki.publicKeyFromPem(keyPairPem.publicKeyPem);
    certificate.serialNumber = certificateSerial();
    certificate.validity.notBefore = notBefore;
    certificate.validity.notAfter = notAfter;
    certificate.setSubject([
      { name: 'commonName', value: 'Claudian LAN Host' },
      { name: 'organizationName', value: 'Claudian Collab' },
    ]);
    certificate.setIssuer(caCertificate.subject.attributes);
    certificate.setExtensions([
      { cA: false, critical: true, name: 'basicConstraints' },
      {
        critical: true,
        digitalSignature: true,
        keyEncipherment: true,
        name: 'keyUsage',
      },
      { clientAuth: false, name: 'extKeyUsage', serverAuth: true },
      { altNames: [{ ip: address, type: 7 }], name: 'subjectAltName' },
      { name: 'subjectKeyIdentifier' },
    ]);
    certificate.sign(caPrivateKey, forgeSha256.create());

    const certificatePem = normalizePem(forgePki.certificateToPem(certificate));
    return Object.freeze({
      caCertificatePem: hostCa.caCertificatePem,
      caFingerprint: hostCa.caFingerprint,
      certificateChainPem: `${certificatePem.trim()}\n${hostCa.caCertificatePem.trim()}\n`,
      certificatePem,
      notAfter,
      notBefore,
      privateKeyPem: keyPairPem.privateKeyPem,
    });
  }

  private async loadOrCreateUnlocked(): Promise<LanTlsHostCa> {
    await ensureCollabContainerGuard(this.vaultRoot, '.claudian/collab', {
      privateContainer: true,
    });
    await ensureCollabVaultDirectory(
      this.vaultRoot,
      `.claudian/collab/installations/${this.installationKey}`,
      { mode: 0o700 },
    );
    await ensureCollabVaultDirectory(this.vaultRoot, this.tlsDirectory, { mode: 0o700 });
    return this.withIdentityLock(async () => {
      const existing = await this.readPersistedIdentity(this.hostCaPath);
      if (existing) return existing;
      const created = await this.createHostCa();
      await this.persistHostCa(created);
      return created;
    });
  }

  private async readPersistedIdentity(relativePath: string): Promise<LanTlsHostCa | null> {
    let contents: string;
    try {
      const absolutePath = await resolveCollabVaultPath(
        this.vaultRoot,
        relativePath,
        { mustExist: true },
      );
      contents = await readFile(absolutePath, 'utf8');
    } catch (error) {
      if (
        error instanceof CollabError
        && error.code === 'project-not-found'
      ) {
        return null;
      }
      throw error;
    }
    let persisted: unknown;
    try {
      persisted = JSON.parse(contents);
    } catch {
      throw tlsIdentityError('host-ca-record-invalid');
    }
    if (
      typeof persisted !== 'object'
      || persisted === null
      || Array.isArray(persisted)
      || (persisted as Record<string, unknown>).schemaVersion !== HOST_CA_SCHEMA_VERSION
      || typeof (persisted as Record<string, unknown>).certificatePem !== 'string'
      || typeof (persisted as Record<string, unknown>).privateKeyPem !== 'string'
    ) {
      throw tlsIdentityError('host-ca-record-invalid');
    }
    return this.validateHostCa(
      (persisted as Record<string, string>).certificatePem,
      (persisted as Record<string, string>).privateKeyPem,
    );
  }

  private persistHostCa(hostCa: LanTlsHostCa): Promise<void> {
    const persisted: PersistedHostCa = {
      certificatePem: hostCa.caCertificatePem,
      privateKeyPem: hostCa.caPrivateKeyPem,
      schemaVersion: HOST_CA_SCHEMA_VERSION,
    };
    return writeCollabFileAtomically(
      this.vaultRoot,
      this.hostCaPath,
      `${JSON.stringify(persisted)}\n`,
      { mode: 0o600 },
    );
  }

  private assertExpectedFingerprint(
    hostCa: LanTlsHostCa,
    expectedFingerprint: string | null,
  ): void {
    if (
      expectedFingerprint !== null
      && hostCa.caFingerprint !== expectedFingerprint.toLocaleLowerCase('en-US')
    ) {
      throw tlsIdentityError('legacy-host-ca-fingerprint-mismatch');
    }
  }

  private async createHostCa(): Promise<LanTlsHostCa> {
    const keyPairPem = await generateRsaKeyPair();
    const privateKey = privateKeyFromPem(keyPairPem.privateKeyPem);
    const certificate = forgePki.createCertificate();
    const now = this.now();
    certificate.publicKey = forgePki.publicKeyFromPem(keyPairPem.publicKeyPem);
    certificate.serialNumber = certificateSerial();
    certificate.validity.notBefore = new Date(now.getTime() - CERTIFICATE_CLOCK_SKEW_MS);
    certificate.validity.notAfter = new Date(now.getTime() + CA_VALIDITY_MS);
    const attributes = [
      { name: 'commonName', value: 'Claudian Vault Host CA' },
      { name: 'organizationName', value: 'Claudian Collab' },
    ];
    certificate.setSubject(attributes);
    certificate.setIssuer(attributes);
    certificate.setExtensions([
      { cA: true, critical: true, name: 'basicConstraints' },
      {
        cRLSign: true,
        critical: true,
        digitalSignature: true,
        keyCertSign: true,
        name: 'keyUsage',
      },
      { name: 'subjectKeyIdentifier' },
    ]);
    certificate.sign(privateKey, forgeSha256.create());
    return this.validateHostCa(
      normalizePem(forgePki.certificateToPem(certificate)),
      keyPairPem.privateKeyPem,
    );
  }

  private validateHostCa(certificatePem: string, privateKeyPem: string): LanTlsHostCa {
    try {
      const normalizedCertificate = normalizePem(certificatePem);
      const normalizedPrivateKey = normalizePem(privateKeyPem);
      const certificate = new X509Certificate(normalizedCertificate);
      const now = this.now().getTime();
      if (
        !certificate.ca
        || !certificate.verify(certificate.publicKey)
        || !publicKeysMatch(certificate, normalizedPrivateKey)
        || Date.parse(certificate.validFrom) > now
        || Date.parse(certificate.validTo) <= now
      ) {
        throw new Error('Host CA validation failed');
      }
      privateKeyFromPem(normalizedPrivateKey);
      return Object.freeze({
        caCertificatePem: normalizedCertificate,
        caFingerprint: fingerprintCertificatePem(normalizedCertificate),
        caPrivateKeyPem: normalizedPrivateKey,
      });
    } catch {
      throw tlsIdentityError('host-ca-integrity-invalid');
    }
  }

  private async withIdentityLock<T>(operation: () => Promise<T>): Promise<T> {
    const lockPath = await resolveCollabVaultPath(this.vaultRoot, this.hostCaLockPath);
    const startedAt = Date.now();
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    while (!handle) {
      try {
        handle = await open(lockPath, 'wx', 0o600);
        await handle.writeFile(`${process.pid}\n`);
        await handle.sync();
      } catch (error) {
        await handle?.close().catch(() => undefined);
        handle = null;
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw tlsIdentityError('host-ca-lock-failed', 'operation-failed');
        }
        const lockStat = await lstat(lockPath).catch(() => null);
        if (lockStat && (!lockStat.isFile() || lockStat.isSymbolicLink())) {
          throw tlsIdentityError('host-ca-lock-boundary-invalid');
        }
        if (lockStat && Date.now() - lockStat.mtimeMs > STALE_IDENTITY_LOCK_MS) {
          await unlink(lockPath).catch(() => undefined);
          continue;
        }
        if (Date.now() - startedAt >= IDENTITY_LOCK_TIMEOUT_MS) {
          throw tlsIdentityError('host-ca-lock-timeout', 'operation-timeout');
        }
        await new Promise(resolve => window.setTimeout(resolve, 25));
      }
    }
    try {
      return await operation();
    } finally {
      await handle.close().catch(() => undefined);
      await unlink(lockPath).catch(() => undefined);
    }
  }
}
