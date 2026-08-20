import {
  constants as cryptoConstants,
  timingSafeEqual,
  verify,
  X509Certificate,
} from 'node:crypto';

import { type CollabIsoTimestamp, type CollabMemberId, type CollabOperationId, type CollabProjectId, isCollabMemberId, isCollabOpaqueId, isCollabProjectId } from '@claudian/collab-protocol';

import type { LanTlsHostCaSigner } from '@/app/collab/lan/LanTlsIdentity';
import { fingerprintCertificatePem } from '@/app/collab/lan/LanTlsIdentity';
import type { CollabHostTrustTransitionProof } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const TRANSITION_DOMAIN = 'claudian-collab-host-transition-v1\n';
const ACTIVATION_DOMAIN = 'claudian-collab-host-activation-v1\n';
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{64,2048}$/;

export interface HostTransferActivationCertificate {
  readonly schemaVersion: 1;
  readonly projectId: CollabProjectId;
  readonly transferId: CollabOperationId;
  readonly targetHostMemberId: CollabMemberId;
  readonly targetCaFingerprint: string;
  readonly manifestDigest: string;
  readonly cutoverAt: CollabIsoTimestamp;
  readonly signatureAlgorithm: 'rsa-pss-sha256';
  readonly signature: string;
}

export interface SignHostTransitionInput {
  readonly projectId: CollabProjectId;
  readonly transferId: CollabOperationId;
  readonly nextCaCertificatePem: string;
  readonly issuedAt: CollabIsoTimestamp;
}

export interface SignHostActivationInput {
  readonly projectId: CollabProjectId;
  readonly transferId: CollabOperationId;
  readonly targetHostMemberId: CollabMemberId;
  readonly targetCaFingerprint: string;
  readonly manifestDigest: string;
  readonly cutoverAt: CollabIsoTimestamp;
}

export interface VerifyHostTransitionChainInput {
  readonly projectId: CollabProjectId;
  readonly pinnedCaCertificatePem: string;
  readonly proofs: readonly CollabHostTrustTransitionProof[];
  readonly expectedCurrentCaFingerprint?: string;
}

function trustError(reason: string): CollabError {
  return new CollabError({
    code: 'tls-ca-mismatch',
    recoveryActions: ['open-diagnostics'],
    safeContext: { reason },
  });
}

function assertId(
  value: string,
  predicate: (candidate: unknown) => candidate is string,
  reason: string,
): void {
  if (!predicate(value)) throw trustError(reason);
}

function assertTimestamp(value: string, reason: string): void {
  if (Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw trustError(reason);
  }
}

function normalizeCaCertificate(certificatePem: string, reason: string): {
  readonly certificate: X509Certificate;
  readonly certificatePem: string;
  readonly fingerprint: string;
} {
  try {
    const normalized = `${certificatePem.replace(/\r\n?/g, '\n').trim()}\n`;
    if (normalized.includes('PRIVATE KEY')) throw new Error('Private key is forbidden');
    const certificate = new X509Certificate(normalized);
    if (!certificate.ca || !certificate.verify(certificate.publicKey)) {
      throw new Error('Certificate is not a self-signed CA');
    }
    return {
      certificate,
      certificatePem: normalized,
      fingerprint: fingerprintCertificatePem(normalized),
    };
  } catch {
    throw trustError(reason);
  }
}

function decodeSignature(signature: string): Buffer {
  if (!SIGNATURE_PATTERN.test(signature)) throw trustError('host-proof-signature-invalid');
  const bytes = Buffer.from(signature, 'base64url');
  if (bytes.toString('base64url') !== signature) {
    throw trustError('host-proof-signature-invalid');
  }
  return bytes;
}

function transitionPayload(proof: Omit<CollabHostTrustTransitionProof, 'signature'>): Buffer {
  return Buffer.from(`${TRANSITION_DOMAIN}${JSON.stringify([
    1,
    proof.projectId,
    proof.transferId,
    proof.previousCaFingerprint,
    proof.nextCaCertificatePem,
    proof.nextCaFingerprint,
    proof.issuedAt,
  ])}`, 'utf8');
}

function activationPayload(
  certificate: Omit<HostTransferActivationCertificate, 'signature'>,
): Buffer {
  return Buffer.from(`${ACTIVATION_DOMAIN}${JSON.stringify([
    1,
    certificate.projectId,
    certificate.transferId,
    certificate.targetHostMemberId,
    certificate.targetCaFingerprint,
    certificate.manifestDigest,
    certificate.cutoverAt,
  ])}`, 'utf8');
}

function verifySignature(
  payload: Uint8Array,
  signature: string,
  certificate: X509Certificate,
): void {
  const valid = verify('sha256', payload, {
    key: certificate.publicKey,
    padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
    saltLength: 32,
  }, decodeSignature(signature));
  if (!valid) throw trustError('host-proof-signature-mismatch');
}

