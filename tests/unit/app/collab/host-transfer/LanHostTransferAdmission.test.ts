import { LanHostTransferAdmission } from '@/app/collab/host-transfer/LanHostTransferAdmission';

describe('LanHostTransferAdmission', () => {
  it('binds every route and authority transition to one Project and transfer', async () => {
    const events: string[] = [];
    const host = {
      closeProjectForHostTransfer: jest.fn(async () => { events.push('close-route'); }),
      completeProjectHostTransfer: jest.fn(async () => { events.push('release-route'); }),
      quiesceProjectForHostTransfer: jest.fn(async () => { events.push('quiesce'); }),
      reopenProjectBeforeHostTransfer: jest.fn(async () => { events.push('reopen'); }),
    };
    const admission = new LanHostTransferAdmission(
      'project-alpha',
      'transfer-alpha',
      host,
      {
        assertAcceptanceSettled: jest.fn(async () => { events.push('accept-settled'); }),
        finalizeOldAuthority: jest.fn(async () => { events.push('remove-authority'); }),
      },
    );

    await admission.quiesceAndDrain('project-alpha', 'transfer-alpha');
    await admission.assertAcceptanceSettled('project-alpha');
    await admission.closeActiveAuthority('project-alpha', 'transfer-alpha');
    await admission.reopenBeforeRelinquishment('project-alpha', 'transfer-alpha');
    await admission.finalizeOldAuthority('project-alpha', 'transfer-alpha');

    expect(events).toEqual([
      'quiesce',
      'accept-settled',
      'close-route',
      'reopen',
      'remove-authority',
      'release-route',
    ]);
  });

  it('fails closed when a coordinator crosses its bound identity', async () => {
    const admission = new LanHostTransferAdmission(
      'project-alpha',
      'transfer-alpha',
      {} as never,
      {
        assertAcceptanceSettled: jest.fn(),
        finalizeOldAuthority: jest.fn(),
      },
    );

    expect(() => admission.closeActiveAuthority('project-other', 'transfer-alpha'))
      .toThrow(expect.objectContaining({ code: 'authority-integrity-error' }));
    expect(() => admission.reopenBeforeRelinquishment('project-alpha', 'transfer-other'))
      .toThrow(expect.objectContaining({ code: 'authority-integrity-error' }));
  });
});
