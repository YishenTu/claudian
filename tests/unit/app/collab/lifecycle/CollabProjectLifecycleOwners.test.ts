import {
  TEST_INSTALLATION_A,
  TEST_INSTALLATION_B,
} from '@test/helpers/installations';

import {
  createCollabProjectLifecycleDurableOwners,
} from '@/app/collab/lifecycle/CollabProjectLifecycleOwners';

function stores() {
  return {
    cloudBootstrapTransitions: { inspectLifecycleOwner: jest.fn().mockResolvedValue('absent') },
    hostTransferRecovery: { load: jest.fn().mockResolvedValue(null) },
    localCleanup: { load: jest.fn().mockResolvedValue(null) },
    managerReceipts: { load: jest.fn().mockResolvedValue(null) },
    pendingLeaves: { load: jest.fn().mockResolvedValue(null) },
    retiredCleanups: { load: jest.fn().mockResolvedValue(null) },
    retirements: { loadRetirementRecord: jest.fn().mockResolvedValue(null) },
    retirementTombstones: { loadRetirementTombstone: jest.fn().mockResolvedValue(null) },
  };
}

describe('CollabProjectLifecycleOwners', () => {
  it('projects real durable lifecycle records into the shared arbiter', async () => {
    const backing = stores();
    backing.hostTransferRecovery.load.mockImplementation(async (_projectId, direction) => (
      direction === 'incoming' ? { direction: 'incoming' } : null
    ));
    backing.pendingLeaves.load.mockResolvedValue({ phase: 'queued' });
    backing.managerReceipts.load.mockResolvedValue({ status: 'acknowledged' });
    backing.retirements.loadRetirementRecord.mockResolvedValue({ cleanupStatus: 'complete' });
    backing.cloudBootstrapTransitions.inspectLifecycleOwner.mockResolvedValue('nonterminal');
    const owners = createCollabProjectLifecycleDurableOwners(backing, () => true);

    await expect(Promise.all(owners.map(async owner => ({
      name: owner.name,
      state: await owner.inspect('project-alpha'),
    })))).resolves.toEqual([
      { name: 'cloud-bootstrap', state: 'nonterminal' },
      { name: 'host-transfer', state: 'nonterminal' },
      { name: 'manager-responsibility', state: 'terminal' },
      { name: 'local-exit', state: 'terminal' },
      { name: 'retirement', state: 'nonterminal' },
    ]);
  });

  it('treats completed bootstrap cleanup as terminal and absent stores as absent', async () => {
    const backing = stores();
    backing.cloudBootstrapTransitions.inspectLifecycleOwner.mockResolvedValue('terminal');
    const owners = createCollabProjectLifecycleDurableOwners(backing, () => true);

    await expect(Promise.all(owners.map(async owner => ({
      name: owner.name,
      state: await owner.inspect('project-alpha'),
    })))).resolves.toEqual([
      { name: 'cloud-bootstrap', state: 'terminal' },
      { name: 'host-transfer', state: 'absent' },
      { name: 'manager-responsibility', state: 'absent' },
      { name: 'local-exit', state: 'absent' },
      { name: 'retirement', state: 'absent' },
    ]);
  });

  it('classifies a reversible Manager offer as a proposal until the target acknowledges it', async () => {
    const backing = stores();
    backing.managerReceipts.load.mockResolvedValue({ status: 'offered' });
    const owner = createCollabProjectLifecycleDurableOwners(backing, () => true)
      .find(candidate => candidate.name === 'manager-responsibility')!;

    await expect(owner.inspect('project-alpha')).resolves.toBe('proposal');

    backing.managerReceipts.load.mockResolvedValue({ status: 'acknowledged' });
    await expect(owner.inspect('project-alpha')).resolves.toBe('nonterminal');
  });

  it('lets a pending Leave durably subsume an acknowledged Manager receipt', async () => {
    const backing = stores();
    backing.managerReceipts.load.mockResolvedValue({ status: 'acknowledged' });
    backing.pendingLeaves.load.mockResolvedValue({ phase: 'queued' });
    const owners = createCollabProjectLifecycleDurableOwners(backing, () => true);
    const managerResponsibility = owners.find(owner => owner.name === 'manager-responsibility')!;
    const localExit = owners.find(owner => owner.name === 'local-exit')!;

    await expect(managerResponsibility.inspect('project-alpha')).resolves.toBe('terminal');
    await expect(localExit.inspect('project-alpha')).resolves.toBe('nonterminal');
  });

  it('fails closed when both Host-transfer directions exist', async () => {
    const backing = stores();
    backing.hostTransferRecovery.load.mockResolvedValue({ phase: 'accepted' });
    const hostTransfer = createCollabProjectLifecycleDurableOwners(backing, () => true)
      .find(owner => owner.name === 'host-transfer')!;

    await expect(hostTransfer.inspect('project-alpha'))
      .rejects.toThrow('Conflicting Host transfer recovery records');
  });

  it('treats a retained incoming terminal receipt as terminal after staging cleanup', async () => {
    const backing = stores();
    backing.hostTransferRecovery.load.mockImplementation(async (_projectId, direction) => (
      direction === 'incoming'
        ? {
            direction,
            ownerInstallationKey: TEST_INSTALLATION_A,
            phase: 'completed',
            receiverCredentialHash: 'a'.repeat(64),
            stagingDirectoryName: null,
          }
        : null
    ));
    const hostTransfer = createCollabProjectLifecycleDurableOwners(backing, () => true)
      .find(owner => owner.name === 'host-transfer')!;

    await expect(hostTransfer.inspect('project-alpha')).resolves.toBe('terminal');
  });

  it('lets a durable retirement absorb an overlapping pending Leave', async () => {
    const backing = stores();
    backing.pendingLeaves.load.mockResolvedValue({ phase: 'recovery-required' });
    backing.retirements.loadRetirementRecord.mockResolvedValue({ cleanupStatus: 'pending' });
    const owners = createCollabProjectLifecycleDurableOwners(backing, () => true);
    const localExit = owners.find(owner => owner.name === 'local-exit')!;
    const retirement = owners.find(owner => owner.name === 'retirement')!;

    await expect(localExit.inspect('project-alpha')).resolves.toBe('terminal');
    await expect(retirement.inspect('project-alpha')).resolves.toBe('nonterminal');
  });

  it('keeps retirement ownership after the authority tombstone commits before local delivery', async () => {
    const backing = stores();
    backing.retirementTombstones.loadRetirementTombstone.mockResolvedValue({
      kind: 'retirement-tombstone',
    ownerInstallationKey: TEST_INSTALLATION_A,
    });
    const retirement = createCollabProjectLifecycleDurableOwners(backing, () => true)
      .find(owner => owner.name === 'retirement')!;

    await expect(retirement.inspect('project-alpha')).resolves.toBe('nonterminal');
  });

  it('keeps foreign Host-transfer and retirement journals out of local lifecycle ownership', async () => {
    const backing = stores();
    backing.hostTransferRecovery.load.mockImplementation(async (_projectId, direction) => (
      direction === 'incoming'
        ? { direction, ownerInstallationKey: TEST_INSTALLATION_A }
        : null
    ));
    backing.retirementTombstones.loadRetirementTombstone.mockResolvedValue({
      kind: 'retirement-tombstone',
      ownerInstallationKey: TEST_INSTALLATION_A,
    });
    const owners = createCollabProjectLifecycleDurableOwners(
      backing,
      ownerInstallationKey => ownerInstallationKey === TEST_INSTALLATION_B,
    );

    await expect(owners.find(owner => owner.name === 'host-transfer')!
      .inspect('project-alpha')).resolves.toBe('absent');
    await expect(owners.find(owner => owner.name === 'retirement')!
      .inspect('project-alpha')).resolves.toBe('absent');
  });

  it('keeps ownerless legacy Host-transfer and retirement journals visible for recovery', async () => {
    const backing = stores();
    backing.hostTransferRecovery.load.mockImplementation(async (_projectId, direction) => (
      direction === 'incoming' ? { direction, ownerInstallationKey: undefined } : null
    ));
    backing.retirementTombstones.loadRetirementTombstone.mockResolvedValue({
      kind: 'retirement-tombstone',
      ownerInstallationKey: undefined,
    });
    const owners = createCollabProjectLifecycleDurableOwners(
      backing,
      ownerInstallationKey => ownerInstallationKey === TEST_INSTALLATION_A,
    );

    await expect(owners.find(owner => owner.name === 'host-transfer')!
      .inspect('project-alpha')).resolves.toBe('nonterminal');
    await expect(owners.find(owner => owner.name === 'retirement')!
      .inspect('project-alpha')).resolves.toBe('nonterminal');
  });
});