function assertFingerprint(value: string, reason: string): void {
  if (!FINGERPRINT_PATTERN.test(value)) throw trustError(reason);
}

function assertDigest(value: string, reason: string): void {
  if (!FINGERPRINT_PATTERN.test(value)) throw trustError(reason);
}

export class HostTrustTransitionService {
  inspectCaCertificate(certificatePem: string): {
    readonly certificatePem: string;
    readonly fingerprint: string;
  } {
    const inspected = normalizeCaCertificate(certificatePem, 'host-ca-invalid');
    return Object.freeze({
      certificatePem: inspected.certificatePem,
      fingerprint: inspected.fingerprint,
    });
  }

  async signTransition(
    signer: LanTlsHostCaSigner,
    input: SignHostTransitionInput,
  ): Promise<CollabHostTrustTransitionProof> {
    assertId(input.projectId, isCollabProjectId, 'host-proof-project-invalid');
    assertId(input.transferId, isCollabOpaqueId, 'host-proof-transfer-invalid');
    assertTimestamp(input.issuedAt, 'host-proof-time-invalid');
    const previousCa = normalizeCaCertificate(
      signer.caCertificatePem,
      'host-proof-previous-ca-invalid',
    );
    if (previousCa.fingerprint !== signer.caFingerprint) {
      throw trustError('host-proof-signer-fingerprint-mismatch');
    }
    const nextCa = normalizeCaCertificate(input.nextCaCertificatePem, 'host-proof-next-ca-invalid');
    if (nextCa.fingerprint === previousCa.fingerprint) {
      throw trustError('host-proof-ca-unchanged');
    }
    const unsigned = {
      issuedAt: input.issuedAt,
      nextCaCertificatePem: nextCa.certificatePem,
      nextCaFingerprint: nextCa.fingerprint,
      previousCaFingerprint: previousCa.fingerprint,
      projectId: input.projectId,
      schemaVersion: 1 as const,
      signatureAlgorithm: 'rsa-pss-sha256' as const,
      transferId: input.transferId,
    };
    const signature = await signer.signRsaPssSha256(transitionPayload(unsigned));
    decodeSignature(signature);
    return Object.freeze({ ...unsigned, signature });
  }

  verifyTransition(
    proof: CollabHostTrustTransitionProof,
    previousCaCertificatePem: string,
    expected: { readonly projectId?: CollabProjectId; readonly transferId?: CollabOperationId } = {},
  ): string {
    if (proof.schemaVersion !== 1 || proof.signatureAlgorithm !== 'rsa-pss-sha256') {
      throw trustError('host-proof-shape-invalid');
    }
    assertId(proof.projectId, isCollabProjectId, 'host-proof-project-invalid');
    assertId(proof.transferId, isCollabOpaqueId, 'host-proof-transfer-invalid');
    assertTimestamp(proof.issuedAt, 'host-proof-time-invalid');
    assertFingerprint(proof.previousCaFingerprint, 'host-proof-previous-fingerprint-invalid');
    assertFingerprint(proof.nextCaFingerprint, 'host-proof-next-fingerprint-invalid');
    if (expected.projectId !== undefined && proof.projectId !== expected.projectId) {
      throw trustError('host-proof-project-mismatch');
    }
    if (expected.transferId !== undefined && proof.transferId !== expected.transferId) {
      throw trustError('host-proof-transfer-mismatch');
    }
    const previousCa = normalizeCaCertificate(
      previousCaCertificatePem,
      'host-proof-previous-ca-invalid',
    );
    const nextCa = normalizeCaCertificate(proof.nextCaCertificatePem, 'host-proof-next-ca-invalid');
    if (previousCa.fingerprint !== proof.previousCaFingerprint) {
      throw trustError('host-proof-previous-fingerprint-mismatch');
    }
    if (nextCa.fingerprint !== proof.nextCaFingerprint) {
      throw trustError('host-proof-next-fingerprint-mismatch');
    }
    if (nextCa.fingerprint === previousCa.fingerprint) {
      throw trustError('host-proof-ca-unchanged');
    }
    verifySignature(transitionPayload({
      issuedAt: proof.issuedAt,
      nextCaCertificatePem: proof.nextCaCertificatePem,
      nextCaFingerprint: proof.nextCaFingerprint,
      previousCaFingerprint: proof.previousCaFingerprint,
      projectId: proof.projectId,
      schemaVersion: 1,
      signatureAlgorithm: 'rsa-pss-sha256',
      transferId: proof.transferId,
    }), proof.signature, previousCa.certificate);
    return nextCa.certificatePem;
  }

