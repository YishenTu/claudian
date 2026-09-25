import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { TEST_INSTALLATION_A } from '@test/helpers/installations';
import { testClock, testTime } from '@test/helpers/testClock';

import { digestHostTransitionProofChain } from '@/app/collab/host-transfer/HostTransferPackage';
import {
  HostTrustTransitionService,
} from '@/app/collab/host-transfer/HostTrustTransitionService';
import { LanTlsIdentity } from '@/app/collab/lan/LanTlsIdentity';

jest.setTimeout(120_000);

describe('HostTrustTransitionService', () => {
  const service = new HostTrustTransitionService();
  const roots: string[] = [];
  let identities: LanTlsIdentity[];

  async function identity(name: string): Promise<LanTlsIdentity> {
    const root = await mkdtemp(path.join(tmpdir(), `claudian-${name}-`));
    roots.push(root);
    return new LanTlsIdentity(root, {
      installationKey: TEST_INSTALLATION_A,
      now: testClock({ days: -19 }),
    });
  }

  beforeAll(async () => {
    identities = await Promise.all(['first', 'second', 'third'].map(identity));
    await Promise.all(identities.map(value => value.loadOrCreate()));
  });

  afterAll(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })));
  });

  it('canonicalizes CRLF CA certificates before they enter transition proofs', async () => {
    const source = identities[0];
    const target = identities[1];
    const next = await target.loadOrCreate();
    const proof = await service.signTransition(await source.hostCaSigner(), {
      issuedAt: testTime({ days: -19 }),
      nextCaCertificatePem: next.caCertificatePem.replaceAll('\n', '\r\n'),
      projectId: 'project-alpha',
      transferId: 'transfer-one',
    });

    expect(proof.nextCaCertificatePem).not.toContain('\r');
  });

  it('signs the exact RSA-PSS transition payload without projecting private material', async () => {
    const source = identities[0];
    const target = identities[1];
    const sourceSigner = await source.hostCaSigner();
    const targetCa = await target.loadOrCreate();

    const proof = await service.signTransition(sourceSigner, {
      issuedAt: testTime({ days: -19 }),
      nextCaCertificatePem: targetCa.caCertificatePem,
      projectId: 'project-1',
      transferId: 'transfer-1',
    });

    expect(service.verifyTransition(proof, sourceSigner.caCertificatePem, {
      projectId: 'project-1',
      transferId: 'transfer-1',
    })).toBe(targetCa.caCertificatePem);
    expect(JSON.stringify(sourceSigner)).not.toContain('PRIVATE KEY');
    expect(JSON.stringify(proof)).not.toContain('PRIVATE KEY');
    expect(Object.keys(sourceSigner).sort()).toEqual([
      'caCertificatePem',
      'caFingerprint',
      'signRsaPssSha256',
    ]);
  });

  it('validates an ordered chain and rejects project, ordering, duplicate, and tamper errors', async () => {
    const first = identities[0];
    const second = identities[1];
    const third = identities[2];
    const firstSigner = await first.hostCaSigner();
    const secondSigner = await second.hostCaSigner();
    const secondCa = await second.loadOrCreate();
    const thirdCa = await third.loadOrCreate();
    const firstProof = await service.signTransition(firstSigner, {
      issuedAt: testTime({ days: -19 }),
      nextCaCertificatePem: secondCa.caCertificatePem,
      projectId: 'project-1',
      transferId: 'transfer-1',
    });
    const secondProof = await service.signTransition(secondSigner, {
      issuedAt: testTime({ days: 4364 }),
      nextCaCertificatePem: thirdCa.caCertificatePem,
      projectId: 'project-1',
      transferId: 'transfer-2',
    });

    expect(service.verifyChain({
      expectedCurrentCaFingerprint: thirdCa.caFingerprint,
      pinnedCaCertificatePem: firstSigner.caCertificatePem,
      projectId: 'project-1',
      proofs: [firstProof, secondProof],
    })).toBe(thirdCa.caCertificatePem);

    expect(() => service.verifyChain({
      pinnedCaCertificatePem: firstSigner.caCertificatePem,
      projectId: 'another-project',
      proofs: [firstProof],
    })).toThrow();
    expect(() => service.verifyChain({
      pinnedCaCertificatePem: firstSigner.caCertificatePem,
      projectId: 'project-1',
      proofs: [secondProof, firstProof],
    })).toThrow();
    expect(() => service.verifyChain({
      pinnedCaCertificatePem: firstSigner.caCertificatePem,
      projectId: 'project-1',
      proofs: [firstProof, firstProof],
    })).toThrow();
    expect(() => service.verifyChain({
      pinnedCaCertificatePem: firstSigner.caCertificatePem,
      projectId: 'project-1',
      proofs: [{ ...firstProof, issuedAt: testTime({ days: -19, seconds: 1 }) }],
    })).toThrow();
  });

  it('binds activation to the exact target CA and package manifest', async () => {
    const source = identities[0];
    const sourceSigner = await source.hostCaSigner();
    const input = {
      cutoverAt: testTime({ days: -19, minutes: 5 }),
      manifestDigest: 'a'.repeat(64),
      projectId: 'project-1',
      targetCaFingerprint: 'b'.repeat(64),
      targetHostMemberId: 'member-2',
      transferId: 'transfer-1',
    } as const;

    const certificate = await service.signActivation(sourceSigner, input);
    expect(() => service.verifyActivation(
      certificate,
      sourceSigner.caCertificatePem,
      input,
    )).not.toThrow();
    expect(() => service.verifyActivation(
      certificate,
      sourceSigner.caCertificatePem,
      { ...input, manifestDigest: 'c'.repeat(64) },
    )).toThrow();
  });

  it('binds committed Host activation evidence to its authority generation', async () => {
    const source = identities[0];
    const signer = await source.hostCaSigner();
    const input = {
      authorityGeneration: 7,
      cutoverAt: testTime({ days: -19, minutes: 5 }), manifestDigest: 'a'.repeat(64),
      projectId: 'project-1', targetCaFingerprint: 'b'.repeat(64),
      targetHostMemberId: 'member-2', transferId: 'transfer-1',
    } as const;
    const certificate = await service.signActivation(signer, input);
    expect(certificate.authorityProof).toMatchObject({
      authorityGeneration: 7, caCertificatePem: signer.caCertificatePem,
      manifestSha256: input.manifestDigest, targetHostMemberId: 'member-2',
    });
    expect(() => service.verifyActivation(certificate, signer.caCertificatePem, input)).not.toThrow();
    expect(() => service.verifyActivation(certificate, signer.caCertificatePem, {
      ...input, authorityGeneration: 8,
    })).toThrow();
    expect(() => service.verifyActivation({ ...certificate, authorityProof: {
      ...certificate.authorityProof!, targetHostMemberId: 'member-attacker',
    } }, signer.caCertificatePem, input)).toThrow();
  });

  it('continues full retained history from a Member already trusting an intermediate Host', async () => {
    const [first, second, third] = identities;
    const [a, b, c] = await Promise.all([first.hostCaSigner(), second.hostCaSigner(), third.hostCaSigner()]);
    const ab = await service.signTransition(a, {
      issuedAt: testTime({ days: -19 }), nextCaCertificatePem: b.caCertificatePem,
      projectId: 'project-1', transferId: 'transfer-ab',
    });
    const bc = await service.signTransition(b, {
      issuedAt: testTime({ days: -19, minutes: 1 }), nextCaCertificatePem: c.caCertificatePem,
      projectId: 'project-1', transferId: 'transfer-bc',
    });
    expect(service.verifyChain({
      expectedCurrentCaFingerprint: c.caFingerprint, pinnedCaCertificatePem: b.caCertificatePem,
      projectId: 'project-1', proofs: [ab, bc],
    })).toBe(c.caCertificatePem);
  });

  it('distinguishes a continuous return to a Host installation from competing successor proofs', async () => {
    const [first, second, third] = identities;
    const [a, b, c] = await Promise.all([first.hostCaSigner(), second.hostCaSigner(), third.hostCaSigner()]);
    const ab = await service.signTransition(a, {
      issuedAt: testTime({ days: -19 }), nextCaCertificatePem: b.caCertificatePem,
      projectId: 'project-1', transferId: 'transfer-ab',
    });
    const ba = await service.signTransition(b, {
      issuedAt: testTime({ days: -19, minutes: 1 }), nextCaCertificatePem: a.caCertificatePem,
      projectId: 'project-1', transferId: 'transfer-ba',
    });
    const ac = await service.signTransition(a, {
      issuedAt: testTime({ days: -19, minutes: 2 }), nextCaCertificatePem: c.caCertificatePem,
      projectId: 'project-1', transferId: 'transfer-ac',
    });
    const checkpoint = {
      transferId: ba.transferId,
      proofChainDigest: digestHostTransitionProofChain([ab, ba]),
    };
    expect(() => service.verifyChain({
      checkpoint,
      expectedCurrentCaFingerprint: c.caFingerprint, pinnedCaCertificatePem: a.caCertificatePem,
      projectId: 'project-1', proofs: [ac],
    })).toThrow();
    expect(service.verifyChain({
      checkpoint,
      expectedCurrentCaFingerprint: c.caFingerprint, pinnedCaCertificatePem: a.caCertificatePem,
      projectId: 'project-1', proofs: [ab, ba, ac],
    })).toBe(c.caCertificatePem);
    expect(() => service.verifyChain({
      expectedCurrentCaFingerprint: c.caFingerprint, pinnedCaCertificatePem: a.caCertificatePem,
      projectId: 'project-1', proofs: [ab, ac],
    })).toThrow();
  });
});
