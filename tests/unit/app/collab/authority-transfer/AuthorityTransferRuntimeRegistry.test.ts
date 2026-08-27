import type { CollabAuthorityTransferStatus } from '@claudian-collab/protocol';

import { createAuthorityTransferRecord } from '@/app/collab/authority-transfer/AuthorityTransferRecord';
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
  it('reconstructs and retains a durable runtime on first startup recovery', async () => {
    const resume = jest.fn(async () => undefined);
    const resolve = jest.fn(async () => ({ resume }));
    const registry = new AuthorityTransferRuntimeRegistry({ resolve });
    const record = createAuthorityTransferRecord({
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