  verifyChain(input: VerifyHostTransitionChainInput): string {
    assertId(input.projectId, isCollabProjectId, 'host-proof-project-invalid');
    if (input.expectedCurrentCaFingerprint !== undefined) {
      assertFingerprint(
        input.expectedCurrentCaFingerprint,
        'host-proof-current-ca-fingerprint-invalid',
      );
    }
    let current = normalizeCaCertificate(input.pinnedCaCertificatePem, 'host-proof-pinned-ca-invalid');
    const transferIds = new Set<string>();
    const previousFingerprints = new Set<string>();
    for (const proof of input.proofs) {
      if (transferIds.has(proof.transferId)) throw trustError('host-proof-transfer-duplicate');
      if (previousFingerprints.has(proof.previousCaFingerprint)) {
        throw trustError('host-proof-chain-fork');
      }
      if (proof.previousCaFingerprint !== current.fingerprint) {
        throw trustError('host-proof-chain-disconnected');
      }
      const nextPem = this.verifyTransition(proof, current.certificatePem, {
        projectId: input.projectId,
      });
      transferIds.add(proof.transferId);
      previousFingerprints.add(proof.previousCaFingerprint);
      current = normalizeCaCertificate(nextPem, 'host-proof-next-ca-invalid');
    }
    if (
      input.expectedCurrentCaFingerprint !== undefined
      && !timingSafeEqual(
        Buffer.from(current.fingerprint, 'hex'),
        Buffer.from(input.expectedCurrentCaFingerprint, 'hex'),
      )
    ) {
      throw trustError('host-proof-current-ca-mismatch');
    }
    return current.certificatePem;
  }

  async signActivation(
    signer: LanTlsHostCaSigner,
    input: SignHostActivationInput,
  ): Promise<HostTransferActivationCertificate> {
    assertId(input.projectId, isCollabProjectId, 'host-activation-project-invalid');
    assertId(input.transferId, isCollabOpaqueId, 'host-activation-transfer-invalid');
    assertId(input.targetHostMemberId, isCollabMemberId, 'host-activation-target-invalid');
    assertFingerprint(input.targetCaFingerprint, 'host-activation-ca-invalid');
    assertDigest(input.manifestDigest, 'host-activation-manifest-invalid');
    assertTimestamp(input.cutoverAt, 'host-activation-time-invalid');
    const signerCa = normalizeCaCertificate(signer.caCertificatePem, 'host-activation-ca-invalid');
    if (signerCa.fingerprint !== signer.caFingerprint) {
      throw trustError('host-activation-signer-fingerprint-mismatch');
    }
    const unsigned = {
      cutoverAt: input.cutoverAt,
      manifestDigest: input.manifestDigest,
      projectId: input.projectId,
      schemaVersion: 1 as const,
      signatureAlgorithm: 'rsa-pss-sha256' as const,
      targetCaFingerprint: input.targetCaFingerprint,
      targetHostMemberId: input.targetHostMemberId,
      transferId: input.transferId,
    };
    const signature = await signer.signRsaPssSha256(activationPayload(unsigned));
    decodeSignature(signature);
    return Object.freeze({ ...unsigned, signature });
  }

  verifyActivation(
    certificate: HostTransferActivationCertificate,
    previousCaCertificatePem: string,
    expected: SignHostActivationInput,
  ): void {
    if (certificate.schemaVersion !== 1 || certificate.signatureAlgorithm !== 'rsa-pss-sha256') {
      throw trustError('host-activation-shape-invalid');
    }
    assertId(certificate.projectId, isCollabProjectId, 'host-activation-project-invalid');
    assertId(certificate.transferId, isCollabOpaqueId, 'host-activation-transfer-invalid');
    assertId(certificate.targetHostMemberId, isCollabMemberId, 'host-activation-target-invalid');
    assertFingerprint(certificate.targetCaFingerprint, 'host-activation-ca-invalid');
    assertDigest(certificate.manifestDigest, 'host-activation-manifest-invalid');
    assertTimestamp(certificate.cutoverAt, 'host-activation-time-invalid');
    if (
      certificate.projectId !== expected.projectId
      || certificate.transferId !== expected.transferId
      || certificate.targetHostMemberId !== expected.targetHostMemberId
      || certificate.targetCaFingerprint !== expected.targetCaFingerprint
      || certificate.manifestDigest !== expected.manifestDigest
      || certificate.cutoverAt !== expected.cutoverAt
    ) {
      throw trustError('host-activation-binding-mismatch');
    }
    const previousCa = normalizeCaCertificate(
      previousCaCertificatePem,
      'host-activation-signer-ca-invalid',
    );
    verifySignature(activationPayload({
      cutoverAt: certificate.cutoverAt,
      manifestDigest: certificate.manifestDigest,
      projectId: certificate.projectId,
      schemaVersion: 1,
      signatureAlgorithm: 'rsa-pss-sha256',
      targetCaFingerprint: certificate.targetCaFingerprint,
      targetHostMemberId: certificate.targetHostMemberId,
      transferId: certificate.transferId,
    }), certificate.signature, previousCa.certificate);
  }
}
