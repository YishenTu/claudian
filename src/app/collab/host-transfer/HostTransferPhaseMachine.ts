import { CollabError } from '@/core/collab/ClaudianCollabError';

export type HostTransferDurablePhase =
  | 'offered'
  | 'accepted'
  | 'quiescing'
  | 'staged'
  | 'authority-relinquished'
  | 'target-active'
  | 'completed'
  | 'cancelled'
  | 'declined'
  | 'expired';

const TERMINAL_PHASES = new Set<HostTransferDurablePhase>([
  'completed',
  'cancelled',
  'declined',
  'expired',
]);

const TRANSITIONS: Readonly<Record<HostTransferDurablePhase, readonly HostTransferDurablePhase[]>> = {
  offered: ['accepted', 'cancelled', 'declined', 'expired'],
  accepted: ['quiescing', 'cancelled', 'declined', 'expired'],
  quiescing: ['staged', 'cancelled'],
  staged: ['authority-relinquished', 'cancelled'],
  'authority-relinquished': ['target-active'],
  'target-active': ['completed'],
  completed: [],
  cancelled: [],
  declined: [],
  expired: [],
};

function phaseError(reason: string): CollabError {
  return new CollabError({
    code: 'host-transfer-pending',
    recoveryActions: ['open-diagnostics'],
    safeContext: { reason },
  });
}

export function isTerminalHostTransferPhase(phase: HostTransferDurablePhase): boolean {
  return TERMINAL_PHASES.has(phase);
}

export function assertHostTransferTransition(
  current: HostTransferDurablePhase,
  next: HostTransferDurablePhase,
): void {
  if (current === next) return;
  if (!TRANSITIONS[current].includes(next)) {
    throw phaseError('host-transfer-phase-transition-invalid');
  }
}
