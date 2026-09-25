import {
COLLAB_AUTHORITY_TRANSFER_OPERATIONS,
} from '@claudian-collab/protocol';

import {
collabLANAuthorityTransferOperationPath,
matchCollabLANAuthorityTransferRoute
} from '@/app/collab/lan/authority-transfer/LANAuthorityTransferBinding';

describe('LAN authority-transfer binding', () => {
  it('owns an independent version and round-trips every package operation', () => {

    for (const operation of COLLAB_AUTHORITY_TRANSFER_OPERATIONS) {
      const path = collabLANAuthorityTransferOperationPath('project-alpha', operation);
      expect(path).toBe(
        `/authority-transfer/v3/projects/project-alpha/operations/${operation}`,
      );
      expect(matchCollabLANAuthorityTransferRoute('POST', path)).toEqual({
        operation,
        projectId: 'project-alpha',
        version: 3,
      });
    }
  });

  it.each([
    ['GET', '/authority-transfer/v1/projects/project-alpha/operations/getProjectAuthorityTransfer'],
    ['POST', '/v9/projects/project-alpha/snapshot'],
    ['POST', '/v9/host-transfers/transfer-alpha/probe'],
    ['POST', '/v1/projects/project-alpha/repository.git/git-upload-pack'],
    ['POST', '/authority-transfer/v1/projects/project-alpha/operations/notAnOperation'],
    ['POST', '/authority-transfer/v1/projects/project-alpha/operations/getProjectAuthorityTransfer?extra=true'],
  ])('does not claim %s %s', (method, path) => {
    expect(matchCollabLANAuthorityTransferRoute(method, path)).toBeNull();
  });

  it('recognizes the prior binding version without treating it as v3', () => {
    expect(matchCollabLANAuthorityTransferRoute(
      'POST',
      '/authority-transfer/v1/projects/project-alpha/operations/getProjectAuthorityTransfer',
    )).toEqual({
      operation: 'getProjectAuthorityTransfer',
      projectId: 'project-alpha',
      version: 1,
    });
  });
});
