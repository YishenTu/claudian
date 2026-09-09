import type { CollabAuthorityTransferStatus } from '@claudian-collab/protocol';
import { TEST_INSTALLATION_A } from '@test/helpers/installations';

import {
  createAuthorityTransferRecord,
  decodeAuthorityTransferRecord,
} from '@/app/collab/authority-transfer/AuthorityTransferRecord';
import {
  AuthorityTransferRuntimeDispatch,
} from '@/app/collab/authority-transfer/AuthorityTransferRuntimeDispatch';

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

describe('AuthorityTransferRuntimeDispatch', () => {
  it('requires exact owner-bound current records', () => {
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
    expect(() => decodeAuthorityTransferRecord({
      ...withoutOwner,
      schemaVersion: 1,
    })).toThrow(TypeError);
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

  it('resumes the requested operation after a later generation replaces the same Project role', async () => {
    const resumed: string[] = [];
    const registry = new AuthorityTransferRuntimeDispatch({
      resolve: async record => ({ resume: async () => { resumed.push(record.transferId); } }),
    });
    const first = createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      lifecycleOwnership: 'owned',
      localRole: 'source',
      operationIntentId: 'intent-runtime',
      stagingDirectoryName: '.claudian-authority-transfer-transfer-runtime',
      status: status(),
    });
    const next = createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      lifecycleOwnership: 'owned',
      localRole: 'source',
      operationIntentId: 'intent-runtime-next',
      stagingDirectoryName: '.claudian-authority-transfer-transfer-runtime-next',
      status: {
        ...status(),
        sourceAuthority: { generation: 3, kind: 'lan' },
        targetAuthority: { generation: 4, kind: 'cloud' },
        transferId: 'transfer-runtime-next',
      },
    });

    await registry.resume(first, {});
    await registry.resume(next, {});

    expect(resumed).toEqual(['transfer-runtime', 'transfer-runtime-next']);
  });

  it('fails closed when no production runtime can be reconstructed', async () => {
    const registry = new AuthorityTransferRuntimeDispatch({
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
