import type { CollabAuthorityTransferStatus } from '@claudian-collab/protocol';
import { TEST_INSTALLATION_A } from '@test/helpers/installations';

import {
  bindLegacyAuthorityTransferSourceOwner,
  createAuthorityTransferRecord,
  decodeAuthorityTransferRecord,
} from '@/app/collab/authority-transfer/AuthorityTransferRecord';
import {
  AuthorityTransferRuntimeRegistry,
} from '@/app/collab/authority-transfer/AuthorityTransferRuntimeRegistry';

function status(projectId = 'project-runtime'): CollabAuthorityTransferStatus {
  return {
    batchRevision: null,
    batchSha256: null,
    checkpointSha256: null,
    createdAt: '2026-08-27T00:00:00.000Z',
    direction: 'lan-to-cloud',
    expiresAt: '2026-09-26T00:00:00.000Z',
    phase: 'source-quiesced',
    projectId,
    relinquishmentProof: null,
    sourceAuthority: { generation: 1, kind: 'lan' },
    state: 'active',
    targetAuthority: { generation: 2, kind: 'cloud' },
    targetUrl: 'https://cloud.example.test/',
    transferId: 'transfer-runtime',
    updatedAt: '2026-08-27T00:00:01.000Z',
  };
}

describe('AuthorityTransferRuntimeRegistry', () => {
  it('decodes exact owner-bound current records and ownerless legacy records', () => {
    const current = createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      lifecycleOwnership: 'owned',
      localRole: 'source',
      operationIntentId: 'intent-runtime',
      stagingDirectoryName: '.claudian-authority-transfer-transfer-runtime',
      status: status(),
    });
    expect(current).toMatchObject({
      ownerInstallationKey: TEST_INSTALLATION_A,
      schemaVersion: 2,
    });

    const { ownerInstallationKey: _, ...withoutOwner } = current;
    expect(decodeAuthorityTransferRecord({
      ...withoutOwner,
      schemaVersion: 1,
    })).toMatchObject({ schemaVersion: 1 });
    expect(() => decodeAuthorityTransferRecord(withoutOwner)).toThrow(TypeError);
    expect(() => decodeAuthorityTransferRecord({
      ...current,
      ownerInstallationKey: 'device-invalid',
    })).toThrow(TypeError);
    expect(() => decodeAuthorityTransferRecord({
      ...current,
      schemaVersion: 1,
    })).toThrow(TypeError);
  });

  it('binds only a source-side legacy checkpoint after explicit Host claim', () => {
    const current = createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      lifecycleOwnership: 'owned',
      localRole: 'source',
      operationIntentId: 'intent-runtime',
      stagingDirectoryName: '.claudian-authority-transfer-transfer-runtime',
      status: status(),
    });
    const { ownerInstallationKey: _, ...withoutOwner } = current;
    const source = decodeAuthorityTransferRecord({ ...withoutOwner, schemaVersion: 1 });
    const currentTarget = createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      lifecycleOwnership: 'owned',
      localRole: 'target',
      operationIntentId: 'intent-runtime',
      stagingDirectoryName: '.claudian-authority-transfer-transfer-runtime',
      status: {
        ...status(),
        direction: 'cloud-to-lan',
        phase: 'collecting-readiness',
        sourceAuthority: { generation: 1, kind: 'cloud' },
        targetAuthority: { generation: 2, kind: 'lan' },
        targetUrl: 'https://192.168.1.20:27001/',
      },
    });
    const { ownerInstallationKey: _targetOwner, ...targetWithoutOwner } = currentTarget;
    const target = decodeAuthorityTransferRecord({ ...targetWithoutOwner, schemaVersion: 1 });

    expect(bindLegacyAuthorityTransferSourceOwner(source, TEST_INSTALLATION_A)).toMatchObject({
      ownerInstallationKey: TEST_INSTALLATION_A,
      schemaVersion: 2,
    });
    expect(() => bindLegacyAuthorityTransferSourceOwner(target, TEST_INSTALLATION_A))
      .toThrow('Authority transfer target owner is ambiguous');
  });

  it('reconstructs and retains a durable runtime on first startup recovery', async () => {
    const resume = jest.fn(async () => undefined);
    const resolve = jest.fn(async () => ({ resume }));
    const registry = new AuthorityTransferRuntimeRegistry({ resolve });
    const record = createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      lifecycleOwnership: 'owned',
      localRole: 'source',
      operationIntentId: 'intent-runtime',
      stagingDirectoryName: '.claudian-authority-transfer-transfer-runtime',
      status: status(),
    });

    await registry.resume(record, {});
    await registry.resume(record, {});

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith(record);
    expect(resume).toHaveBeenCalledTimes(2);
    expect(resume).toHaveBeenNthCalledWith(1, 'project-runtime', {});
  });

  it('fails closed when no production runtime can be reconstructed', async () => {
    const registry = new AuthorityTransferRuntimeRegistry({
      resolve: async () => null,
    });
    const record = createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      lifecycleOwnership: 'owned',
      localRole: 'source',
      operationIntentId: 'intent-runtime',
      stagingDirectoryName: '.claudian-authority-transfer-transfer-runtime',
      status: status(),
    });

    await expect(registry.resume(record, {})).rejects.toMatchObject({
      code: 'durable-progress-recovery-required',
      safeContext: { reason: 'authority-transfer-runtime-not-bound' },
    });
  });
});
