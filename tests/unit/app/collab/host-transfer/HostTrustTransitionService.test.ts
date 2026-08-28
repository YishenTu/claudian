import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { TEST_INSTALLATION_A } from '@test/helpers/installations';

import {
  HostTrustTransitionService,
} from '@/app/collab/host-transfer/HostTrustTransitionService';
import { LanTlsIdentity } from '@/app/collab/lan/LanTlsIdentity';

jest.setTimeout(120_000);

describe('HostTrustTransitionService', () => {
  const service = new HostTrustTransitionService();
  const roots: string[] = [];

  async function identity(name: string): Promise<LanTlsIdentity> {
    const root = await mkdtemp(path.join(tmpdir(), `claudian-${name}-`));
    roots.push(root);
    return new LanTlsIdentity(root, {
      installationKey: TEST_INSTALLATION_A,
      now: () => new Date('2026-08-08T00:00:00.000Z'),
    });
  }

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })));
  });

  it('canonicalizes CRLF CA certificates before they enter transition proofs', async () => {
    const source = await identity('source-crlf');
    const target = await identity('target-crlf');
    const next = await target.loadOrCreate();
    const proof = await service.signTransition(await source.hostCaSigner(), {
      issuedAt: '2026-08-08T00:00:00.000Z',
      nextCaCertificatePem: next.caCertificatePem.replaceAll('\n', '\r\n'),
      projectId: 'project-alpha',
      transferId: 'transfer-one',
    });

    expect(proof.nextCaCertificatePem).not.toContain('\r');
  });

  it('signs the exact RSA-PSS transition payload without projecting private material', async () => {
    const source = await identity('source');
    const target = await identity('target');
    const sourceSigner = await source.hostCaSigner();
    const targetCa = await target.loadOrCreate();

    const proof = await service.signTransition(sourceSigner, {
      issuedAt: '2026-08-08T00:00:00.000Z',
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
    const first = await identity('first');
    const second = await identity('second');
    const third = await identity('third');
    const firstSigner = await first.hostCaSigner();
    const secondSigner = await second.hostCaSigner();
    const secondCa = await second.loadOrCreate();
    const thirdCa = await third.loadOrCreate();
    const firstProof = await service.signTransition(firstSigner, {
      issuedAt: '2026-08-08T00:00:00.000Z',
      nextCaCertificatePem: secondCa.caCertificatePem,
      projectId: 'project-1',
      transferId: 'transfer-1',
    });
    const secondProof = await service.signTransition(secondSigner, {
      issuedAt: '2038-08-08T00:00:00.000Z',
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
      proofs: [{ ...firstProof, issuedAt: '2026-08-08T00:00:01.000Z' }],
    })).toThrow();
  });

  it('binds activation to the exact target CA and package manifest', async () => {
    const source = await identity('source');
    const sourceSigner = await source.hostCaSigner();
    const input = {
      cutoverAt: '2026-08-08T00:05:00.000Z',
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
});
