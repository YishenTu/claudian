import {
  COLLAB_AUTHORITY_TRANSFER_OPERATIONS,
} from '@claudian-collab/protocol';

import {
  COLLAB_LAN_AUTHORITY_TRANSFER_BINDING_VERSION,
  collabLanAuthorityTransferOperationPath,
  matchCollabLanAuthorityTransferRoute,
} from '@/app/collab/lan/authority-transfer/LanAuthorityTransferBinding';

describe('LAN authority-transfer binding', () => {
  it('owns an independent version and round-trips every package operation', () => {
    expect(COLLAB_LAN_AUTHORITY_TRANSFER_BINDING_VERSION).toBe(1);

    for (const operation of COLLAB_AUTHORITY_TRANSFER_OPERATIONS) {
      const path = collabLanAuthorityTransferOperationPath('project-alpha', operation);
      expect(path).toBe(
        `/authority-transfer/v1/projects/project-alpha/operations/${operation}`,
      );
      expect(matchCollabLanAuthorityTransferRoute('POST', path)).toEqual({
        operation,
        projectId: 'project-alpha',
        version: 1,
      });
    }
  });

  it.each([
    ['GET', '/authority-transfer/v1/projects/project-alpha/operations/getProjectAuthorityTransfer'],
    ['POST', '/v9/projects/project-alpha/snapshot'],
    ['POST', '/v6/host-transfers/transfer-alpha/probe'],
    ['POST', '/v1/projects/project-alpha/repository.git/git-upload-pack'],
    ['POST', '/authority-transfer/v1/projects/project-alpha/operations/notAnOperation'],
    ['POST', '/authority-transfer/v1/projects/project-alpha/operations/getProjectAuthorityTransfer?extra=true'],
  ])('does not claim %s %s', (method, path) => {
    expect(matchCollabLanAuthorityTransferRoute(method, path)).toBeNull();
  });

  it('recognizes an unsupported binding version without treating it as v1', () => {
    expect(matchCollabLanAuthorityTransferRoute(
      'POST',
      '/authority-transfer/v2/projects/project-alpha/operations/getProjectAuthorityTransfer',
    )).toEqual({
      operation: 'getProjectAuthorityTransfer',
      projectId: 'project-alpha',
      version: 2,
    });
  });
});
