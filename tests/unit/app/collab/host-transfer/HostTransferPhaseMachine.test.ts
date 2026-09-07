import {
  assertHostTransferTransition,
  isTerminalHostTransferPhase,
} from '@/app/collab/host-transfer/HostTransferPhaseMachine';

describe('HostTransferPhaseMachine', () => {
  it('allows the one-way durable cutover path and idempotent reconstruction', () => {
    const phases = [
      'offered',
      'accepted',
      'quiescing',
      'staged',
      'authority-relinquished',
      'target-active',
      'completed',
    ] as const;
    for (let index = 1; index < phases.length; index += 1) {
      expect(() => assertHostTransferTransition(phases[index - 1], phases[index])).not.toThrow();
      expect(() => assertHostTransferTransition(phases[index], phases[index])).not.toThrow();
    }
    expect(isTerminalHostTransferPhase('completed')).toBe(true);
  });

  it('rejects rollback and all cancellation after authority relinquishment', () => {
    expect(() => assertHostTransferTransition('authority-relinquished', 'staged')).toThrow();
    expect(() => assertHostTransferTransition('authority-relinquished', 'cancelled')).toThrow();
    expect(() => assertHostTransferTransition('target-active', 'cancelled')).toThrow();
  });
});
