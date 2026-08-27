import type {
  CollabAuthorityRelinquishmentProof,
} from '@claudian-collab/protocol';

import type {
  LanAuthorityTransferRouteRegistration,
  LanAuthorityTransferSourceActiveService,
  LanAuthorityTransferTargetActiveService,
  LanAuthorityTransferTargetStagedService,
  LanAuthorityTransferTerminalSourceService,
} from '@/app/collab/lan/authority-transfer/LanAuthorityTransferRouter';
import {
  LanAuthorityTransferRouteRegistry,
} from '@/app/collab/lan/authority-transfer/LanAuthorityTransferRouteRegistry';

const PROJECT_ID = 'project-route-transition';
const TRANSFER_ID = 'transfer-route-transition';

function registration(
  state: LanAuthorityTransferRouteRegistration['state'],
): LanAuthorityTransferRouteRegistration {
  if (state === 'source-active') {
    return {
      hostMemberId: 'member-host',
      projectId: PROJECT_ID,
      service: {} as LanAuthorityTransferSourceActiveService,
      state,
    };
  }
  if (state === 'target-only-staged') {
    return {
      credentialHash: 'a'.repeat(64),
      projectId: PROJECT_ID,
      service: {} as LanAuthorityTransferTargetStagedService,
      state,
      transferId: TRANSFER_ID,
    };
  }
  return state === 'target-active'
    ? {
        projectId: PROJECT_ID,
        service: {} as LanAuthorityTransferTargetActiveService,
        state,
        transferId: TRANSFER_ID,
      }
    : {
        projectId: PROJECT_ID,
        service: {} as LanAuthorityTransferTerminalSourceService,
        state,
        transferId: TRANSFER_ID,
      };
}

function proof(
  direction: 'cloud-to-lan' | 'lan-to-cloud',
): CollabAuthorityRelinquishmentProof {
  const shared = {
    batchRevision: 1,
    batchSha256: 'b'.repeat(64),
    certificate: Buffer.alloc(64, 2).toString('base64url'),
    certificateAlgorithm: 'ed25519' as const,
    checkpointSha256: 'c'.repeat(64),
    committedAt: '2026-08-27T00:00:00.000Z',
    operationIntentId: 'intent-route-transition',
    projectId: PROJECT_ID,
    transferId: TRANSFER_ID,
  };
  return direction === 'lan-to-cloud'
    ? {
        ...shared,
        sourceAuthority: { generation: 1, kind: 'lan' },
        sourceHostMemberId: 'member-host',
        targetAuthority: { generation: 2, kind: 'cloud' },
      }
    : {
        ...shared,
        sourceAuthority: { generation: 1, kind: 'cloud' },
        sourceHostMemberId: null,
        targetAuthority: { generation: 2, kind: 'lan' },
      };
}

describe('LanAuthorityTransferRouteRegistry', () => {
  it('permits only the two proof-bound forward authority transitions', async () => {
    const sourceRegistry = new LanAuthorityTransferRouteRegistry();
    const source = registration('source-active');
    const terminal = registration('terminal-source');
    await sourceRegistry.install(source);
    await expect(sourceRegistry.transition({
      expected: source,
      next: terminal,
      relinquishmentProof: proof('lan-to-cloud'),
    })).resolves.toBeUndefined();
    expect(sourceRegistry.resolve(PROJECT_ID)).toBe(terminal);

    const targetRegistry = new LanAuthorityTransferRouteRegistry();
    const staged = registration('target-only-staged');
    const active = registration('target-active');
    await targetRegistry.install(staged);
    await expect(targetRegistry.transition({
      expected: staged,
      next: active,
      relinquishmentProof: proof('cloud-to-lan'),
    })).resolves.toBeUndefined();
    expect(targetRegistry.resolve(PROJECT_ID)).toBe(active);
  });

  it('rejects reverse, proofless-in-effect, and stale route replacement', async () => {
    const registry = new LanAuthorityTransferRouteRegistry();
    const source = registration('source-active');
    const terminal = registration('terminal-source');
    await registry.install(source);

    expect(() => registry.transition({
      expected: source,
      next: terminal,
      relinquishmentProof: proof('cloud-to-lan'),
    })).toThrow(expect.objectContaining({
      safeContext: { reason: 'authority-transfer-route-transition-invalid' },
    }));
    expect(() => registry.transition({
      expected: terminal,
      next: source,
      relinquishmentProof: proof('lan-to-cloud'),
    })).toThrow(expect.objectContaining({
      safeContext: { reason: 'authority-transfer-route-transition-invalid' },
    }));
    await expect(registry.transition({
      expected: registration('source-active'),
      next: terminal,
      relinquishmentProof: proof('lan-to-cloud'),
    })).rejects.toMatchObject({
      safeContext: { reason: 'authority-transfer-route-stale' },
    });
    expect(registry.resolve(PROJECT_ID)).toBe(source);
  });
});
